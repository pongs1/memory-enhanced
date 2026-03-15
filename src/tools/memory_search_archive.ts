import { Type, type Static } from "@sinclair/typebox";
import { resolveWorkspace } from "../utils.js";
import { searchArchiveSpans } from "../v8/archive-search.js";
import { v8StorePaths } from "../v8/paths_v8.js";
import { readJsonl } from "../v8/architecture/io.js";

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
    plan_id: Type.Optional(
        Type.String({
            minLength: 3,
            description:
                "Optional relation_search_plan id. When provided, search is constrained by shard selection and boosted by plan hint spans.",
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
    const planContext = loadPlanContext(workspace, params.plan_id);
    const queryWithPlanHints = planContext
        ? joinQuery(params.query, planContext.queryTerms)
        : params.query;
    const results = searchArchiveSpans({
        workspace,
        query: queryWithPlanHints,
        topK: params.top_k,
        mode: params.mode,
        windowChars: params.window_chars,
        allowedShardIds: planContext?.allowedShardIds,
        boostSpanIds: planContext?.boostSpanIds,
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
    if (planContext) {
        lines.push(
            `plan_id=${planContext.id} lane=${planContext.lane} shardHints=${planContext.allowedShardIds.length} boostSpans=${planContext.boostSpanIds.length}`
        );
    }
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

interface SearchPlanRecord {
    id: string;
    lane?: string;
    queryTerms?: string[];
    hintSpanIds?: string[];
}

interface ShardSelectionRecord {
    id: string;
    planId: string;
    lane?: string;
    selectedShardHints?: Array<{ id?: string }>;
}

interface PlanContext {
    id: string;
    lane: string;
    queryTerms: string[];
    boostSpanIds: string[];
    allowedShardIds: string[];
}

function loadPlanContext(workspace: string, planId?: string): PlanContext | null {
    if (!planId) return null;
    const store = v8StorePaths(workspace);
    const plans = readJsonl<SearchPlanRecord>(store.relationSearchPlans);
    const plan = plans.find((item) => item.id === planId);
    if (!plan) return null;
    const shardSelections = readJsonl<ShardSelectionRecord>(store.narrativeShardSelections);
    const selection = shardSelections.find((item) => item.planId === planId);
    const allowedShardIds =
        selection?.selectedShardHints
            ?.map((item) => (item?.id || "").trim())
            .filter(Boolean) || [];
    const queryTerms =
        plan.queryTerms
            ?.map((item) => (item || "").trim())
            .filter(Boolean)
            .slice(0, 10) || [];
    const boostSpanIds =
        plan.hintSpanIds
            ?.map((item) => (item || "").trim())
            .filter(Boolean)
            .slice(0, 64) || [];
    return {
        id: plan.id,
        lane: selection?.lane || plan.lane || "focused",
        queryTerms,
        boostSpanIds,
        allowedShardIds,
    };
}

function joinQuery(base: string, extras: string[]): string {
    const merged = [base.trim(), ...extras].filter(Boolean).join(" ");
    return merged.replace(/\s+/g, " ").trim();
}

function singleLine(text: string, maxChars: number): string {
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (flat.length <= maxChars) return flat;
    return `${flat.slice(0, maxChars)}…`;
}
