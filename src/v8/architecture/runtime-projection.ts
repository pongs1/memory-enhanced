import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../../utils.js";
import type {
    V8EdgeCatalogEntry,
    V8EvidenceSpan,
    V8GraphEdge,
    V8GraphNode,
    V8IgnitionEdgeProjection,
    V8IgnitionNodeProjection,
    V8RecallBundleProjection,
    V8NarrativeRecord,
} from "../types_v8.js";

interface EdgeCatalogFile {
    edges?: Array<Partial<V8EdgeCatalogEntry> & { type?: string }>;
}

function edgeCatalogPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../schema/v8-edge-catalog.json");
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

function tokenize(text: string): string[] {
    const englishWords = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const cjkNgrams: string[] = [];

    for (const chunk of cjkChunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        if (trimmed.length <= 4) {
            cjkNgrams.push(trimmed);
            continue;
        }

        for (let size = 2; size <= Math.min(4, trimmed.length); size++) {
            for (let i = 0; i <= trimmed.length - size; i++) {
                cjkNgrams.push(trimmed.slice(i, i + size));
            }
        }
    }

    return [...englishWords, ...cjkNgrams];
}

function unique(items: string[]): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        output.push(trimmed);
    }
    return output;
}

function toDayKey(timestamp: string | null): string | null {
    if (!timestamp) return null;
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
}

function classifyKind(
    spanIds: string[],
    spanById: Map<string, V8EvidenceSpan>,
    sourceById: Map<string, V8NarrativeRecord>
): { kind: "episodic" | "semantic" | "procedural"; dayKey: string | null } {
    let hasProcedural = false;
    let hasCurated = false;
    let latestDayKey: string | null = null;
    let latestTs = 0;

    for (const spanId of spanIds) {
        const span = spanById.get(spanId);
        if (!span) continue;
        const source = sourceById.get(span.narrativeRecordId);
        if (!source) continue;
        if (source.sourceType === "skill_md") {
            hasProcedural = true;
        }
        if (source.sourceClass === "curated") {
            hasCurated = true;
        }
        const ts = source.timestamp ? Date.parse(source.timestamp) : NaN;
        if (!Number.isNaN(ts) && ts >= latestTs) {
            latestTs = ts;
            latestDayKey = toDayKey(source.timestamp);
        }
    }

    if (hasProcedural) {
        return { kind: "procedural", dayKey: latestDayKey };
    }
    if (hasCurated) {
        return { kind: "semantic", dayKey: latestDayKey };
    }
    return { kind: "episodic", dayKey: latestDayKey };
}

function resolveSourceRef(
    spanIds: string[],
    spanById: Map<string, V8EvidenceSpan>,
    sourceById: Map<string, V8NarrativeRecord>
): string | null {
    for (const spanId of spanIds) {
        const span = spanById.get(spanId);
        if (!span) continue;
        const source = sourceById.get(span.narrativeRecordId);
        if (source?.sourceRef) return source.sourceRef;
    }
    return null;
}

const CONTROL_MEMORY_TYPES = new Set([
    "preference",
    "goal",
    "constraint",
    "decision",
    "open_question",
    "conversation_act",
]);

function isStateMemoryType(memoryType: string): boolean {
    return (
        memoryType.endsWith("_state") ||
        memoryType === "session_state" ||
        memoryType === "topic_state"
    );
}

function isControlMemoryType(memoryType: string): boolean {
    return CONTROL_MEMORY_TYPES.has(memoryType);
}

function resolvePackType(
    memoryType: string
): V8RecallBundleProjection["packType"] {
    if (isStateMemoryType(memoryType)) return "state";
    if (isControlMemoryType(memoryType)) return "summary";
    return "raw_evidence";
}

export function buildRuntimeProjections(input: {
    nodes: V8GraphNode[];
    edges: V8GraphEdge[];
    evidenceSpans: V8EvidenceSpan[];
    sources: V8NarrativeRecord[];
}): {
    ignitionNodes: V8IgnitionNodeProjection[];
    ignitionEdges: V8IgnitionEdgeProjection[];
    recallBundles: V8RecallBundleProjection[];
} {
    const spanById = new Map(input.evidenceSpans.map((span) => [span.id, span]));
    const sourceById = new Map(input.sources.map((source) => [source.id, source]));
    const edgeKinds = loadEdgeCatalog();

    const ignitionNodes: V8IgnitionNodeProjection[] = [];
    const recallBundles: V8RecallBundleProjection[] = [];

    for (const node of input.nodes) {
        if (node.memoryType === "evidence") continue;
        if (node.memoryType === "discourse_unit") continue;
        if (node.primaryLayer !== "micro") continue;
        if (node.id.startsWith("node_edge_")) {
            if (!isControlMemoryType(node.memoryType) && !isStateMemoryType(node.memoryType)) {
                continue;
            }
        }

        const spanIds = node.evidenceSpanIds || [];
        const bestSpanIds = node.bestEvidenceSpanIds || [];
        const { kind, dayKey } = classifyKind(spanIds, spanById, sourceById);
        const sourceRef = resolveSourceRef(spanIds, spanById, sourceById);
        const label = node.canonicalLabel || "";
        const aliases = node.aliases || [];
        const triggerTerms = unique(tokenize([label, ...aliases].join(" ")));
        const searchText = unique([label, ...aliases]).join(" ");
        const names = {
            zh: label,
            en: label,
        };

        ignitionNodes.push({
            nodeId: node.id,
            bundleId: node.id,
            kind,
            names,
            aliases,
            triggerTerms,
            summary: label,
            searchText,
            sourceRef,
            evidenceSpanIds: spanIds,
            bestEvidenceSpanIds: bestSpanIds.length > 0 ? bestSpanIds : spanIds.slice(0, 1),
            dayKey: dayKey ?? null,
        });

        recallBundles.push({
            bundleId: node.id,
            title: label,
            kind,
            nodeIds: [node.id],
            sourceRefs: sourceRef ? [sourceRef] : [],
            evidenceSpanIds: spanIds,
            bestEvidenceSpanIds: bestSpanIds.length > 0 ? bestSpanIds : spanIds.slice(0, 1),
            summaryText: label,
            packType: resolvePackType(node.memoryType),
        });
    }

    const ignitionEdges: V8IgnitionEdgeProjection[] = input.edges.map((edge) => {
        const kind = edgeKinds.get(edge.type) || "semantic";
        const family =
            kind === "change"
                ? "supersession"
                : kind === "semantic" || kind === "discourse"
                  ? "associative"
                  : "structural";
        return {
            edgeId: edge.id,
            type: edge.type,
            srcNodeId: edge.src,
            dstNodeId: edge.dst,
            family,
            score: edge.confidence ?? 0.6,
        };
    });

    return {
        ignitionNodes,
        ignitionEdges,
        recallBundles,
    };
}
