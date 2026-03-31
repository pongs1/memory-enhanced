import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../utils.js";
import { dimensionWeight, edgeDirectionDimension, familyWeight, policyDirectionForDimension, scopeGate, trajectoryAffinity } from "./geometry-runtime.js";
import { getNodeFeedbackBias, refreshFeedbackStore } from "./feedback-store.js";
import { loadHypothesisEdges } from "./hypothesis-store.js";
import { resolveUnitBundles } from "./unit-bundle-resolver.js";
import { collectNodeSpanIdsFromItems } from "./node-evidence.js";
import { v8StorePaths } from "./paths_v8.js";
import type {
    V8ActivatedBundle,
    V8ControlAnchors,
    V8EdgeCatalogEntry,
    V8EvidenceSpan,
    V8GraphEdge,
    V8GraphNode,
    V8HypothesisEdge,
    V8IgnitionEdgeProjection,
    V8IgnitionNodeProjection,
    V8MemoryItem,
    V8RecallBias,
    V8RecallMode,
    V8Unit,
    V8PropagationDimension,
    V8RecallBundleProjection,
    V8ScanResult,
    V8ScannerConfig,
    V8SceneSignal,
} from "./types_v8.js";

interface EdgeCatalogFile {
    edges?: Array<Partial<V8EdgeCatalogEntry> & { type?: string }>;
}

interface LoadedGraphData {
    nodesById: Map<string, V8GraphNode>;
    ignitionNodesById: Map<string, V8IgnitionNodeProjection> | null;
    edges: V8GraphEdge[];
    adjacency: Map<string, V8GraphEdge[]>;
    reverseAdjacency: Map<string, V8GraphEdge[]>;
    nodeTokens: Map<string, Set<string>>;
    degree: Map<string, number>;
    scopeAnchorsByNode: Map<string, string[]>;
    scopeNodes: Set<string>;
    nodeKinds: Map<string, "episodic" | "semantic" | "procedural">;
    nodeDayKeys: Map<string, Set<string>>;
    edgeKinds: Map<string, V8EdgeCatalogEntry["kind"]>;
    groupBundles: V8RecallBundleProjection[];
    groupBundleById: Map<string, V8RecallBundleProjection>;
    groupBundleIrTokens: Map<string, Set<string>>;
    hypothesisEdges: V8HypothesisEdge[];
    itemsById: Map<string, V8MemoryItem>;
    unitsById: Map<string, V8Unit>;
    tokenWeights: Map<string, number>;
}

interface RuntimeEdge {
    edge: V8GraphEdge;
    weight: number;
    forwardDirection: "up" | "down" | "bidirectional" | "none";
    reverseDirection: "up" | "down" | "bidirectional" | "none";
    forwardDimension: V8PropagationDimension;
    reverseDimension: V8PropagationDimension;
}

interface ReweightEdge {
    edge: V8GraphEdge;
}

function loadJsonl<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
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

function overlapScore(tokens: Set<string>, referenceTokens: Set<string>): number {
    if (tokens.size === 0 || referenceTokens.size === 0) {
        return 0;
    }

    let matches = 0;
    for (const token of referenceTokens) {
        if (tokens.has(token)) {
            matches += 1;
        }
    }
    return matches / referenceTokens.size;
}

function symmetricOverlapScore(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) return 0;
    const lr = overlapScore(left, right);
    const rl = overlapScore(right, left);
    return (lr + rl) / 2;
}

function buildTokenWeights(tokenSets: Iterable<Set<string>>): Map<string, number> {
    const documentFrequency = new Map<string, number>();
    let totalDocs = 0;
    for (const tokens of tokenSets) {
        if (!tokens || tokens.size === 0) continue;
        totalDocs += 1;
        for (const token of tokens) {
            documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
        }
    }

    const weights = new Map<string, number>();
    for (const [token, df] of documentFrequency.entries()) {
        const rarity = Math.log((totalDocs + 1) / (df + 0.5));
        weights.set(token, Math.max(0.2, rarity));
    }
    return weights;
}

function tokenWeight(token: string, weights: Map<string, number>): number {
    return weights.get(token) || 1;
}

function weightedOverlapScore(
    tokens: Set<string>,
    referenceTokens: Set<string>,
    weights: Map<string, number>
): number {
    if (tokens.size === 0 || referenceTokens.size === 0) {
        return 0;
    }

    let matchedWeight = 0;
    let totalWeight = 0;
    for (const token of referenceTokens) {
        const weight = tokenWeight(token, weights);
        totalWeight += weight;
        if (tokens.has(token)) {
            matchedWeight += weight;
        }
    }
    if (totalWeight <= 0) {
        return 0;
    }
    return matchedWeight / totalWeight;
}

function weightedSymmetricOverlapScore(
    left: Set<string>,
    right: Set<string>,
    weights: Map<string, number>
): number {
    if (left.size === 0 || right.size === 0) {
        return 0;
    }
    const lr = weightedOverlapScore(left, right, weights);
    const rl = weightedOverlapScore(right, left, weights);
    return (lr + rl) / 2;
}

function nowMs(): number {
    return Date.now();
}

function fileMtimeMs(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
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
        if (!entry?.type || !entry.kind) {
            continue;
        }
        map.set(entry.type, entry.kind as V8EdgeCatalogEntry["kind"]);
    }
    return map;
}

function normalizeRecallBias(value: V8RecallBias | V8RecallMode): V8RecallBias {
    if (value === "trajectory" || value === "audit" || value === "historical_trace") {
        return "historical_trace";
    }
    return "current_state";
}

function toDayKey(timestamp: string): string | null {
    if (!timestamp) return null;
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
}

function scoreTier(energy: number, config: V8ScannerConfig): V8ActivatedBundle["tier"] | null {
    if (energy >= config.criticalThreshold) return "critical";
    if (energy >= config.decisionThreshold) return "decision";
    if (energy >= config.backgroundThreshold) return "background";
    return null;
}

