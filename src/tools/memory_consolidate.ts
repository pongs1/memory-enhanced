import { Type, type Static } from "@sinclair/typebox";
import { resolveWorkspace } from "../utils.js";
import { buildCleanSlateGraph } from "../v8/compiler_clean_slate.js";
import { v8StorePaths } from "../v8/paths_v8.js";

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
    max_narrative_docs: Type.Optional(
        Type.Number({
            minimum: 1,
            description:
                "Optional dev-only cap for narrative docs compiled in one run (temporary fast-build knob).",
        })
    ),
    worker_count: Type.Optional(
        Type.Number({
            minimum: 1,
            description: "Optional worker count for unitization.",
        })
    ),
    emit_unit_preview: Type.Optional(
        Type.Boolean({
            description: "Whether to write unit preview markdown files.",
        })
    ),
    start_at: Type.Optional(
        Type.Union([Type.Literal("source"), Type.Literal("narrative")], {
            description:
                "Pipeline start stage. narrative skips session re-normalization and starts from existing *_narrative.md files.",
        })
    ),
    stop_after: Type.Optional(
        Type.Union([Type.Literal("evidence"), Type.Literal("memory_ir")], {
            description: "Optional early stop stage for faster debugging.",
        })
    ),
    plan_only: Type.Optional(
        Type.Boolean({
            description:
                "Only compute and persist build scope diagnostics without generating units/graph artifacts.",
        })
    ),
    ir_llm_command: Type.Optional(
        Type.String({
            description:
                "Optional command to run offline LLM IR extraction. " +
                "Use {jobs}, {items_md}, {items_jsonl} placeholders (or {items} for md) " +
                "or rely on V8_IR_JOBS/V8_IR_ITEMS_MD/V8_IR_ITEMS_JSONL env vars.",
        })
    ),
    rebuild_mode: Type.Optional(
        Type.Union(
            [Type.Literal("full"), Type.Literal("incremental"), Type.Literal("hybrid")],
            {
                description:
                    "Build scope mode. full=rebuild all; incremental=only changed narrative docs; hybrid=changed + recent hot window.",
            }
        )
    ),
    hot_window_hours: Type.Optional(
        Type.Number({
            minimum: 1,
            description:
                "Hot window (hours) used by rebuild_mode=hybrid to force recent docs through full recompilation.",
        })
    ),
    rule_ir_mode: Type.Optional(
        Type.Union([Type.Literal("off"), Type.Literal("micro_light")], {
            description:
                "Rule-based IR extraction mode. micro_light adds lightweight micro anchors before LLM IR merge.",
        })
    ),
});

export type MemoryConsolidateInput = Static<typeof MemoryConsolidateParams>;

// DEV marker: remove temporary fast-build knobs before release hardening.
const DEV_FAST_BUILD_MARKER = "TODO_REMOVE_BEFORE_RELEASE__V8_FAST_BUILD_DEFAULTS";

