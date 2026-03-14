import { Type, type Static } from "@sinclair/typebox";
import { resolveWorkspace } from "../utils.js";
import { buildCleanSlateGraph } from "../v8/compiler_clean_slate.js";

/** Parameter schema for memory_consolidate tool. */
export const MemoryConsolidateParams = Type.Object({
    session_trace_dir: Type.Optional(
        Type.String({
            description: "Optional override for OpenClaw session trace directory.",
        })
    ),
    max_session_files: Type.Optional(
        Type.Number({
            minimum: 1,
            description: "Optional cap on number of session transcript files to ingest.",
        })
    ),
    ir_llm_command: Type.Optional(
        Type.String({
            description:
                "Optional command to run offline LLM IR extraction. " +
                "Use {jobs} and {items} placeholders or rely on V8_IR_JOBS/V8_IR_ITEMS env vars.",
        })
    ),
});

export type MemoryConsolidateInput = Static<typeof MemoryConsolidateParams>;

export async function executeMemoryConsolidate(
    _toolCallId: string,
    params: MemoryConsolidateInput,
    ctx?: { workspaceDir?: string; config?: Record<string, unknown> }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const pluginConfig = ctx?.config || {};
    const sessionTraceDir =
        (params.session_trace_dir as string | undefined) ||
        (pluginConfig as any)?.v8SessionTraceDir ||
        process.env.OPENCLAW_SESSION_TRACE_DIR;
    const maxSessionFiles = params.max_session_files;
    const llmCommand =
        (params.ir_llm_command as string | undefined) ||
        (pluginConfig as any)?.v8IrLlmCommand ||
        process.env.V8_IR_LLM_COMMAND;
    const llmTimeoutMs =
        typeof (pluginConfig as any)?.v8IrLlmTimeoutMs === "number"
            ? (pluginConfig as any).v8IrLlmTimeoutMs
            : undefined;

    const output = buildCleanSlateGraph({
        workspace,
        sessionTraceDir,
        maxSessionFiles,
        llmCommand,
        llmCommandTimeoutMs: llmTimeoutMs,
    });

    const summary = [
        "Clean-slate V8 build completed.",
        `sessionTraceDir=${sessionTraceDir || "default"}`,
        maxSessionFiles ? `maxSessionFiles=${maxSessionFiles}` : null,
        llmCommand ? `llmStatus=${output.llmStatus}` : null,
        `sourceRecords=${output.sourceRecords.length}`,
        `units=${output.units.length}`,
        `evidenceSpans=${output.evidenceSpans.length}`,
        `memoryItems=${output.memoryItems.length}`,
        `llmJobs=${output.llmJobs.length}`,
        `llmItems=${output.llmItems.length}`,
        `graphNodes=${output.nodes.length}`,
        `graphEdges=${output.edges.length}`,
        `ignitionNodes=${output.ignitionNodes.length}`,
        `ignitionEdges=${output.ignitionEdges.length}`,
        `recallBundles=${output.recallBundles.length}`,
    ]
        .filter(Boolean)
        .join("\n");

    return { content: [{ type: "text", text: summary }] };
}