function lastTrajectoryIsRepeatedSemantic(
    recentTrajectory: V8PropagationDimension[],
    candidate: V8PropagationDimension
): boolean {
    if (candidate !== "H") return false;
    const last = recentTrajectory[recentTrajectory.length - 1];
    const secondLast = recentTrajectory[recentTrajectory.length - 2];
    return last === "H" && secondLast === "H";
}

export const DEFAULT_V8_SCANNER_CONFIG: V8ScannerConfig = {
    microCharsZh: 20,
    microCharsEn: 40,
    mesoCharsZh: 96,
    mesoCharsEn: 144,
    macroCharsZh: 256,
    macroCharsEn: 384,
    scanIntervalChars: 24,
    maxInjectedBundles: 2,
    forwardGain: 0.3,
    reverseGain: 0.15,
    decayLambda: 0.95,
    hubPenaltyPower: 0.5,
    topKEdges: 6,
    nodeCooldownMs: 15000,
    bundleCooldownMs: 30000,
    criticalThreshold: 0.82,
    decisionThreshold: 0.74,
    backgroundThreshold: 0.68,
    secondWaveThreshold: 0.78,
    sceneSignalGain: 0.8,
    sceneCarryGain: 0.22,
    sceneBundleBiasGain: 1,
    sceneDecayLambda: 0.985,
    sceneTopKNodes: 10,
    sceneOverlapThreshold: 0.12,
    supersededNodePenalty: 0.28,
    repeatedSemanticStepPenalty: 0.72,
    enableGroupBundles: true,
    groupTriggerScoreThreshold: 0.27,
    groupAllowSemanticFallback: true,
    groupEnergyGain: 0.88,
    dimensionWeights: {
        H: 1.0,
        V_up: 0.45,
        V_down: 0.25,
        T_forward: 1.1,
        T_backward: 0.5,
        O_up: 0.7,
        O_down: 0.55,
    },
    scopeGateFloor: 0.15,
};

const GRAPH_REFRESH_INTERVAL_MS = 2000;
const sharedGraphCache = new Map<string, { signature: number; graph: LoadedGraphData }>();

export class V8GraphScanner {
    private readonly workspace: string;
    private readonly config: V8ScannerConfig;
    private recallBias: V8RecallBias;
    private graph: LoadedGraphData;
    private graphLoadSignature = 0;
    private lastGraphCheckAt = 0;
    private readonly activations = new Map<string, number>();
    private readonly nodeCooldowns = new Map<string, number>();
    private readonly bundleCooldowns = new Map<string, number>();
    private readonly sceneBiases = new Map<string, number>();
    private readonly runtimeEdgeCache = new Map<
        "default" | "oblique",
        { outgoing: Map<string, RuntimeEdge[]>; incoming: Map<string, RuntimeEdge[]> }
    >();
    private readonly runtimeReweightCache = new Map<"current_state" | "historical_trace", ReweightEdge[]>();
    private activeScopeIds: Set<string> | null = null;
    private activeDayKeys: Set<string> | null = null;
    private recentWindow = "";
    private charsSinceLastScan = 0;
    private recentTrajectory: Array<"H" | "V_up" | "V_down" | "T_forward" | "T_backward" | "O_up" | "O_down" | "gate" | "none"> = [];

    constructor(
        workspace: string,
        config: Partial<V8ScannerConfig> = {},
        recallBias: V8RecallBias | V8RecallMode = "current_state"
    ) {
        this.workspace = workspace;
        this.config = { ...DEFAULT_V8_SCANNER_CONFIG, ...config };
        this.recallBias = normalizeRecallBias(recallBias);
        this.graphLoadSignature = this.computeGraphSignature();
        this.graph = this.loadGraph(this.graphLoadSignature);
    }


