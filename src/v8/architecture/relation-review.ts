import * as crypto from "node:crypto";
import type {
    V8GraphEdge,
    V8GraphNode,
    V8HypothesisEdge,
    V8LearningEvent,
    V8RelationReviewJob,
    V8RelationSearchPlan,
    V8ReviewedRelation,
    V8SearchFeedbackSignal,
} from "../types_v8.js";

export interface ApplyReviewedRelationsToGraphInput {
    nodes: V8GraphNode[];
    edges: V8GraphEdge[];
    reviewedRelations: V8ReviewedRelation[];
    existingHypothesisEdges: V8HypothesisEdge[];
}

export interface ApplyReviewedRelationsToGraphOutput {
    edges: V8GraphEdge[];
    reviewedRelations: V8ReviewedRelation[];
    hypothesisEdges: V8HypothesisEdge[];
    stats: {
        accepted: number;
        hypothesis: number;
        rejected: number;
        ignored: number;
    };
}

export interface FinalizeRelationReviewArtifactsInput {
    reviewedRelations: V8ReviewedRelation[];
    relationReviewJobs: V8RelationReviewJob[];
    relationSearchPlans: V8RelationSearchPlan[];
}

export interface FinalizeRelationReviewArtifactsOutput {
    relationReviewJobs: V8RelationReviewJob[];
    learningEvents: V8LearningEvent[];
    searchFeedbackSignals: V8SearchFeedbackSignal[];
    stats: {
        completedJobs: number;
        learningEvents: number;
        searchFeedbackSignals: number;
    };
}

const TRAJECTORY_EDGE_HINTS = new Set([
    "before",
    "after",
    "evolves_to",
    "state_supersedes_state",
    "state_refines_state",
    "state_changed_by_event",
    "valid_during",
    "valid_in_phase",
    "supersedes",
    "refines",
]);

export function applyReviewedRelationsToGraph(
    input: ApplyReviewedRelationsToGraphInput
): ApplyReviewedRelationsToGraphOutput {
    const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
    const normalizedReviewedRelations = normalizeReviewedRelations(
        input.reviewedRelations,
        nodeById
    );

    const edges = input.edges.map((edge) => ({
        ...edge,
        evidenceSpanIds: uniqueStrings(edge.evidenceSpanIds || []),
        sourceItemIds: uniqueStrings(edge.sourceItemIds || []),
        qualifiers: { ...(edge.qualifiers || {}) },
    }));
    const edgeIndexByKey = new Map<string, number>();
    for (let i = 0; i < edges.length; i += 1) {
        edgeIndexByKey.set(edgeKey(edges[i]!.src, edges[i]!.type, edges[i]!.dst), i);
    }

    const hypothesisByKey = new Map<string, V8HypothesisEdge>();
    for (const hypothesis of input.existingHypothesisEdges || []) {
        const normalized = normalizeHypothesisEdge(hypothesis);
        if (!normalized) continue;
        hypothesisByKey.set(
            edgeKey(normalized.src, normalized.suggestedType, normalized.dst),
            normalized
        );
    }

    const stats = {
        accepted: 0,
        hypothesis: 0,
        rejected: 0,
        ignored: 0,
    };

    for (const relation of normalizedReviewedRelations) {
        const key = edgeKey(relation.srcNodeId, relation.edgeType, relation.dstNodeId);
        if (relation.status === "accepted") {
            stats.accepted += 1;
            upsertAcceptedEdge({
                relation,
                nodeById,
                edges,
                edgeIndexByKey,
            });
            hypothesisByKey.delete(key);
            continue;
        }
        if (relation.status === "hypothesis") {
            stats.hypothesis += 1;
            upsertHypothesisEdge(relation, hypothesisByKey);
            continue;
        }
        if (relation.status === "rejected") {
            stats.rejected += 1;
            markHypothesisRejected(relation, hypothesisByKey);
            continue;
        }
        stats.ignored += 1;
    }

    const hypothesisEdges = Array.from(hypothesisByKey.values()).sort((a, b) =>
        a.id.localeCompare(b.id)
    );

    return {
        edges,
        reviewedRelations: normalizedReviewedRelations,
        hypothesisEdges,
        stats,
    };
}