export async function executeMemoryConsolidate(
    _toolCallId: string,
    params: MemoryConsolidateInput,
    ctx?: { workspaceDir?: string; config?: Record<string, unknown> }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const store = v8StorePaths(workspace);
    const pluginConfig = ctx?.config || {};
    const sessionTraceDir =
        (params.session_trace_dir as string | undefined) ||
        (pluginConfig as any)?.v8SessionTraceDir ||
        process.env.OPENCLAW_SESSION_TRACE_DIR;
    const maxSessionFiles = params.max_session_files;
    const maxNarrativeDocs =
        typeof params.max_narrative_docs === "number"
            ? params.max_narrative_docs
            : typeof (pluginConfig as any)?.v8MaxNarrativeDocs === "number"
              ? (pluginConfig as any).v8MaxNarrativeDocs
              : undefined;
    const workerCount =
        typeof params.worker_count === "number"
            ? params.worker_count
            : typeof (pluginConfig as any)?.v8WorkerCount === "number"
              ? (pluginConfig as any).v8WorkerCount
              : undefined;
    const emitUnitPreview =
        typeof params.emit_unit_preview === "boolean"
            ? params.emit_unit_preview
            : typeof (pluginConfig as any)?.v8EmitUnitPreview === "boolean"
              ? (pluginConfig as any).v8EmitUnitPreview
              : undefined;
    const startAt =
        (params.start_at as "source" | "narrative" | undefined) ||
        ((pluginConfig as any)?.v8StartAt as "source" | "narrative" | undefined);
    const stopAfter =
        (params.stop_after as "evidence" | "memory_ir" | undefined) ||
        ((pluginConfig as any)?.v8StopAfter as "evidence" | "memory_ir" | undefined);
    const planOnly =
        typeof params.plan_only === "boolean"
            ? params.plan_only
            : typeof (pluginConfig as any)?.v8PlanOnly === "boolean"
              ? (pluginConfig as any).v8PlanOnly
              : false;
    const llmCommand =
        (params.ir_llm_command as string | undefined) ||
        (pluginConfig as any)?.v8IrLlmCommand ||
        process.env.V8_IR_LLM_COMMAND;
    const llmTimeoutMs =
        typeof (pluginConfig as any)?.v8IrLlmTimeoutMs === "number"
            ? (pluginConfig as any).v8IrLlmTimeoutMs
            : undefined;
    const rebuildMode =
        (params.rebuild_mode as "full" | "incremental" | "hybrid" | undefined) ||
        ((pluginConfig as any)?.v8RebuildMode as
            | "full"
            | "incremental"
            | "hybrid"
            | undefined) ||
        "hybrid";
    const hotWindowHours =
        typeof params.hot_window_hours === "number"
            ? params.hot_window_hours
            : typeof (pluginConfig as any)?.v8HotWindowHours === "number"
              ? (pluginConfig as any).v8HotWindowHours
              : undefined;
    const ruleIrMode =
        (params.rule_ir_mode as "off" | "micro_light" | undefined) ||
        ((pluginConfig as any)?.v8RuleIrMode as "off" | "micro_light" | undefined) ||
        "off";

    const output = await buildCleanSlateGraph({
        workspace,
        sessionTraceDir,
        maxSessionFiles,
        maxNarrativeDocs,
        workerCount,
        emitUnitPreview,
        startAt,
        stopAfter,
        planOnly,
        llmCommand,
        llmCommandTimeoutMs: llmTimeoutMs,
        rebuildMode,
        hotWindowHours,
        ruleIrMode,
    });

    const summary = [
        "Clean-slate V8 build completed.",
        `sessionTraceDir=${sessionTraceDir || "default"}`,
        maxSessionFiles ? `maxSessionFiles=${maxSessionFiles}` : null,
        maxNarrativeDocs ? `maxNarrativeDocs=${maxNarrativeDocs}` : null,
        workerCount ? `workerCount=${workerCount}` : null,
        typeof emitUnitPreview === "boolean"
            ? `emitUnitPreview=${String(emitUnitPreview)}`
            : null,
        startAt ? `startAt=${startAt}` : null,
        stopAfter ? `stopAfter=${stopAfter}` : null,
        planOnly ? "planOnly=true" : null,
        `ruleIrMode=${ruleIrMode}`,
        `rebuildMode=${rebuildMode}`,
        hotWindowHours ? `hotWindowHours=${hotWindowHours}` : null,
        maxNarrativeDocs ? `devFastBuildMarker=${DEV_FAST_BUILD_MARKER}` : null,
        llmCommand ? `llmStatus=${output.llmStatus}` : null,
        "units=narrative",
        output.toolCatalogCheck
            ? `toolCatalogCheck=${output.toolCatalogCheck.status} tools=${output.toolCatalogCheck.toolCount} rules=${output.toolCatalogCheck.ruleCount}`
            : null,
        output.toolCatalogCheck?.promptPath
            ? `toolCatalogPrompt=${output.toolCatalogCheck.promptPath}`
            : null,
        `buildManifest=${store.buildManifest}`,
        `buildReport=${store.buildReport}`,
        `buildReportMd=${store.buildReportMd}`,
        `narrativeDocs=${output.narrativeDocs.length}`,
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
        output.buildStats
            ? `buildScope=hot:${output.buildStats.hotDocs} cold:${output.buildStats.coldDocs} removed:${output.buildStats.removedDocs} reusedCache:${output.buildStats.reusedCache} noopReuse:${output.buildStats.noopReuse} partial:${output.buildStats.partialBuild} sourceWrites:${output.buildStats.sourceNarrativeWrittenFiles} sourceSkips:${output.buildStats.sourceNarrativeSkippedFiles}`
            : null,
        output.buildStats
            ? `sourceNormalization=records:${output.buildStats.sourceNormalizationRecordCount} touchedRecords:${output.buildStats.sourceNormalizationTouchedRecords} rawChars:${output.buildStats.sourceNormalizationRawChars} cleanChars:${output.buildStats.sourceNormalizationCleanChars} removedChars:${output.buildStats.sourceNormalizationRemovedChars} removedRatioPct:${output.buildStats.sourceNormalizationRemovedRatioPct.toFixed(2)}`
            : null,
        output.buildStats
            ? `irExtraction=rule:${output.buildStats.irRuleItems} llm:${output.buildStats.irLlmItems} fallback:${output.buildStats.irFallbackItems} fallbackApplied:${output.buildStats.irFallbackApplied}`
            : null,
        output.scopePreview?.hotDocIds?.length
            ? `hotDocPreview=${output.scopePreview.hotDocIds.slice(0, 8).join(",")}`
            : null,
        output.scopePreview?.coldDocIds?.length
            ? `coldDocPreview=${output.scopePreview.coldDocIds.slice(0, 5).join(",")}`
            : null,
        output.scopePreview?.removedDocIds?.length
            ? `removedDocPreview=${output.scopePreview.removedDocIds.slice(0, 8).join(",")}`
            : null,
    ]
        .filter(Boolean)
        .join("\n");

    return { content: [{ type: "text", text: summary }] };
}
