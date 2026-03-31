import type { V8GraphNode, V8MemoryItem } from "./types_v8.js";

export function collectNodeSpanIdsFromItems(
    node: V8GraphNode,
    itemsById: Map<string, V8MemoryItem>
): string[] {
    const spanIds: string[] = [];
    const seen = new Set<string>();
    for (const itemId of node.sourceItemIds || []) {
        const item = itemsById.get(itemId);
        if (!item) continue;
        for (const spanId of item.evidenceSpanIds || []) {
            if (seen.has(spanId)) continue;
            seen.add(spanId);
            spanIds.push(spanId);
        }
    }
    return spanIds.length > 0 ? spanIds : (node.evidenceSpanIds || []);
}