export function finalizeRelationReviewArtifacts(
    input: FinalizeRelationReviewArtifactsInput
): FinalizeRelationReviewArtifactsOutput {
    const planById = new Map(input.relationSearchPlans.map((plan) => [plan.id, plan]));
    const reviewedByJobId = new Map<string, V8ReviewedRelation[]>();
    for (const relation of input.reviewedRelations) {
        const list = reviewedByJobId.get(relation.reviewJobId) || [];
        list.push(relation);
        reviewedByJobId.set(relation.reviewJobId, list);
    }

    const relationReviewJobs = input.relationReviewJobs.map((job) => {
        const reviewed = reviewedByJobId.get(job.id) || [];
        if (reviewed.length === 0) return job;
        if (job.status === "failed") return job;
        return {
            ...job,
            status: "completed" as const,
        };
    });

    const learningEvents: V8LearningEvent[] = [];
    for (const relation of input.reviewedRelations) {
        if (relation.status !== "accepted" && relation.status !== "rejected") continue;
        const isAccepted = relation.status === "accepted";
        learningEvents.push({
            id: `le_${shortHash(
                `${relation.id}|${relation.reviewJobId}|${relation.status}|${relation.createdAt}`
            )}`,
            subsystem: "fact",
            eventType: isAccepted ? "review_relation_accepted" : "review_relation_rejected",
            subjectIds: uniqueStrings([
                relation.reviewJobId,
                relation.srcNodeId,
                relation.dstNodeId,
            ]),
            polarity: isAccepted ? "positive" : "negative",
            features: {
                edgeType: relation.edgeType,
                confidence: relation.confidence,
                reviewStatus: relation.status,
            },
            createdAt: relation.createdAt,
        });
    }

    const searchFeedbackSignals: V8SearchFeedbackSignal[] = [];
    for (const job of relationReviewJobs) {
        const reviewed = reviewedByJobId.get(job.id) || [];
        if (reviewed.length === 0) continue;
        const accepted = reviewed.filter((item) => item.status === "accepted").length;
        const rejected = reviewed.filter((item) => item.status === "rejected").length;
        const outcome: V8SearchFeedbackSignal["outcome"] =
            accepted > 0 ? "confirmed" : rejected > 0 ? "rejected" : "ignored";
        const scoreDelta = accepted > 0 ? 0.12 : rejected > 0 ? -0.12 : 0;
        const latestTs = reviewed
            .map((item) => item.createdAt)
            .sort()
            .at(-1);
        const plan = planById.get(job.planId);
        searchFeedbackSignals.push({
            id: `sfs_${shortHash(`${job.id}|${outcome}|${latestTs || ""}`)}`,
            anchorNodeIds: uniqueStrings(job.anchorNodeIds || []),
            lane: plan?.lane || "focused",
            hintIds: uniqueStrings(job.candidateEdgeTypes || []).slice(0, 8),
            outcome,
            scoreDelta: round3(scoreDelta),
            createdAt: latestTs || new Date().toISOString(),
        });
    }

    const dedupLearning = dedupeById(learningEvents);
    const dedupSignals = dedupeById(searchFeedbackSignals);
    const completedJobs = relationReviewJobs.filter((job) => job.status === "completed").length;

    return {
        relationReviewJobs,
        learningEvents: dedupLearning,
        searchFeedbackSignals: dedupSignals,
        stats: {
            completedJobs,
            learningEvents: dedupLearning.length,
            searchFeedbackSignals: dedupSignals.length,
        },
    };
}

