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
    _units: V8Unit[],
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

    return { nodes, edges };
}

function truncateLabel(text: string, maxLen = 120): string {
    const trimmed = (text || "").trim().replace(/\s+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
}
