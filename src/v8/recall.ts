import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../utils.js";
import { loadEdgeRuntimePolicy } from "./edge-runtime-policy.js";
import { v8StorePaths } from "./paths_v8.js";
import type {
    AssembleRecallInput,
    AssembleRecallOutput,
    V8ActivatedBundle,
    V8EvidenceSpan,
    V8EdgeCatalogEntry,
    V8EdgeRuntimePolicyEntry,
    V8GraphEdge,
    V8GraphNode,
    V8RecallMode,
    V8SourceRecord,
} from "./types_v8.js";

interface RecallAssemblyContext {
    nodesById: Map<string, V8GraphNode>;
    evidenceById: Map<string, V8EvidenceSpan>;
    sourcesById: Map<string, V8SourceRecord>;
    edges: V8GraphEdge[];
    edgesByNode: Map<string, V8GraphEdge[]>;
    edgeKinds: Map<string, V8EdgeCatalogEntry["kind"]>;
    policyByKindMode: Map<string, V8EdgeRuntimePolicyEntry>;
}

interface EdgeCatalogFile {
    edges?: Array<Partial<V8EdgeCatalogEntry> & { type?: string }>;
}

function edgeCatalogPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../schema/v8-edge-catalog.json");
}

function loadEdgeCatalog(): Map<string, V8EdgeCatalogEntry["kind"]> {
    const data = readJson<EdgeCatalogFile>(edgeCatalogPath(), { edges: [] });
    const entries = Array.isArray(data.edges) ? data.edges : [];
    const map = new Map<string, V8EdgeCatalogEntry["kind"]>();
    for (const entry of entries) {
        if (!entry?.type || !entry.kind) continue;
        map.set(entry.type, entry.kind as V8EdgeCatalogEntry["kind"]);
    }
    return map;
}

function policyKey(kind: string, mode: V8RecallMode): string {
    return `${kind}:${mode}`;
}

function buildPolicyMap(
    entries: V8EdgeRuntimePolicyEntry[]
): Map<string, V8EdgeRuntimePolicyEntry> {
    const map = new Map<string, V8EdgeRuntimePolicyEntry>();
    for (const entry of entries) {
        map.set(policyKey(entry.kind, entry.mode), entry);
    }
    return map;
}