function normalizeReviewedRelations(
    raw: V8ReviewedRelation[],
    nodeById: Map<string, V8GraphNode>
): V8ReviewedRelation[] {
    const map = new Map<string, V8ReviewedRelation>();
    for (const entry of raw || []) {
        if (!entry || typeof entry !== "object") continue;
        const srcNodeId = String(entry.srcNodeId || "").trim();
        const dstNodeId = String(entry.dstNodeId || "").trim();
        if (!srcNodeId || !dstNodeId) continue;
        if (!nodeById.has(srcNodeId) || !nodeById.has(dstNodeId)) continue;
        const edgeType = String(entry.edgeType || "").trim();
        if (!edgeType) continue;
        const status =
            entry.status === "accepted" ||
            entry.status === "hypothesis" ||
            entry.status === "rejected"
                ? entry.status
                : null;
        if (!status) continue;

        const supportEvidenceSpanIds = uniqueStrings(entry.supportEvidenceSpanIds || []);
        const confidence = clamp01(typeof entry.confidence === "number" ? entry.confidence : 0.5);
        const createdAt = normalizeTimestamp(entry.createdAt);
        const reviewJobId = String(entry.reviewJobId || "manual").trim() || "manual";
        const id =
            String(entry.id || "").trim() ||
            `rr_${shortHash(
                `${reviewJobId}|${srcNodeId}|${edgeType}|${dstNodeId}|${createdAt}`
            )}`;

        map.set(id, {
            id,
            reviewJobId,
            srcNodeId,
            dstNodeId,
            edgeType,
            status,
            supportEvidenceSpanIds,
            confidence: round3(confidence),
            rationale: String(entry.rationale || "").trim().slice(0, 1200),
            createdAt,
        });
    }
    return Array.from(map.values()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
}

function normalizeHypothesisEdge(edge: V8HypothesisEdge): V8HypothesisEdge | null {
    if (!edge || typeof edge !== "object") return null;
    const id = String(edge.id || "").trim();
    const src = String(edge.src || "").trim();
    const dst = String(edge.dst || "").trim();
    const suggestedType = String(edge.suggestedType || "").trim();
    if (!id || !src || !dst || !suggestedType) return null;
    return {
        id,
        src,
        dst,
        suggestedType,
        modeHint: edge.modeHint === "trajectory" ? "trajectory" : "oblique",
        supportEvidenceSpanIds: uniqueStrings(edge.supportEvidenceSpanIds || []),
        inferenceTrace: String(edge.inferenceTrace || "").trim(),
        confidence: clamp01(typeof edge.confidence === "number" ? edge.confidence : 0.5),
        status:
            edge.status === "candidate" ||
            edge.status === "validated" ||
            edge.status === "rejected" ||
            edge.status === "expired"
                ? edge.status
                : "candidate",
        expiresAt: edge.expiresAt || null,
    };
}

function upsertAcceptedEdge(input: {
    relation: V8ReviewedRelation;
    nodeById: Map<string, V8GraphNode>;
    edges: V8GraphEdge[];
    edgeIndexByKey: Map<string, number>;
}): void {
    const key = edgeKey(input.relation.srcNodeId, input.relation.edgeType, input.relation.dstNodeId);
    const existingIndex = input.edgeIndexByKey.get(key);
    if (typeof existingIndex === "number") {
        const current = input.edges[existingIndex]!;
        const nextConfidence = Math.max(
            clamp01(current.confidence || 0),
            clamp01(input.relation.confidence || 0)
        );
        const reviewedRelationIds = readStringArrayQualifier(
            current.qualifiers,
            "reviewed_relation_ids"
        );
        const sourceItemIds = uniqueStrings([
            ...(current.sourceItemIds || []),
            `reviewed_relation:${input.relation.id}`,
        ]);
        input.edges[existingIndex] = {
            ...current,
            originType: current.originType === "asserted" ? "asserted" : "inferred",
            sourceItemIds,
            evidenceSpanIds: uniqueStrings([
                ...(current.evidenceSpanIds || []),
                ...(input.relation.supportEvidenceSpanIds || []),
            ]),
            qualifiers: {
                ...(current.qualifiers || {}),
                reviewed_relation_ids: uniqueStrings([
                    ...reviewedRelationIds,
                    input.relation.id,
                ]),
                review_job_id: input.relation.reviewJobId,
                review_status: "accepted",
            },
            confidence: round3(nextConfidence),
            state: {
                scope: current.state?.scope || "global",
                validity:
                    current.state?.validity === "superseded"
                        ? "active"
                        : current.state?.validity || "active",
            },
        };
        return;
    }

    const srcNode = input.nodeById.get(input.relation.srcNodeId);
    const dstNode = input.nodeById.get(input.relation.dstNodeId);
    const layer =
        srcNode && dstNode && srcNode.primaryLayer === dstNode.primaryLayer
            ? srcNode.primaryLayer
            : "cross";
    const edge: V8GraphEdge = {
        id: `edge_rev_${shortHash(
            `${input.relation.srcNodeId}|${input.relation.edgeType}|${input.relation.dstNodeId}`
        )}`,
        type: input.relation.edgeType as V8GraphEdge["type"],
        src: input.relation.srcNodeId,
        dst: input.relation.dstNodeId,
        layer,
        originType: "inferred",
        sourceItemIds: [`reviewed_relation:${input.relation.id}`],
        evidenceSpanIds: uniqueStrings(input.relation.supportEvidenceSpanIds || []),
        qualifiers: {
            reviewed_relation_ids: [input.relation.id],
            review_job_id: input.relation.reviewJobId,
            review_status: "accepted",
        },
        confidence: round3(clamp01(input.relation.confidence)),
        state: {
            scope: "global",
            validity: "active",
        },
    };
    input.edgeIndexByKey.set(key, input.edges.length);
    input.edges.push(edge);
}

function upsertHypothesisEdge(
    relation: V8ReviewedRelation,
    hypothesisByKey: Map<string, V8HypothesisEdge>
): void {
    const key = edgeKey(relation.srcNodeId, relation.edgeType, relation.dstNodeId);
    const existing = hypothesisByKey.get(key);
    const supportEvidenceSpanIds = uniqueStrings([
        ...(existing?.supportEvidenceSpanIds || []),
        ...(relation.supportEvidenceSpanIds || []),
    ]);
    const confidence = Math.max(
        clamp01(existing?.confidence ?? 0),
        clamp01(relation.confidence || 0)
    );
    hypothesisByKey.set(key, {
        id: existing?.id || `hrev_${shortHash(`${relation.id}|${key}`)}`,
        src: relation.srcNodeId,
        dst: relation.dstNodeId,
        suggestedType: relation.edgeType,
        modeHint: inferModeHint(relation.edgeType),
        supportEvidenceSpanIds,
        inferenceTrace:
            relation.rationale ||
            existing?.inferenceTrace ||
            `reviewed_relation:${relation.id}`,
        confidence: round3(confidence),
        status: "candidate",
        expiresAt: null,
    });
}

function markHypothesisRejected(
    relation: V8ReviewedRelation,
    hypothesisByKey: Map<string, V8HypothesisEdge>
): void {
    const key = edgeKey(relation.srcNodeId, relation.edgeType, relation.dstNodeId);
    const existing = hypothesisByKey.get(key);
    if (!existing) return;
    hypothesisByKey.set(key, {
        ...existing,
        status: "rejected",
        inferenceTrace:
            relation.rationale ||
            existing.inferenceTrace ||
            `reviewed_relation_rejected:${relation.id}`,
        supportEvidenceSpanIds: uniqueStrings([
            ...(existing.supportEvidenceSpanIds || []),
            ...(relation.supportEvidenceSpanIds || []),
        ]),
    });
}

function inferModeHint(edgeType: string): "oblique" | "trajectory" {
    const normalized = (edgeType || "").trim().toLowerCase();
    if (!normalized) return "oblique";
    if (normalized.includes("state_")) return "trajectory";
    if (TRAJECTORY_EDGE_HINTS.has(normalized)) return "trajectory";
    return "oblique";
}

function readStringArrayQualifier(
    qualifiers: Record<string, unknown> | undefined,
    key: string
): string[] {
    const value = qualifiers?.[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && !!item.trim());
}

function normalizeTimestamp(value: string | undefined): string {
    const raw = String(value || "").trim();
    if (!raw) return new Date().toISOString();
    const ts = Date.parse(raw);
    if (Number.isNaN(ts)) return new Date().toISOString();
    return new Date(ts).toISOString();
}

function dedupeById<T extends { id: string }>(records: T[]): T[] {
    const map = new Map<string, T>();
    for (const record of records) {
        map.set(record.id, record);
    }
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function uniqueStrings(values: string[]): string[] {
    return Array.from(
        new Set(values.map((value) => String(value || "").trim()).filter(Boolean))
    );
}

function edgeKey(src: string, type: string, dst: string): string {
    return `${src}::${type}::${dst}`;
}

function shortHash(text: string): string {
    return crypto
        .createHash("sha1")
        .update(text)
        .digest("hex")
        .slice(0, 12);
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
