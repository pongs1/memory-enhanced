import type { V8ActivatedBundle, V8GraphNode, V8MemoryItem, V8Unit } from "./types_v8.js";

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function scoreTier(
    energy: number,
    thresholds: {
        criticalThreshold: number;
        decisionThreshold: number;
        backgroundThreshold: number;
    }
): V8ActivatedBundle["tier"] | null {
    if (energy >= thresholds.criticalThreshold) return "critical";
    if (energy >= thresholds.decisionThreshold) return "decision";
    if (energy >= thresholds.backgroundThreshold) return "background";
    return null;
}

export interface ResolveUnitBundlesInput {
    activations: Map<string, number>;
    nodesById: Map<string, V8GraphNode>;
    itemsById: Map<string, V8MemoryItem>;
    unitsById: Map<string, V8Unit>;
    criticalThreshold: number;
    decisionThreshold: number;
    backgroundThreshold: number;
    maxBundles: number;
}

export function resolveUnitBundles(input: ResolveUnitBundlesInput): V8ActivatedBundle[] {
    const supportScores = new Map<string, number>();
    const totalItemCounts = new Map<string, number>();
    const supportingNodes = new Map<string, Set<string>>();
    const evidenceByUnit = new Map<string, Set<string>>();

    for (const item of input.itemsById.values()) {
        for (const unitId of item.unitIds || []) {
            if (!input.unitsById.has(unitId)) continue;
            totalItemCounts.set(unitId, (totalItemCounts.get(unitId) || 0) + 1);
        }
    }

    for (const [nodeId, energy] of input.activations.entries()) {
        if (energy <= 0) continue;
        const node = input.nodesById.get(nodeId);
        if (!node) continue;
        for (const itemId of node.sourceItemIds || []) {
            const item = input.itemsById.get(itemId);
            if (!item) continue;
            for (const unitId of item.unitIds || []) {
                if (!input.unitsById.has(unitId)) continue;
                supportScores.set(unitId, (supportScores.get(unitId) || 0) + energy);
                const nodeSet = supportingNodes.get(unitId) || new Set<string>();
                nodeSet.add(nodeId);
                supportingNodes.set(unitId, nodeSet);
                const evidenceSet = evidenceByUnit.get(unitId) || new Set<string>();
                for (const spanId of item.evidenceSpanIds || []) {
                    evidenceSet.add(spanId);
                }
                evidenceByUnit.set(unitId, evidenceSet);
            }
        }
    }

    const bundles: V8ActivatedBundle[] = [];
    for (const [unitId, rawSupport] of supportScores.entries()) {
        const normalizationBase = Math.max(1, totalItemCounts.get(unitId) || 0);
        const energy = clamp01(rawSupport / normalizationBase);
        const tier = scoreTier(energy, input);
        if (!tier) continue;
        bundles.push({
            bundleId: unitId,
            nodeIds: Array.from(supportingNodes.get(unitId) || []),
            tier,
            energy,
            evidenceSpanIds: Array.from(evidenceByUnit.get(unitId) || []).slice(0, 8),
            sourceRefs: input.unitsById.get(unitId)?.narrativeRef ? [input.unitsById.get(unitId)!.narrativeRef] : undefined,
            diagnostics: {
                coverage: supportingNodes.get(unitId)?.size || 0,
            },
        });
    }

    bundles.sort((a, b) => b.energy - a.energy);
    return bundles.slice(0, input.maxBundles);
}
