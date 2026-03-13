const recentRecalls = new Map<string, { nodeIds: string[]; at: number }>();

export function recordSessionRecalls(sessionId: string, nodeIds: string[]): void {
    if (!sessionId || nodeIds.length === 0) {
        return;
    }
    const unique = Array.from(new Set(nodeIds));
    recentRecalls.set(sessionId, { nodeIds: unique, at: Date.now() });
}

export function takeRecentRecalls(
    sessionId: string,
    maxAgeMs = 10 * 60 * 1000
): string[] {
    const entry = recentRecalls.get(sessionId);
    if (!entry) return [];
    if (Date.now() - entry.at > maxAgeMs) {
        recentRecalls.delete(sessionId);
        return [];
    }
    recentRecalls.delete(sessionId);
    return entry.nodeIds;
}
