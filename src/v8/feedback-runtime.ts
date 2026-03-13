import type { V8ActivatedBundle, V8RecallMode } from "./types_v8.js";

export interface V8RecallTraceBundle {
    bundleId: string;
    nodeIds: string[];
    evidenceSpanIds: string[];
    tier: V8ActivatedBundle["tier"];
}

export interface V8RecallTrace {
    traceId: string;
    sessionId: string;
    mode: V8RecallMode;
    bundles: V8RecallTraceBundle[];
    createdAt: number;
}

const recentRecalls = new Map<string, V8RecallTrace[]>();
const MAX_TRACES_PER_SESSION = 4;

function nowMs(): number {
    return Date.now();
}

function buildTraceId(): string {
    return `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneTraces(traces: V8RecallTrace[], maxAgeMs: number): V8RecallTrace[] {
    const now = nowMs();
    return traces.filter((trace) => now - trace.createdAt <= maxAgeMs);
}

export function recordRecallTrace(
    sessionId: string,
    payload: {
        mode: V8RecallMode;
        bundles: V8RecallTraceBundle[];
    }
): V8RecallTrace | null {
    if (!sessionId || payload.bundles.length === 0) {
        return null;
    }
    const trace: V8RecallTrace = {
        traceId: buildTraceId(),
        sessionId,
        mode: payload.mode,
        bundles: payload.bundles,
        createdAt: nowMs(),
    };
    const list = recentRecalls.get(sessionId) || [];
    list.push(trace);
    recentRecalls.set(
        sessionId,
        list.slice(-MAX_TRACES_PER_SESSION)
    );
    return trace;
}

export function getRecentRecallTraces(
    sessionId: string,
    maxAgeMs = 10 * 60 * 1000
): V8RecallTrace[] {
    const list = recentRecalls.get(sessionId);
    if (!list || list.length === 0) return [];
    const fresh = pruneTraces(list, maxAgeMs);
    recentRecalls.set(sessionId, fresh);
    return fresh;
}

export function takeRecentRecallTraces(
    sessionId: string,
    maxAgeMs = 10 * 60 * 1000
): V8RecallTrace[] {
    const list = recentRecalls.get(sessionId);
    if (!list || list.length === 0) return [];
    const fresh = pruneTraces(list, maxAgeMs);
    recentRecalls.delete(sessionId);
    return fresh;
}

export function recordSessionRecalls(sessionId: string, nodeIds: string[]): void {
    if (!sessionId || nodeIds.length === 0) {
        return;
    }
    const unique = Array.from(new Set(nodeIds));
    recordRecallTrace(sessionId, {
        mode: "profile",
        bundles: [
            {
                bundleId: "legacy",
                nodeIds: unique,
                evidenceSpanIds: [],
                tier: "background",
            },
        ],
    });
}

export function takeRecentRecalls(
    sessionId: string,
    maxAgeMs = 10 * 60 * 1000
): string[] {
    const traces = takeRecentRecallTraces(sessionId, maxAgeMs);
    if (traces.length === 0) return [];
    const aggregated = new Set<string>();
    for (const trace of traces) {
        for (const bundle of trace.bundles) {
            for (const nodeId of bundle.nodeIds) {
                aggregated.add(nodeId);
            }
        }
    }
    return Array.from(aggregated);
}
