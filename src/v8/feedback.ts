import * as fs from "node:fs";
import { nowISO } from "../utils.js";
import { ensureGraphDirs, getNodeStorePath, graphPaths } from "./paths.js";
import type {
    AssembleRecallOutput,
    V8FeedbackUpdate,
    V8MemoryBundle,
    V8MemoryEdge,
    V8MemoryNode,
    V8NodeKind,
    V8RecallFeedback,
    V8UpdateQueueItem,
} from "./types.js";

interface PendingRecallEntry {
    bundleId: string;
    nodeIds: string[];
    sourceRefs: string[];
    deliveredAt: string;
}

interface GraphSnapshot {
    bundles: V8MemoryBundle[];
    nodes: V8MemoryNode[];
    edges: V8MemoryEdge[];
    queueItems: V8UpdateQueueItem[];
}

const pendingRecallsBySession = new Map<string, PendingRecallEntry[]>();

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function readJsonl<T>(filePath: string): T[] {
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

function writeJsonl<T>(filePath: string, items: T[]): void {
    const content = items.length > 0
        ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
        : "";
    fs.writeFileSync(filePath, content, "utf-8");
}

function loadGraphSnapshot(workspace: string): GraphSnapshot {
    const gp = ensureGraphDirs(workspace);
    return {
        bundles: readJsonl<V8MemoryBundle>(gp.bundles),
        nodes: [
            ...readJsonl<V8MemoryNode>(gp.nodesEpisodic),
            ...readJsonl<V8MemoryNode>(gp.nodesSemantic),
            ...readJsonl<V8MemoryNode>(gp.nodesProcedural),
        ],
        edges: [
            ...readJsonl<V8MemoryEdge>(gp.edgesAssociative),
            ...readJsonl<V8MemoryEdge>(gp.edgesStructural),
            ...readJsonl<V8MemoryEdge>(gp.edgesSupersession),
        ],
        queueItems: readJsonl<V8UpdateQueueItem>(gp.updateQueue),
    };
}

function persistGraphSnapshot(workspace: string, snapshot: GraphSnapshot): void {
    const gp = ensureGraphDirs(workspace);
    const byKind = new Map<V8NodeKind, V8MemoryNode[]>();
    byKind.set("episodic", snapshot.nodes.filter((node) => node.kind === "episodic"));
    byKind.set("semantic", snapshot.nodes.filter((node) => node.kind === "semantic"));
    byKind.set("procedural", snapshot.nodes.filter((node) => node.kind === "procedural"));

    writeJsonl(gp.bundles, snapshot.bundles);
    writeJsonl(getNodeStorePath(gp, "episodic"), byKind.get("episodic") || []);
    writeJsonl(getNodeStorePath(gp, "semantic"), byKind.get("semantic") || []);
    writeJsonl(getNodeStorePath(gp, "procedural"), byKind.get("procedural") || []);
    writeJsonl(
        gp.edgesAssociative,
        snapshot.edges.filter((edge) => edge.type === "associative")
    );
    writeJsonl(
        gp.edgesStructural,
        snapshot.edges.filter(
            (edge) => edge.type !== "associative" && edge.type !== "supersedes"
        )
    );
    writeJsonl(
        gp.edgesSupersession,
        snapshot.edges.filter((edge) => edge.type === "supersedes")
    );
    writeJsonl(gp.updateQueue, snapshot.queueItems);
}

function appendFeedbackLog(workspace: string, feedbacks: V8RecallFeedback[]): void {
    if (feedbacks.length === 0) return;
    const gp = ensureGraphDirs(workspace);
    const existing = readJsonl<V8RecallFeedback>(gp.feedbackLog);
    writeJsonl(gp.feedbackLog, [...existing, ...feedbacks]);
}

function makeQueueItem(
    feedback: V8RecallFeedback,
    reason: V8UpdateQueueItem["reason"],
    evidence: string[]
): V8UpdateQueueItem {
    return {
        id: `uq_${feedback.bundleId}_${reason}_${Date.parse(feedback.observedAt)}`,
        targetType: "bundle",
        targetId: feedback.bundleId,
        reason,
        evidence,
        createdAt: feedback.observedAt,
        status: "pending",
    };
}

function applyNodeOutcome(node: V8MemoryNode, feedback: V8RecallFeedback): V8MemoryNode {
    const next = { ...node, lastUsedAt: feedback.observedAt };

    switch (feedback.outcome) {
        case "accepted":
            next.adoptCount += 1;
            next.confidence = clamp01(next.confidence + 0.02);
            next.importance = clamp01(next.importance + 0.01);
            next.lastVerifiedAt = feedback.observedAt;
            break;
        case "ignored":
            break;
        case "not_reached":
            break;
        case "misapplied":
            next.rejectCount += 1;
            next.confidence = clamp01(next.confidence - 0.015);
            break;
        case "contradicted":
            next.rejectCount += 1;
            next.confidence = clamp01(next.confidence - 0.05);
            break;
        case "superseded":
            next.rejectCount += 1;
            next.confidence = clamp01(next.confidence - 0.02);
            next.importance = clamp01(next.importance - 0.01);
            break;
        case "harmful":
            next.rejectCount += 1;
            next.harmCount += 1;
            next.confidence = clamp01(next.confidence - 0.08);
            next.importance = clamp01(next.importance - 0.03);
            break;
    }

    return next;
}

function applyEdgeOutcome(edge: V8MemoryEdge, feedback: V8RecallFeedback): V8MemoryEdge {
    if (edge.type !== "associative") {
        return edge;
    }

    const next = { ...edge, lastUpdatedAt: feedback.observedAt };

    switch (feedback.outcome) {
        case "accepted":
            next.adoptCount += 1;
            next.assocStrength = clamp01(next.assocStrength + 0.03);
            next.utility = clamp01(next.utility + 0.05);
            next.trust = clamp01(next.trust + 0.02);
            next.contextFit = clamp01(next.contextFit + 0.04);
            next.lastVerifiedAt = feedback.observedAt;
            break;
        case "ignored":
            next.contextFit = clamp01(next.contextFit - 0.015);
            break;
        case "not_reached":
            break;
        case "misapplied":
            next.rejectCount += 1;
            next.utility = clamp01(next.utility - 0.035);
            next.contextFit = clamp01(next.contextFit - 0.05);
            break;
        case "contradicted":
            next.rejectCount += 1;
            next.utility = clamp01(next.utility - 0.06);
            next.trust = clamp01(next.trust - 0.08);
            next.contextFit = clamp01(next.contextFit - 0.06);
            break;
        case "superseded":
            next.rejectCount += 1;
            next.freshness = clamp01(next.freshness - 0.08);
            next.contextFit = clamp01(next.contextFit - 0.07);
            break;
        case "harmful":
            next.rejectCount += 1;
            next.assocStrength = clamp01(next.assocStrength - 0.08);
            next.utility = clamp01(next.utility - 0.12);
            next.trust = clamp01(next.trust - 0.14);
            next.contextFit = clamp01(next.contextFit - 0.12);
            break;
    }

    return next;
}

export function applyRecallFeedback(
    feedback: V8RecallFeedback,
    graph: {
        nodes: V8MemoryNode[];
        edges: V8MemoryEdge[];
    }
): V8FeedbackUpdate {
    const targetNodeIds = new Set(feedback.nodeIds);
    const nodeUpdates: Partial<V8MemoryNode>[] = [];
    const edgeUpdates: Partial<V8MemoryEdge>[] = [];
    const queueItems: V8UpdateQueueItem[] = [];

    for (const node of graph.nodes) {
        if (!targetNodeIds.has(node.id)) continue;
        nodeUpdates.push(applyNodeOutcome(node, feedback));
    }

    for (const edge of graph.edges) {
        if (!targetNodeIds.has(edge.src) && !targetNodeIds.has(edge.dst)) {
            continue;
        }
        const nextEdge = applyEdgeOutcome(edge, feedback);
        if (nextEdge !== edge) {
            edgeUpdates.push(nextEdge);
        }
    }

    if (feedback.outcome === "contradicted") {
        queueItems.push(
            makeQueueItem(feedback, "contradicted", [
                feedback.reason || "Recall contradicted by later evidence or user feedback.",
            ])
        );
    } else if (feedback.outcome === "superseded") {
        queueItems.push(
            makeQueueItem(feedback, "distribution_shift", [
                feedback.reason || "Recall path appears superseded by a newer condition or memory.",
            ])
        );
    } else if (feedback.outcome === "harmful") {
        queueItems.push(
            makeQueueItem(feedback, "high_harm", [
                feedback.reason || "Recall caused harmful execution drift or wrong action.",
            ])
        );
    }

    return { nodeUpdates, edgeUpdates, queueItems };
}

export function registerDeliveredRecalls(
    workspace: string,
    sessionId: string,
    recalls: AssembleRecallOutput[]
): { bundlesUpdated: number; edgesActivated: number } {
    if (recalls.length === 0) {
        return { bundlesUpdated: 0, edgesActivated: 0 };
    }

    const snapshot = loadGraphSnapshot(workspace);
    const deliveredAt = nowISO();
    const deliveredNodeIds = new Set<string>();
    const deliveredBundleIds = new Set<string>();

    for (const recall of recalls) {
        deliveredBundleIds.add(recall.bundleId);
        for (const nodeId of recall.nodeIds) {
            deliveredNodeIds.add(nodeId);
        }
    }

    let edgesActivated = 0;
    snapshot.nodes = snapshot.nodes.map((node) => {
        if (!deliveredNodeIds.has(node.id)) {
            return node;
        }
        return {
            ...node,
            hitCount: node.hitCount + 1,
            lastUsedAt: deliveredAt,
        };
    });

    snapshot.edges = snapshot.edges.map((edge) => {
        if (edge.type !== "associative") {
            return edge;
        }
        if (!deliveredNodeIds.has(edge.src) && !deliveredNodeIds.has(edge.dst)) {
            return edge;
        }
        edgesActivated += 1;
        return {
            ...edge,
            activationCount: edge.activationCount + 1,
            lastUpdatedAt: deliveredAt,
        };
    });

    persistGraphSnapshot(workspace, snapshot);

    const existingPending = pendingRecallsBySession.get(sessionId) || [];
    const pendingByBundle = new Map(existingPending.map((item) => [item.bundleId, item]));
    for (const recall of recalls) {
        pendingByBundle.set(recall.bundleId, {
            bundleId: recall.bundleId,
            nodeIds: recall.nodeIds,
            sourceRefs: recall.sourceRefs,
            deliveredAt,
        });
    }
    pendingRecallsBySession.set(sessionId, [...pendingByBundle.values()]);

    return {
        bundlesUpdated: deliveredBundleIds.size,
        edgesActivated,
    };
}

export function getPendingSessionRecalls(sessionId: string): PendingRecallEntry[] {
    return [...(pendingRecallsBySession.get(sessionId) || [])];
}

export function clearPendingSessionRecalls(sessionId: string, bundleIds?: string[]): void {
    if (!bundleIds || bundleIds.length === 0) {
        pendingRecallsBySession.delete(sessionId);
        return;
    }

    const pending = pendingRecallsBySession.get(sessionId) || [];
    const targetIds = new Set(bundleIds);
    const kept = pending.filter((entry) => !targetIds.has(entry.bundleId));
    if (kept.length === 0) {
        pendingRecallsBySession.delete(sessionId);
    } else {
        pendingRecallsBySession.set(sessionId, kept);
    }
}

export function persistRecallFeedback(
    workspace: string,
    feedbacks: V8RecallFeedback[]
): { applied: number; queueItems: number; bundleIds: string[] } {
    if (feedbacks.length === 0) {
        return { applied: 0, queueItems: 0, bundleIds: [] };
    }

    const snapshot = loadGraphSnapshot(workspace);
    const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const edgeMap = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
    const queueMap = new Map(snapshot.queueItems.map((item) => [item.id, item]));

    for (const feedback of feedbacks) {
        const update = applyRecallFeedback(feedback, {
            nodes: [...nodeMap.values()],
            edges: [...edgeMap.values()],
        });

        for (const nodeUpdate of update.nodeUpdates) {
            if (!nodeUpdate.id) continue;
            nodeMap.set(nodeUpdate.id, nodeUpdate as V8MemoryNode);
        }
        for (const edgeUpdate of update.edgeUpdates) {
            if (!edgeUpdate.id) continue;
            edgeMap.set(edgeUpdate.id, edgeUpdate as V8MemoryEdge);
        }
        for (const queueItem of update.queueItems) {
            queueMap.set(queueItem.id, queueItem);
        }
    }

    snapshot.nodes = [...nodeMap.values()];
    snapshot.edges = [...edgeMap.values()];
    snapshot.queueItems = [...queueMap.values()];
    persistGraphSnapshot(workspace, snapshot);
    appendFeedbackLog(workspace, feedbacks);

    return {
        applied: feedbacks.length,
        queueItems: snapshot.queueItems.length,
        bundleIds: [...new Set(feedbacks.map((item) => item.bundleId))],
    };
}

export function resolveBundleNodeIds(
    workspace: string,
    bundleIds: string[]
): Array<{ bundleId: string; nodeIds: string[] }> {
    const snapshot = loadGraphSnapshot(workspace);
    const bundleMap = new Map(snapshot.bundles.map((bundle) => [bundle.bundleId, bundle]));
    return bundleIds
        .map((bundleId) => {
            const bundle = bundleMap.get(bundleId);
            return bundle ? { bundleId, nodeIds: bundle.nodeIds } : null;
        })
        .filter((item): item is { bundleId: string; nodeIds: string[] } => Boolean(item));
}