    private loadGraph(signature = this.computeGraphSignature()): LoadedGraphData {
        const cached = sharedGraphCache.get(this.workspace);
        if (cached && cached.signature === signature) {
            return cached.graph;
        }
        const store = v8StorePaths(this.workspace);
        const nodes = loadJsonl<V8GraphNode>(store.graphNodes);
        const graphEdges = loadJsonl<V8GraphEdge>(store.graphEdges);
        const evidenceSpans = loadJsonl<V8EvidenceSpan>(store.evidenceSpans);
        const memoryItems = loadJsonl<V8MemoryItem>(store.memoryItems);
        const units = loadJsonl<V8Unit>(store.units);
        const ignitionNodes = fs.existsSync(store.ignitionNodes)
            ? loadJsonl<V8IgnitionNodeProjection>(store.ignitionNodes)
            : [];
        const ignitionEdges = fs.existsSync(store.ignitionEdges)
            ? loadJsonl<V8IgnitionEdgeProjection>(store.ignitionEdges)
            : [];
        const recallBundles = fs.existsSync(store.recallBundles)
            ? loadJsonl<V8RecallBundleProjection>(store.recallBundles)
            : [];
        const hypothesisEdges = loadHypothesisEdges(this.workspace);
        const groupBundles = recallBundles.filter(
            (bundle) => bundle.bundleId.startsWith("group_") && bundle.nodeIds.length >= 2
        );
        const groupBundleById = new Map(groupBundles.map((bundle) => [bundle.bundleId, bundle]));

        const nodesById = new Map<string, V8GraphNode>();
        const nodeTokens = new Map<string, Set<string>>();
        const spanById = new Map(evidenceSpans.map((span) => [span.id, span]));
        const itemsById = new Map(memoryItems.map((item) => [item.id, item]));
        const nodeKinds = new Map<string, "episodic" | "semantic" | "procedural">();
        const nodeDayKeys = new Map<string, Set<string>>();
        const ignitionNodesById =
            ignitionNodes.length > 0 ? new Map<string, V8IgnitionNodeProjection>() : null;

        if (ignitionNodesById) {
            for (const projection of ignitionNodes) {
                ignitionNodesById.set(projection.nodeId, projection);
                const triggerText = [
                    projection.searchText,
                    projection.names?.zh,
                    projection.names?.en,
                    ...(projection.aliases || []),
                    ...(projection.triggerTerms || []),
                ]
                    .filter(Boolean)
                    .join(" ");
                const tokens = tokenize(triggerText);
                nodeTokens.set(projection.nodeId, new Set(tokens));
                nodeKinds.set(projection.nodeId, projection.kind);
                if (projection.dayKey) {
                    nodeDayKeys.set(projection.nodeId, new Set([projection.dayKey]));
                }
            }
        }
        for (const node of nodes) {
            nodesById.set(node.id, node);
            if (node.memoryType === "evidence") {
                continue;
            }
            if (node.primaryLayer !== "micro") {
                continue;
            }
            if (node.memoryType === "discourse_unit") {
                continue;
            }
            if (node.id.startsWith("node_edge_")) {
                continue;
            }
            const tokens = tokenize(
                [node.canonicalLabel, ...(node.aliases || [])].join(" ")
            );
            const existingTokens = nodeTokens.get(node.id);
            nodeTokens.set(node.id, new Set([...(existingTokens || new Set<string>()), ...tokens]));

            let hasCurated = false;
            let hasProcedural = false;
            const dayKeys = new Set<string>();
            for (const spanId of collectNodeSpanIdsFromItems(node, itemsById)) {
                const span = spanById.get(spanId);
                if (!span) continue;
                if (span.sourceType === "skill_md") {
                    hasProcedural = true;
                }
                if (span.sourceClass === "curated") {
                    hasCurated = true;
                }
                if (span.timestamp) {
                    const dayKey = toDayKey(span.timestamp);
                    if (dayKey) {
                        dayKeys.add(dayKey);
                    }
                }
            }
            if (dayKeys.size > 0) {
                nodeDayKeys.set(node.id, dayKeys);
            }
            if (hasProcedural) {
                nodeKinds.set(node.id, "procedural");
            } else if (hasCurated) {
                nodeKinds.set(node.id, "semantic");
            } else {
                nodeKinds.set(node.id, "episodic");
            }
        }
        const groupBundleIrTokens = new Map<string, Set<string>>();
        const tokenWeights = buildTokenWeights(nodeTokens.values());
        for (const bundle of groupBundles) {
            const merged = new Set<string>();
            for (const nodeId of bundle.nodeIds) {
                const tokens = nodeTokens.get(nodeId);
                if (tokens) {
                    for (const token of tokens) merged.add(token);
                    continue;
                }
                const node = nodesById.get(nodeId);
                if (!node) continue;
                for (const token of tokenize(node.canonicalLabel)) {
                    merged.add(token);
                }
            }
            groupBundleIrTokens.set(bundle.bundleId, merged);
        }

        const runtimeEdges: V8GraphEdge[] =
            graphEdges.length > 0
                ? graphEdges
                : ignitionEdges.map((edge, index) => ({
                      id: edge.edgeId || `edge_runtime_${index + 1}`,
                      type: edge.type,
                      src: edge.srcNodeId,
                      dst: edge.dstNodeId,
                      layer: "cross",
                      originType: "aggregated",
                      sourceItemIds: [],
                      evidenceSpanIds: [],
                      qualifiers: {},
                      confidence: edge.score ?? 0.6,
                      state: {
                          scope: "session",
                          validity: "active",
                      },
                  }));

        const adjacency = new Map<string, V8GraphEdge[]>();
        const reverseAdjacency = new Map<string, V8GraphEdge[]>();
        const degree = new Map<string, number>();
        for (const edge of runtimeEdges) {
            if (!adjacency.has(edge.src)) adjacency.set(edge.src, []);
            adjacency.get(edge.src)!.push(edge);
            if (!reverseAdjacency.has(edge.dst)) reverseAdjacency.set(edge.dst, []);
            reverseAdjacency.get(edge.dst)!.push(edge);
            degree.set(edge.src, (degree.get(edge.src) || 0) + 1);
            degree.set(edge.dst, (degree.get(edge.dst) || 0) + 1);
        }

        const edgeKinds = loadEdgeCatalog();
        const scopeAnchorsByNode = new Map<string, string[]>();
        const scopeNodes = new Set<string>();
        for (const edge of runtimeEdges) {
            const kind = edgeKinds.get(edge.type) || "semantic";
            if (kind !== "scope_anchor") continue;
            scopeNodes.add(edge.dst);
            const list = scopeAnchorsByNode.get(edge.src) || [];
            list.push(edge.dst);
            scopeAnchorsByNode.set(edge.src, list);
        }

        const graph = {
            nodesById,
            ignitionNodesById,
            edges: runtimeEdges,
            adjacency,
            reverseAdjacency,
            nodeTokens,
            degree,
            scopeAnchorsByNode,
            scopeNodes,
            nodeKinds,
            nodeDayKeys,
            edgeKinds,
            groupBundles,
            groupBundleById,
            groupBundleIrTokens,
            hypothesisEdges,
            itemsById,
            unitsById: new Map(units.map((unit) => [unit.id, unit])),
            tokenWeights,
        };
        sharedGraphCache.set(this.workspace, { signature, graph });
        return graph;
    }

    private computeGraphSignature(): number {
        const store = v8StorePaths(this.workspace);
        return Math.max(
            fileMtimeMs(store.graphNodes),
            fileMtimeMs(store.graphEdges),
            fileMtimeMs(store.evidenceSpans),
            fileMtimeMs(store.ignitionNodes),
            fileMtimeMs(store.ignitionEdges),
            fileMtimeMs(store.recallBundles),
            fileMtimeMs(store.hypothesisEdges)
        );
    }

