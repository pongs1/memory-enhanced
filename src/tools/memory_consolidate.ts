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

    const output = buildCleanSlateGraph({
        workspace,
        sessionTraceDir,
        maxSessionFiles,
    });

    const summary = [
        "Clean-slate V8 build completed.",
        `sessionTraceDir=${sessionTraceDir || "default"}`,
        maxSessionFiles ? `maxSessionFiles=${maxSessionFiles}` : null,
        `sourceRecords=${output.sourceRecords.length}`,
        `units=${output.units.length}`,
        `evidenceSpans=${output.evidenceSpans.length}`,
        `memoryItems=${output.memoryItems.length}`,
        `graphNodes=${output.nodes.length}`,
        `graphEdges=${output.edges.length}`,
    ]
        .filter(Boolean)
        .join("\n");

    return { content: [{ type: "text", text: summary }] };
}
