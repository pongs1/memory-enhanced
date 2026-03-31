import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../../utils.js";
import { collectNodeSpanIdsFromItems } from "../node-evidence.js";
import type {
    V8EdgeCatalogEntry,
    V8EvidenceSpan,
    V8GraphEdge,
    V8GraphNode,
    V8IgnitionEdgeProjection,
    V8IgnitionNodeProjection,
    V8MemoryItem,
    V8RecallBundleProjection,
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
    const MAX_CJK_NGRAMS = 320;

    for (const chunk of cjkChunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        if (trimmed.length <= 4) {
            cjkNgrams.push(trimmed);
            continue;
        }

        const stride = trimmed.length > 40 ? 2 : 1;
        for (let size = 2; size <= Math.min(4, trimmed.length); size++) {
            for (let i = 0; i <= trimmed.length - size; i += stride) {
                cjkNgrams.push(trimmed.slice(i, i + size));
                if (cjkNgrams.length >= MAX_CJK_NGRAMS) {
                    break;
                }
            }
            if (cjkNgrams.length >= MAX_CJK_NGRAMS) {
                break;
            }
        }
        if (cjkNgrams.length >= MAX_CJK_NGRAMS) {
            break;
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
    spanById: Map<string, V8EvidenceSpan>
): { kind: "episodic" | "semantic" | "procedural"; dayKey: string | null } {
    let hasProcedural = false;
    let hasCurated = false;
    let latestDayKey: string | null = null;
    let latestTs = 0;

    for (const spanId of spanIds) {
        const span = spanById.get(spanId);
        if (!span) continue;
        if (span.sourceType === "skill_md") {
            hasProcedural = true;
        }
        if (span.sourceClass === "curated") {
            hasCurated = true;
        }
        const ts = span.timestamp ? Date.parse(span.timestamp) : NaN;
        if (!Number.isNaN(ts) && ts >= latestTs) {
            latestTs = ts;
            latestDayKey = toDayKey(span.timestamp);
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
    spanById: Map<string, V8EvidenceSpan>
): string | null {
    for (const spanId of spanIds) {
        const span = spanById.get(spanId);
        if (!span) continue;
        if (span.narrativeRef) return span.narrativeRef;
    }
    return null;
}

function isStateMemoryType(memoryType: string): boolean {
    return (
        memoryType.endsWith("_state") ||
        memoryType === "session_state" ||
        memoryType === "topic_state"
    );
}

function isProjectionCandidate(
    node: V8GraphNode,
    allowDiscourseUnitFallback: boolean
): boolean {
    if (node.memoryType === "evidence") return false;
    if (node.primaryLayer !== "micro") return false;
    if (node.id.startsWith("node_edge_")) {
        if (!isStateMemoryType(node.memoryType)) {
            return false;
        }
    }
    if (node.memoryType === "discourse_unit") {
        return allowDiscourseUnitFallback;
    }
    return true;
}

function resolvePackType(
    memoryType: string
): V8RecallBundleProjection["packType"] {
    if (isStateMemoryType(memoryType)) return "state";
    return "raw_evidence";
}

export function buildRuntimeProjections(input: {
    nodes: V8GraphNode[];
    edges: V8GraphEdge[];
    evidenceSpans: V8EvidenceSpan[];
    memoryItems?: V8MemoryItem[];
}): {
    ignitionNodes: V8IgnitionNodeProjection[];
    ignitionEdges: V8IgnitionEdgeProjection[];
    recallBundles: V8RecallBundleProjection[];
} {
    const spanById = new Map(input.evidenceSpans.map((span) => [span.id, span]));
    const itemsById = new Map((input.memoryItems || []).map((item) => [item.id, item]));
    const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
    const edgeKinds = loadEdgeCatalog();

    const ignitionNodes: V8IgnitionNodeProjection[] = [];
    const recallBundles: V8RecallBundleProjection[] = [];
    const candidates: Array<{
        node: V8GraphNode;
        kind: "episodic" | "semantic" | "procedural";
        dayKey: string | null;
        anchorUnitId: string | null;
        sourceRef: string | null;
        label: string;
        aliases: string[];
        triggerTerms: string[];
        searchText: string;
        packType: V8RecallBundleProjection["packType"];
    }> = [];
    const candidateNodes = input.nodes.filter((node) => isProjectionCandidate(node, false));
    const effectiveCandidateNodes =
        candidateNodes.length > 0
            ? candidateNodes
            : input.nodes.filter((node) => isProjectionCandidate(node, true));

    for (const node of effectiveCandidateNodes) {

        const spanIds = collectNodeSpanIdsFromItems(node, itemsById);
        const bestSpanIds =
            node.bestEvidenceSpanIds && node.bestEvidenceSpanIds.length > 0
                ? node.bestEvidenceSpanIds
                : spanIds.slice(0, 1);
        const { kind, dayKey } = classifyKind(spanIds, spanById);
        const anchorUnitId = resolveAnchorUnitId(node, spanById, itemsById);
        const sourceRef = resolveSourceRef(spanIds, spanById);
        const label = node.canonicalLabel || "";
        const aliases = node.aliases || [];
        const triggerTerms = unique(tokenize([label, ...aliases].join(" ")));
        const searchText = unique([label, ...aliases]).join(" ");
        candidates.push({
            node,
            kind,
            dayKey: dayKey ?? null,
            anchorUnitId,
            sourceRef,
            label,
            aliases,
            triggerTerms,
            searchText,
            packType: resolvePackType(node.memoryType),
        });
    }

    const microBundleIdByNodeId = new Map<string, string>();
    const candidatesByMicroBundle = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
        const bundleId = candidate.anchorUnitId || `compat_${candidate.node.id}`;

        microBundleIdByNodeId.set(candidate.node.id, bundleId);
        const list = candidatesByMicroBundle.get(bundleId) || [];
        list.push(candidate);
        candidatesByMicroBundle.set(bundleId, list);
    }

    const groupedBundles = buildBundlesFromCandidates(candidates, input.edges, edgeKinds, spanById, itemsById);
    const groupBundleIdsByNode = new Map<string, string[]>();
    for (const bundle of groupedBundles) {
        for (const nodeId of bundle.nodeIds) {
            const list = groupBundleIdsByNode.get(nodeId) || [];
            list.push(bundle.bundleId);
            groupBundleIdsByNode.set(nodeId, list);
        }
    }
    for (const [bundleId, bundleCandidates] of candidatesByMicroBundle.entries()) {
        const sorted = bundleCandidates
            .slice()
            .sort((a, b) => b.node.state.confidence - a.node.state.confidence);
        const nodeIds = sorted.map((item) => item.node.id);
        const stateLine = summarizeStateLine(nodeIds, nodeById, input.edges);
        const labelTop = sorted.map((item) => item.label).filter(Boolean).slice(0, 3);
        const title = stateLine?.title || labelTop[0] || bundleId;
        const summaryText = stateLine?.summaryText || unique(labelTop).join(" | ") || title;
        const sourceRefs = unique(sorted.map((item) => item.sourceRef || "").filter(Boolean));
        const evidenceSpanIds = unique(
            sorted.flatMap((item) => collectNodeSpanIdsFromItems(item.node, itemsById))
        ).slice(0, 80);
        const bestEvidenceSpanIds = selectBestSpans(evidenceSpanIds, spanById, 8);
        recallBundles.push({
            bundleId,
            title,
            kind: resolveBundleKind(sorted.map((item) => item.kind)),
            nodeIds,
            sourceRefs,
            evidenceSpanIds,
            bestEvidenceSpanIds,
            summaryText,
            packType: stateLine ? "state" : resolveBundlePackType(sorted.map((item) => item.packType)),
        });
    }
    for (const bundle of groupedBundles) {
        recallBundles.push({
            bundleId: bundle.bundleId,
            title: bundle.title,
            kind: bundle.kind,
            nodeIds: bundle.nodeIds,
            sourceRefs: bundle.sourceRefs,
            evidenceSpanIds: bundle.evidenceSpanIds,
            bestEvidenceSpanIds: bundle.bestEvidenceSpanIds,
            summaryText: bundle.summaryText,
            packType: bundle.packType,
        });
    }

    for (const candidate of candidates) {
        const primaryBundleId =
            microBundleIdByNodeId.get(candidate.node.id) || `compat_${candidate.node.id}`;
        const linkedGroupIds = (groupBundleIdsByNode.get(candidate.node.id) || []).slice(0, 4);
        const bundleIds = unique([primaryBundleId, ...linkedGroupIds]);
        const bestEvidenceSpanIds = Array.isArray(candidate.node.bestEvidenceSpanIds)
            ? candidate.node.bestEvidenceSpanIds
            : [];
        ignitionNodes.push({
            nodeId: candidate.node.id,
            bundleId: primaryBundleId,
            bundleIds,
            kind: candidate.kind,
            names: {
                zh: candidate.label,
                en: candidate.label,
            },
            aliases: candidate.aliases,
            triggerTerms: candidate.triggerTerms,
            summary: candidate.label,
            searchText: candidate.searchText,
            sourceRef: candidate.sourceRef,
            evidenceSpanIds: collectNodeSpanIdsFromItems(candidate.node, itemsById),
            bestEvidenceSpanIds:
                bestEvidenceSpanIds.length > 0
                    ? bestEvidenceSpanIds
                    : collectNodeSpanIdsFromItems(candidate.node, itemsById).slice(0, 1),
            dayKey: candidate.dayKey,
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

function resolveAnchorUnitId(
    node: V8GraphNode,
    spanById: Map<string, V8EvidenceSpan>,
    itemsById: Map<string, V8MemoryItem>
): string | null {
    const spanOrder = [
        ...(node.bestEvidenceSpanIds || []),
        ...collectNodeSpanIdsFromItems(node, itemsById),
    ];
    for (const spanId of spanOrder) {
        const span = spanById.get(spanId);
        if (!span?.unitId) continue;
        return span.unitId;
    }
    return null;
}

function buildBundlesFromCandidates(
    candidates: Array<{
        node: V8GraphNode;
        kind: "episodic" | "semantic" | "procedural";
        dayKey: string | null;
        sourceRef: string | null;
        label: string;
        aliases: string[];
        triggerTerms: string[];
        searchText: string;
        packType: V8RecallBundleProjection["packType"];
    }>,
    edges: V8GraphEdge[],
    edgeKinds: Map<string, V8EdgeCatalogEntry["kind"]>,
    spanById: Map<string, V8EvidenceSpan>,
    itemsById: Map<string, V8MemoryItem>
): Array<{
    bundleId: string;
    title: string;
    summaryText: string;
    kind: "episodic" | "semantic" | "procedural";
    packType: V8RecallBundleProjection["packType"];
    nodeIds: string[];
    sourceRefs: string[];
    evidenceSpanIds: string[];
    bestEvidenceSpanIds: string[];
}> {
    if (candidates.length === 0) return [];

    const candidateById = new Map(candidates.map((item) => [item.node.id, item]));
    const adjacency = new Map<string, Set<string>>();
    for (const item of candidates) {
        adjacency.set(item.node.id, new Set());
    }

    for (const edge of edges) {
        if (!candidateById.has(edge.src) || !candidateById.has(edge.dst)) continue;
        const kind = edgeKinds.get(edge.type) || "semantic";
        // Ignore strictly anchoring/containment links for topic bundling.
        if (kind === "evidence_anchor" || kind === "containment") continue;
        adjacency.get(edge.src)?.add(edge.dst);
        adjacency.get(edge.dst)?.add(edge.src);
    }

    const visited = new Set<string>();
    const components: string[][] = [];
    for (const id of adjacency.keys()) {
        if (visited.has(id)) continue;
        const stack = [id];
        const component: string[] = [];
        visited.add(id);
        while (stack.length > 0) {
            const current = stack.pop()!;
            component.push(current);
            for (const next of adjacency.get(current) || []) {
                if (visited.has(next)) continue;
                visited.add(next);
                stack.push(next);
            }
        }
        components.push(component);
    }

    const bundles: Array<{
        bundleId: string;
        title: string;
        summaryText: string;
        kind: "episodic" | "semantic" | "procedural";
        packType: V8RecallBundleProjection["packType"];
        nodeIds: string[];
        sourceRefs: string[];
        evidenceSpanIds: string[];
        bestEvidenceSpanIds: string[];
    }> = [];

    let bundleSeq = 0;
    for (const component of components) {
        const componentNodes = component
            .map((id) => candidateById.get(id))
            .filter(Boolean) as typeof candidates;
        const dayBuckets = splitComponentByDay(componentNodes);
        for (const bucket of dayBuckets) {
            if (bucket.length === 0) continue;
            bundleSeq += 1;
            const sorted = bucket
                .slice()
                .sort((a, b) => b.node.state.confidence - a.node.state.confidence);
            const nodeIds = sorted.map((item) => item.node.id);
            const stateLine = summarizeStateLine(nodeIds, candidateById, edges);
            const labelTop = sorted.slice(0, 3).map((item) => item.label).filter(Boolean);
            const title = stateLine?.title || labelTop[0] || `bundle_${bundleSeq}`;
            const summaryText = stateLine?.summaryText || unique(labelTop).join(" | ") || title;
            const sourceRefs = unique(
                sorted
                    .map((item) => item.sourceRef || "")
                    .filter(Boolean)
            );
            const evidenceSpanIds = unique(
                sorted.flatMap((item) => collectNodeSpanIdsFromItems(item.node, itemsById))
            );
            const bestEvidenceSpanIds = selectBestSpans(evidenceSpanIds, spanById, 8);
            bundles.push({
                bundleId: `group_${bundleSeq}`,
                title,
                summaryText,
                kind: resolveBundleKind(sorted.map((item) => item.kind)),
                packType: stateLine ? "state" : resolveGroupPackType(sorted.map((item) => item.packType)),
                nodeIds,
                sourceRefs,
                evidenceSpanIds: evidenceSpanIds.slice(0, 80),
                bestEvidenceSpanIds,
            });
        }
    }

    return bundles;
}

function splitComponentByDay<T extends { dayKey: string | null }>(
    nodes: T[]
): T[][] {
    if (nodes.length <= 10) return [nodes];
    const dated = nodes.filter((item) => !!item.dayKey);
    const undated = nodes.filter((item) => !item.dayKey);
    if (dated.length === 0) return [nodes];
    const byDay = new Map<string, T[]>();
    for (const item of dated) {
        const key = item.dayKey!;
        const list = byDay.get(key) || [];
        list.push(item);
        byDay.set(key, list);
    }
    const result = Array.from(byDay.values()) as T[][];
    if (result.length <= 1) return [nodes];
    const largest = result.reduce((max, bucket) => Math.max(max, bucket.length), 0);
    // Keep cross-day continuity when one dominant thread spans most nodes.
    if (largest / nodes.length >= 0.75) return [nodes];
    if (undated.length > 0) {
        if (result.length === 0) {
            result.push(undated);
        } else {
            // Attach undated nodes to the largest day bucket.
            result.sort((a, b) => b.length - a.length);
            result[0]!.push(...undated);
        }
    }
    return result;
}

function resolveBundleKind(
    kinds: Array<"episodic" | "semantic" | "procedural">
): "episodic" | "semantic" | "procedural" {
    if (kinds.includes("procedural")) return "procedural";
    if (kinds.includes("semantic")) return "semantic";
    return "episodic";
}

function resolveBundlePackType(
    types: Array<V8RecallBundleProjection["packType"]>
): V8RecallBundleProjection["packType"] {
    const uniq = new Set(types);
    if (uniq.size === 1) return types[0] || "raw_evidence";
    if (uniq.has("state")) return "state";
    if (uniq.has("summary")) return "summary";
    return "mixed";
}

function resolveGroupPackType(
    types: Array<V8RecallBundleProjection["packType"]>
): V8RecallBundleProjection["packType"] {
    // Group bundles are for high-level recall injection; default to summary/state packs.
    const uniq = new Set(types);
    if (uniq.has("state")) return "state";
    return "summary";
}

function selectBestSpans(
    spanIds: string[],
    spanById: Map<string, V8EvidenceSpan>,
    limit: number
): string[] {
    return spanIds
        .map((id) => spanById.get(id))
        .filter(Boolean)
        .sort((a, b) => (b?.score || 0) - (a?.score || 0))
        .slice(0, limit)
        .map((span) => span!.id);
}

function summarizeStateLine(
    nodeIds: string[],
    nodeLookup:
        | Map<string, V8GraphNode>
        | Map<string, { node: V8GraphNode }>,
    edges: V8GraphEdge[]
): { title: string; summaryText: string } | null {
    const nodeIdSet = new Set(nodeIds);
    const supersedeEdges: V8GraphEdge[] = [];
    let changingEdge: V8GraphEdge | null = null;
    for (const edge of edges) {
        if (!nodeIdSet.has(edge.src) || !nodeIdSet.has(edge.dst)) continue;
        if (edge.type === "state_supersedes_state") {
            supersedeEdges.push(edge);
        }
        if (edge.type === "state_changed_by_event" && !changingEdge) {
            changingEdge = edge;
        }
    }
    const supersedeEdge = supersedeEdges
        .slice()
        .sort((left, right) => {
            const leftNode = resolveStateLineNode(nodeLookup, left.src);
            const rightNode = resolveStateLineNode(nodeLookup, right.src);
            const leftActive = leftNode?.state.validity === "active" ? 1 : 0;
            const rightActive = rightNode?.state.validity === "active" ? 1 : 0;
            return rightActive - leftActive;
        })[0] || null;
    if (!supersedeEdge) return null;

    const supersedeBySrc = new Map<string, V8GraphEdge>();
    for (const edge of supersedeEdges) {
        if (!supersedeBySrc.has(edge.src)) supersedeBySrc.set(edge.src, edge);
    }

    const currentNode = resolveStateLineNode(nodeLookup, supersedeEdge.src);
    let previousNode = resolveStateLineNode(nodeLookup, supersedeEdge.dst);
    const middleNodes: V8GraphNode[] = [];
    let cursor = previousNode ? supersedeBySrc.get(previousNode.id) || null : null;
    const visited = new Set<string>([
        currentNode?.id || "",
        previousNode?.id || "",
    ]);
    while (cursor) {
        const ancestor = resolveStateLineNode(nodeLookup, cursor.dst);
        if (!ancestor || visited.has(ancestor.id)) break;
        if (previousNode) {
            middleNodes.push(previousNode);
        }
        previousNode = ancestor;
        visited.add(ancestor.id);
        cursor = supersedeBySrc.get(ancestor.id) || null;
    }
    if (!currentNode || !previousNode) return null;
    const eventNode = changingEdge ? resolveStateLineNode(nodeLookup, changingEdge.dst) : null;
    const currentSummary = toStateClause(currentNode, "current");
    const previousSummary = toStateClause(previousNode, "previous");
    const title = readableStateLabel(currentNode) || readableStateLabel(previousNode);
    const middleSummary =
        middleNodes.length > 0
            ? `via ${middleNodes
                  .slice(0, 2)
                  .map((node) => toStateClause(node, "intermediate"))
                  .join(" -> ")}`
            : "";
    const clauses = [
        currentSummary,
        previousSummary ? `replaces ${previousSummary}` : "",
        middleSummary,
        eventNode?.canonicalLabel ? `changed by ${readableStateLabel(eventNode)}` : "",
    ].filter(Boolean);
    return {
        title,
        summaryText: clauses.join("; "),
    };
}

function resolveStateLineNode(
    nodeLookup:
        | Map<string, V8GraphNode>
        | Map<string, { node: V8GraphNode }>,
    nodeId: string
): V8GraphNode | null {
    const value = nodeLookup.get(nodeId);
    if (!value) return null;
    if ("canonicalLabel" in value) return value;
    return value.node || null;
}

function readableStateLabel(node: V8GraphNode): string {
    const raw = String(node.canonicalLabel || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    const statuses = [
        "current",
        "latest",
        "now",
        "final",
        "earlier",
        "previous",
        "original",
        "initial",
        "former",
        "derived",
    ];
    const kinds = ["relationship:", "state:"];
    for (const status of statuses) {
        for (const kind of kinds) {
            const prefix = `${status} ${kind}`;
            if (lower.startsWith(prefix)) {
                return raw.slice(prefix.length).trim();
            }
        }
    }
    return raw;
}

function toStateClause(
    node: V8GraphNode,
    flavor: "current" | "previous" | "intermediate"
): string {
    const label = readableStateLabel(node);
    if (!label) return "";
    if (node.memoryType === "relationship_state") {
        if (flavor === "current") return `relationship now: ${label}`;
        if (flavor === "intermediate") return `relationship: ${label}`;
        return `relationship: ${label}`;
    }
    if (flavor === "current") return `state now: ${label}`;
    if (flavor === "intermediate") return `state: ${label}`;
    return `state: ${label}`;
}