    private ensureGraphFresh(force = false): void {
        const now = nowMs();
        if (!force && now - this.lastGraphCheckAt < GRAPH_REFRESH_INTERVAL_MS) {
            return;
        }
        this.lastGraphCheckAt = now;
        const signature = this.computeGraphSignature();
        if (signature <= this.graphLoadSignature) {
            return;
        }

        this.graph = this.loadGraph(signature);
        this.graphLoadSignature = signature;
        this.runtimeEdgeCache.clear();
        this.runtimeReweightCache.clear();

        // Reloading graph invalidates activation/cooldown references.
        this.activations.clear();
        this.nodeCooldowns.clear();
        this.bundleCooldowns.clear();
        this.sceneBiases.clear();
        this.activeScopeIds = null;
        this.activeDayKeys = null;
        this.charsSinceLastScan = 0;
    }

    private getRuntimeEdges(strategy: "default" | "oblique" = "default") {
        const cached = this.runtimeEdgeCache.get(strategy);
        if (cached) return cached;

        const outgoing = new Map<string, RuntimeEdge[]>();
        const incoming = new Map<string, RuntimeEdge[]>();

        for (const edge of this.graph.edges) {
            const forwardDimension = edgeDirectionDimension(edge, "forward");
            const reverseDimension = edgeDirectionDimension(edge, "reverse");
            if (
                (forwardDimension === "none" || forwardDimension === "gate") &&
                (reverseDimension === "none" || reverseDimension === "gate")
            ) {
                continue;
            }
            const weight = clamp01(edge.confidence ?? 0.6) * familyWeight(edge);
            if (weight <= 0) continue;
            const entry: RuntimeEdge = {
                edge,
                weight,
                forwardDirection: policyDirectionForDimension(forwardDimension),
                reverseDirection: policyDirectionForDimension(reverseDimension),
                forwardDimension,
                reverseDimension,
            };
            if (!outgoing.has(edge.src)) outgoing.set(edge.src, []);
            outgoing.get(edge.src)!.push(entry);
            if (!incoming.has(edge.dst)) incoming.set(edge.dst, []);
            incoming.get(edge.dst)!.push(entry);
        }

        const limitEdges = (bucket: Map<string, RuntimeEdge[]>) => {
            if (this.config.topKEdges <= 0) return;
            for (const [nodeId, edges] of bucket.entries()) {
                edges.sort((a, b) => b.weight - a.weight);
                bucket.set(nodeId, edges.slice(0, this.config.topKEdges));
            }
        };

        if (strategy === "oblique") {
            const gain = 0.36;
            for (const hypothesis of this.graph.hypothesisEdges) {
                if (hypothesis.modeHint !== "oblique" && hypothesis.modeHint !== "trajectory") continue;
                const edgeType = this.graph.edgeKinds.has(
                    hypothesis.suggestedType as V8GraphEdge["type"]
                )
                    ? (hypothesis.suggestedType as V8GraphEdge["type"])
                    : "similar_to";
                const edge: V8GraphEdge = {
                    id: `hyp_${hypothesis.id}`,
                    type: edgeType,
                    src: hypothesis.src,
                    dst: hypothesis.dst,
                    layer: "cross",
                    originType: "inferred",
                    sourceItemIds: [],
                    evidenceSpanIds: hypothesis.supportEvidenceSpanIds,
                    qualifiers: { hypothesis: true },
                    confidence: clamp01(hypothesis.confidence),
                    forwardDimension: "O_up",
                    reverseDimension: "O_down",
                    state: {
                        scope: "session",
                        validity: "tentative",
                    },
                };
                const entry: RuntimeEdge = {
                    edge,
                    weight: clamp01(hypothesis.confidence) * gain,
                    forwardDirection: "up",
                    reverseDirection: "down",
                    forwardDimension: "O_up",
                    reverseDimension: "O_down",
                };
                if (!outgoing.has(edge.src)) outgoing.set(edge.src, []);
                outgoing.get(edge.src)!.push(entry);
                if (!incoming.has(edge.dst)) incoming.set(edge.dst, []);
                incoming.get(edge.dst)!.push(entry);
                if (!outgoing.has(edge.dst)) outgoing.set(edge.dst, []);
                outgoing.get(edge.dst)!.push(entry);
                if (!incoming.has(edge.src)) incoming.set(edge.src, []);
                incoming.get(edge.src)!.push(entry);
            }
        }

        limitEdges(outgoing);
        limitEdges(incoming);

        const result = { outgoing, incoming };
        this.runtimeEdgeCache.set(strategy, result);
        return result;
    }

    private getReweightEdges(): ReweightEdge[] {
        const cached = this.runtimeReweightCache.get(this.recallBias);
        if (cached) return cached;

        const edges: ReweightEdge[] = [];
        for (const edge of this.graph.edges) {
            const kind = this.graph.edgeKinds.get(edge.type) || "semantic";
            const forwardDimension = edgeDirectionDimension(edge, "forward");
            const reverseDimension = edgeDirectionDimension(edge, "reverse");
            const hasTemporalGeometry =
                forwardDimension === "T_forward" ||
                forwardDimension === "T_backward" ||
                reverseDimension === "T_forward" ||
                reverseDimension === "T_backward";
            const shouldFallbackReweight =
                (kind === "change" || hasTemporalGeometry);
            if (!shouldFallbackReweight) {
                continue;
            }
            edges.push({ edge });
        }

        this.runtimeReweightCache.set(this.recallBias, edges);
        return edges;
    }

    public refreshScene(signals: V8SceneSignal[], anchors: V8ControlAnchors): void {
        this.ensureGraphFresh();
        const combined = [
            anchors.goal,
            anchors.activeTask,
            anchors.latestUserRequest,
            ...signals.map((signal) => signal.text),
        ]
            .filter(Boolean)
            .join(" ");

        if (!combined) {
            this.sceneBiases.clear();
            return;
        }

        const signalTokens = new Set(tokenize(combined));
        const nextBiases = new Map<string, number>();

        this.updateActiveScopes(signalTokens);
        this.updateActiveDays(signalTokens);

        for (const [nodeId, tokens] of this.graph.nodeTokens.entries()) {
            if (this.isNodeSuppressed(nodeId)) {
                continue;
            }
            const overlap = weightedSymmetricOverlapScore(
                signalTokens,
                tokens,
                this.graph.tokenWeights
            );
            if (overlap >= this.config.sceneOverlapThreshold) {
                nextBiases.set(
                    nodeId,
                    overlap * this.config.sceneSignalGain * this.supersededPenalty(nodeId)
                );
            }
        }

        this.sceneBiases.clear();
        for (const [nodeId, bias] of nextBiases.entries()) {
            this.sceneBiases.set(nodeId, bias);
        }
    }

