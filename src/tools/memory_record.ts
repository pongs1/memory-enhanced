import { Type, type Static } from "@sinclair/typebox";
import {
    resolveWorkspace,
    paths,
    today,
    nowTime,
    nowISO,
    nextEventSeq,
    appendLine,
    ensureDir,
    readJson,
    writeJson,
    type MemoryEvent,
} from "../utils.js";

/** Parameter schema for memory_record tool. */
export const MemoryRecordParams = Type.Object({
    content: Type.String({ description: "What happened — concise description" }),
    type: Type.Union(
        [
            Type.Literal("decision"),
            Type.Literal("observation"),
            Type.Literal("insight"),
            Type.Literal("error"),
            Type.Literal("preference"),
            Type.Literal("correction"),
        ],
        { description: "Event type classification" }
    ),
    importance: Type.Optional(
        Type.Number({
            minimum: 0,
            maximum: 1,
            default: 0.5,
            description:
                "0.0-1.0 importance. 0.9+: explicit user request; 0.7-0.8: confirmed decisions/prefs; 0.5-0.6: useful observations; <0.3: don't record",
        })
    ),
    tags: Type.Optional(
        Type.Array(Type.String(), { description: "Categorization tags" })
    ),
    associations: Type.Optional(
        Type.Array(Type.String(), {
            description: "Linked event IDs (evt_*) or knowledge IDs (ke_*)",
        })
    ),
});

export type MemoryRecordInput = Static<typeof MemoryRecordParams>;

/**
 * Execute memory_record: write a structured event in dual format.
 *
 * 1. Appends structured JSONL to .memory/events/YYYY-MM-DD.jsonl
 * 2. Appends human-readable summary to memory/YYYY-MM-DD.md
 * 3. Returns the generated event ID
 */
export async function executeMemoryRecord(
    _toolCallId: string,
    params: MemoryRecordInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace();
    const p = paths(workspace);
    const dateStr = today();
    const timeStr = nowTime();

    // Generate event ID
    const jsonlPath = p.dailyJsonl(dateStr);
    const seq = nextEventSeq(jsonlPath);
    const eventId = `evt_${dateStr.replace(/-/g, "")}_${String(seq).padStart(3, "0")}`;

    // Build event object
    const event: MemoryEvent = {
        id: eventId,
        timestamp: nowISO(),
        type: params.type,
        content: params.content,
        tags: params.tags ?? [],
        importance: params.importance ?? 0.5,
        associations: params.associations ?? [],
        consolidated: false,
        decay_score: 1.0,
    };

    // --- Write JSONL (structured data, .memory/events/) ---
    ensureDir(p.eventsDir);
    appendLine(jsonlPath, JSON.stringify(event));

    // Update active time in focus_stack.json
    const focusStack = readJson<{ stack?: any[]; last_updated?: string }>(
        p.focusStack,
        { stack: [], last_updated: "" }
    );
    focusStack.last_updated = nowISO();
    writeJson(p.focusStack, focusStack);

    // --- Write MD (searchable summary, memory/YYYY-MM-DD.md) ---
    const assocStr =
        event.associations.length > 0
            ? ` | Assoc: ${event.associations.join(", ")}`
            : "";
    const tagStr =
        event.tags.length > 0 ? `Tags: ${event.tags.join(", ")} | ` : "";
    const mdLine = [
        `### ${timeStr} — ${event.type} [importance: ${event.importance}]`,
        event.content,
        `${tagStr}ID: ${eventId}${assocStr}`,
        "",
    ].join("\n");

    const mdPath = p.dailyLog(dateStr);
    ensureDir(p.memoryDir);
    appendLine(mdPath, mdLine);

    return {
        content: [
            {
                type: "text",
                text: `Event recorded: ${eventId}\nType: ${event.type} | Importance: ${event.importance}\nWritten to: .memory/events/${dateStr}.jsonl + memory/${dateStr}.md`,
            },
        ],
    };
}
