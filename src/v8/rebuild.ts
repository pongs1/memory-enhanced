import * as fs from "node:fs";
import type {
    V8ClusterDiagnosis,
    V8MemoryEdge,
    V8MemoryNode,
    V8UpdateQueueItem,
} from "./types.js";
import { graphPaths } from "./paths.js";

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function buildAssociativeAdjacency(edges: V8MemoryEdge[]): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
        if (edge.type !== "associative") continue;
        if (!adjacency.has(edge.src)) adjacency.set(edge.src, new Set());
        if (!adjacency.has(edge.dst)) adjacency.set(edge.dst, new Set());
        adjacency.get(edge.src)!.add(edge.dst);
        adjacency.get(edge.dst)!.add(edge.src);
    }
    return adjacency;
}

function connectedComponents(adjacency: Map<string, Set<string>>): string[][] {
    const seen = new Set<string>();
    const components: string[][] = [];

    for (const nodeId of adjacency.keys()) {
        if (seen.has(nodeId)) continue;
        const stack = [nodeId];
        const component: string[] = [];
        seen.add(nodeId);

        while (stack.length > 0) {
            const current = stack.pop()!;
            component.push(current);
            for (const neighbor of adjacency.get(current) || []) {
                if (seen.has(neighbor)) continue;
                seen.add(neighbor);
                stack.push(neighbor);
            }
        }

        if (component.length > 0) {
            components.push(component);
        }
    }

    return components;
}

function classifyCluster(
    nodeCount: number,
    avgHitCount: number,
    avgAdoptRate: number,
    avgHarmRate: number,
    internalAssociativeDensity: number,
    hitchhikerRatio: number
): { zone: V8ClusterDiagnosis["zone"]; reasons: string[] } {
    const reasons: string[] = [];

    if (avgHitCount < 1 && avgHarmRate === 0) {
        reasons.push("insufficient usage history");
        return { zone: "plastic_zone", reasons };
    }

    if (avgHitCount >= 4 && avgAdoptRate >= 0.65 && avgHarmRate <= 0.08) {
        reasons.push("high hit count", "high adopt rate", "low harm rate");
        return { zone: "stable_core", reasons };
    }

    if (nodeCount >= 3 && internalAssociativeDensity >= 0.5) {
        reasons.push("dense associative cluster");
    }
    if (avgAdoptRate < 0.2) {
        reasons.push("low adopt rate");
    }
    if (avgHarmRate >= 0.2) {
        reasons.push("elevated harm rate");
    }
    if (hitchhikerRatio >= 0.34) {
        reasons.push("many hitchhiker nodes");
    }

    if (
        (avgHitCount >= 2 && internalAssociativeDensity >= 0.5 && avgAdoptRate < 0.2 && nodeCount >= 3) ||
        avgHarmRate >= 0.25 ||
        (avgHitCount >= 2 && hitchhikerRatio >= 0.5)
    ) {
        return { zone: "rebuild_queue", reasons };
    }

    if (reasons.length === 0) {
        reasons.push("normal evolving cluster");
    }
    return { zone: "plastic_zone", reasons };
}

