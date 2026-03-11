import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, writeJson } from "../utils.js";
import { buildDayIndex, buildHardCoreIndex, buildSourceIndex, buildTriggerLexicon } from "./indexes.js";
import type {
    BuildGraphOutput,
    V8ClusterRebuildRecord,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8NodeRole,
} from "./types.js";

function sanitizeText(text: string, maxChars = 180): string {
    return (text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function detectLanguage(text: string): "zh" | "en" | "mixed" | "unknown" {
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;
    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > 0 && enCount > 0) return "mixed";
    return zhCount > 0 ? "zh" : "en";
}

function extractKeywords(text: string, maxItems = 10): string[] {
    const englishWords = text.toLowerCase().match(/[a-z0-9/_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const seen = new Set<string>();
    const output: string[] = [];

    for (const item of [...englishWords, ...cjkChunks]) {
        const normalized = sanitizeText(item, 40).toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(normalized);
        if (output.length >= maxItems) break;
    }
    return output;
}

function sanitizeIdPart(value: string): string {
    return (value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48) || "x";
}

function nextUniqueId(base: string, exists: (id: string) => boolean): string {
    if (!exists(base)) return base;
    for (let i = 2; i < 10000; i++) {
        const candidate = `${base}_${i}`;
        if (!exists(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
}

function appendJsonl(filePath: string, items: unknown[]): void {
    const content = items.length > 0
        ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
        : "";
    fs.writeFileSync(filePath, content, "utf-8");
}

function splitEdges(edges: V8MemoryEdge[]): {
    associative: V8MemoryEdge[];
    structural: V8MemoryEdge[];
    supersession: V8MemoryEdge[];
} {
    return {
        associative: edges.filter((edge) => edge.type === "associative"),
        supersession: edges.filter((edge) => edge.type === "supersedes"),
        structural: edges.filter((edge) => edge.type !== "associative" && edge.type !== "supersedes"),
    };
}

export interface MaterializeClusterRebuildResult {
    graph: BuildGraphOutput;
    appliedClusters: number;
    skippedClusters: number;
    addedNodes: number;
    droppedNodes: number;
    addedEdges: number;
    droppedEdges: number;
}

export function materializeClusterRebuildGraph(
    baseGraph: BuildGraphOutput,
    records: V8ClusterRebuildRecord[]
): MaterializeClusterRebuildResult {
    const bundleMap = new Map(baseGraph.bundles.map((bundle) => [bundle.bundleId, { ...bundle }]));
    const nodeMap = new Map(baseGraph.nodes.map((node) => [node.id, { ...node }]));
    let edges = baseGraph.edges.map((edge) => ({ ...edge }));

    let appliedClusters = 0;
    let skippedClusters = 0;
    let addedNodes = 0;
    let droppedNodes = 0;
    let addedEdges = 0;
    let droppedEdges = 0;

    for (const record of records) {
        const draft = record.rebuiltDraft;
        if (!draft) {
            skippedClusters += 1;
            continue;
        }

        const diagnosis = record.diagnosis;
        const clusterNodeIds = new Set(diagnosis.nodeIds);
        const clusterNodes = diagnosis.nodeIds
            .map((nodeId) => nodeMap.get(nodeId))
            .filter((node): node is V8MemoryNode => Boolean(node));
        const sourceBundle = diagnosis.bundleIds
            .map((bundleId) => bundleMap.get(bundleId))
            .find(Boolean) || (clusterNodes[0] ? bundleMap.get(clusterNodes[0].bundleId) : undefined);

        if (!sourceBundle) {
            skippedClusters += 1;
            continue;
        }

        const droppedNodeIds = new Set(
            draft.droppedNodeIds
                .map((id) => sanitizeText(id, 120))
                .filter((id) => nodeMap.has(id))
        );
        const droppedEdgeIds = new Set(
            draft.droppedNodeIds
                .map((id) => sanitizeText(id, 120))
                .filter((id) => edges.some((edge) => edge.id === id))
        );

        if (droppedNodeIds.size > 0) {
            for (const nodeId of droppedNodeIds) {
                if (nodeMap.delete(nodeId)) droppedNodes += 1;
            }
        }

        const edgeCountBeforeDrop = edges.length;
        edges = edges.filter((edge) => {
            if (droppedEdgeIds.has(edge.id)) return false;
            if (droppedNodeIds.has(edge.src) || droppedNodeIds.has(edge.dst)) return false;
            return true;
        });
        droppedEdges += edgeCountBeforeDrop - edges.length;

        const preservedByRole = new Map<V8NodeRole, string>();
        for (const nodeId of draft.preservedNodeIds) {
            const node = nodeMap.get(nodeId);
            if (!node || !clusterNodeIds.has(node.id)) continue;
            if (!preservedByRole.has(node.role)) {
                preservedByRole.set(node.role, node.id);
            }
        }

        const rebuiltNodeIdsByRole = new Map<V8NodeRole, string>();
        const clusterTag = sanitizeIdPart(record.clusterId);
        for (let i = 0; i < draft.rebuiltNodes.length; i++) {
            const item = draft.rebuiltNodes[i];
            const role = item.role;
            const baseId = `mn_rb_${clusterTag}_${sanitizeIdPart(role)}_${i + 1}`;
            const nodeId = nextUniqueId(baseId, (id) => nodeMap.has(id));
            const text = sanitizeText(item.text, 220);
            const summary = sanitizeText(item.summary || item.text, 120);
            const zhName = sanitizeText(item.nameZh || text, 72);
            const enName = sanitizeText(item.nameEn || text, 72);
            const aliases = Array.from(
                new Set(
                    [zhName, enName, ...(item.aliases || [])]
                        .map((value) => sanitizeText(value, 72))
                        .filter(Boolean)
                )
            ).slice(0, 8);
            const node: V8MemoryNode = {
                id: nodeId,
                bundleId: sourceBundle.bundleId,
                kind: item.kind || sourceBundle.kind,
                role,
                names: { zh: zhName, en: enName },
                aliases,
                text,
                summary,
                keywords: extractKeywords(`${zhName} ${enName} ${text}`),
                language: detectLanguage(`${zhName} ${enName} ${text}`),
                sourceRef: record.sourceRefs[0] || sourceBundle.sourceRef,
                canonicalRef: sourceBundle.canonicalRef,
                confidence: clamp01(item.confidence ?? 0.72),
                importance: clamp01(item.importance ?? 0.68),
                hitCount: 0,
                adoptCount: 0,
                rejectCount: 0,
                harmCount: 0,
                lastUsedAt: null,
                lastVerifiedAt: record.createdAt,
                cooldownUntil: null,
                dayKey: sourceBundle.dayKey,
                episodeKey: sourceBundle.episodeKey,
            };
            nodeMap.set(nodeId, node);
            if (!rebuiltNodeIdsByRole.has(role)) {
                rebuiltNodeIdsByRole.set(role, nodeId);
            }
            addedNodes += 1;
        }

        const roleToNodeId = new Map<V8NodeRole, string>();
        for (const [role, nodeId] of rebuiltNodeIdsByRole) {
            roleToNodeId.set(role, nodeId);
        }
        for (const [role, nodeId] of preservedByRole) {
            if (!roleToNodeId.has(role)) {
                roleToNodeId.set(role, nodeId);
            }
        }
        for (const node of clusterNodes) {
            if (!nodeMap.has(node.id)) continue;
            if (!roleToNodeId.has(node.role)) {
                roleToNodeId.set(node.role, node.id);
            }
        }

        for (let i = 0; i < draft.rebuiltEdges.length; i++) {
            const edgeDraft = draft.rebuiltEdges[i];
            const src = roleToNodeId.get(edgeDraft.srcRole);
            const dst = roleToNodeId.get(edgeDraft.dstRole);
            if (!src || !dst || src === dst) continue;
            const baseId = `me_rb_${clusterTag}_${sanitizeIdPart(edgeDraft.type)}_${i + 1}`;
            const edgeId = nextUniqueId(baseId, (id) => edges.some((edge) => edge.id === id));
            const edge: V8MemoryEdge = {
                id: edgeId,
                type: edgeDraft.type,
                src,
                dst,
                assocStrength: clamp01(edgeDraft.assocStrength ?? 0.72),
                utility: clamp01(edgeDraft.utility ?? edgeDraft.assocStrength ?? 0.7),
                trust: clamp01(edgeDraft.trust ?? edgeDraft.assocStrength ?? 0.7),
                freshness: clamp01(edgeDraft.freshness ?? 0.82),
                contextFit: clamp01(edgeDraft.contextFit ?? 0.78),
                evidenceCount: Math.max(1, edgeDraft.evidenceCount ?? 1),
                activationCount: 0,
                adoptCount: 0,
                rejectCount: 0,
                lastUpdatedAt: record.createdAt,
                lastVerifiedAt: record.createdAt,
            };
            edges.push(edge);
            addedEdges += 1;
        }

        appliedClusters += 1;
    }

    const nodes = [...nodeMap.values()];
    const nodeIdsByBundle = new Map<string, string[]>();
    for (const node of nodes) {
        const list = nodeIdsByBundle.get(node.bundleId) || [];
        list.push(node.id);
        nodeIdsByBundle.set(node.bundleId, list);
    }

    const bundles = [...bundleMap.values()].map((bundle) => ({
        ...bundle,
        nodeIds: nodeIdsByBundle.get(bundle.bundleId) || [],
    }));

    const triggerLexicon = buildTriggerLexicon(nodes);
    const dayIndex = buildDayIndex(nodes);
    const sourceIndex = buildSourceIndex(bundles);
    const hardCoreIndex = buildHardCoreIndex(nodes);

    return {
        graph: {
            ...baseGraph,
            bundles,
            nodes,
            edges,
            triggerLexicon,
            dayIndex,
            sourceIndex,
            hardCoreIndex,
        },
        appliedClusters,
        skippedClusters,
        addedNodes,
        droppedNodes,
        addedEdges,
        droppedEdges,
    };
}

export function writeGraphSnapshotDir(
    snapshotDir: string,
    graph: BuildGraphOutput
): void {
    ensureDir(snapshotDir);
    const nodesEpisodic = graph.nodes.filter((node) => node.kind === "episodic");
    const nodesSemantic = graph.nodes.filter((node) => node.kind === "semantic");
    const nodesProcedural = graph.nodes.filter((node) => node.kind === "procedural");
    const split = splitEdges(graph.edges);

    appendJsonl(path.join(snapshotDir, "bundles.jsonl"), graph.bundles);
    appendJsonl(path.join(snapshotDir, "nodes_episodic.jsonl"), nodesEpisodic);
    appendJsonl(path.join(snapshotDir, "nodes_semantic.jsonl"), nodesSemantic);
    appendJsonl(path.join(snapshotDir, "nodes_procedural.jsonl"), nodesProcedural);
    appendJsonl(path.join(snapshotDir, "edges_associative.jsonl"), split.associative);
    appendJsonl(path.join(snapshotDir, "edges_structural.jsonl"), split.structural);
    appendJsonl(path.join(snapshotDir, "edges_supersession.jsonl"), split.supersession);
    writeJson(path.join(snapshotDir, "trigger_lexicon.json"), graph.triggerLexicon);
    writeJson(path.join(snapshotDir, "day_index.json"), graph.dayIndex);
    writeJson(path.join(snapshotDir, "source_index.json"), graph.sourceIndex);
    writeJson(path.join(snapshotDir, "hard_core_index.json"), graph.hardCoreIndex);
    writeJson(path.join(snapshotDir, "manifest.json"), graph.manifest);
}
