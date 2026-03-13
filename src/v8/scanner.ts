import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../utils.js";
import { loadEdgeRuntimePolicy } from "./edge-runtime-policy.js";
import { getNodeFeedbackBias, refreshFeedbackStore } from "./feedback-store.js";
import { v8StorePaths } from "./paths_v8.js";
import type {
    V8ActivatedBundle,
    V8ControlAnchors,
    V8EdgeCatalogEntry,
    V8EdgeRuntimePolicyEntry,
    V8GraphEdge,
    V8GraphNode,
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
    edges: V8GraphEdge[];
    adjacency: Map<string, V8GraphEdge[]>;
    reverseAdjacency: Map<string, V8GraphEdge[]>;
    nodeTokens: Map<string, Set<string>>;
    edgeKinds: Map<string, V8EdgeCatalogEntry["kind"]>;
    policyByKindMode: Map<string, V8EdgeRuntimePolicyEntry>;
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
        const edges = loadJsonl<V8GraphEdge>(store.graphEdges);

        const nodesById = new Map<string, V8GraphNode>();
        const nodeTokens = new Map<string, Set<string>>();
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
            nodeTokens.set(node.id, new Set(tokens));
        }

        const adjacency = new Map<string, V8GraphEdge[]>();
        const reverseAdjacency = new Map<string, V8GraphEdge[]>();
        for (const edge of edges) {
            if (!adjacency.has(edge.src)) adjacency.set(edge.src, []);
            adjacency.get(edge.src)!.push(edge);
            if (!reverseAdjacency.has(edge.dst)) reverseAdjacency.set(edge.dst, []);
            reverseAdjacency.get(edge.dst)!.push(edge);
        }

        const edgeKinds = loadEdgeCatalog();
        const policyByKindMode = buildPolicyMap(loadEdgeRuntimePolicy());

        return {
            nodesById,
            edges,
            adjacency,
            reverseAdjacency,
            nodeTokens,
            edgeKinds,
            policyByKindMode,
        };
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

        for (const [nodeId, tokens] of this.graph.nodeTokens.entries()) {
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
        for (const [nodeId, nodeTokens] of this.graph.nodeTokens.entries()) {
            const overlap = overlapScore(tokens, nodeTokens);
            if (overlap <= 0) continue;
            const bias = this.sceneBiases.get(nodeId) || 0;
            const feedbackBias = getNodeFeedbackBias(nodeId);
            const energy = clamp01(overlap + bias + feedbackBias);
            this.activate(nodeId, energy);
        }

        this.spreadActivation();

        const now = nowMs();
        const candidates: V8ActivatedBundle[] = [];
        for (const [nodeId, energy] of this.activations.entries()) {
            const tier = scoreTier(energy, this.config);
            if (!tier) continue;
            const cooldownUntil = this.nodeCooldowns.get(nodeId) || 0;
            if (cooldownUntil > now) continue;

            const node = this.graph.nodesById.get(nodeId);
            if (!node) continue;
            const evidenceSpanIds =
                node.bestEvidenceSpanIds.length > 0
                    ? node.bestEvidenceSpanIds
                    : node.evidenceSpanIds;

            candidates.push({
                bundleId: nodeId,
                nodeIds: [nodeId],
                tier,
                energy,
                evidenceSpanIds,
            });
        }

        let topBundles = candidates
            .sort((a, b) => b.energy - a.energy)
            .slice(0, this.config.maxInjectedBundles);

        if (topBundles.length === 0) {
            this.spreadActivation("oblique");
            const obliqueCandidates: V8ActivatedBundle[] = [];
            for (const [nodeId, energy] of this.activations.entries()) {
                if (energy < this.config.secondWaveThreshold) continue;
                const cooldownUntil = this.nodeCooldowns.get(nodeId) || 0;
                if (cooldownUntil > now) continue;
                const node = this.graph.nodesById.get(nodeId);
                if (!node) continue;
                const evidenceSpanIds =
                    node.bestEvidenceSpanIds.length > 0
                        ? node.bestEvidenceSpanIds
                        : node.evidenceSpanIds;
                obliqueCandidates.push({
                    bundleId: nodeId,
                    nodeIds: [nodeId],
                    tier: "background",
                    energy,
                    evidenceSpanIds,
                    wave: 2,
                });
            }
            topBundles = obliqueCandidates
                .sort((a, b) => b.energy - a.energy)
                .slice(0, this.config.maxInjectedBundles);
        }

        for (const bundle of topBundles) {
            this.nodeCooldowns.set(bundle.bundleId, now + this.config.nodeCooldownMs);
            this.bundleCooldowns.set(bundle.bundleId, now + this.config.bundleCooldownMs);
        }

        return { activatedBundles: topBundles, recentWindow: this.recentWindow };
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

    private spreadActivation(modeOverride?: V8RecallMode): void {
        const mode = modeOverride || this.mode;
        const nextEnergy = new Map<string, number>();
        const degree = new Map<string, number>();

        for (const edge of this.graph.edges) {
            degree.set(edge.src, (degree.get(edge.src) || 0) + 1);
            degree.set(edge.dst, (degree.get(edge.dst) || 0) + 1);
        }

        for (const edge of this.graph.edges) {
            const kind = this.graph.edgeKinds.get(edge.type) || "semantic";
            const policy =
                this.graph.policyByKindMode.get(policyKey(kind, mode));
            if (!policy || policy.role !== "spread") {
                continue;
            }

            const weight = clamp01(edge.confidence ?? 0.6) * policy.gain;

            const srcEnergy = this.activations.get(edge.src) || 0;
            const dstEnergy = this.activations.get(edge.dst) || 0;

            const srcPenalty = Math.pow(Math.max(1, degree.get(edge.src) || 1), this.config.hubPenaltyPower);
            const dstPenalty = Math.pow(Math.max(1, degree.get(edge.dst) || 1), this.config.hubPenaltyPower);

            const canForward = policy.direction === "bidirectional" || policy.direction === "up";
            const canReverse = policy.direction === "bidirectional" || policy.direction === "down";

            if (canForward && srcEnergy > 0.05) {
                const transfer = (srcEnergy * weight * this.config.forwardGain) / srcPenalty;
                nextEnergy.set(edge.dst, (nextEnergy.get(edge.dst) || 0) + transfer);
            }
            if (canReverse && dstEnergy > 0.05) {
                const transfer = (dstEnergy * weight * this.config.reverseGain) / dstPenalty;
                nextEnergy.set(edge.src, (nextEnergy.get(edge.src) || 0) + transfer);
            }
        }

        for (const [nodeId, energy] of nextEnergy.entries()) {
            this.activate(nodeId, energy);
        }
    }
}