    public preExcite(prompt: string, anchors: V8ControlAnchors): void {
        this.ensureGraphFresh();
        if (!prompt) {
            return;
        }

        const tokens = new Set(tokenize(prompt));
        for (const [nodeId, nodeTokens] of this.graph.nodeTokens.entries()) {
            if (this.isNodeSuppressed(nodeId)) {
                continue;
            }
            const overlap = weightedSymmetricOverlapScore(
                tokens,
                nodeTokens,
                this.graph.tokenWeights
            );
            if (overlap <= 0) continue;
            const bias = this.sceneBiases.get(nodeId) || 0;
            this.activate(nodeId, clamp01((overlap + bias) * this.supersededPenalty(nodeId)));
        }

        this.spreadActivation();
    }

    public processChunk(delta: string, _anchors: V8ControlAnchors): V8ScanResult {
        this.ensureGraphFresh();
        if (!delta) {
            return { activatedBundles: [], recentWindow: this.recentWindow };
        }

        this.recentWindow = (this.recentWindow + delta).slice(-1200);
        this.charsSinceLastScan += delta.length;

        if (this.charsSinceLastScan < this.config.scanIntervalChars) {
            return { activatedBundles: [], recentWindow: this.recentWindow };
        }

        this.charsSinceLastScan = 0;
        refreshFeedbackStore(this.workspace);
        this.applyDecay();

        const tokens = new Set(tokenize(this.recentWindow));
        this.updateActiveDays(tokens);
        for (const [nodeId, nodeTokens] of this.graph.nodeTokens.entries()) {
            if (this.isNodeSuppressed(nodeId)) {
                continue;
            }
            const overlap = weightedSymmetricOverlapScore(
                tokens,
                nodeTokens,
                this.graph.tokenWeights
            );
            if (overlap <= 0) continue;
            const bias = this.sceneBiases.get(nodeId) || 0;
            const feedbackBias = getNodeFeedbackBias(nodeId);
            const energy = clamp01(
                (overlap + bias + feedbackBias) * this.supersededPenalty(nodeId)
            );
            this.activate(nodeId, energy);
        }

        this.spreadActivation();

        const now = nowMs();
        const collectEvidence = (
            entries: Array<{ nodeId: string; energy: number; evidenceSpanIds: string[] }>,
            limit: number
        ) => {
            const merged: string[] = [];
            const seen = new Set<string>();
            for (const entry of entries) {
                for (const spanId of entry.evidenceSpanIds) {
                    if (seen.has(spanId)) continue;
                    seen.add(spanId);
                    merged.push(spanId);
                    if (merged.length >= limit) return merged;
                }
            }
            return merged;
        };

        const buildBundles = (
            _strategy: "default" | "oblique",
            minEnergy: number,
            tierOverride?: V8ActivatedBundle["tier"],
            wave?: 2
        ): V8ActivatedBundle[] => {
            const eligibleActivations = new Map<string, number>();
            for (const [nodeId, energy] of this.activations.entries()) {
                if (energy < minEnergy) continue;
                if (this.isNodeSuppressed(nodeId)) continue;
                const cooldownUntil = this.nodeCooldowns.get(nodeId) || 0;
                if (cooldownUntil > now) continue;
                eligibleActivations.set(nodeId, energy * this.supersededPenalty(nodeId));
            }

            const bundles = resolveUnitBundles({
                activations: eligibleActivations,
                nodesById: this.graph.nodesById,
                itemsById: this.graph.itemsById,
                unitsById: this.graph.unitsById,
                criticalThreshold: tierOverride === "critical" ? minEnergy : this.config.criticalThreshold,
                decisionThreshold: tierOverride === "decision" ? minEnergy : this.config.decisionThreshold,
                backgroundThreshold: tierOverride === "background" ? minEnergy : this.config.backgroundThreshold,
                maxBundles: this.config.maxInjectedBundles * 3,
            }).filter((bundle) => {
                const bundleCooldownUntil = this.bundleCooldowns.get(bundle.bundleId) || 0;
                return bundleCooldownUntil <= now;
            });

            return bundles
                .map((bundle) => ({
                    ...bundle,
                    tier: tierOverride ?? bundle.tier,
                    ...(wave ? { wave } : {}),
                }))
                .sort((a, b) => b.energy - a.energy)
                .slice(0, this.config.maxInjectedBundles);
        };

        let topBundles = this.selectBundlesWithDiversity(buildBundles("default", 0.05));
        if (this.config.enableGroupBundles) {
            topBundles = this.mergeGroupBundles(topBundles, now);
        }

        if (topBundles.length === 0) {
            this.spreadActivation("oblique");
            topBundles = this.selectBundlesWithDiversity(buildBundles(
                "oblique",
                this.config.secondWaveThreshold,
                "background",
                2
            ));
            if (this.config.enableGroupBundles) {
                topBundles = this.mergeGroupBundles(topBundles, now);
            }
        }

        for (const bundle of topBundles) {
            for (const nodeId of bundle.nodeIds) {
                this.nodeCooldowns.set(nodeId, now + this.config.nodeCooldownMs);
            }
            this.bundleCooldowns.set(bundle.bundleId, now + this.config.bundleCooldownMs);
        }

        return { activatedBundles: topBundles, recentWindow: this.recentWindow };
    }

