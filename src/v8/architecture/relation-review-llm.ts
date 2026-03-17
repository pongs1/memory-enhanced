import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../../utils.js";
import { readJsonl } from "./io.js";
import type {
    V8EvidenceSpan,
    V8GraphNode,
    V8RelationCandidateHit,
    V8RelationReviewJob,
    V8RelationSearchPlan,
    V8ReviewedRelation,
} from "../types_v8.js";

interface WriteRelationReviewMarkdownInput {
    filePath: string;
    jobs: V8RelationReviewJob[];
    plans: V8RelationSearchPlan[];
    candidateHits: V8RelationCandidateHit[];
    nodes: V8GraphNode[];
    evidenceSpans: V8EvidenceSpan[];
}

interface LoadReviewedRelationsInput {
    mdPath: string;
    jsonlPath: string;
    jobs: V8RelationReviewJob[];
    nodes: V8GraphNode[];
}

export function writeRelationReviewJobsMarkdown(
    input: WriteRelationReviewMarkdownInput
): void {
    const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
    const planById = new Map(input.plans.map((plan) => [plan.id, plan]));
    const hitById = new Map(input.candidateHits.map((hit) => [hit.id, hit]));
    const spanById = new Map(input.evidenceSpans.map((span) => [span.id, span]));
    const lines: string[] = [];

    lines.push("# Relation Review Jobs");
    lines.push("");
    lines.push("Review relation candidates and output only evidence-backed reviewed relations in markdown.");
    lines.push("");
    lines.push("Review rules:");
    lines.push("- Accept a relation only when the candidate spans directly support that edge type between the nodes.");
    lines.push("- If evidence is suggestive but not decisive, use `hypothesis`.");
    lines.push("- If the spans do not support the edge, use `rejected`.");
    lines.push("- Prefer direct span evidence over abstract guessing.");
    lines.push("- Do not invent node ids, edge types, or evidence ids.");
    lines.push("- Use anchor nodes plus the listed candidate nodes only.");
    lines.push("- One reviewed relation should describe one concrete relation judgment.");
    lines.push("");
    lines.push("Output format:");
    lines.push("```md");
    lines.push("### Reviewed Relation");
    lines.push("review_job_id: <job_id>");
    lines.push("src_node_id: <node_id>");
    lines.push("dst_node_id: <node_id>");
    lines.push("edge_type: <edge_type>");
    lines.push("status: accepted|hypothesis|rejected");
    lines.push("confidence: 0.0-1.0");
    lines.push("support_evidence_span_ids: <span_id_1>, <span_id_2>");
    lines.push("rationale: <short rationale>");
    lines.push("```");
    lines.push("");
    lines.push("Use only node ids and evidence ids present below.");
    lines.push("");

    const sortedJobs = input.jobs
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));
    for (const job of sortedJobs) {
        const plan = planById.get(job.planId);
        const anchors = (job.anchorNodeIds || [])
            .map((nodeId) => `${nodeId} (${nodeById.get(nodeId)?.canonicalLabel || "unknown"})`)
            .join(", ");

        lines.push(`## Job ${job.id}`);
        lines.push(`- plan_id: ${job.planId}`);
        lines.push(`- review_question: ${job.reviewQuestion}`);
        lines.push(`- candidate_edge_types: ${(job.candidateEdgeTypes || []).join(", ")}`);
        lines.push(`- anchor_nodes: ${anchors || "(none)"}`);
        if (plan?.anchorLabels?.length) {
            lines.push(`- anchor_labels: ${plan.anchorLabels.join(", ")}`);
        }
        if (plan?.queryTerms?.length) {
            lines.push(`- query_terms: ${plan.queryTerms.slice(0, 12).join(", ")}`);
        }
        lines.push("");

        lines.push("### Candidate Nodes");
        const candidateNodes = (job.candidateNodeIds || [])
            .map((nodeId) => nodeById.get(nodeId))
            .filter((node): node is V8GraphNode => Boolean(node))
            .sort((a, b) => a.id.localeCompare(b.id));
        if (candidateNodes.length === 0) {
            lines.push("- (none)");
        } else {
            for (const node of candidateNodes) {
                const evidenceLabel =
                    node.bestEvidenceSpanIds?.[0] || node.evidenceSpanIds?.[0] || "";
                lines.push(
                    `- node_id=${node.id}; label=${singleLine(node.canonicalLabel || node.id, 80)}; type=${node.memoryType}; confidence=${node.state.confidence.toFixed(3)}`
                );
                if (evidenceLabel) {
                    lines.push(`  best_evidence_span_id=${evidenceLabel}`);
                }
            }
        }
        lines.push("");

        lines.push("### Candidate Hits");
        const hitRows = (job.candidateHitIds || [])
            .map((id) => hitById.get(id))
            .filter((hit): hit is V8RelationCandidateHit => Boolean(hit))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        if (hitRows.length === 0) {
            lines.push("- (none)");
        } else {
            for (const hit of hitRows) {
                const span = spanById.get(hit.spanId);
                lines.push(
                    `- hit_id=${hit.id}; edge_type=${hit.candidateEdgeType}; score=${hit.score.toFixed(3)}; span_id=${hit.spanId}; unit_id=${hit.unitId}`
                );
                lines.push(
                    `  text=${singleLine(span?.text || hit.spanText || "", 280)}`
                );
            }
        }
        lines.push("");
    }

    ensureDir(path.dirname(input.filePath));
    fs.writeFileSync(input.filePath, lines.join("\n"), "utf-8");
}

