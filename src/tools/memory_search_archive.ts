import { Type, type Static } from "@sinclair/typebox";
import { resolveWorkspace } from "../utils.js";
import { searchArchiveSpans } from "../v8/archive-search.js";

export const MemorySearchArchiveParams = Type.Object({
    query: Type.String({
        minLength: 1,
        description: "Natural-language query for searching memory archive spans.",
    }),
    top_k: Type.Optional(
        Type.Number({
            minimum: 1,
            maximum: 30,
            description: "Number of top span matches to return. Default 8.",
        })
    ),
    mode: Type.Optional(
        Type.Union([Type.Literal("hybrid"), Type.Literal("bm25"), Type.Literal("vector")], {
            description: "Search mode. hybrid = bm25 + vector rerank.",
        })
    ),
    window_chars: Type.Optional(
        Type.Number({
            minimum: 80,
            maximum: 1200,
            description:
                "How much original narrative context to return around the matched span.",
        })
    ),
});

export type MemorySearchArchiveInput = Static<typeof MemorySearchArchiveParams>;

export async function executeMemorySearchArchive(
    _toolCallId: string,
    params: MemorySearchArchiveInput,
    ctx?: { workspaceDir?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const results = searchArchiveSpans({
        workspace,
        query: params.query,
        topK: params.top_k,
        mode: params.mode,
        windowChars: params.window_chars,
    });

    if (results.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text:
                        "No archive span matched the query. " +
                        "Try broader terms, or run memory_consolidate first.",
                },
            ],
        };
    }

    const lines: string[] = [];
    lines.push(
        `archive_search mode=${params.mode || "hybrid"} top_k=${params.top_k || 8} hits=${results.length}`
    );
    for (let i = 0; i < results.length; i += 1) {
        const hit = results[i]!;
        lines.push("");
        lines.push(
            `${i + 1}. score=${hit.score.toFixed(4)} bm25=${hit.bm25Score.toFixed(4)} vector=${hit.vectorScore.toFixed(4)}`
        );
        lines.push(`span_id=${hit.spanId} unit_id=${hit.unitId}`);
        lines.push(
            `speaker=${hit.speaker || "unknown"} time=${hit.timestamp || "unknown"}`
        );
        lines.push(`span_text=${singleLine(hit.spanText, 220)}`);
        lines.push(`raw_text=${singleLine(hit.rawText, 280)}`);
        lines.push(
            `source=${hit.narrativeRef}#${hit.charStart}-${hit.charEnd}`
        );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
}

function singleLine(text: string, maxChars: number): string {
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (flat.length <= maxChars) return flat;
    return `${flat.slice(0, maxChars)}…`;
}
