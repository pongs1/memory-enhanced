import * as fs from "node:fs";
import {
    normalizeUserRequest,
    readEvents,
} from "../utils.js";
import { graphPaths } from "./paths.js";
import type {
    V8ActivatedBundle,
    V8ControlAnchors,
    V8DayIndex,
    V8HardCoreIndex,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8ScanResult,
    V8ScannerConfig,
    V8SceneSignal,
    V8SourceIndex,
    V8TriggerLexicon,
} from "./types.js";

interface LoadedGraphData {
    bundles: Map<string, V8MemoryBundle>;
    nodes: Map<string, V8MemoryNode>;
    adjacency: Map<string, V8MemoryEdge[]>;
    reverseAdjacency: Map<string, V8MemoryEdge[]>;
    triggerLexicon: V8TriggerLexicon;
    dayIndex: V8DayIndex;
    sourceIndex: V8SourceIndex;
    hardCoreIndex: V8HardCoreIndex;
}

function loadJson<T>(filePath: string, fallback: T): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
        return fallback;
    }
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

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function isBoundary(text: string): boolean {
    return /(\n\n|\n|```|[。！？!?](?:\s|$)|\.(?:\s|$)|:(?:\s|$)|;(?:\s|$)|,(?:\s|$))/.test(text);
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

function overlapScore(sourceText: string, referenceText: string): number {
    const sourceTokens = new Set(tokenize(sourceText));
    const referenceTokens = [...new Set(tokenize(referenceText))];
    if (sourceTokens.size === 0 || referenceTokens.length === 0) {
        return 0;
    }

    let matches = 0;
    for (const token of referenceTokens) {
        if (sourceTokens.has(token)) {
            matches += 1;
        }
    }
    return matches / referenceTokens.length;
}

function maxAnchorOverlap(text: string, anchors: V8ControlAnchors): number {
    return Math.max(
        overlapScore(text, anchors.goal || ""),
        overlapScore(text, anchors.activeTask || ""),
        overlapScore(text, anchors.latestUserRequest || "")
    );
}

function normalizeTrigger(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function topK<T>(
    values: T[],
    k: number,
    scoreFn: (value: T) => number
): T[] {
    return [...values]
        .sort((a, b) => scoreFn(b) - scoreFn(a))
        .slice(0, Math.max(0, k));
}

function scoreEdge(edge: V8MemoryEdge): number {
    return (
        edge.assocStrength *
        edge.utility *
        edge.trust *
        edge.freshness *
        edge.contextFit
    );
}

function bundleTier(
    bundle: V8MemoryBundle,
    bundleNodes: V8MemoryNode[],
    hardCoreIndex: V8HardCoreIndex
): V8ActivatedBundle["tier"] {
    const hardCoreIds = new Set([
        ...(hardCoreIndex.agent_identity_core || []),
        ...(hardCoreIndex.inter_agent_protocol_core || []),
    ]);

    if (bundleNodes.some((node) => hardCoreIds.has(node.id))) {
        return "critical";
    }

    const roles = new Set(bundleNodes.map((node) => node.role));
    if (
        roles.has("checkpoint") ||
        roles.has("constraint") ||
        (roles.has("workflow") && roles.has("constraint"))
    ) {
        return "critical";
    }

    if (roles.has("workflow") || roles.has("condition")) {
        return "decision";
    }

    return "background";
}

function scoreNodeSceneOverlap(node: V8MemoryNode, text: string): number {
    return overlapScore(
        text,
        `${node.text} ${node.summary} ${node.keywords.join(" ")}`
    );
}

function sceneSourceWeight(signal: V8SceneSignal): number {
    if (typeof signal.weight === "number") {
        return signal.weight;
    }

    switch (signal.source) {
        case "control":
            return 1.15;
        case "prompt":
            return 1.0;
        case "tool":
            return 1.05;
        case "event":
            return 0.9;
        default:
            return 0.85;
    }
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
    private readonly graph: LoadedGraphData;
    private readonly activations = new Map<string, number>();
    private readonly nodeCooldowns = new Map<string, number>();
    private readonly bundleCooldowns = new Map<string, number>();
    private readonly activeDayKeys = new Set<string>();
    private readonly sceneBiases = new Map<string, number>();
    private recentWindow = "";
    private charsSinceLastScan = 0;

    constructor(
        workspace: string,
        config: Partial<V8ScannerConfig> = {}
    ) {
        this.workspace = workspace;
        this.config = { ...DEFAULT_V8_SCANNER_CONFIG, ...config };
        this.graph = this.loadGraph();
    }

    private loadGraph(): LoadedGraphData {
        const gp = graphPaths(this.workspace);
        const bundles = loadJsonl<V8MemoryBundle>(gp.bundles);
        const nodes = [
            ...loadJsonl<V8MemoryNode>(gp.nodesEpisodic),
            ...loadJsonl<V8MemoryNode>(gp.nodesSemantic),
            ...loadJsonl<V8MemoryNode>(gp.nodesProcedural),
        ];
        const edges = [
            ...loadJsonl<V8MemoryEdge>(gp.edgesAssociative),
            ...loadJsonl<V8MemoryEdge>(gp.edgesStructural),
            ...loadJsonl<V8MemoryEdge>(gp.edgesSupersession),
        ];

        const adjacency = new Map<string, V8MemoryEdge[]>();
        const reverseAdjacency = new Map<string, V8MemoryEdge[]>();
        for (const edge of edges) {
            if (!adjacency.has(edge.src)) adjacency.set(edge.src, []);
            adjacency.get(edge.src)!.push(edge);
            if (!reverseAdjacency.has(edge.dst)) reverseAdjacency.set(edge.dst, []);
            reverseAdjacency.get(edge.dst)!.push(edge);
        }

        return {
            bundles: new Map(bundles.map((bundle) => [bundle.bundleId, bundle])),
            nodes: new Map(nodes.map((node) => [node.id, node])),
            adjacency,
            reverseAdjacency,
            triggerLexicon: loadJson<V8TriggerLexicon>(gp.triggerLexicon, {}),
            dayIndex: loadJson<V8DayIndex>(gp.dayIndex, {}),
            sourceIndex: loadJson<V8SourceIndex>(gp.sourceIndex, {}),
            hardCoreIndex: loadJson<V8HardCoreIndex>(gp.hardCoreIndex, {
                agent_identity_core: [],
                inter_agent_protocol_core: [],
            }),
        };
    }

    public preExcite(prompt: string, anchors: V8ControlAnchors): void {
        if (!prompt.trim()) return;
        this.injectFromText(prompt, anchors, true);
        this.spreadActivation();
    }

    public refreshScene(
        signals: V8SceneSignal[],
        anchors: V8ControlAnchors
    ): void {
        const usableSignals = signals
            .map((signal) => ({
                ...signal,
                text: normalizeTrigger(signal.text || ""),
            }))
            .filter((signal) => signal.text);
        if (usableSignals.length === 0) {
            return;
        }

        this.decaySceneBiases();

        for (const signal of usableSignals) {
            this.injectSceneSignal(signal, anchors);
        }

        this.applySceneField();
        this.spreadActivation();
    }

    public processChunk(delta: string, anchors: V8ControlAnchors): V8ScanResult {
        if (!delta) {
            return { activatedBundles: [], recentWindow: this.recentWindow };
        }

        this.charsSinceLastScan += delta.length;
        this.recentWindow = (
            this.recentWindow + delta
        ).slice(-Math.max(this.config.macroCharsZh, this.config.macroCharsEn));

        if (
            this.charsSinceLastScan < this.config.scanIntervalChars &&
            !isBoundary(delta)
        ) {
            return { activatedBundles: [], recentWindow: this.recentWindow };
        }

        this.charsSinceLastScan = 0;
        this.applyDecay();
        this.decaySceneBiases();
        this.injectFromText(this.recentWindow, anchors, false);
        this.applySceneField();
        this.spreadActivation();

        const activatedBundles = this.collectActivatedBundles();
        return { activatedBundles, recentWindow: this.recentWindow };
    }

    public getSourceIndex(): V8SourceIndex {
        return this.graph.sourceIndex;
    }

    public getBundle(bundleId: string): V8MemoryBundle | undefined {
        return this.graph.bundles.get(bundleId);
    }

    public getBundleNodes(bundleId: string): V8MemoryNode[] {
        const bundle = this.graph.bundles.get(bundleId);
        if (!bundle) return [];
        return bundle.nodeIds
            .map((nodeId) => this.graph.nodes.get(nodeId))
            .filter((node): node is V8MemoryNode => Boolean(node));
    }

    public getHardCoreIndex(): V8HardCoreIndex {
        return this.graph.hardCoreIndex;
    }

    private injectFromText(
        text: string,
        anchors: V8ControlAnchors,
        isInitialPrompt: boolean
    ) {
        const normalizedText = normalizeTrigger(text);
        const lexicalHits = new Set<string>();

        for (const [trigger, nodeIds] of Object.entries(this.graph.triggerLexicon)) {
            if (!trigger || !normalizedText.includes(trigger)) continue;
            for (const nodeId of nodeIds) {
                lexicalHits.add(nodeId);
            }
        }

        const overlappingNodes = topK(
            [...this.graph.nodes.values()]
                .map((node) => ({
                    node,
                    overlap: scoreNodeSceneOverlap(node, normalizedText),
                }))
                .filter((entry) => entry.overlap >= this.config.sceneOverlapThreshold),
            this.config.sceneTopKNodes,
            (entry) => entry.overlap
        );
        const candidateNodeIds = new Set<string>(lexicalHits);
        for (const entry of overlappingNodes) {
            candidateNodeIds.add(entry.node.id);
        }

        const now = Date.now();

        for (const nodeId of candidateNodeIds) {
            const node = this.graph.nodes.get(nodeId);
            if (!node) continue;

            const cooldownUntil = this.nodeCooldowns.get(nodeId) || 0;
            if (cooldownUntil > now) continue;

            if (node.kind === "episodic" && node.dayKey) {
                this.activeDayKeys.add(node.dayKey);
            }

            const gLex = lexicalHits.has(nodeId) ? 1 : 0;
            const gOverlap = scoreNodeSceneOverlap(node, normalizedText);
            const gCtrl = maxAnchorOverlap(
                `${node.text} ${node.summary}`,
                anchors
            );
            const gTime =
                node.kind !== "episodic"
                    ? 0.65
                    : node.dayKey && this.activeDayKeys.has(node.dayKey)
                        ? 1
                        : 0.2;
            const baseGain = isInitialPrompt ? 1.4 : 1;
            const energy =
                baseGain *
                (0.45 * gLex + 0.35 * Math.max(gOverlap, gCtrl) + 0.2 * gTime);
            this.activate(nodeId, energy);
        }
    }

    private injectSceneSignal(
        signal: V8SceneSignal & { text: string },
        anchors: V8ControlAnchors
    ): void {
        const lexicalHits = new Set<string>();
        for (const [trigger, nodeIds] of Object.entries(this.graph.triggerLexicon)) {
            if (!trigger || !signal.text.includes(trigger)) continue;
            for (const nodeId of nodeIds) {
                lexicalHits.add(nodeId);
            }
        }

        const overlappingNodes = topK(
            [...this.graph.nodes.values()]
                .map((node) => ({
                    node,
                    overlap: scoreNodeSceneOverlap(node, signal.text),
                }))
                .filter((entry) => entry.overlap >= this.config.sceneOverlapThreshold),
            this.config.sceneTopKNodes,
            (entry) => entry.overlap
        );

        const candidateNodeIds = new Set<string>(lexicalHits);
        for (const entry of overlappingNodes) {
            candidateNodeIds.add(entry.node.id);
        }

        for (const nodeId of candidateNodeIds) {
            const node = this.graph.nodes.get(nodeId);
            if (!node) continue;

            const lexicalScore = lexicalHits.has(nodeId) ? 1 : 0;
            const overlap = scoreNodeSceneOverlap(node, signal.text);
            const gCtrl = maxAnchorOverlap(
                `${node.text} ${node.summary}`,
                anchors
            );
            const gTime =
                node.kind !== "episodic"
                    ? 0.72
                    : node.dayKey && this.activeDayKeys.has(node.dayKey)
                        ? 1
                        : 0.3;
            const sourceWeight = sceneSourceWeight(signal);
            const bias =
                sourceWeight *
                this.config.sceneSignalGain *
                (0.6 * lexicalScore + 0.25 * Math.max(overlap, gCtrl) + 0.15 * gTime);

            if (bias <= 0.03) continue;

            if (node.kind === "episodic" && node.dayKey) {
                this.activeDayKeys.add(node.dayKey);
            }

            this.sceneBiases.set(
                nodeId,
                Math.min(1.25, (this.sceneBiases.get(nodeId) || 0) + bias)
            );
        }
    }

    private activate(nodeId: string, energy: number): void {
        this.activations.set(nodeId, (this.activations.get(nodeId) || 0) + energy);
    }

    private applySceneField(): void {
        const topSceneNodes = topK(
            [...this.sceneBiases.entries()],
            this.config.sceneTopKNodes,
            ([, energy]) => energy
        );

        for (const [nodeId, energy] of topSceneNodes) {
            const node = this.graph.nodes.get(nodeId);
            if (!node) continue;
            if (
                node.kind === "episodic" &&
                node.dayKey &&
                !this.activeDayKeys.has(node.dayKey)
            ) {
                continue;
            }

            this.activate(nodeId, energy * this.config.sceneCarryGain);
        }
    }

    private spreadActivation(): void {
        const spreadUpdates = new Map<string, number>();
        const degree = new Map<string, number>();

        for (const [src, edges] of this.graph.adjacency.entries()) {
            degree.set(src, edges.length);
            for (const edge of edges) {
                degree.set(edge.dst, (degree.get(edge.dst) || 0) + 1);
            }
        }

        for (const [nodeId, energy] of this.activations.entries()) {
            if (energy <= 0.08) continue;

            const forwardEdges = topK(
                this.graph.adjacency.get(nodeId) || [],
                this.config.topKEdges,
                scoreEdge
            );
            for (const edge of forwardEdges) {
                const penalty = Math.pow(
                    Math.max(1, degree.get(nodeId) || 1),
                    this.config.hubPenaltyPower
                );
                const transfer =
                    energy *
                    scoreEdge(edge) *
                    this.config.forwardGain /
                    penalty;
                spreadUpdates.set(
                    edge.dst,
                    (spreadUpdates.get(edge.dst) || 0) + transfer
                );
            }

            const reverseEdges = topK(
                this.graph.reverseAdjacency.get(nodeId) || [],
                this.config.topKEdges,
                scoreEdge
            );
            for (const edge of reverseEdges) {
                const penalty = Math.pow(
                    Math.max(1, degree.get(nodeId) || 1),
                    this.config.hubPenaltyPower
                );
                const transfer =
                    energy *
                    scoreEdge(edge) *
                    this.config.reverseGain /
                    penalty;
                spreadUpdates.set(
                    edge.src,
                    (spreadUpdates.get(edge.src) || 0) + transfer
                );
            }
        }

        for (const [nodeId, energy] of spreadUpdates.entries()) {
            const node = this.graph.nodes.get(nodeId);
            if (!node) continue;
            if (
                node.kind === "episodic" &&
                node.dayKey &&
                !this.activeDayKeys.has(node.dayKey)
            ) {
                continue;
            }
            this.activate(nodeId, energy);
        }
    }

    private applyDecay(): void {
        for (const [nodeId, energy] of this.activations.entries()) {
            const decayed = energy * this.config.decayLambda;
            if (decayed < 0.04) {
                this.activations.delete(nodeId);
            } else {
                this.activations.set(nodeId, decayed);
            }
        }
    }

    private decaySceneBiases(): void {
        for (const [nodeId, energy] of this.sceneBiases.entries()) {
            const decayed = energy * this.config.sceneDecayLambda;
            if (decayed < 0.03) {
                this.sceneBiases.delete(nodeId);
            } else {
                this.sceneBiases.set(nodeId, decayed);
            }
        }
    }

    private collectActivatedBundles(): V8ActivatedBundle[] {
        const bundleEnergy = new Map<string, number>();
        const bundleNodeIds = new Map<string, Set<string>>();
        const now = Date.now();

        const candidateNodeIds = new Set<string>([
            ...this.activations.keys(),
            ...this.sceneBiases.keys(),
        ]);

        for (const nodeId of candidateNodeIds) {
            const node = this.graph.nodes.get(nodeId);
            if (!node) continue;

            const activationEnergy = this.activations.get(nodeId) || 0;
            const sceneEnergy =
                (this.sceneBiases.get(nodeId) || 0) * this.config.sceneBundleBiasGain;
            const energy = activationEnergy + sceneEnergy;
            if (energy <= 0) continue;

            const bundle = this.graph.bundles.get(node.bundleId);
            if (!bundle) continue;

            const existingEnergy = bundleEnergy.get(bundle.bundleId) || 0;
            bundleEnergy.set(bundle.bundleId, Math.max(existingEnergy, energy));

            if (!bundleNodeIds.has(bundle.bundleId)) {
                bundleNodeIds.set(bundle.bundleId, new Set());
            }
            bundleNodeIds.get(bundle.bundleId)!.add(nodeId);
        }

        const ranked: V8ActivatedBundle[] = [];
        for (const [bundleId, energy] of bundleEnergy.entries()) {
            const cooldownUntil = this.bundleCooldowns.get(bundleId) || 0;
            if (cooldownUntil > now) continue;

            const bundle = this.graph.bundles.get(bundleId);
            if (!bundle) continue;

            const bundleNodes = this.getBundleNodes(bundleId);
            const tier = bundleTier(bundle, bundleNodes, this.graph.hardCoreIndex);
            const threshold =
                tier === "critical"
                    ? this.config.criticalThreshold
                    : tier === "decision"
                        ? this.config.decisionThreshold
                        : this.config.backgroundThreshold;

            if (energy < threshold) continue;

            ranked.push({
                bundleId,
                energy: clamp01(energy),
                tier,
                nodeIds: [...(bundleNodeIds.get(bundleId) || new Set<string>())],
            });
        }

        const selected = topK(
            ranked,
            this.config.maxInjectedBundles,
            (bundle) => bundle.energy
        );

        for (const hit of selected) {
            this.bundleCooldowns.set(
                hit.bundleId,
                now + this.config.bundleCooldownMs
            );
            for (const nodeId of hit.nodeIds) {
                this.nodeCooldowns.set(
                    nodeId,
                    now + this.config.nodeCooldownMs
                );
            }
        }

        return selected;
    }
}