export function loadReviewedRelations(
    input: LoadReviewedRelationsInput
): V8ReviewedRelation[] {
    const fromJsonl = normalizeReviewedRelationsJsonl(
        readJsonl<Partial<V8ReviewedRelation>>(input.jsonlPath),
        input.jobs,
        input.nodes
    );
    const fromMd = normalizeReviewedRelationsMarkdown(
        safeReadText(input.mdPath),
        input.jobs,
        input.nodes
    );
    const merged = new Map<string, V8ReviewedRelation>();
    for (const item of [...fromJsonl, ...fromMd]) {
        merged.set(item.id, item);
    }
    return Array.from(merged.values()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
}

function normalizeReviewedRelationsJsonl(
    rows: Array<Partial<V8ReviewedRelation>>,
    jobs: V8RelationReviewJob[],
    nodes: V8GraphNode[]
): V8ReviewedRelation[] {
    const out: V8ReviewedRelation[] = [];
    for (const row of rows || []) {
        const normalized = normalizeOneRelation(row, jobs, nodes);
        if (!normalized) continue;
        out.push(normalized);
    }
    return out;
}

function normalizeReviewedRelationsMarkdown(
    markdown: string,
    jobs: V8RelationReviewJob[],
    nodes: V8GraphNode[]
): V8ReviewedRelation[] {
    if (!markdown.trim()) return [];
    const sections = markdown
        .split(/\n###\s+Reviewed Relation\s*\n/i)
        .map((section) => section.trim())
        .filter(Boolean);
    const out: V8ReviewedRelation[] = [];
    for (const section of sections) {
        const parsed = parseKeyValueSection(section);
        const normalized = normalizeOneRelation(parsed, jobs, nodes);
        if (!normalized) continue;
        out.push(normalized);
    }
    return out;
}

function normalizeOneRelation(
    raw: Partial<V8ReviewedRelation> | Record<string, unknown>,
    jobs: V8RelationReviewJob[],
    nodes: V8GraphNode[]
): V8ReviewedRelation | null {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const reviewJobId = String(
        (raw as any).reviewJobId ?? (raw as any).review_job_id ?? ""
    ).trim();
    if (!reviewJobId) return null;
    const job = jobs.find((entry) => entry.id === reviewJobId);
    if (!job) return null;
    const allowedNodeIds = new Set([...(job.anchorNodeIds || []), ...(job.candidateNodeIds || [])]);

    const srcNodeId = String(
        (raw as any).srcNodeId ?? (raw as any).src_node_id ?? ""
    ).trim();
    const dstNodeId = String(
        (raw as any).dstNodeId ?? (raw as any).dst_node_id ?? ""
    ).trim();
    if (!srcNodeId || !dstNodeId) return null;
    if (!nodeIds.has(srcNodeId) || !nodeIds.has(dstNodeId)) return null;
    if (!allowedNodeIds.has(srcNodeId) || !allowedNodeIds.has(dstNodeId)) return null;
    const anchorNodeSet = new Set(job.anchorNodeIds || []);
    if (!anchorNodeSet.has(srcNodeId) && !anchorNodeSet.has(dstNodeId)) return null;

    const edgeType = String(
        (raw as any).edgeType ?? (raw as any).edge_type ?? ""
    ).trim();
    if (!edgeType) return null;
    if (
        Array.isArray(job.candidateEdgeTypes) &&
        job.candidateEdgeTypes.length > 0 &&
        !job.candidateEdgeTypes.includes(edgeType)
    ) {
        return null;
    }
    const statusRaw = String((raw as any).status || "").trim();
    const status: V8ReviewedRelation["status"] =
        statusRaw === "accepted" || statusRaw === "hypothesis" || statusRaw === "rejected"
            ? statusRaw
            : "hypothesis";

    const confidenceRaw = Number((raw as any).confidence);
    const confidence = clamp01(Number.isFinite(confidenceRaw) ? confidenceRaw : 0.5);
    const supportRaw =
        (raw as any).supportEvidenceSpanIds ?? (raw as any).support_evidence_span_ids ?? "";
    const supportEvidenceSpanIds = normalizeStringList(supportRaw).filter((spanId) =>
        (job.evidenceSpanIds || []).includes(spanId)
    );
    if (status !== "rejected" && supportEvidenceSpanIds.length === 0) {
        return null;
    }
    const rationale = String((raw as any).rationale || "").trim().slice(0, 1200);
    const createdAt = normalizeTimestamp(String((raw as any).createdAt || ""));
    const explicitId = String((raw as any).id || "").trim();
    const id =
        explicitId ||
        `rr_${shortHash(
            `${reviewJobId}|${srcNodeId}|${edgeType}|${dstNodeId}|${status}|${createdAt}`
        )}`;

    return {
        id,
        reviewJobId,
        srcNodeId,
        dstNodeId,
        edgeType,
        status,
        supportEvidenceSpanIds,
        confidence,
        rationale,
        createdAt,
    };
}

function parseKeyValueSection(section: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const line of section.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
        if (!match) continue;
        out[match[1]!] = match[2]!.trim();
    }
    return out;
}

function normalizeStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return Array.from(
            new Set(value.map((item) => String(item || "").trim()).filter(Boolean))
        );
    }
    const text = String(value || "");
    if (!text.trim()) return [];
    return Array.from(
        new Set(
            text
                .split(/[,\n;]/)
                .map((item) => item.trim())
                .filter(Boolean)
        )
    );
}

function safeReadText(filePath: string): string {
    try {
        return fs.readFileSync(filePath, "utf-8");
    } catch {
        return "";
    }
}

function normalizeTimestamp(value: string): string {
    const raw = (value || "").trim();
    const ts = raw ? Date.parse(raw) : NaN;
    if (Number.isNaN(ts)) return new Date().toISOString();
    return new Date(ts).toISOString();
}

function singleLine(text: string, maxChars: number): string {
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (flat.length <= maxChars) return flat;
    return `${flat.slice(0, maxChars)}...`;
}

function shortHash(value: string): string {
    return crypto
        .createHash("sha1")
        .update(value)
        .digest("hex")
        .slice(0, 12);
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
