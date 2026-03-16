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
                "Pipeline start stage. source performs append-only session->narrative sync first (silent no-op when no new turns), then continues; narrative starts directly from existing *_narrative.md files.",
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
    relation_review_llm_command: Type.Optional(
        Type.String({
            description:
                "Optional (deferred/frozen) command to run relation review over compact review jobs. " +
                "Use {review_jobs}, {output_md}, {output_jsonl} placeholders " +
                "or rely on V8_REL_REVIEW_JOBS/V8_REL_REVIEW_OUTPUT_MD/V8_REL_REVIEW_OUTPUT_JSONL env vars.",
        })
    ),
    rebuild_mode: Type.Optional(
        Type.Union(
            [Type.Literal("full"), Type.Literal("incremental"), Type.Literal("hybrid")],
            {
                description:
                    "Build scope mode. full=force rebuild from all narratives; incremental=only narratives whose content changed or whose requested compile phase is missing; hybrid is kept as a compatibility alias of incremental.",
            }
        )
    ),
    hot_window_hours: Type.Optional(
        Type.Number({
            minimum: 1,
            description:
                "Legacy option kept for compatibility. Current V8 compile scope does not use hot-window recompilation.",
        })
    ),
    compile_phase: Type.Optional(
        Type.Union([Type.Literal("stream"), Type.Literal("final")], {
            description:
                "IR compile phase. stream=meso/micro only and skips newest unstable tail units; final=full macro+meso+micro compile.",
        })
    ),
    hot_tail_skip_units: Type.Optional(
        Type.Number({
            minimum: 0,
            description:
                "When compile_phase=stream, skip this many latest units per narrative from LLM IR jobs.",
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
    const relationReviewLlmCommand =
        (params.relation_review_llm_command as string | undefined) ||
        (pluginConfig as any)?.v8RelationReviewLlmCommand ||
        process.env.V8_REL_REVIEW_LLM_COMMAND;
    const llmTimeoutMs =
        typeof (pluginConfig as any)?.v8IrLlmTimeoutMs === "number"
            ? (pluginConfig as any).v8IrLlmTimeoutMs
            : undefined;
    const relationReviewLlmTimeoutMs =
        typeof (pluginConfig as any)?.v8RelationReviewLlmTimeoutMs === "number"
            ? (pluginConfig as any).v8RelationReviewLlmTimeoutMs
            : undefined;
    const rebuildMode =
        (params.rebuild_mode as "full" | "incremental" | "hybrid" | undefined) ||
        ((pluginConfig as any)?.v8RebuildMode as
            | "full"
            | "incremental"
            | "hybrid"
            | undefined) ||
        "incremental";
    const hotWindowHours =
        typeof params.hot_window_hours === "number"
            ? params.hot_window_hours
            : typeof (pluginConfig as any)?.v8HotWindowHours === "number"
              ? (pluginConfig as any).v8HotWindowHours
              : undefined;
    const compilePhase =
        (params.compile_phase as "stream" | "final" | undefined) ||
        ((pluginConfig as any)?.v8CompilePhase as "stream" | "final" | undefined);
    const hotTailSkipUnits =
        typeof params.hot_tail_skip_units === "number"
            ? params.hot_tail_skip_units
            : typeof (pluginConfig as any)?.v8HotTailSkipUnits === "number"
              ? (pluginConfig as any).v8HotTailSkipUnits
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
        relationReviewLlmCommand,
        relationReviewLlmTimeoutMs,
        rebuildMode,
        hotWindowHours,
        compilePhase,
        hotTailSkipUnits,
        ruleIrMode,
    });

    const summary = [
        "Memory graph build completed.",
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
        compilePhase ? `compilePhase=${compilePhase}` : null,
        typeof hotTailSkipUnits === "number"
            ? `hotTailSkipUnits=${hotTailSkipUnits}`
            : null,
        maxNarrativeDocs ? `devFastBuildMarker=${DEV_FAST_BUILD_MARKER}` : null,
        llmCommand ? `llmStatus=${output.llmStatus}` : null,
        `relationReviewLlmStatus=${output.buildStats.relationReviewLlmStatus}`,
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
            ? `buildScope=hot:${output.buildStats.hotDocs} cold:${output.buildStats.coldDocs} removed:${output.buildStats.removedDocs} reusedCache:${output.buildStats.reusedCache} coldPromoted:${output.buildStats.coldDocsPromotedToHot} noopReuse:${output.buildStats.noopReuse} partial:${output.buildStats.partialBuild} sourceWrites:${output.buildStats.sourceNarrativeWrittenFiles} sourceSkips:${output.buildStats.sourceNarrativeSkippedFiles} sourceFastSkips:${output.buildStats.sourceFastSkippedFiles}`
            : null,
        output.buildStats
            ? `sourceNormalization=records:${output.buildStats.sourceNormalizationRecordCount} touchedRecords:${output.buildStats.sourceNormalizationTouchedRecords} rawChars:${output.buildStats.sourceNormalizationRawChars} cleanChars:${output.buildStats.sourceNormalizationCleanChars} removedChars:${output.buildStats.sourceNormalizationRemovedChars} removedRatioPct:${output.buildStats.sourceNormalizationRemovedRatioPct.toFixed(2)}`
            : null,
        output.buildStats
            ? `irExtraction=rule:${output.buildStats.irRuleItems} llm:${output.buildStats.irLlmItems} fallback:${output.buildStats.irFallbackItems} fallbackApplied:${output.buildStats.irFallbackApplied}`
            : null,
        output.buildStats
            ? `compileLayerFilter=phaseLayerDroppedUnits:${output.buildStats.phaseLayerDroppedUnits} streamMacroCarryUnits:${output.buildStats.streamMacroCarryUnits}`
            : null,
        output.buildStats
            ? `relationPlanning=entityPostings:${output.buildStats.relationEntityPostings} scopeCards:${output.buildStats.relationScopeCards} groupSummaries:${output.buildStats.relationGroupSummaries} searchPlans:${output.buildStats.relationSearchPlans} shardSelections:${output.buildStats.relationShardSelections} candidateHits:${output.buildStats.relationCandidateHits} reviewJobs:${output.buildStats.relationReviewJobs}`
            : null,
        output.buildStats
            ? `relationReview=autoHypothesis:${output.buildStats.relationAutoHypothesis} accepted:${output.buildStats.relationReviewedAccepted} hypothesis:${output.buildStats.relationReviewedHypothesis} rejected:${output.buildStats.relationReviewedRejected} completedJobs:${output.buildStats.relationReviewJobsCompleted} learningEvents:${output.buildStats.learningEvents} searchFeedbackSignals:${output.buildStats.searchFeedbackSignals}`
            : null,
        output.buildStats
            ? `llmCache=hitUnits:${output.buildStats.llmCacheHitUnits} missUnits:${output.buildStats.llmCacheMissUnits} entries:${output.buildStats.llmCacheEntries}`
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
