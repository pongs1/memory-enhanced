import type {
    V8GraphEdge,
    V8GraphNode,
    V8MemoryItem,
    V8MemoryOriginType,
    V8EvidenceSpan,
    V8Unit,
} from "../types_v8.js";

export interface GraphMaterializationOutput {
    nodes: V8GraphNode[];
    edges: V8GraphEdge[];
}

export function materializeGraph(
    items: V8MemoryItem[],
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[]
): GraphMaterializationOutput {
    const nodes: V8GraphNode[] = [];
    const edges: V8GraphEdge[] = [];

    const nodeIdByItemId = new Map<string, string>();
    const itemByNodeId = new Map<string, V8MemoryItem>();
    const mentionTargetsBySpan = new Map<string, string[]>();
    const discourseUnitBySpan = new Map<string, string>();

    for (const item of items) {
        const nodeId = `node_${item.id}`;
        nodeIdByItemId.set(item.id, nodeId);
        itemByNodeId.set(nodeId, item);

        const node: V8GraphNode = {
            id: nodeId,
            memoryType: item.itemType,
            canonicalLabel: item.label,
            aliases: [],
            primaryLayer: item.layer,
            layerMemberships: [item.layer],
            sourceItemIds: [item.id],
            evidenceSpanIds: item.evidenceSpanIds,
            bestEvidenceSpanIds: item.evidenceSpanIds.slice(0, 1),
            state: {
                scope: item.scope,
                validity: item.validity,
                confidence: item.confidence,
                supportCount: item.evidenceSpanIds.length,
            },
        };
        nodes.push(node);

        for (const spanId of item.evidenceSpanIds) {
            if (item.itemType === "discourse_unit") {
                if (!discourseUnitBySpan.has(spanId)) {
                    discourseUnitBySpan.set(spanId, nodeId);
                }
                continue;
            }
            const list = mentionTargetsBySpan.get(spanId) || [];
            list.push(nodeId);
            mentionTargetsBySpan.set(spanId, list);
        }
    }

    const evidenceNodeBySpan = new Map<string, string>();
    for (const span of evidenceSpans) {
        const evidenceNodeId = `node_span_${span.id}`;
        evidenceNodeBySpan.set(span.id, evidenceNodeId);
        nodes.push({
            id: evidenceNodeId,
            memoryType: "evidence",
            canonicalLabel: truncateLabel(span.text),
            aliases: [],
            primaryLayer: "micro",
            layerMemberships: ["micro"],
            sourceItemIds: [],
            evidenceSpanIds: [span.id],
            bestEvidenceSpanIds: [span.id],
            state: {
                scope: "session",
                validity: "active",
                confidence: span.score,
                supportCount: 1,
            },
        });
    }

    const unitById = new Map(units.map((unit) => [unit.id, unit]));
    const childrenByParent = new Map<string, V8Unit[]>();
    for (const unit of units) {
        if (!unit.parentUnitId) continue;
        const list = childrenByParent.get(unit.parentUnitId) || [];
        list.push(unit);
        childrenByParent.set(unit.parentUnitId, list);
    }

    const spansByUnitId = new Map<string, string[]>();
    for (const span of evidenceSpans) {
        const list = spansByUnitId.get(span.unitId) || [];
        list.push(span.id);
        spansByUnitId.set(span.unitId, list);
    }

    const unitNodeById = new Map<string, string>();

    const collectDescendantSpans = (unitId: string): string[] => {
        const collected = new Set<string>();
        const stack: string[] = [unitId];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const directSpans = spansByUnitId.get(current);
            if (directSpans) {
                for (const spanId of directSpans) {
                    collected.add(spanId);
                }
            }
            const children = childrenByParent.get(current) || [];
            for (const child of children) {
                stack.push(child.id);
            }
        }
        return Array.from(collected);
    };

    for (const unit of units) {
        if (unit.layer === "micro") {
            const spanIds = spansByUnitId.get(unit.id) || [];
            const discourseNodeId =
                spanIds.length > 0 ? discourseUnitBySpan.get(spanIds[0]) : null;
            if (discourseNodeId) {
                unitNodeById.set(unit.id, discourseNodeId);
                continue;
            }
        }

        if (unit.layer === "meso" || unit.layer === "macro") {
            const nodeId = `node_unit_${unit.id}`;
            const evidenceSpanIds = collectDescendantSpans(unit.id);
            nodes.push({
                id: nodeId,
                memoryType: unit.layer === "meso" ? "scene_block" : "phase",
                canonicalLabel: truncateLabel(unit.text),
                aliases: [],
                primaryLayer: unit.layer,
                layerMemberships: [unit.layer],
                sourceItemIds: [],
                evidenceSpanIds,
                bestEvidenceSpanIds: evidenceSpanIds.slice(0, 1),
                state: {
                    scope: "session",
                    validity: "active",
                    confidence: deriveConfidence(evidenceSpanIds, evidenceSpans),
                    supportCount: evidenceSpanIds.length,
                },
            });
            unitNodeById.set(unit.id, nodeId);
            continue;
        }
    }

    let edgeIndex = 0;
    const pushEdge = (edge: Omit<V8GraphEdge, "id">) => {
        edgeIndex += 1;
        edges.push({ id: `edge_${edgeIndex}`, ...edge });
    };

    for (const span of evidenceSpans) {
        const evidenceNodeId = evidenceNodeBySpan.get(span.id);
        if (!evidenceNodeId) continue;

        const discourseUnitNodeId = discourseUnitBySpan.get(span.id);
        if (discourseUnitNodeId) {
            pushEdge({
                type: "span_in_micro_unit",
                src: evidenceNodeId,
                dst: discourseUnitNodeId,
                layer: "cross",
                originType: "asserted",
                sourceItemIds: [],
                evidenceSpanIds: [span.id],
                qualifiers: {},
                confidence: span.score,
                state: {
                    scope: "session",
                    validity: "active",
                },
            });
        }

        const mentionTargets = mentionTargetsBySpan.get(span.id) || [];
        for (const targetNodeId of mentionTargets) {
            const item = itemByNodeId.get(targetNodeId);
            if (!item) continue;
            pushEdge({
                type: "mention_maps_to_micro_node",
                src: evidenceNodeId,
                dst: targetNodeId,
                layer: "cross",
                originType: item.originType as V8MemoryOriginType,
                sourceItemIds: [item.id],
                evidenceSpanIds: [span.id],
                qualifiers: {},
                confidence: Math.min(span.score, item.confidence),
                state: {
                    scope: item.scope,
                    validity: item.validity,
                },
            });
        }
    }

    for (const unit of units) {
        const unitNodeId = unitNodeById.get(unit.id);
        if (!unitNodeId || !unit.parentUnitId) continue;
        const parentUnit = unitById.get(unit.parentUnitId);
        const parentNodeId = unitNodeById.get(unit.parentUnitId);
        if (!parentUnit || !parentNodeId) continue;

        if (unit.layer === "micro" && parentUnit.layer === "meso") {
            const spanIds = spansByUnitId.get(unit.id) || [];
            pushEdge({
                type: "micro_unit_in_meso_unit",
                src: unitNodeId,
                dst: parentNodeId,
                layer: "cross",
                originType: "asserted",
                sourceItemIds: [],
                evidenceSpanIds: spanIds.slice(0, 2),
                qualifiers: {},
                confidence: 0.72,
                state: {
                    scope: "session",
                    validity: "active",
                },
            });
        }

        if (unit.layer === "meso" && parentUnit.layer === "macro") {
            const spanIds = collectDescendantSpans(unit.id);
            pushEdge({
                type: "meso_unit_in_macro_unit",
                src: unitNodeId,
                dst: parentNodeId,
                layer: "cross",
                originType: "asserted",
                sourceItemIds: [],
                evidenceSpanIds: spanIds.slice(0, 2),
                qualifiers: {},
                confidence: 0.68,
                state: {
                    scope: "session",
                    validity: "active",
                },
            });
        }
    }

    return { nodes, edges };
}

function truncateLabel(text: string, maxLen = 120): string {
    const trimmed = (text || "").trim().replace(/\s+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
}

function deriveConfidence(
    spanIds: string[],
    spans: V8EvidenceSpan[]
): number {
    if (spanIds.length === 0) return 0.4;
    const spanById = new Map(spans.map((span) => [span.id, span]));
    let sum = 0;
    let count = 0;
    for (const spanId of spanIds) {
        const span = spanById.get(spanId);
        if (!span) continue;
        sum += span.score;
        count += 1;
    }
    if (count === 0) return 0.4;
    return Math.min(0.95, sum / count);
}
