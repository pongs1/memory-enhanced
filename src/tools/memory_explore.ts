import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    resolveWorkspace,
    paths,
    readEvents,
    writeEvents,
    findKnowledgeEntry,
    type MemoryEvent,
} from "../utils.js";
import { computeScore } from "../scoring.js";

/** Parameter schema for memory_explore tool. */
export const MemoryExploreParams = Type.Object({
    entry_id: Type.String({
        description:
            "Event ID (evt_YYYYMMDD_NNN) or knowledge entry ID (ke_NNN) to explore from",
    }),
    depth: Type.Optional(
        Type.Number({
            minimum: 1,
            maximum: 3,
            default: 2,
            description: "Max association hops to follow (1-3)",
        })
    ),
    direction: Type.Optional(
        Type.Union(
            [
                Type.Literal("forward"),
                Type.Literal("backward"),
                Type.Literal("both"),
            ],
            { default: "both", description: "Association traversal direction" }
        )
    ),
});

export type MemoryExploreInput = Static<typeof MemoryExploreParams>;

interface ExploreNode {
    id: string;
    type: string; // "event" | "knowledge"
    content: string;
    importance: number;
    associations: string[];
    depth: number; // how many hops from the root
    score: number;
}

/**
 * Execute memory_explore: traverse association chains from a given entry.
 *
 * 1. Finds the root entry (event or knowledge)
 * 2. Follows association links up to `depth` hops
 * 3. Calculates relevance scores
 * 4. Reinforces accessed events (resets decay_score)
 * 5. Returns an association graph
 */
export async function executeMemoryExplore(
    _toolCallId: string,
    params: MemoryExploreInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace();
    const p = paths(workspace);
    const maxDepth = params.depth ?? 2;

    // Collect all events across all JSONL files for lookups
    const allEvents = loadAllEvents(p.eventsDir);
    const visited = new Set<string>();
    const graph: ExploreNode[] = [];

    // BFS traversal
    const queue: Array<{ id: string; depth: number }> = [
        { id: params.entry_id, depth: 0 },
    ];

    while (queue.length > 0) {
        const item = queue.shift()!;
        if (visited.has(item.id) || item.depth > maxDepth) continue;
        visited.add(item.id);

        const entry = resolveEntry(item.id, allEvents, p.knowledgeDir);
        if (!entry) continue;

        const node: ExploreNode = {
            id: item.id,
            type: entry.kind,
            content:
                entry.content.length > 300
                    ? entry.content.slice(0, 300) + "..."
                    : entry.content,
            importance: entry.importance,
            associations: entry.associations,
            depth: item.depth,
            score: computeScore({
                importance: entry.importance,
                associationCount: entry.associations.length,
            }),
        };
        graph.push(node);

        // Enqueue associations
        for (const assocId of entry.associations) {
            if (!visited.has(assocId)) {
                queue.push({ id: assocId, depth: item.depth + 1 });
            }
        }

        // Backward associations: find entries that reference this ID
        if (params.direction !== "forward") {
            for (const evt of allEvents) {
                if (
                    evt.associations.includes(item.id) &&
                    !visited.has(evt.id)
                ) {
                    queue.push({ id: evt.id, depth: item.depth + 1 });
                }
            }
        }
    }

    // Reinforce accessed events (reset decay_score to 1.0)
    reinforceEvents(p.eventsDir, visited);

    // Format output
    if (graph.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No entry found for ID: ${params.entry_id}`,
                },
            ],
        };
    }

    const lines = [
        `Association graph from ${params.entry_id} (depth: ${maxDepth}, direction: ${params.direction ?? "both"}):`,
        "",
    ];

    for (const node of graph) {
        const indent = "  ".repeat(node.depth);
        const assocLabel =
            node.associations.length > 0
                ? ` → [${node.associations.join(", ")}]`
                : "";
        lines.push(
            `${indent}[${node.type}] ${node.id} (imp: ${node.importance}, score: ${node.score})${assocLabel}`
        );
        lines.push(`${indent}  ${node.content}`);
        lines.push("");
    }

    lines.push(`Nodes visited: ${graph.length} | Decay scores reinforced`);

    return {
        content: [{ type: "text", text: lines.join("\n") }],
    };
}

// --- Internal helpers ---

function loadAllEvents(eventsDir: string): MemoryEvent[] {
    const all: MemoryEvent[] = [];
    try {
        const files = fs
            .readdirSync(eventsDir)
            .filter((f: string) => f.endsWith(".jsonl"));
        for (const file of files) {
            all.push(...readEvents(path.join(eventsDir, file)));
        }
    } catch {
        // eventsDir doesn't exist yet
    }
    return all;
}

interface ResolvedEntry {
    kind: "event" | "knowledge";
    content: string;
    importance: number;
    associations: string[];
}

function resolveEntry(
    id: string,
    allEvents: MemoryEvent[],
    knowledgeDir: string
): ResolvedEntry | null {
    // Check events
    if (id.startsWith("evt_")) {
        const evt = allEvents.find((e) => e.id === id);
        if (evt) {
            return {
                kind: "event",
                content: evt.content,
                importance: evt.importance,
                associations: evt.associations,
            };
        }
    }

    // Check knowledge
    if (id.startsWith("ke_")) {
        const ke = findKnowledgeEntry(knowledgeDir, id);
        if (ke) {
            // Parse importance and associations from markdown
            const impMatch = ke.content.match(/\*\*Confidence\*\*:\s*([\d.]+|high|medium|low)/i);
            const assocMatch = ke.content.match(/\*\*Associations?\*\*:\s*(.+)/i);
            const importance = impMatch
                ? impMatch[1] === "high"
                    ? 0.9
                    : impMatch[1] === "medium"
                        ? 0.6
                        : impMatch[1] === "low"
                            ? 0.3
                            : parseFloat(impMatch[1]) || 0.5
                : 0.5;
            const associations = assocMatch
                ? assocMatch[1]
                    .split(/[,\s]+/)
                    .filter((s: string) => s.startsWith("ke_") || s.startsWith("evt_"))
                : [];

            return {
                kind: "knowledge",
                content: ke.content,
                importance,
                associations,
            };
        }
    }

    return null;
}

/**
 * Reinforce events: reset decay_score to 1.0 for accessed event IDs.
 * This mimics the brain's "retrieval strengthens memory" effect.
 */
function reinforceEvents(eventsDir: string, accessedIds: Set<string>): void {
    try {
        const files = fs
            .readdirSync(eventsDir)
            .filter((f: string) => f.endsWith(".jsonl"));
        for (const file of files) {
            const filePath = path.join(eventsDir, file);
            const events = readEvents(filePath);
            let modified = false;
            for (const evt of events) {
                if (accessedIds.has(evt.id) && evt.decay_score < 1.0) {
                    evt.decay_score = 1.0;
                    modified = true;
                }
            }
            if (modified) {
                writeEvents(filePath, events);
            }
        }
    } catch {
        // ignore
    }
}
