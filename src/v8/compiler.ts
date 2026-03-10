import * as fs from "node:fs";
import * as path from "node:path";
import {
    ensureDir,
    nowISO,
    readEvents,
    resolveWorkspace,
    type MemoryEvent,
} from "../utils.js";
import { compileEventToBundle } from "./compile-event.js";
import { compileKnowledgeMdToBundles } from "./compile-knowledge-md.js";
import { buildDayIndex, buildHardCoreIndex, buildSourceIndex, buildTriggerLexicon } from "./indexes.js";
import { ensureGraphManifest, writeGraphManifest } from "./manifest.js";
import { ensureGraphDirs, graphPaths } from "./paths.js";
import type {
    BuildGraphInput,
    BuildGraphOutput,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8ExplorationConfig,
    V8OfflineAnnotationRecord,
    V8SanitizedAnnotationBundleDraft,
} from "./types.js";

export const DEFAULT_V8_EXPLORATION_CONFIG: V8ExplorationConfig = {
    enabled: false,
    mode: "global_random",
    newEdgeProbability: 0.004,
    weightJitterProbability: 0.015,
    weightJitterDelta: 0.03,
    maxNewEdges: 4,
    minNewEdgeWeight: 0.04,
    maxNewEdgeWeight: 0.12,
};

function sanitizeText(text: string, maxChars = 220): string {
    return (text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function detectLanguage(text: string): "zh" | "en" | "mixed" | "unknown" {
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;
    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > 0 && enCount > 0) return "mixed";
    return zhCount > 0 ? "zh" : "en";
}

function extractKeywords(text: string, maxItems = 12): string[] {
    const englishWords = text.toLowerCase().match(/[a-z0-9/_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const raw = [...englishWords, ...cjkChunks];
    const seen = new Set<string>();
    const output: string[] = [];

    for (const item of raw) {
        const normalized = sanitizeText(item, 48).toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(normalized);
        if (output.length >= maxItems) break;
    }

    return output;
}

function readJsonlRecords<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function collectJsonlFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    return fs
        .readdirSync(dirPath)
        .filter((file) => file.endsWith(".jsonl"))
        .sort()
        .map((file) => path.join(dirPath, file));
}

function collectMarkdownFiles(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    return fs
        .readdirSync(dirPath)
        .filter((file) => file.endsWith(".md"))
        .sort()
        .map((file) => path.join(dirPath, file));
}

function appendJsonl<T>(filePath: string, items: T[]): void {
    if (items.length === 0) {
        fs.writeFileSync(filePath, "", "utf-8");
        return;
    }
    const content = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf-8");
}

function dedupeBundles(bundles: V8MemoryBundle[]): V8MemoryBundle[] {
    const seen = new Map<string, V8MemoryBundle>();
    for (const bundle of bundles) {
        seen.set(bundle.bundleId, bundle);
    }
    return [...seen.values()];
}

function dedupeNodes(nodes: V8MemoryNode[]): V8MemoryNode[] {
    const seen = new Map<string, V8MemoryNode>();
    for (const node of nodes) {
        seen.set(node.id, node);
    }
    return [...seen.values()];
}

function dedupeEdges(edges: V8MemoryEdge[]): V8MemoryEdge[] {
    const seen = new Map<string, V8MemoryEdge>();
    for (const edge of edges) {
        seen.set(edge.id, edge);
    }
    return [...seen.values()];
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function buildAnnotatedNodeId(bundleId: string, role: string, index: number): string {
    return `mn_${bundleId}_ann_${role}_${index + 1}`;
}

function buildAnnotatedEdgeId(bundleId: string, type: string, index: number): string {
    return `me_${bundleId}_ann_${type}_${index + 1}`;
}

function materializeAnnotatedDraft(
    draft: V8SanitizedAnnotationBundleDraft,
    existingBundle: V8MemoryBundle,
    annotatedAt: string
): { bundle: V8MemoryBundle; nodes: V8MemoryNode[]; edges: V8MemoryEdge[] } {
    const nodes = draft.nodes.map((node, index) => {
        const text = sanitizeText(node.text, 220);
        return {
            id: buildAnnotatedNodeId(existingBundle.bundleId, node.role, index),
            bundleId: existingBundle.bundleId,
            kind: node.kind,
            role: node.role,
            names: node.names,
            aliases: node.aliases,
            text,
            summary: sanitizeText(node.summary, 120),
            keywords: extractKeywords(`${node.names.zh} ${node.names.en} ${text}`),
            language: detectLanguage(`${node.names.zh} ${node.names.en} ${text}`),
            sourceRef: existingBundle.sourceRef,
            canonicalRef: draft.canonicalRef,
            confidence: node.confidence,
            importance: node.importance,
            hitCount: 0,
            adoptCount: 0,
            rejectCount: 0,
            harmCount: 0,
            lastUsedAt: null,
            lastVerifiedAt: annotatedAt,
            cooldownUntil: null,
            dayKey: draft.dayKey,
            episodeKey: draft.episodeKey,
        } satisfies V8MemoryNode;
    });

    const firstByRole = new Map<string, string>();
    for (const node of nodes) {
        if (!firstByRole.has(node.role)) {
            firstByRole.set(node.role, node.id);
        }
    }

    const edges = draft.edges
        .map((edge, index): V8MemoryEdge | null => {
            const src = firstByRole.get(edge.srcRole);
            const dst = firstByRole.get(edge.dstRole);
            if (!src || !dst) {
                return null;
            }
            return {
                id: buildAnnotatedEdgeId(existingBundle.bundleId, edge.type, index),
                type: edge.type,
                src,
                dst,
                assocStrength: edge.assocStrength,
                utility: edge.utility,
                trust: edge.trust,
                freshness: edge.freshness,
                contextFit: edge.contextFit,
                evidenceCount: edge.evidenceCount,
                activationCount: 0,
                adoptCount: 0,
                rejectCount: 0,
                lastUpdatedAt: annotatedAt,
                lastVerifiedAt: annotatedAt,
            };
        })
        .filter((edge): edge is V8MemoryEdge => Boolean(edge));

    const bundle: V8MemoryBundle = {
        ...existingBundle,
        kind: draft.kind,
        title: draft.title,
        nodeIds: nodes.map((node) => node.id),
        canonicalRef: draft.canonicalRef,
        summaryRef: draft.summaryRef,
        dayKey: draft.dayKey,
        episodeKey: draft.episodeKey,
        encodingContext: draft.encodingContext,
        updatedAt: annotatedAt || nowISO(),
    };

    return { bundle, nodes, edges };
}

function applyOfflineAnnotationDrafts(
    workspace: string,
    bundles: V8MemoryBundle[],
    nodes: V8MemoryNode[],
    edges: V8MemoryEdge[]
): { bundles: V8MemoryBundle[]; nodes: V8MemoryNode[]; edges: V8MemoryEdge[] } {
    const gp = graphPaths(workspace);
    const records = readJsonlRecords<V8OfflineAnnotationRecord>(gp.offlineAnnotationDrafts);
    if (records.length === 0) {
        return { bundles, nodes, edges };
    }

    const bundleMap = new Map(bundles.map((bundle) => [bundle.bundleId, bundle]));
    const oldNodeIdsByBundle = new Map<string, Set<string>>();
    for (const node of nodes) {
        const set = oldNodeIdsByBundle.get(node.bundleId) || new Set<string>();
        set.add(node.id);
        oldNodeIdsByBundle.set(node.bundleId, set);
    }

    let nextNodes = [...nodes];
    let nextEdges = [...edges];

    for (const record of records) {
        const existingBundle = bundleMap.get(record.bundleId);
        if (!existingBundle) {
            continue;
        }

        const oldNodeIds = oldNodeIdsByBundle.get(record.bundleId) || new Set<string>();
        nextNodes = nextNodes.filter((node) => node.bundleId !== record.bundleId);
        nextEdges = nextEdges.filter((edge) => !oldNodeIds.has(edge.src) && !oldNodeIds.has(edge.dst));

        const materialized = materializeAnnotatedDraft(
            record.sanitizedDraft,
            existingBundle,
            record.createdAt
        );
        bundleMap.set(record.bundleId, materialized.bundle);
        nextNodes.push(...materialized.nodes);
        nextEdges.push(...materialized.edges);
    }

    return {
        bundles: [...bundleMap.values()],
        nodes: nextNodes,
        edges: nextEdges,
    };
}

function buildEdgeKey(src: string, dst: string, type: string): string {
    return `${src}->${dst}:${type}`;
}

function randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function buildUndirectedEdgeKey(src: string, dst: string, type: string): string {
    return src < dst ? `${src}<->${dst}:${type}` : `${dst}<->${src}:${type}`;
}

function buildNodeDegreeMap(edges: V8MemoryEdge[]): Map<string, { total: number; associative: number }> {
    const degreeMap = new Map<string, { total: number; associative: number }>();
    const touch = (nodeId: string, edgeType: V8MemoryEdge["type"]) => {
        const current = degreeMap.get(nodeId) || { total: 0, associative: 0 };
        current.total += 1;
        if (edgeType === "associative") {
            current.associative += 1;
        }
        degreeMap.set(nodeId, current);
    };

    for (const edge of edges) {
        touch(edge.src, edge.type);
        touch(edge.dst, edge.type);
    }

    return degreeMap;
}

function nodeSparsityScore(
    nodeId: string,
    degreeMap: Map<string, { total: number; associative: number }>,
    maxAssociativeDegree: number,
    maxTotalDegree: number
): number {
    const degree = degreeMap.get(nodeId) || { total: 0, associative: 0 };
    const assocDensity = maxAssociativeDegree > 0 ? degree.associative / maxAssociativeDegree : 0;
    const totalDensity = maxTotalDegree > 0 ? degree.total / maxTotalDegree : 0;
    const blendedDensity = assocDensity * 0.7 + totalDensity * 0.3;
    return clamp01(1 - blendedDensity);
}

function pickNodeWeightedBySparsity(
    candidates: V8MemoryNode[],
    scores: Map<string, number>
): V8MemoryNode | null {
    if (candidates.length === 0) return null;
    const weighted = candidates.map((node) => ({
        node,
        weight: Math.max(0.05, scores.get(node.id) ?? 0.5),
    }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let cursor = Math.random() * total;
    for (const item of weighted) {
        cursor -= item.weight;
        if (cursor <= 0) {
            return item.node;
        }
    }
    return weighted[weighted.length - 1]?.node || null;
}

function applyExplorationPerturbation(
    bundles: V8MemoryBundle[],
    nodes: V8MemoryNode[],
    edges: V8MemoryEdge[],
    config: V8ExplorationConfig
): { edges: V8MemoryEdge[]; stats: { addedEdges: number; jitteredEdges: number } } {
    if (!config.enabled || config.mode === "disabled") {
        return { edges, stats: { addedEdges: 0, jitteredEdges: 0 } };
    }

    if (config.mode === "sparse_biased") {
        return applySparseBiasedExplorationPerturbation(bundles, nodes, edges, config);
    }

    return applyGlobalExplorationPerturbation(bundles, nodes, edges, config);
}

function applyGlobalExplorationPerturbation(
    bundles: V8MemoryBundle[],
    nodes: V8MemoryNode[],
    edges: V8MemoryEdge[],
    config: V8ExplorationConfig
): { edges: V8MemoryEdge[]; stats: { addedEdges: number; jitteredEdges: number } } {
    let jitteredEdges = 0;
    const nextEdges = edges.map((edge) => {
        if (edge.type !== "associative") {
            return edge;
        }
        if (Math.random() > config.weightJitterProbability) {
            return edge;
        }

        const delta = randomBetween(-config.weightJitterDelta, config.weightJitterDelta);
        jitteredEdges += 1;
        return {
            ...edge,
            assocStrength: clamp01(edge.assocStrength + delta),
            utility: clamp01(edge.utility + delta * 0.8),
            contextFit: clamp01(edge.contextFit + delta * 0.6),
            lastUpdatedAt: nowISO(),
        };
    });

    const bundleById = new Map(bundles.map((bundle) => [bundle.bundleId, bundle]));
    const existingKeys = new Set(nextEdges.map((edge) => buildEdgeKey(edge.src, edge.dst, edge.type)));
    const eligibleNodes = nodes.filter((node) =>
        node.importance >= 0.55 &&
        node.confidence >= 0.55 &&
        Boolean(node.text)
    );
    const addedEdges: V8MemoryEdge[] = [];
    const maxAttempts = Math.max(config.maxNewEdges * 20, eligibleNodes.length * 2);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (addedEdges.length >= config.maxNewEdges) {
            break;
        }
        if (Math.random() > config.newEdgeProbability) {
            continue;
        }
        if (eligibleNodes.length < 2) {
            break;
        }

        const src = eligibleNodes[Math.floor(Math.random() * eligibleNodes.length)];
        const dst = eligibleNodes[Math.floor(Math.random() * eligibleNodes.length)];
        if (!src || !dst || src.id === dst.id) continue;
        if (src.bundleId === dst.bundleId) continue;
        const srcBundle = bundleById.get(src.bundleId);
        const dstBundle = bundleById.get(dst.bundleId);
        if (srcBundle?.sourceRef === dstBundle?.sourceRef) continue;

        const key = buildEdgeKey(src.id, dst.id, "associative");
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);

        const baseWeight = randomBetween(config.minNewEdgeWeight, config.maxNewEdgeWeight);
        addedEdges.push({
            id: `me_explore_${src.id}_${dst.id}_${attempt + 1}`,
            type: "associative",
            src: src.id,
            dst: dst.id,
            assocStrength: baseWeight,
            utility: clamp01(baseWeight * 0.9),
            trust: clamp01(baseWeight * 0.8),
            freshness: 0.72,
            contextFit: clamp01(baseWeight * 0.85),
            evidenceCount: 1,
            activationCount: 0,
            adoptCount: 0,
            rejectCount: 0,
            lastUpdatedAt: nowISO(),
            lastVerifiedAt: null,
        });
    }

    return {
        edges: [...nextEdges, ...addedEdges],
        stats: {
            addedEdges: addedEdges.length,
            jitteredEdges,
        },
    };
}

function applySparseBiasedExplorationPerturbation(
    bundles: V8MemoryBundle[],
    nodes: V8MemoryNode[],
    edges: V8MemoryEdge[],
    config: V8ExplorationConfig
): { edges: V8MemoryEdge[]; stats: { addedEdges: number; jitteredEdges: number } } {
    const degreeMap = buildNodeDegreeMap(edges);
    const maxAssociativeDegree = Math.max(
        0,
        ...[...degreeMap.values()].map((entry) => entry.associative)
    );
    const maxTotalDegree = Math.max(
        0,
        ...[...degreeMap.values()].map((entry) => entry.total)
    );
    const sparsityScores = new Map(
        nodes.map((node) => [
            node.id,
            nodeSparsityScore(node.id, degreeMap, maxAssociativeDegree, maxTotalDegree),
        ])
    );
    const bundleById = new Map(bundles.map((bundle) => [bundle.bundleId, bundle]));

    let jitteredEdges = 0;
    const nextEdges = edges.map((edge) => {
        if (edge.type !== "associative") {
            return edge;
        }
        const localSparsity = (
            (sparsityScores.get(edge.src) ?? 0.5) +
            (sparsityScores.get(edge.dst) ?? 0.5)
        ) / 2;
        const effectiveProbability = clamp01(
            config.weightJitterProbability * (0.65 + localSparsity * 0.9)
        );
        if (Math.random() > effectiveProbability) {
            return edge;
        }

        let delta: number;
        if (localSparsity <= 0.3) {
            delta = randomBetween(-config.weightJitterDelta, config.weightJitterDelta * 0.2);
        } else if (localSparsity >= 0.7) {
            delta = randomBetween(-config.weightJitterDelta * 0.25, config.weightJitterDelta);
        } else {
            delta = randomBetween(-config.weightJitterDelta * 0.6, config.weightJitterDelta * 0.6);
        }
        jitteredEdges += 1;
        return {
            ...edge,
            assocStrength: clamp01(edge.assocStrength + delta),
            utility: clamp01(edge.utility + delta * 0.8),
            contextFit: clamp01(edge.contextFit + delta * 0.6),
            lastUpdatedAt: nowISO(),
        };
    });

    const existingKeys = new Set(
        nextEdges
            .filter((edge) => edge.type === "associative")
            .map((edge) => buildUndirectedEdgeKey(edge.src, edge.dst, edge.type))
    );
    const eligibleNodes = nodes.filter((node) =>
        node.importance >= 0.55 &&
        node.confidence >= 0.55 &&
        Boolean(node.text)
    );
    const addedEdges: V8MemoryEdge[] = [];
    const maxAttempts = Math.max(config.maxNewEdges * 20, eligibleNodes.length * 2);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (addedEdges.length >= config.maxNewEdges) {
            break;
        }
        if (Math.random() > config.newEdgeProbability) {
            continue;
        }
        if (eligibleNodes.length < 2) {
            break;
        }

        const src = pickNodeWeightedBySparsity(eligibleNodes, sparsityScores);
        const dst = pickNodeWeightedBySparsity(eligibleNodes, sparsityScores);
        if (!src || !dst || src.id === dst.id) continue;
        if (src.bundleId === dst.bundleId) continue;
        const srcBundle = bundleById.get(src.bundleId);
        const dstBundle = bundleById.get(dst.bundleId);
        if (srcBundle?.sourceRef === dstBundle?.sourceRef) continue;
        const pairSparsity = ((sparsityScores.get(src.id) ?? 0.5) + (sparsityScores.get(dst.id) ?? 0.5)) / 2;
        if (pairSparsity < 0.28) continue;

        const key = buildUndirectedEdgeKey(src.id, dst.id, "associative");
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);

        const sparseLift = 0.7 + pairSparsity * 0.6;
        const minWeight = config.minNewEdgeWeight;
        const maxWeight = Math.max(
            minWeight,
            config.minNewEdgeWeight + (config.maxNewEdgeWeight - config.minNewEdgeWeight) * sparseLift
        );
        const baseWeight = randomBetween(minWeight, maxWeight);
        addedEdges.push({
            id: `me_explore_${src.id}_${dst.id}_${attempt + 1}`,
            type: "associative",
            src: src.id,
            dst: dst.id,
            assocStrength: baseWeight,
            utility: clamp01(baseWeight * 0.9),
            trust: clamp01(baseWeight * 0.8),
            freshness: 0.72,
            contextFit: clamp01(baseWeight * 0.85),
            evidenceCount: 1,
            activationCount: 0,
            adoptCount: 0,
            rejectCount: 0,
            lastUpdatedAt: nowISO(),
            lastVerifiedAt: null,
        });
    }

    return {
        edges: [...nextEdges, ...addedEdges],
        stats: {
            addedEdges: addedEdges.length,
            jitteredEdges,
        },
    };
}

function persistGraph(output: BuildGraphOutput, workspace: string) {
    const gp = ensureGraphDirs(workspace);
    const episodicNodes = output.nodes.filter((node) => node.kind === "episodic");
    const semanticNodes = output.nodes.filter((node) => node.kind === "semantic");
    const proceduralNodes = output.nodes.filter((node) => node.kind === "procedural");
    const associativeEdges = output.edges.filter((edge) => edge.type === "associative");
    const supersessionEdges = output.edges.filter((edge) => edge.type === "supersedes");
    const structuralEdges = output.edges.filter((edge) => edge.type !== "associative" && edge.type !== "supersedes");

    appendJsonl(gp.bundles, output.bundles);
    appendJsonl(gp.nodesEpisodic, episodicNodes);
    appendJsonl(gp.nodesSemantic, semanticNodes);
    appendJsonl(gp.nodesProcedural, proceduralNodes);
    appendJsonl(gp.edgesAssociative, associativeEdges);
    appendJsonl(gp.edgesStructural, structuralEdges);
    appendJsonl(gp.edgesSupersession, supersessionEdges);
    fs.writeFileSync(gp.updateQueue, "", "utf-8");
    fs.writeFileSync(gp.triggerLexicon, JSON.stringify(output.triggerLexicon, null, 2), "utf-8");
    fs.writeFileSync(gp.dayIndex, JSON.stringify(output.dayIndex, null, 2), "utf-8");
    fs.writeFileSync(gp.sourceIndex, JSON.stringify(output.sourceIndex, null, 2), "utf-8");
    fs.writeFileSync(gp.hardCoreIndex, JSON.stringify(output.hardCoreIndex, null, 2), "utf-8");
    fs.writeFileSync(gp.embeddingIds, JSON.stringify([], null, 2), "utf-8");
    fs.writeFileSync(gp.embeddingMetadata, JSON.stringify({ items: 0 }, null, 2), "utf-8");
    if (!fs.existsSync(gp.embeddingVectors)) {
        fs.writeFileSync(gp.embeddingVectors, "", "utf-8");
    }

    return writeGraphManifest(workspace, {
        updatedAt: new Date().toISOString(),
        lastFullRebuildAt: new Date().toISOString(),
    });
}

export async function buildV8Graph(
    input: BuildGraphInput
): Promise<BuildGraphOutput> {
    const workspace = resolveWorkspace(input.workspace);
    const includeEvents = input.includeEvents ?? true;
    const includeKnowledgeMd = input.includeKnowledgeMd ?? true;
    const includeSkillMd = input.includeSkillMd ?? false;
    const writeToDisk = input.writeToDisk ?? false;
    const exploration = {
        ...DEFAULT_V8_EXPLORATION_CONFIG,
        ...(input.exploration || {}),
    };

    const basePaths = graphPaths(workspace);
    ensureDir(basePaths.graphDir);
    ensureDir(basePaths.embeddingIndexDir);

    const bundles: V8MemoryBundle[] = [];
    const nodes: V8MemoryNode[] = [];
    const edges: V8MemoryEdge[] = [];

    if (includeEvents) {
        const eventFiles = collectJsonlFiles(path.join(workspace, ".memory", "events"));
        for (const eventFile of eventFiles) {
            const eventList = readEvents(eventFile);
            for (const event of eventList) {
                const compiled = compileEventToBundle({ workspace, event: event as MemoryEvent });
                bundles.push(compiled.bundle);
                nodes.push(...compiled.nodes);
                edges.push(...compiled.edges);
            }
        }
    }

    if (includeKnowledgeMd) {
        const knowledgeFiles = collectMarkdownFiles(path.join(workspace, "memory", "knowledge"));
        for (const filePath of knowledgeFiles) {
            const compiled = compileKnowledgeMdToBundles({ workspace, filePath });
            bundles.push(...compiled.bundles);
            nodes.push(...compiled.nodes);
            edges.push(...compiled.edges);
        }
    }

    if (includeSkillMd) {
        const skillsDir = path.join(workspace, "memory", "skills");
        const verifiedDir = path.join(skillsDir, "verified");
        const draftDir = path.join(skillsDir, "drafts");
        for (const root of [verifiedDir, draftDir]) {
            const files = collectMarkdownFiles(root);
            for (const filePath of files) {
                const compiled = compileKnowledgeMdToBundles({ workspace, filePath });
                bundles.push(
                    ...compiled.bundles.map((bundle) => ({
                        ...bundle,
                        sourceType: "skill_md" as const,
                        kind: bundle.kind === "episodic" ? "procedural" : bundle.kind,
                    }))
                );
                nodes.push(
                    ...compiled.nodes.map((node) => ({
                        ...node,
                        kind: node.kind === "episodic" ? "procedural" : node.kind,
                    }))
                );
                edges.push(...compiled.edges);
            }
        }
    }

    const withAnnotations = applyOfflineAnnotationDrafts(workspace, bundles, nodes, edges);
    const withExploration = applyExplorationPerturbation(
        withAnnotations.bundles,
        withAnnotations.nodes,
        withAnnotations.edges,
        exploration
    );
    const finalBundles = dedupeBundles(withAnnotations.bundles);
    const finalNodes = dedupeNodes(withAnnotations.nodes);
    const finalEdges = dedupeEdges(withExploration.edges);
    const triggerLexicon = buildTriggerLexicon(finalNodes);
    const dayIndex = buildDayIndex(finalNodes);
    const sourceIndex = buildSourceIndex(finalBundles);
    const hardCoreIndex = buildHardCoreIndex(finalNodes);
    let manifest = ensureGraphManifest(workspace);

    const output: BuildGraphOutput = {
        manifest,
        bundles: finalBundles,
        nodes: finalNodes,
        edges: finalEdges,
        triggerLexicon,
        dayIndex,
        sourceIndex,
        hardCoreIndex,
        explorationStats: withExploration.stats,
    };

    if (writeToDisk) {
        manifest = persistGraph(output, workspace);
        output.manifest = manifest;
    }

    return output;
}