    private collectBundleUnitIds(nodeIds: string[]): string[] {
        const unitIds = new Set<string>();
        for (const nodeId of nodeIds) {
            const node = this.graph.nodesById.get(nodeId);
            if (!node) continue;
            for (const itemId of node.sourceItemIds || []) {
                const item = this.graph.itemsById.get(itemId);
                if (!item) continue;
                for (const unitId of item.unitIds || []) {
                    unitIds.add(unitId);
                }
            }
        }
        return Array.from(unitIds);
    }
    private mergeGroupBundles(
        baseBundles: V8ActivatedBundle[],
        now: number
    ): V8ActivatedBundle[] {
        if (baseBundles.length === 0) return baseBundles;
        if (this.graph.groupBundles.length === 0) return baseBundles;

        const activeNodeIds = new Set<string>();
        for (const bundle of baseBundles) {
            for (const nodeId of bundle.nodeIds) {
                activeNodeIds.add(nodeId);
            }
        }
        const baseNodeSet = new Set<string>();
        for (const bundle of baseBundles) {
            for (const nodeId of bundle.nodeIds) {
                baseNodeSet.add(nodeId);
            }
        }
        const baseNodeCount = Math.max(1, baseNodeSet.size);
        const activeIrTokens = new Set<string>();
        for (const nodeId of baseNodeSet) {
            const tokens = this.graph.nodeTokens.get(nodeId);
            if (!tokens) continue;
            for (const token of tokens) {
                activeIrTokens.add(token);
            }
        }
        const baseEnergyAvg =
            baseBundles.reduce((sum, bundle) => sum + bundle.energy, 0) /
            Math.max(1, baseBundles.length);

        const extraBundles: V8ActivatedBundle[] = [];
        for (const group of this.graph.groupBundles) {
            const cooldownUntil = this.bundleCooldowns.get(group.bundleId) || 0;
            if (cooldownUntil > now) continue;

            const overlapNodeIds = group.nodeIds.filter((nodeId) => activeNodeIds.has(nodeId));
            const overlapCount = overlapNodeIds.length;
            const minOverlapCount = group.nodeIds.length >= 5 ? 2 : 1;
            const coverage = overlapCount / Math.max(1, group.nodeIds.length);
            const jaccard =
                overlapCount /
                Math.max(1, baseNodeCount + group.nodeIds.length - overlapCount);
            const groupIrTokens = this.graph.groupBundleIrTokens.get(group.bundleId) || new Set<string>();
            const irSimilarity = weightedSymmetricOverlapScore(
                activeIrTokens,
                groupIrTokens,
                this.graph.tokenWeights
            );
            // Transparent score: overlap coverage + jaccard + IR-group similarity.
            const triggerScore = 0.5 * coverage + 0.3 * jaccard + 0.2 * irSimilarity;
            const hasSemanticFallback =
                this.config.groupAllowSemanticFallback &&
                baseBundles.length >= 2 &&
                irSimilarity >= this.config.groupTriggerScoreThreshold + 0.08;
            const hasNodeOverlap = overlapCount > 0;
            const hasActiveDayOverlap = this.groupHasActiveDayOverlap(group.nodeIds);
            if (!hasNodeOverlap && !hasSemanticFallback) {
                continue;
            }
            if (overlapCount < minOverlapCount && !hasSemanticFallback) {
                continue;
            }
            if (
                group.kind === "episodic" &&
                this.recallBias === "current_state" &&
                !hasNodeOverlap &&
                this.activeDayKeys &&
                this.activeDayKeys.size > 0 &&
                !hasActiveDayOverlap
            ) {
                continue;
            }
            if (triggerScore < this.config.groupTriggerScoreThreshold && !hasSemanticFallback) {
                continue;
            }

            let activationSum = 0;
            for (const nodeId of overlapNodeIds) {
                activationSum += this.activations.get(nodeId) || 0;
            }
            const meanActivation =
                overlapCount > 0 ? activationSum / overlapCount : baseEnergyAvg * 0.8;
            const semanticOnlyActivation = overlapCount === 0 && hasSemanticFallback;
            const relationStrength = semanticOnlyActivation
                ? irSimilarity
                : Math.max(triggerScore, coverage);
            const semanticPenalty = semanticOnlyActivation
                ? hasActiveDayOverlap
                    ? 0.72
                    : 0.58
                : 1;
            const energy = clamp01(
                meanActivation *
                    this.config.groupEnergyGain *
                    semanticPenalty *
                    (0.65 + 0.35 * relationStrength)
            );

            const tier = scoreTier(energy, this.config);
            if (!tier) continue;

            extraBundles.push({
                bundleId: group.bundleId,
                sourceUnitIds: this.collectBundleUnitIds(group.nodeIds),
                nodeIds:
                    overlapNodeIds.length > 0
                        ? overlapNodeIds
                        : group.nodeIds.slice(0, Math.min(4, group.nodeIds.length)),
                tier,
                energy,
                evidenceSpanIds:
                    group.bestEvidenceSpanIds.length > 0
                        ? group.bestEvidenceSpanIds
                        : group.evidenceSpanIds.slice(0, 8),
                diagnostics: {
                    triggerScore: Number(triggerScore.toFixed(4)),
                    coverage: Number(coverage.toFixed(4)),
                    jaccard: Number(jaccard.toFixed(4)),
                    irSimilarity: Number(irSimilarity.toFixed(4)),
                },
            });
        }

        if (extraBundles.length === 0) {
            return baseBundles;
        }

        const merged = new Map<string, V8ActivatedBundle>();
        for (const bundle of [...baseBundles, ...extraBundles]) {
            const existing = merged.get(bundle.bundleId);
            if (!existing || bundle.energy > existing.energy) {
                merged.set(bundle.bundleId, bundle);
            }
        }

        return this.selectBundlesWithDiversity(Array.from(merged.values()));
    }

