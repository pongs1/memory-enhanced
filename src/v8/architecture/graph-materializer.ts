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

interface DerivedStateCandidate {
    stateNodeId: string;
    sourceItemId: string;
    edgeNodeId: string;
    anchorNodeIds: string[];
    anchorTokens: string[];
    timestampMs: number | null;
    statusRank: number;
    validity: V8GraphNode["state"]["validity"];
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
    const itemSemanticLinks = new Map<
        string,
        { subjectNodeId: string; objectNodeId: string }
    >();
    const discourseUnitBySpan = new Map<string, string>();
    const semanticNodeByKey = new Map<string, V8GraphNode>();
    let semanticNodeSeq = 0;

    for (const item of items) {
        const nodeId =
            item.itemType === "discourse_unit"
                ? `node_${item.id}`
                : `node_edge_${item.id}`;
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
            }
        }
    }

    const evidenceNodeBySpan = new Map<string, string>();
    const spanById = new Map<string, V8EvidenceSpan>();
    for (const span of evidenceSpans) {
        spanById.set(span.id, span);
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

    const upsertSemanticNode = (
        label: string,
        memoryType: V8MemoryItem["itemType"],
        spanIds: string[],
        confidence: number
    ): string => {
        const key = `${memoryType}:${normalizeKey(label)}`;
        const existing = semanticNodeByKey.get(key);
        if (existing) {
            const combined = mergeIds(existing.evidenceSpanIds, spanIds);
            existing.evidenceSpanIds = combined;
            existing.bestEvidenceSpanIds = combined.slice(0, 1);
            existing.state.supportCount = combined.length;
            existing.state.confidence = Math.max(existing.state.confidence, confidence);
            return existing.id;
        }

        semanticNodeSeq += 1;
        const node: V8GraphNode = {
            id: `node_sem_${semanticNodeSeq}`,
            memoryType,
            canonicalLabel: label,
            aliases: [],
            primaryLayer: "micro",
            layerMemberships: ["micro"],
            sourceItemIds: [],
            evidenceSpanIds: [...spanIds],
            bestEvidenceSpanIds: spanIds.slice(0, 1),
            state: {
                scope: "session",
                validity: "active",
                confidence,
                supportCount: spanIds.length,
            },
        };
        semanticNodeByKey.set(key, node);
        nodes.push(node);
        return node.id;
    };

    for (const item of items) {
        if (item.itemType === "discourse_unit") continue;
        if (!item.subject || !item.object) continue;
        const subjectType = item.subject === "user" || item.subject === "assistant" || item.subject === "system"
            ? "entity"
            : "entity";
        const objectType = "concept";

        const subjectNodeId = upsertSemanticNode(
            item.subject,
            subjectType,
            item.evidenceSpanIds,
            item.confidence
        );
        const objectNodeId = upsertSemanticNode(
            item.object,
            objectType,
            item.evidenceSpanIds,
            item.confidence
        );
        itemSemanticLinks.set(item.id, { subjectNodeId, objectNodeId });

        pushEdge({
            type: item.predicate as V8GraphEdge["type"],
            src: subjectNodeId,
            dst: objectNodeId,
            layer: item.layer,
            originType: item.originType as V8MemoryOriginType,
            sourceItemIds: [item.id],
            evidenceSpanIds: item.evidenceSpanIds,
            qualifiers: item.qualifiers || {},
            confidence: item.confidence,
            state: {
                scope: item.scope,
                validity: item.validity,
            },
        });
    }

    const stateCandidates: DerivedStateCandidate[] = [];
    const stateLinkSeen = new Set<string>();
    const pushUniqueEdge = (edge: Omit<V8GraphEdge, "id">) => {
        const signature = [
            edge.type,
            edge.src,
            edge.dst,
            edge.sourceItemIds.join(","),
            edge.evidenceSpanIds.join(","),
        ].join("|");
        if (stateLinkSeen.has(signature)) return;
        stateLinkSeen.add(signature);
        pushEdge(edge);
    };

    for (const item of items) {
        if (item.itemType === "discourse_unit") continue;
        const cue = deriveStateCue(item);
        const isNativeState = isStateMemoryType(item.itemType);
        if (!isNativeState && !cue) continue;

        const edgeNodeId = nodeIdByItemId.get(item.id);
        if (!edgeNodeId) continue;
        const semanticLinks = itemSemanticLinks.get(item.id);
        const stateMemoryType = deriveStateMemoryType(item, semanticLinks);
        const stateNodeId = isNativeState ? edgeNodeId : `node_state_${item.id}`;
        const validity = resolveStateValidity(item.validity, cue?.status);

        if (!isNativeState) {
            nodes.push({
                id: stateNodeId,
                memoryType: stateMemoryType,
                canonicalLabel: buildStateLabel(item, stateMemoryType, cue?.status),
                aliases: [],
                primaryLayer: item.layer,
                layerMemberships: [item.layer],
                sourceItemIds: [item.id],
                evidenceSpanIds: item.evidenceSpanIds,
                bestEvidenceSpanIds: item.evidenceSpanIds.slice(0, 1),
                state: {
                    scope: item.scope,
                    validity,
                    confidence: item.confidence,
                    supportCount: item.evidenceSpanIds.length,
                },
            });
        } else {
            const node = nodes.find((candidate) => candidate.id === stateNodeId);
            if (node) {
                node.state.validity = validity;
            }
        }

        if (!isNativeState) {
            pushUniqueEdge({
                type: "asserted_by",
                src: stateNodeId,
                dst: edgeNodeId,
                layer: item.layer,
                originType: item.originType as V8MemoryOriginType,
                sourceItemIds: [item.id],
                evidenceSpanIds: item.evidenceSpanIds.slice(0, 2),
                qualifiers: item.qualifiers || {},
                confidence: Math.min(0.92, item.confidence),
                state: {
                    scope: item.scope,
                    validity,
                },
            });
        }
        const scopeTargetIds = deriveStateScopeTargets(semanticLinks, stateMemoryType);
        for (const scopeTargetId of scopeTargetIds) {
            pushUniqueEdge({
                type: "scoped_to",
                src: stateNodeId,
                dst: scopeTargetId,
                layer: item.layer,
                originType: item.originType as V8MemoryOriginType,
                sourceItemIds: [item.id],
                evidenceSpanIds: item.evidenceSpanIds.slice(0, 2),
                qualifiers: item.qualifiers || {},
                confidence: Math.min(0.88, item.confidence),
                state: {
                    scope: item.scope,
                    validity,
                },
            });
        }

        stateCandidates.push({
            stateNodeId,
            sourceItemId: item.id,
            edgeNodeId,
            anchorNodeIds: [
                semanticLinks?.subjectNodeId || "",
                semanticLinks?.objectNodeId || "",
            ].filter(Boolean),
            anchorTokens: deriveAnchorTokens(item),
            timestampMs: resolveItemTimestampMs(item, spanById),
            statusRank: cue ? stateStatusRank(cue.status) : validity === "superseded" ? 0 : 1,
            validity,
        });
    }

    const itemById = new Map(items.map((item) => [item.id, item]));
    const eventCandidates = items
        .filter((item) => item.itemType === "event")
        .map((item) => ({
            item,
            edgeNodeId: nodeIdByItemId.get(item.id) || "",
            timestampMs: resolveItemTimestampMs(item, spanById),
            anchorTokens: deriveAnchorTokens(item),
        }))
        .filter((candidate) => candidate.edgeNodeId);

    const transitionSeen = new Set<string>();
    for (const current of stateCandidates) {
        let bestPrevious: DerivedStateCandidate | null = null;
        let bestScore = 0;
        for (const previous of stateCandidates) {
            if (previous.stateNodeId === current.stateNodeId) continue;
            if (previous.statusRank >= current.statusRank) continue;
            const previousTime = previous.timestampMs ?? Number.NEGATIVE_INFINITY;
            const currentTime = current.timestampMs ?? Number.POSITIVE_INFINITY;
            if (previousTime > currentTime) continue;
            const score = stateCandidateSimilarity(current, previous);
            if (score <= bestScore || score < 0.16) continue;
            bestPrevious = previous;
            bestScore = score;
        }
        if (!bestPrevious) continue;

        const transitionKey = `${current.stateNodeId}->${bestPrevious.stateNodeId}`;
        if (transitionSeen.has(transitionKey)) continue;
        transitionSeen.add(transitionKey);

        const currentItem = itemById.get(current.sourceItemId);
        pushUniqueEdge({
            type: "state_supersedes_state",
            src: current.stateNodeId,
            dst: bestPrevious.stateNodeId,
            layer: currentItem?.layer || "micro",
            originType: (currentItem?.originType || "inferred") as V8MemoryOriginType,
            sourceItemIds: [current.sourceItemId, bestPrevious.sourceItemId],
            evidenceSpanIds: mergeIds(
                [...(currentItem?.evidenceSpanIds || [])],
                [...(itemById.get(bestPrevious.sourceItemId)?.evidenceSpanIds || [])]
            ).slice(0, 4),
            qualifiers: {
                derived: true,
                similarity: Number(bestScore.toFixed(3)),
            },
            confidence: Math.min(0.92, 0.58 + bestScore),
            state: {
                scope: currentItem?.scope || "session",
                validity: "active",
            },
        });

        const changingEvent = selectChangingEvent(
            eventCandidates,
            current,
            bestPrevious
        );
        if (changingEvent) {
            pushUniqueEdge({
                type: "state_changed_by_event",
                src: current.stateNodeId,
                dst: changingEvent.edgeNodeId,
                layer: "micro",
                originType: "inferred",
                sourceItemIds: [current.sourceItemId, changingEvent.item.id],
                evidenceSpanIds: mergeIds(
                    [...itemById.get(current.sourceItemId)?.evidenceSpanIds || []],
                    [...changingEvent.item.evidenceSpanIds || []]
                ).slice(0, 4),
                qualifiers: {
                    derived: true,
                },
                confidence: 0.68,
                state: {
                    scope: currentItem?.scope || "session",
                    validity: "active",
                },
            });
        }
    }

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

    }

    for (const node of nodes) {
        if (!node.id.startsWith("node_sem_")) continue;
        for (const spanId of node.evidenceSpanIds) {
            const evidenceNodeId = evidenceNodeBySpan.get(spanId);
            if (!evidenceNodeId) continue;
            pushEdge({
                type: "mention_maps_to_micro_node",
                src: evidenceNodeId,
                dst: node.id,
                layer: "cross",
                originType: "aggregated",
                sourceItemIds: [],
                evidenceSpanIds: [spanId],
                qualifiers: {},
                confidence: Math.min(0.9, node.state.confidence),
                state: {
                    scope: node.state.scope,
                    validity: node.state.validity,
                },
            });
        }
    }

    const edgeLinkSeen = new Set<string>();
    for (const item of items) {
        if (item.itemType === "discourse_unit") continue;
        const edgeNodeId = nodeIdByItemId.get(item.id);
        if (!edgeNodeId) continue;

        for (const spanId of item.evidenceSpanIds) {
            const evidenceNodeId = evidenceNodeBySpan.get(spanId);
            if (!evidenceNodeId) continue;
            const edgeKey = `${edgeNodeId}->${evidenceNodeId}`;
            if (!edgeLinkSeen.has(edgeKey)) {
                edgeLinkSeen.add(edgeKey);
                pushEdge({
                    type: "micro_edge_evidenced_by_span",
                    src: edgeNodeId,
                    dst: evidenceNodeId,
                    layer: "cross",
                    originType: item.originType as V8MemoryOriginType,
                    sourceItemIds: [item.id],
                    evidenceSpanIds: [spanId],
                    qualifiers: {},
                    confidence: Math.min(0.95, item.confidence),
                    state: {
                        scope: item.scope,
                        validity: item.validity,
                    },
                });
            }
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

    const unitSpanLimits = {
        meso: 4,
        macro: 4,
    };

    for (const unit of units) {
        if (unit.layer !== "meso" && unit.layer !== "macro") continue;
        const unitNodeId = unitNodeById.get(unit.id);
        if (!unitNodeId) continue;
        const allSpanIds = collectDescendantSpans(unit.id);
        const topSpanIds = selectTopSpans(allSpanIds, unitSpanLimits[unit.layer]);
        for (const spanId of topSpanIds) {
            const evidenceNodeId = evidenceNodeBySpan.get(spanId);
            if (!evidenceNodeId) continue;
            pushEdge({
                type:
                    unit.layer === "meso"
                        ? "meso_block_evidenced_by_span_set"
                        : "macro_node_evidenced_by_span_set",
                src: unitNodeId,
                dst: evidenceNodeId,
                layer: "cross",
                originType: "aggregated",
                sourceItemIds: [],
                evidenceSpanIds: [spanId],
                qualifiers: {},
                confidence: 0.7,
                state: {
                    scope: "session",
                    validity: "active",
                },
            });
        }
    }

    const mesoLinkSeen = new Set<string>();
    const mesoAbstractSeen = new Set<string>();
    for (const node of nodes) {
        if (node.primaryLayer !== "micro") continue;
        if (!node.id.startsWith("node_sem_")) {
            continue;
        }
        const item = itemByNodeId.get(node.id);
        const originType = item?.originType || "aggregated";
        const sourceItemIds = item ? [item.id] : [];
        const confidence = item ? item.confidence : node.state.confidence;
        const scope = item ? item.scope : node.state.scope;
        const validity = item ? item.validity : node.state.validity;

        for (const spanId of node.evidenceSpanIds) {
            const span = spanById.get(spanId);
            if (!span) continue;
            const microUnit = unitById.get(span.unitId);
            if (!microUnit || !microUnit.parentUnitId) continue;
            const mesoUnit = unitById.get(microUnit.parentUnitId);
            if (!mesoUnit || mesoUnit.layer !== "meso") continue;
            const mesoNodeId = unitNodeById.get(mesoUnit.id);
            if (!mesoNodeId) continue;
            const key = `${node.id}->${mesoNodeId}`;
            if (mesoLinkSeen.has(key)) continue;
            mesoLinkSeen.add(key);
            pushEdge({
                type: "micro_node_in_meso_block",
                src: node.id,
                dst: mesoNodeId,
                layer: "cross",
                originType: originType as V8MemoryOriginType,
                sourceItemIds,
                evidenceSpanIds: [spanId],
                qualifiers: {},
                confidence: Math.min(0.95, confidence),
                state: {
                    scope,
                    validity,
                },
            });
            if (!mesoAbstractSeen.has(key)) {
                mesoAbstractSeen.add(key);
                pushEdge({
                    type: "micro_fact_abstracted_as_block",
                    src: node.id,
                    dst: mesoNodeId,
                    layer: "cross",
                    originType: originType as V8MemoryOriginType,
                    sourceItemIds,
                    evidenceSpanIds: [spanId],
                    qualifiers: {},
                    confidence: Math.min(0.65, confidence),
                    state: {
                        scope,
                        validity,
                    },
                });
            }
        }
    }

    const edgeMesoSeen = new Set<string>();
    const edgeAbstractSeen = new Set<string>();
    for (const item of items) {
        if (item.itemType === "discourse_unit") continue;
        const edgeNodeId = nodeIdByItemId.get(item.id);
        if (!edgeNodeId) continue;
        for (const spanId of item.evidenceSpanIds) {
            const span = spanById.get(spanId);
            if (!span) continue;
            const microUnit = unitById.get(span.unitId);
            if (!microUnit || !microUnit.parentUnitId) continue;
            const mesoUnit = unitById.get(microUnit.parentUnitId);
            if (!mesoUnit || mesoUnit.layer !== "meso") continue;
            const mesoNodeId = unitNodeById.get(mesoUnit.id);
            if (!mesoNodeId) continue;
            const key = `${edgeNodeId}->${mesoNodeId}`;
            if (edgeMesoSeen.has(key)) continue;
            edgeMesoSeen.add(key);
            pushEdge({
                type: "micro_edge_in_meso_block",
                src: edgeNodeId,
                dst: mesoNodeId,
                layer: "cross",
                originType: item.originType as V8MemoryOriginType,
                sourceItemIds: [item.id],
                evidenceSpanIds: [spanId],
                qualifiers: {},
                confidence: Math.min(0.92, item.confidence),
                state: {
                    scope: item.scope,
                    validity: item.validity,
                },
            });
            if (!edgeAbstractSeen.has(key)) {
                edgeAbstractSeen.add(key);
                pushEdge({
                    type: "micro_fact_abstracted_as_block",
                    src: edgeNodeId,
                    dst: mesoNodeId,
                    layer: "cross",
                    originType: item.originType as V8MemoryOriginType,
                    sourceItemIds: [item.id],
                    evidenceSpanIds: [spanId],
                    qualifiers: {},
                    confidence: Math.min(0.6, item.confidence),
                    state: {
                        scope: item.scope,
                        validity: item.validity,
                    },
                });
            }
        }
    }

    return { nodes, edges };
}

function truncateLabel(text: string, maxLen = 120): string {
    const trimmed = (text || "").trim().replace(/\s+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
}

function normalizeKey(text: string): string {
    return (text || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function mergeIds(base: string[], extra: string[]): string[] {
    if (!extra.length) return base;
    const set = new Set(base);
    for (const id of extra) {
        if (!set.has(id)) {
            base.push(id);
            set.add(id);
        }
    }
    return base;
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

function selectTopSpans(spanIds: string[], maxCount: number): string[] {
    if (spanIds.length <= maxCount) return spanIds;
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const spanId of spanIds) {
        if (seen.has(spanId)) continue;
        seen.add(spanId);
        unique.push(spanId);
    }
    return unique.slice(0, maxCount);
}

function isStateMemoryType(itemType: V8MemoryItem["itemType"]): boolean {
    return itemType.endsWith("_state") || itemType === "session_state" || itemType === "topic_state";
}

function deriveStateMemoryType(
    item: V8MemoryItem,
    semanticLinks?: { subjectNodeId: string; objectNodeId: string }
): V8GraphNode["memoryType"] {
    if (isStateMemoryType(item.itemType)) {
        return item.itemType;
    }

    const predicate = String(item.predicate || "").trim().toLowerCase();
    const hay = `${item.subject || ""} ${item.object || ""} ${item.label || ""}`.toLowerCase();
    const hasDualAnchors = Boolean(semanticLinks?.subjectNodeId && semanticLinks?.objectNodeId);
    const relationshipPredicate = new Set([
        "involves",
        "conflicts_with",
        "supports",
        "contradicts",
        "similar_to",
        "differs_from",
        "better_than",
        "worse_than",
        "equivalent_to",
        "before",
        "after",
    ]);

    if (
        hasDualAnchors &&
        (relationshipPredicate.has(predicate) ||
            /(relationship|partner|friend|enemy|rival|夫妻|恋人|朋友|敌人|对手|搭档|盟友|同事|关系)/.test(hay))
    ) {
        return "relationship_state";
    }

    return "topic_state";
}

function deriveStateCue(item: V8MemoryItem): { status: string } | null {
    const status = String(item.qualifiers?.status || item.qualifiers?.phase || "").trim().toLowerCase();
    if (!status) return null;
    if (
        status.includes("current") ||
        status.includes("latest") ||
        status.includes("now") ||
        status.includes("final") ||
        status.includes("earlier") ||
        status.includes("previous") ||
        status.includes("original") ||
        status.includes("initial") ||
        status.includes("former")
    ) {
        return { status };
    }
    return null;
}

function resolveStateValidity(
    validity: V8MemoryItem["validity"],
    status?: string
): V8GraphNode["state"]["validity"] {
    if (!status) return validity;
    if (
        status.includes("earlier") ||
        status.includes("previous") ||
        status.includes("original") ||
        status.includes("initial") ||
        status.includes("former")
    ) {
        return "superseded";
    }
    if (
        status.includes("current") ||
        status.includes("latest") ||
        status.includes("now") ||
        status.includes("final")
    ) {
        return "active";
    }
    return validity;
}

function stateStatusRank(status: string): number {
    if (
        status.includes("earlier") ||
        status.includes("previous") ||
        status.includes("original") ||
        status.includes("initial") ||
        status.includes("former")
    ) {
        return 0;
    }
    if (
        status.includes("current") ||
        status.includes("latest") ||
        status.includes("now") ||
        status.includes("final")
    ) {
        return 2;
    }
    return 1;
}

function buildStateLabel(
    item: V8MemoryItem,
    memoryType: V8GraphNode["memoryType"],
    status?: string
): string {
    const statusPrefix = status ? `${status.replace(/_/g, " ")}` : "derived";
    if (memoryType === "relationship_state") {
        const participants = [item.subject, item.object].filter(Boolean).join(" ↔ ");
        const relationshipText = item.label || participants;
        return truncateLabel(`${statusPrefix} relationship: ${relationshipText}`);
    }
    return truncateLabel(`${statusPrefix} state: ${item.label || item.object || item.subject}`);
}

function deriveStateScopeTargets(
    semanticLinks: { subjectNodeId: string; objectNodeId: string } | undefined,
    memoryType: V8GraphNode["memoryType"]
): string[] {
    if (!semanticLinks) return [];
    if (memoryType === "relationship_state") {
        return Array.from(
            new Set([semanticLinks.subjectNodeId, semanticLinks.objectNodeId].filter(Boolean))
        );
    }
    return semanticLinks.objectNodeId
        ? [semanticLinks.objectNodeId]
        : semanticLinks.subjectNodeId
          ? [semanticLinks.subjectNodeId]
          : [];
}

function resolveItemTimestampMs(
    item: V8MemoryItem,
    spanById: Map<string, V8EvidenceSpan>
): number | null {
    const qualifierTime = String(item.qualifiers?.time || "").trim();
    const qualifierMs = qualifierTime ? Date.parse(qualifierTime) : Number.NaN;
    if (Number.isFinite(qualifierMs)) return qualifierMs;
    for (const spanId of item.evidenceSpanIds || []) {
        const span = spanById.get(spanId);
        if (!span?.timestamp) continue;
        const spanMs = Date.parse(span.timestamp);
        if (Number.isFinite(spanMs)) return spanMs;
    }
    return null;
}

function deriveAnchorTokens(item: V8MemoryItem): string[] {
    return tokenizeForState([
        item.subject || "",
        item.object || "",
        item.label || "",
    ].join(" "));
}

function tokenizeForState(text: string): string[] {
    const stop = new Set([
        "the",
        "a",
        "an",
        "and",
        "or",
        "to",
        "of",
        "on",
        "in",
        "for",
        "with",
        "current",
        "design",
        "team",
        "service",
        "state",
        "avoidance",
        "should",
        "stay",
    ]);
    return Array.from(
        new Set(
            String(text || "")
                .toLowerCase()
                .split(/[^a-z0-9\u4e00-\u9fff]+/)
                .map((token) => token.trim())
                .filter((token) => token.length >= 2 || /[\u4e00-\u9fff]/.test(token))
                .filter((token) => !stop.has(token))
        )
    );
}

function stateCandidateSimilarity(
    current: DerivedStateCandidate,
    previous: DerivedStateCandidate
): number {
    const sharedAnchorNode = current.anchorNodeIds.some((id) => previous.anchorNodeIds.includes(id));
    const currentTokens = new Set(current.anchorTokens);
    const previousTokens = new Set(previous.anchorTokens);
    let tokenHits = 0;
    for (const token of previousTokens) {
        if (currentTokens.has(token)) tokenHits += 1;
    }
    const tokenScore = tokenHits / Math.max(1, Math.min(currentTokens.size || 1, previousTokens.size || 1));
    return tokenScore + (sharedAnchorNode ? 0.35 : 0);
}

function selectChangingEvent(
    events: Array<{
        item: V8MemoryItem;
        edgeNodeId: string;
        timestampMs: number | null;
        anchorTokens: string[];
    }>,
    current: DerivedStateCandidate,
    previous: DerivedStateCandidate
): { item: V8MemoryItem; edgeNodeId: string; timestampMs: number | null; anchorTokens: string[] } | null {
    const currentTime = current.timestampMs ?? Number.POSITIVE_INFINITY;
    const previousTime = previous.timestampMs ?? Number.NEGATIVE_INFINITY;
    let best: { item: V8MemoryItem; edgeNodeId: string; timestampMs: number | null; anchorTokens: string[] } | null = null;
    let bestScore = 0;
    const anchorSet = new Set([...current.anchorTokens, ...previous.anchorTokens]);
    for (const event of events) {
        const eventTime = event.timestampMs ?? currentTime;
        if (eventTime < previousTime || eventTime > currentTime) continue;
        let overlap = 0;
        for (const token of event.anchorTokens) {
            if (anchorSet.has(token)) overlap += 1;
        }
        const cueScore = hasChangeCue(event.item) ? 0.75 : 0;
        const score = overlap + cueScore;
        if (score <= bestScore) continue;
        bestScore = score;
        best = event;
    }
    return bestScore > 0 ? best : null;
}

function hasChangeCue(item: V8MemoryItem): boolean {
    const hay = `${item.subject || ""} ${item.predicate || ""} ${item.object || ""} ${item.label || ""}`.toLowerCase();
    return /(revers|changed|change|switch|replace|removed|remove|drop|rollback|fallout|fix|fixed|resolved|invalidat|reactivat|取代|改成|改为|变成|反转|撤回|恢复|修复)/.test(hay);
}
