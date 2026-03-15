import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../utils.js";
import { loadEdgeRuntimePolicy } from "./edge-runtime-policy.js";
import { getNodeFeedbackBias, refreshFeedbackStore } from "./feedback-store.js";
import { loadHypothesisEdges } from "./hypothesis-store.js";
import { v8StorePaths } from "./paths_v8.js";
import type {
    V8ActivatedBundle,
    V8ControlAnchors,
    V8EdgeCatalogEntry,
    V8EdgeRuntimePolicyEntry,
    V8EvidenceSpan,
    V8GraphEdge,
    V8GraphNode,
    V8HypothesisEdge,
    V8IgnitionEdgeProjection,
    V8IgnitionNodeProjection,
    V8RecallBundleProjection,
    V8RecallMode,
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
    policyByKindMode: Map<string, V8EdgeRuntimePolicyEntry>;
    groupBundles: V8RecallBundleProjection[];
    groupBundleById: Map<string, V8RecallBundleProjection>;
    groupBundleIrTokens: Map<string, Set<string>>;
    hypothesisEdges: V8HypothesisEdge[];
}

interface RuntimeEdge {
    edge: V8GraphEdge;
    weight: number;
    direction: V8EdgeRuntimePolicyEntry["direction"];
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

function nowMs(): number {
    return Date.now();
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

function policyKey(kind: string, mode: V8RecallMode): string {
    return `${kind}:${mode}`;
}

function toDayKey(timestamp: string): string | null {
    if (!timestamp) return null;
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
}

function buildPolicyMap(entries: V8EdgeRuntimePolicyEntry[]): Map<string, V8EdgeRuntimePolicyEntry> {
    const map = new Map<string, V8EdgeRuntimePolicyEntry>();
    for (const entry of entries) {
        map.set(policyKey(entry.kind, entry.mode), entry);
    }
    return map;
}

function scoreTier(energy: number, config: V8ScannerConfig): V8ActivatedBundle["tier"] | null {
    if (energy >= config.criticalThreshold) return "critical";
    if (energy >= config.decisionThreshold) return "decision";
    if (energy >= config.backgroundThreshold) return "background";
    return null;
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
    groupTriggerScoreThreshold: 0.24,
    groupAllowSemanticFallback: true,
    groupEnergyGain: 0.92,
};

export class V8GraphScanner {
    private readonly workspace: string;
    private readonly config: V8ScannerConfig;
    private mode: V8RecallMode;
    private readonly graph: LoadedGraphData;
    private readonly activations = new Map<string, number>();
    private readonly nodeCooldowns = new Map<string, number>();
    private readonly bundleCooldowns = new Map<string, number>();
    private readonly sceneBiases = new Map<string, number>();
    private readonly runtimeEdgeCache = new Map<
        V8RecallMode,
        { outgoing: Map<string, RuntimeEdge[]>; incoming: Map<string, RuntimeEdge[]> }
    >();
    private readonly runtimeReweightCache = new Map<V8RecallMode, ReweightEdge[]>();
    private activeScopeIds: Set<string> | null = null;
    private activeDayKeys: Set<string> | null = null;
    private recentWindow = "";
    private charsSinceLastScan = 0;

    constructor(workspace: string, config: Partial<V8ScannerConfig> = {}, mode: V8RecallMode = "profile") {
        this.workspace = workspace;
        this.config = { ...DEFAULT_V8_SCANNER_CONFIG, ...config };
        this.mode = mode;
        this.graph = this.loadGraph();
    }

    public setMode(mode: V8RecallMode): void {
        this.mode = mode;
    }

    public getMode(): V8RecallMode {
        return this.mode;
    }

    private loadGraph(): LoadedGraphData {
        const store = v8StorePaths(this.workspace);
        const nodes = loadJsonl<V8GraphNode>(store.graphNodes);
        const graphEdges = loadJsonl<V8GraphEdge>(store.graphEdges);
        const evidenceSpans = loadJsonl<V8EvidenceSpan>(store.evidenceSpans);
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
            if (ignitionNodesById) {
                continue;
            }
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
            nodeTokens.set(node.id, new Set(tokens));

            let hasCurated = false;
            let hasProcedural = false;
            const dayKeys = new Set<string>();
            for (const spanId of node.evidenceSpanIds || []) {
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
                for (const token of tokenize(`${node.memoryType} ${node.canonicalLabel}`)) {
                    merged.add(token);
                }
            }
            groupBundleIrTokens.set(bundle.bundleId, merged);
        }

        const runtimeEdges: V8GraphEdge[] =
            ignitionEdges.length > 0
                ? ignitionEdges.map((edge, index) => ({
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
                  }))
                : graphEdges;

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
        const policyByKindMode = buildPolicyMap(loadEdgeRuntimePolicy());
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

        return {
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
            policyByKindMode,
            groupBundles,
            groupBundleById,
            groupBundleIrTokens,
            hypothesisEdges,
        };
    }

    private getRuntimeEdges(mode: V8RecallMode) {
        const cached = this.runtimeEdgeCache.get(mode);
        if (cached) return cached;

        const outgoing = new Map<string, RuntimeEdge[]>();
        const incoming = new Map<string, RuntimeEdge[]>();

        for (const edge of this.graph.edges) {
            if (
                edge.state?.validity === "superseded" &&
                mode !== "trajectory" &&
                mode !== "audit"
            ) {
                continue;
            }
            const kind = this.graph.edgeKinds.get(edge.type) || "semantic";
            const policy = this.graph.policyByKindMode.get(policyKey(kind, mode));
            if (!policy || policy.role !== "spread") {
                continue;
            }
            const weight = clamp01(edge.confidence ?? 0.6) * policy.gain;
            if (weight <= 0) continue;
            const entry: RuntimeEdge = {
                edge,
                weight,
                direction: policy.direction,
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

        if (mode === "oblique" || mode === "trajectory") {
            const gain = mode === "trajectory" ? 0.32 : 0.36;
            for (const hypothesis of this.graph.hypothesisEdges) {
                if (hypothesis.modeHint !== mode) continue;
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
                    state: {
                        scope: "session",
                        validity: "tentative",
                    },
                };
                const weight = clamp01(hypothesis.confidence) * gain;
                if (weight <= 0) continue;
                const entry: RuntimeEdge = {
                    edge,
                    weight,
                    direction: "bidirectional",
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
        this.runtimeEdgeCache.set(mode, result);
        return result;
    }

    private getReweightEdges(mode: V8RecallMode): ReweightEdge[] {
        const cached = this.runtimeReweightCache.get(mode);
        if (cached) return cached;

        const edges: ReweightEdge[] = [];
        for (const edge of this.graph.edges) {
            if (
                edge.state?.validity === "superseded" &&
                mode !== "trajectory" &&
                mode !== "audit"
            ) {
                continue;
            }
            const kind = this.graph.edgeKinds.get(edge.type) || "semantic";
            const policy = this.graph.policyByKindMode.get(policyKey(kind, mode));
            if (!policy || policy.role !== "reweight") {
                continue;
            }
            edges.push({ edge });
        }

        this.runtimeReweightCache.set(mode, edges);
        return edges;
    }

    public refreshScene(signals: V8SceneSignal[], anchors: V8ControlAnchors): void {
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
            if (this.isNodeSuppressed(nodeId, this.mode)) {
                continue;
            }
            const overlap = overlapScore(signalTokens, tokens);
            if (overlap >= this.config.sceneOverlapThreshold) {
                nextBiases.set(nodeId, overlap * this.config.sceneSignalGain);
            }
        }

        this.sceneBiases.clear();
        for (const [nodeId, bias] of nextBiases.entries()) {
            this.sceneBiases.set(nodeId, bias);
        }
    }

    public preExcite(prompt: string, anchors: V8ControlAnchors): void {
        if (!prompt) {
            return;
        }

        const tokens = new Set(tokenize(prompt));
        for (const [nodeId, nodeTokens] of this.graph.nodeTokens.entries()) {
            if (this.isNodeSuppressed(nodeId, this.mode)) {
                continue;
            }
            const overlap = overlapScore(tokens, nodeTokens);
            if (overlap <= 0) continue;
            const bias = this.sceneBiases.get(nodeId) || 0;
            this.activate(nodeId, clamp01(overlap + bias));
        }

        this.spreadActivation();
    }

    public processChunk(delta: string, _anchors: V8ControlAnchors): V8ScanResult {
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
            if (this.isNodeSuppressed(nodeId, this.mode)) {
                continue;
            }
            const overlap = overlapScore(tokens, nodeTokens);
            if (overlap <= 0) continue;
            const bias = this.sceneBiases.get(nodeId) || 0;
            const feedbackBias = getNodeFeedbackBias(nodeId);
            const energy = clamp01(overlap + bias + feedbackBias);
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
            suppressionMode: V8RecallMode,
            minEnergy: number,
            tierOverride?: V8ActivatedBundle["tier"],
            wave?: 2
        ): V8ActivatedBundle[] => {
            const bundleMap = new Map<
                string,
                { energy: number; nodes: Array<{ nodeId: string; energy: number; evidenceSpanIds: string[] }> }
            >();

            for (const [nodeId, energy] of this.activations.entries()) {
                if (energy < minEnergy) continue;
                if (this.isNodeSuppressed(nodeId, suppressionMode)) continue;
                const cooldownUntil = this.nodeCooldowns.get(nodeId) || 0;
                if (cooldownUntil > now) continue;
                const node = this.graph.nodesById.get(nodeId);
                if (!node) continue;
                const projection = this.graph.ignitionNodesById?.get(nodeId) || null;
                const evidenceSpanIds =
                    projection?.bestEvidenceSpanIds && projection.bestEvidenceSpanIds.length > 0
                        ? projection.bestEvidenceSpanIds
                        : projection?.evidenceSpanIds && projection.evidenceSpanIds.length > 0
                          ? projection.evidenceSpanIds
                          : node.bestEvidenceSpanIds.length > 0
                            ? node.bestEvidenceSpanIds
                            : node.evidenceSpanIds;
                const bundleId = projection?.bundleId || nodeId;
                const bundleCooldownUntil = this.bundleCooldowns.get(bundleId) || 0;
                if (bundleCooldownUntil > now) continue;
                const entry = bundleMap.get(bundleId) || { energy: 0, nodes: [] };
                entry.energy += energy;
                entry.nodes.push({ nodeId, energy, evidenceSpanIds });
                bundleMap.set(bundleId, entry);
            }

            const bundles: V8ActivatedBundle[] = [];
            for (const [bundleId, entry] of bundleMap.entries()) {
                const energy = clamp01(entry.energy);
                const tier = tierOverride ?? scoreTier(energy, this.config);
                if (!tier) continue;
                const ordered = entry.nodes.sort((a, b) => b.energy - a.energy);
                const evidenceSpanIds = collectEvidence(ordered, 8);
                const nodeIds = ordered.map((node) => node.nodeId);
                bundles.push({
                    bundleId,
                    nodeIds,
                    tier,
                    energy,
                    evidenceSpanIds,
                    ...(wave ? { wave } : {}),
                });
            }

            return bundles
                .sort((a, b) => b.energy - a.energy)
                .slice(0, this.config.maxInjectedBundles);
        };

        let topBundles = this.selectBundlesWithDiversity(buildBundles(this.mode, 0.05));
        topBundles = this.mergeGroupBundles(topBundles, now);

        if (topBundles.length === 0) {
            this.spreadActivation("oblique");
            topBundles = this.selectBundlesWithDiversity(buildBundles(
                "oblique",
                this.config.secondWaveThreshold,
                "background",
                2
            ));
            topBundles = this.mergeGroupBundles(topBundles, now);
        }

        for (const bundle of topBundles) {
            for (const nodeId of bundle.nodeIds) {
                this.nodeCooldowns.set(nodeId, now + this.config.nodeCooldownMs);
            }
            this.bundleCooldowns.set(bundle.bundleId, now + this.config.bundleCooldownMs);
        }

        return { activatedBundles: topBundles, recentWindow: this.recentWindow };
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
            const coverage = overlapCount / Math.max(1, group.nodeIds.length);
            const jaccard =
                overlapCount /
                Math.max(1, baseNodeCount + group.nodeIds.length - overlapCount);
            const groupIrTokens = this.graph.groupBundleIrTokens.get(group.bundleId) || new Set<string>();
            const irSimilarity = symmetricOverlapScore(activeIrTokens, groupIrTokens);
            // Transparent score: overlap coverage + jaccard + IR-group similarity.
            const triggerScore = 0.5 * coverage + 0.3 * jaccard + 0.2 * irSimilarity;
            const hasSemanticFallback =
                this.config.groupAllowSemanticFallback &&
                baseBundles.length >= 2 &&
                irSimilarity >= this.config.groupTriggerScoreThreshold;
            if (triggerScore < this.config.groupTriggerScoreThreshold && !hasSemanticFallback) {
                continue;
            }

            let activationSum = 0;
            for (const nodeId of overlapNodeIds) {
                activationSum += this.activations.get(nodeId) || 0;
            }
            const meanActivation =
                overlapCount > 0 ? activationSum / overlapCount : baseEnergyAvg * 0.8;
            const energy = clamp01(
                meanActivation *
                    this.config.groupEnergyGain *
                    (0.7 + 0.3 * Math.max(triggerScore, irSimilarity))
            );

            const tier = scoreTier(energy, this.config);
            if (!tier) continue;

            extraBundles.push({
                bundleId: group.bundleId,
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

        const micros = sorted.filter((b) => b.bundleId.startsWith("micro_"));
        const groups = sorted.filter((b) => b.bundleId.startsWith("group_"));
        const selected: V8ActivatedBundle[] = [];
        const seen = new Set<string>();

        if (micros.length > 0) {
            selected.push(micros[0]!);
            seen.add(micros[0]!.bundleId);
        }
        if (groups.length > 0 && selected.length < limit) {
            selected.push(groups[0]!);
            seen.add(groups[0]!.bundleId);
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

    private applyReweight(mode: V8RecallMode): void {
        const edges = this.getReweightEdges(mode);
        if (edges.length === 0) return;

        const profileMode = mode === "profile" || mode === "oblique";
        const trajectoryMode = mode === "trajectory" || mode === "audit";
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
                    if (profileMode) {
                        pushDelta(edge.dst, -0.5 * srcEnergy);
                        pushDelta(edge.src, 0.1 * srcEnergy);
                    } else if (trajectoryMode) {
                        pushDelta(edge.dst, 0.3 * srcEnergy);
                        pushDelta(edge.src, 0.18 * dstEnergy);
                    }
                    break;
                }
                case "state_refines_state": {
                    if (profileMode) {
                        pushDelta(edge.dst, -0.3 * srcEnergy);
                        pushDelta(edge.src, 0.08 * srcEnergy);
                    } else if (trajectoryMode) {
                        pushDelta(edge.dst, 0.18 * srcEnergy);
                        pushDelta(edge.src, 0.12 * dstEnergy);
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

    private spreadActivation(modeOverride?: V8RecallMode): void {
        const mode = modeOverride || this.mode;
        const nextEnergy = new Map<string, number>();

        const degree = this.graph.degree;
        const { outgoing, incoming } = this.getRuntimeEdges(mode);

        for (const [nodeId, energy] of this.activations.entries()) {
            if (this.isNodeSuppressed(nodeId, mode)) {
                continue;
            }
            if (energy <= 0.05) continue;
            const nodePenalty = Math.pow(
                Math.max(1, degree.get(nodeId) || 1),
                this.config.hubPenaltyPower
            );

            const outEdges = outgoing.get(nodeId) || [];
            for (const entry of outEdges) {
                const canForward =
                    entry.direction === "bidirectional" || entry.direction === "up";
                if (!canForward) continue;
                if (this.isNodeSuppressed(entry.edge.dst, mode)) {
                    continue;
                }
                const transfer =
                    (energy * entry.weight * this.config.forwardGain) / nodePenalty;
                if (transfer <= 0) continue;
                nextEnergy.set(
                    entry.edge.dst,
                    (nextEnergy.get(entry.edge.dst) || 0) + transfer
                );
            }

            const inEdges = incoming.get(nodeId) || [];
            for (const entry of inEdges) {
                const canReverse =
                    entry.direction === "bidirectional" || entry.direction === "down";
                if (!canReverse) continue;
                if (this.isNodeSuppressed(entry.edge.src, mode)) {
                    continue;
                }
                const transfer =
                    (energy * entry.weight * this.config.reverseGain) / nodePenalty;
                if (transfer <= 0) continue;
                nextEnergy.set(
                    entry.edge.src,
                    (nextEnergy.get(entry.edge.src) || 0) + transfer
                );
            }
        }

        for (const [nodeId, energy] of nextEnergy.entries()) {
            this.activate(nodeId, energy);
        }

        this.applyReweight(mode);
    }

    private isNodeSuppressed(nodeId: string, mode: V8RecallMode): boolean {
        const node = this.graph.nodesById.get(nodeId);
        if (!node) return false;
        if (mode !== "trajectory" && mode !== "audit") {
            if (node.state?.validity === "superseded") {
                return true;
            }
        }

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
            return true;
        }
        for (const dayKey of dayKeys) {
            if (this.activeDayKeys.has(dayKey)) {
                return false;
            }
        }
        return true;
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
}