    private selectBundlesWithDiversity(bundles: V8ActivatedBundle[]): V8ActivatedBundle[] {
        const sorted = bundles.slice().sort((a, b) => b.energy - a.energy);
        const limit = this.config.maxInjectedBundles;
        if (limit <= 1 || sorted.length <= 1) {
            return sorted.slice(0, limit);
        }

        const unitBundles = sorted.filter((bundle) => !this.graph.groupBundleById.has(bundle.bundleId));
        const groupBundles = sorted.filter((bundle) => this.graph.groupBundleById.has(bundle.bundleId));
        const selected: V8ActivatedBundle[] = [];
        const seen = new Set<string>();

        if (unitBundles.length > 0) {
            selected.push(unitBundles[0]!);
            seen.add(unitBundles[0]!.bundleId);
        }
        if (groupBundles.length > 0 && selected.length < limit) {
            selected.push(groupBundles[0]!);
            seen.add(groupBundles[0]!.bundleId);
        }
        for (const bundle of sorted) {
            if (selected.length >= limit) break;
            if (seen.has(bundle.bundleId)) continue;
            selected.push(bundle);
            seen.add(bundle.bundleId);
        }
        return selected;
    }

    private activate(nodeId: string, energy: number): void {
        const current = this.activations.get(nodeId) || 0;
        this.activations.set(nodeId, current + energy);
    }

    private applyDecay(): void {
        for (const [nodeId, energy] of this.activations.entries()) {
            const next = energy * this.config.decayLambda;
            if (next < 0.05) {
                this.activations.delete(nodeId);
            } else {
                this.activations.set(nodeId, next);
            }
        }

        for (const [nodeId, bias] of this.sceneBiases.entries()) {
            const next = bias * this.config.sceneDecayLambda;
            if (next < 0.01) {
                this.sceneBiases.delete(nodeId);
            } else {
                this.sceneBiases.set(nodeId, next);
            }
        }
    }

    private applyReweight(): void {
        const edges = this.getReweightEdges();
        if (edges.length === 0) return;

        const currentStateBias = this.recallBias === "current_state";
        const historicalTraceBias = this.recallBias === "historical_trace";
        const deltas = new Map<string, number>();

        const pushDelta = (nodeId: string, delta: number) => {
            if (!delta) return;
            deltas.set(nodeId, (deltas.get(nodeId) || 0) + delta);
        };

        for (const entry of edges) {
            const edge = entry.edge;
            if (!this.isStateNode(edge.src) || !this.isStateNode(edge.dst)) {
                continue;
            }

            const srcEnergy = this.activations.get(edge.src) || 0;
            const dstEnergy = this.activations.get(edge.dst) || 0;
            if (srcEnergy <= 0 && dstEnergy <= 0) {
                continue;
            }

            switch (edge.type) {
                case "state_supersedes_state": {
                    const predecessorId =
                        edge.forwardDimension === "T_forward" ? edge.src : edge.dst;
                    const successorId =
                        edge.forwardDimension === "T_forward" ? edge.dst : edge.src;
                    const predecessorEnergy = this.activations.get(predecessorId) || 0;
                    const successorEnergy = this.activations.get(successorId) || 0;
                    if (currentStateBias) {
                        pushDelta(successorId, 0.65 * predecessorEnergy);
                        pushDelta(predecessorId, -0.45 * predecessorEnergy);
                    } else if (historicalTraceBias) {
                        pushDelta(successorId, 0.18 * predecessorEnergy);
                        pushDelta(predecessorId, 0.12 * successorEnergy);
                    }
                    break;
                }
                case "state_refines_state": {
                    const predecessorId =
                        edge.forwardDimension === "T_forward" ? edge.src : edge.dst;
                    const successorId =
                        edge.forwardDimension === "T_forward" ? edge.dst : edge.src;
                    const predecessorEnergy = this.activations.get(predecessorId) || 0;
                    const successorEnergy = this.activations.get(successorId) || 0;
                    if (currentStateBias) {
                        pushDelta(successorId, 0.32 * predecessorEnergy);
                        pushDelta(predecessorId, -0.22 * predecessorEnergy);
                    } else if (historicalTraceBias) {
                        pushDelta(successorId, 0.12 * predecessorEnergy);
                        pushDelta(predecessorId, 0.08 * successorEnergy);
                    }
                    break;
                }
                default:
                    break;
            }
        }

        for (const [nodeId, delta] of deltas.entries()) {
            const current = this.activations.get(nodeId) || 0;
            const next = clamp01(current + delta);
            if (next <= 0.01) {
                this.activations.delete(nodeId);
            } else {
                this.activations.set(nodeId, next);
            }
        }
    }