function loadJsonl<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content
            .split(/\\r?\\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function sanitizeText(text: string, maxChars = 520): string {
    return (text || "")
        .replace(/<!--[\\s\\S]*?-->/g, " ")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function formatEvidence(span: V8EvidenceSpan, source?: V8SourceRecord): string {
    const speaker = source?.speaker || span.speaker || "unknown";
    const ts = source?.timestamp ? ` @ ${source.timestamp}` : "";
    const text = sanitizeText(span.text, 420);
    return `[${speaker}${ts}] ${text}`;
}

function resolveEvidenceSpanIds(
    bundle: V8ActivatedBundle,
    node: V8GraphNode
): string[] {
    if (bundle.evidenceSpanIds && bundle.evidenceSpanIds.length > 0) {
        return bundle.evidenceSpanIds;
    }
    if (node.bestEvidenceSpanIds && node.bestEvidenceSpanIds.length > 0) {
        return node.bestEvidenceSpanIds;
    }
    return node.evidenceSpanIds || [];
}

export function loadRecallAssemblyContext(workspace: string): RecallAssemblyContext {
    const store = v8StorePaths(workspace);
    const nodes = loadJsonl<V8GraphNode>(store.graphNodes);
    const evidence = loadJsonl<V8EvidenceSpan>(store.evidenceSpans);
    const sources = loadJsonl<V8SourceRecord>(store.sourceRecords);
    const edges = loadJsonl<V8GraphEdge>(store.graphEdges);

    const edgesByNode = new Map<string, V8GraphEdge[]>();
    for (const edge of edges) {
        if (!edgesByNode.has(edge.src)) edgesByNode.set(edge.src, []);
        if (!edgesByNode.has(edge.dst)) edgesByNode.set(edge.dst, []);
        edgesByNode.get(edge.src)!.push(edge);
        edgesByNode.get(edge.dst)!.push(edge);
    }

    const edgeKinds = loadEdgeCatalog();
    const policyByKindMode = buildPolicyMap(loadEdgeRuntimePolicy());

    return {
        nodesById: new Map(nodes.map((node) => [node.id, node])),
        evidenceById: new Map(evidence.map((span) => [span.id, span])),
        sourcesById: new Map(sources.map((src) => [src.id, src])),
        edges,
        edgesByNode,
        edgeKinds,
        policyByKindMode,
    };
}

export function assembleRecallPrompts(
    input: AssembleRecallInput,
    context: RecallAssemblyContext
): AssembleRecallOutput[] {
    const outputs: AssembleRecallOutput[] = [];
    const mode: V8RecallMode = input.mode || "profile";
    const isStructuralMode = mode === "trajectory" || mode === "audit";
    const maxEvidence = mode === "audit" ? 8 : mode === "trajectory" ? 6 : 4;

    for (const bundle of input.bundles) {
        const node = context.nodesById.get(bundle.bundleId);
        if (!node) continue;

        let evidenceSpanIds = resolveEvidenceSpanIds(bundle, node);
        if (isStructuralMode) {
            const structural = collectBacktraceEvidence(
                bundle.nodeIds.length > 0 ? bundle.nodeIds : [bundle.bundleId],
                mode,
                context
            );
            evidenceSpanIds = mergeUnique(evidenceSpanIds, structural);
        }
        const evidenceLines: string[] = [];
        const sourceRefs = new Set<string>();

        for (const spanId of evidenceSpanIds.slice(0, maxEvidence)) {
            const span = context.evidenceById.get(spanId);
            if (!span) continue;
            const source = context.sourcesById.get(span.sourceRecordId);
            if (source?.sourceRef) {
                sourceRefs.add(source.sourceRef);
            }
            evidenceLines.push(formatEvidence(span, source));
        }

        if (evidenceLines.length === 0) {
            continue;
        }

        const header = `<!-- Memory Recall (${bundle.tier}) -->`;
        const body = [
            `Topic: ${sanitizeText(node.canonicalLabel, 120)}`,
            `Evidence:`,
            ...evidenceLines.map((line) => `- ${line}`),
        ].join("\\n");

        const prompt = `${header}\\n${body}\\n<!-- End Memory Recall -->`;

        outputs.push({
            bundleId: bundle.bundleId,
            nodeIds: [node.id],
            tier: bundle.tier,
            prompt,
            sourceRefs: [...sourceRefs],
        });
    }

    return outputs;
}

function collectBacktraceEvidence(
    seedNodeIds: string[],
    mode: V8RecallMode,
    context: RecallAssemblyContext
): string[] {
    if (seedNodeIds.length === 0) return [];
    const maxDepth = mode === "audit" ? 4 : 3;
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [];
    const evidence = new Set<string>();

    for (const seed of seedNodeIds) {
        queue.push({ id: seed, depth: 0 });
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.id)) continue;
        visited.add(current.id);

        if (current.id.startsWith("es_")) {
            evidence.add(current.id);
            continue;
        }

        const node = context.nodesById.get(current.id);
        if (node) {
            for (const spanId of node.evidenceSpanIds || []) {
                evidence.add(spanId);
            }
        }

        const edges = context.edgesByNode.get(current.id) || [];
        for (const edge of edges) {
            for (const spanId of edge.evidenceSpanIds || []) {
                evidence.add(spanId);
            }

            const kind = context.edgeKinds.get(edge.type) || "semantic";
            const policy =
                context.policyByKindMode.get(policyKey(kind, mode));

            if (!policy || policy.role === "spread") {
                continue;
            }
            if (policy.role === "gate") {
                continue;
            }
            if (
                policy.role === "reweight" &&
                mode !== "trajectory" &&
                mode !== "audit"
            ) {
                continue;
            }

            const nextId = edge.src === current.id ? edge.dst : edge.src;
            if (nextId === current.id) continue;
            if (current.depth >= maxDepth) continue;
            queue.push({ id: nextId, depth: current.depth + 1 });
        }
    }

    return Array.from(evidence);
}

function mergeUnique(base: string[], extra: string[]): string[] {
    if (!extra.length) return base;
    const seen = new Set(base);
    for (const item of extra) {
        if (!seen.has(item)) {
            base.push(item);
            seen.add(item);
        }
    }
    return base;
}