function readJsonl<T>(filePath: string): T[] {
    try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (!content) return [];
        return content.split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

function writeJsonl<T>(filePath: string, items: T[]): void {
    fs.writeFileSync(
        filePath,
        items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "",
        "utf-8"
    );
}

export function diagnoseAssociativeClusters(graph: {
    nodes: V8MemoryNode[];
    edges: V8MemoryEdge[];
}, stableNodeIds: Iterable<string> = []): V8ClusterDiagnosis[] {
    const associativeEdges = graph.edges.filter((edge) => edge.type === "associative");
    const adjacency = buildAssociativeAdjacency(associativeEdges);
    const components = connectedComponents(adjacency);
    const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
    const stableNodeIdSet = new Set(stableNodeIds);

    return components
        .filter((component) => component.length >= 2)
        .map((component, index) => {
            const clusterNodes = component
                .map((nodeId) => nodeMap.get(nodeId))
                .filter((node): node is V8MemoryNode => Boolean(node));
            const nodeIdSet = new Set(clusterNodes.map((node) => node.id));
            const clusterEdges = associativeEdges.filter(
                (edge) => nodeIdSet.has(edge.src) && nodeIdSet.has(edge.dst)
            );
            const bundleIds = [...new Set(clusterNodes.map((node) => node.bundleId))];

            const totalHits = clusterNodes.reduce((sum, node) => sum + node.hitCount, 0);
            const totalAdopts = clusterNodes.reduce((sum, node) => sum + node.adoptCount, 0);
            const totalHarm = clusterNodes.reduce((sum, node) => sum + node.harmCount, 0);
            const avgHitCount = clusterNodes.length > 0 ? totalHits / clusterNodes.length : 0;
            const avgAdoptRate = totalHits > 0 ? totalAdopts / totalHits : 0;
            const avgHarmRate = totalHits > 0 ? totalHarm / totalHits : 0;

            const maxPossibleEdges =
                clusterNodes.length > 1 ? (clusterNodes.length * (clusterNodes.length - 1)) / 2 : 1;
            const internalAssociativeDensity = clamp01(clusterEdges.length / maxPossibleEdges);

            const hitchhikerNodeIds = clusterNodes
                .filter((node) => {
                    const degree = adjacency.get(node.id)?.size || 0;
                    if (degree === 0) return false;
                    if (node.hitCount === 0) return true;
                    const adoptRate = node.hitCount > 0 ? node.adoptCount / node.hitCount : 0;
                    return adoptRate < Math.max(0.1, avgAdoptRate * 0.35);
                })
                .map((node) => node.id);
            const hitchhikerRatio =
                clusterNodes.length > 0 ? hitchhikerNodeIds.length / clusterNodes.length : 0;

            if (clusterNodes.some((node) => stableNodeIdSet.has(node.id))) {
                return {
                    clusterId: `mc_${String(index + 1).padStart(4, "0")}_${bundleIds.slice(0, 2).join("_")}`,
                    nodeIds: clusterNodes.map((node) => node.id),
                    bundleIds,
                    zone: "stable_core" as const,
                    avgHitCount,
                    avgAdoptRate,
                    avgHarmRate,
                    internalAssociativeDensity,
                    hitchhikerNodeIds,
                    reasons: ["contains hard-core protected node"],
                } satisfies V8ClusterDiagnosis;
            }

            const classification = classifyCluster(
                clusterNodes.length,
                avgHitCount,
                avgAdoptRate,
                avgHarmRate,
                internalAssociativeDensity,
                hitchhikerRatio
            );

            return {
                clusterId: `mc_${String(index + 1).padStart(4, "0")}_${bundleIds.slice(0, 2).join("_")}`,
                nodeIds: clusterNodes.map((node) => node.id),
                bundleIds,
                zone: classification.zone,
                avgHitCount,
                avgAdoptRate,
                avgHarmRate,
                internalAssociativeDensity,
                hitchhikerNodeIds,
                reasons: classification.reasons,
            } satisfies V8ClusterDiagnosis;
        });
}

export function selectRebuildCandidates(
    diagnoses: V8ClusterDiagnosis[]
): V8ClusterDiagnosis[] {
    return diagnoses.filter((item) => item.zone === "rebuild_queue");
}

export function buildClusterQueueItems(
    diagnoses: V8ClusterDiagnosis[],
    observedAt: string
): V8UpdateQueueItem[] {
    return selectRebuildCandidates(diagnoses).map((diagnosis, index) => ({
        id: `uq_cluster_${diagnosis.clusterId}_${Date.parse(observedAt)}_${index + 1}`,
        targetType: "cluster",
        targetId: diagnosis.clusterId,
        reason: diagnosis.reasons.some((reason) => reason.includes("hitchhiker"))
            ? "hitchhiker"
            : diagnosis.reasons.some((reason) => reason.includes("dense associative"))
                ? "cluster_resonance"
                : "needs_rebuild",
        evidence: [
            `bundleIds=${diagnosis.bundleIds.join(",")}`,
            `avgHitCount=${diagnosis.avgHitCount.toFixed(2)}`,
            `avgAdoptRate=${diagnosis.avgAdoptRate.toFixed(2)}`,
            `avgHarmRate=${diagnosis.avgHarmRate.toFixed(2)}`,
            `internalAssociativeDensity=${diagnosis.internalAssociativeDensity.toFixed(2)}`,
            ...diagnosis.reasons,
        ],
        createdAt: observedAt,
        status: "pending",
    }));
}

export function syncClusterDiagnosisQueue(
    workspace: string,
    diagnoses: V8ClusterDiagnosis[],
    observedAt: string
): { queued: number; diagnoses: number } {
    const gp = graphPaths(workspace);
    const existing = readJsonl<V8UpdateQueueItem>(gp.updateQueue);
    const freshItems = buildClusterQueueItems(diagnoses, observedAt);
    const freshByTarget = new Map(
        freshItems.map((item) => [`${item.targetType}:${item.targetId}`, item])
    );
    const kept = existing.filter((item) => {
        if (item.targetType !== "cluster") return true;
        return !freshByTarget.has(`${item.targetType}:${item.targetId}`);
    });
    const nextQueue = [...kept, ...freshItems];
    writeJsonl(gp.updateQueue, nextQueue);
    return {
        queued: freshItems.length,
        diagnoses: diagnoses.length,
    };
}