    private spreadActivation(strategy: "default" | "oblique" = "default"): void {
        const nextEnergy = new Map<string, number>();

        const degree = this.graph.degree;
        const { outgoing, incoming } = this.getRuntimeEdges(strategy);

        for (const [nodeId, energy] of this.activations.entries()) {
            if (this.isNodeSuppressed(nodeId)) {
                continue;
            }
            if (energy <= 0.05) continue;
            const sourceEnergy = energy * this.supersededPenalty(nodeId);
            if (sourceEnergy <= 0.01) continue;
            const nodePenalty = Math.pow(
                Math.max(1, degree.get(nodeId) || 1),
                this.config.hubPenaltyPower
            );

            const outEdges = outgoing.get(nodeId) || [];
            for (const entry of outEdges) {
                const canForward =
                    entry.forwardDirection === "bidirectional" || entry.forwardDirection === "up";
                if (!canForward) continue;
                if (this.isNodeSuppressed(entry.edge.dst)) {
                    continue;
                }
                const forwardWeight =
                    entry.weight *
                    dimensionWeight(entry.forwardDimension, this.config.dimensionWeights) *
                    scopeGate(entry.edge, this.matchesEdgeScope(entry.edge), this.config.scopeGateFloor) *
                    trajectoryAffinity(entry.forwardDimension, this.recentTrajectory);
                const semanticPenalty =
                    lastTrajectoryIsRepeatedSemantic(this.recentTrajectory, entry.forwardDimension)
                        ? this.config.repeatedSemanticStepPenalty
                        : 1;
                const transfer =
                    (sourceEnergy *
                        this.supersededPenalty(entry.edge.dst) *
                        forwardWeight *
                        semanticPenalty *
                        this.config.forwardGain) /
                    nodePenalty;
                if (transfer <= 0) continue;
                nextEnergy.set(
                    entry.edge.dst,
                    (nextEnergy.get(entry.edge.dst) || 0) + transfer
                );
                this.recentTrajectory.push(entry.forwardDimension);
                if (this.recentTrajectory.length > 3) {
                    this.recentTrajectory = this.recentTrajectory.slice(-3);
                }
            }

            const inEdges = incoming.get(nodeId) || [];
            for (const entry of inEdges) {
                const canReverse =
                    entry.reverseDirection === "bidirectional" || entry.reverseDirection === "down";
                if (!canReverse) continue;
                if (this.isNodeSuppressed(entry.edge.src)) {
                    continue;
                }
                const reverseWeight =
                    entry.weight *
                    dimensionWeight(entry.reverseDimension, this.config.dimensionWeights) *
                    scopeGate(entry.edge, this.matchesEdgeScope(entry.edge), this.config.scopeGateFloor) *
                    trajectoryAffinity(entry.reverseDimension, this.recentTrajectory);
                const semanticPenalty =
                    lastTrajectoryIsRepeatedSemantic(this.recentTrajectory, entry.reverseDimension)
                        ? this.config.repeatedSemanticStepPenalty
                        : 1;
                const transfer =
                    (sourceEnergy *
                        this.supersededPenalty(entry.edge.src) *
                        reverseWeight *
                        semanticPenalty *
                        this.config.reverseGain) /
                    nodePenalty;
                if (transfer <= 0) continue;
                nextEnergy.set(
                    entry.edge.src,
                    (nextEnergy.get(entry.edge.src) || 0) + transfer
                );
                this.recentTrajectory.push(entry.reverseDimension);
                if (this.recentTrajectory.length > 3) {
                    this.recentTrajectory = this.recentTrajectory.slice(-3);
                }
            }
        }

        for (const [nodeId, energy] of nextEnergy.entries()) {
            this.activate(nodeId, energy);
        }

        this.applyReweight();
    }

    private matchesEdgeScope(edge: V8GraphEdge): boolean {
        if (!this.activeScopeIds || this.activeScopeIds.size === 0) {
            return true;
        }
        return this.activeScopeIds.has(edge.src) || this.activeScopeIds.has(edge.dst);
    }

    private isNodeSuppressed(nodeId: string): boolean {
        const node = this.graph.nodesById.get(nodeId);
        if (!node) return false;

        const scopedTo = this.graph.scopeAnchorsByNode.get(nodeId);
        if (scopedTo && scopedTo.length > 0) {
            if (this.activeScopeIds && this.activeScopeIds.size > 0) {
                for (const scopeId of scopedTo) {
                    if (this.activeScopeIds.has(scopeId)) {
                        return false;
                    }
                }
                return true;
            }
        }

        const kind = this.graph.nodeKinds.get(nodeId) || "semantic";
        if (kind !== "episodic") {
            return false;
        }
        const dayKeys = this.graph.nodeDayKeys.get(nodeId);
        if (!dayKeys || dayKeys.size === 0) {
            return false;
        }
        if (!this.activeDayKeys || this.activeDayKeys.size === 0) {
            return false;
        }
        for (const dayKey of dayKeys) {
            if (this.activeDayKeys.has(dayKey)) {
                return false;
            }
        }
        return true;
    }

    private supersededPenalty(nodeId: string): number {
        const node = this.graph.nodesById.get(nodeId);
        if (!node) return 1;
        if (node.state?.validity !== "superseded") return 1;
        return this.recallBias === "historical_trace" ? 1 : this.config.supersededNodePenalty;
    }

    private isStateNode(nodeId: string): boolean {
        const node = this.graph.nodesById.get(nodeId);
        if (!node) return false;
        if (!node.memoryType) return false;
        if (node.memoryType.endsWith("_state")) return true;
        return node.memoryType === "session_state" || node.memoryType === "topic_state";
    }

    private updateActiveScopes(signalTokens: Set<string>): void {
        if (signalTokens.size === 0 || this.graph.scopeNodes.size === 0) {
            this.activeScopeIds = null;
            return;
        }
        const active = new Set<string>();
        for (const scopeId of this.graph.scopeNodes) {
            const node = this.graph.nodesById.get(scopeId);
            if (!node) continue;
            const tokens = new Set(
                tokenize([node.canonicalLabel, ...(node.aliases || [])].join(" "))
            );
            const overlap = overlapScore(signalTokens, tokens);
            if (overlap >= this.config.sceneOverlapThreshold) {
                active.add(scopeId);
            }
        }
        this.activeScopeIds = active.size > 0 ? active : null;
    }

    private updateActiveDays(signalTokens: Set<string>): void {
        if (signalTokens.size === 0) {
            this.activeDayKeys = null;
            return;
        }
        const active = new Set<string>();
        for (const [nodeId, tokens] of this.graph.nodeTokens.entries()) {
            if (this.graph.nodeKinds.get(nodeId) !== "episodic") continue;
            const overlap = overlapScore(signalTokens, tokens);
            if (overlap < this.config.sceneOverlapThreshold) continue;
            const dayKeys = this.graph.nodeDayKeys.get(nodeId);
            if (!dayKeys || dayKeys.size === 0) continue;
            for (const dayKey of dayKeys) {
                active.add(dayKey);
            }
        }
        this.activeDayKeys = active.size > 0 ? active : null;
    }

    private groupHasActiveDayOverlap(nodeIds: string[]): boolean {
        if (!this.activeDayKeys || this.activeDayKeys.size === 0) return true;
        for (const nodeId of nodeIds) {
            const dayKeys = this.graph.nodeDayKeys.get(nodeId);
            if (!dayKeys || dayKeys.size === 0) continue;
            for (const dayKey of dayKeys) {
                if (this.activeDayKeys.has(dayKey)) return true;
            }
        }
        return false;
    }
}

