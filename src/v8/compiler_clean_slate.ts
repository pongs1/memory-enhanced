import { resolveWorkspace } from "../utils.js";
import { ensureV8StoreDirs } from "./paths_v8.js";
import {
    loadSessionTraces,
    resolveSessionTraceDir,
} from "./adapters/session-source.js";
import {
    normalizeSessionMessages,
    type RawSessionMessage,
} from "./architecture/narrative-normalizer.js";
import { loadResolvedToolCleaningProfiles } from "./architecture/tool-cleaning-profiles.js";
import {
    checkToolCatalogAgainstRules,
    type ToolCatalogCheckResult,
} from "./architecture/tool-catalog-check.js";
import { loadNarrativeRecords } from "./architecture/narrative-source.js";
import { unitizeNarrativeRecordsParallel } from "./architecture/unitizer.js";
import { extractEvidenceSpans } from "./architecture/evidence.js";
import { extractMemoryItems } from "./architecture/ir-extractor.js";
import { buildLlmIrJobs, loadLlmIrItems, writeIrLlmJobs } from "./architecture/ir-llm.js";
import { materializeGraph } from "./architecture/graph-materializer.js";
import { buildRuntimeProjections } from "./architecture/runtime-projection.js";
import { buildRelationPlanningArtifacts } from "./architecture/relation-planning.js";
import {
    applyReviewedRelationsToGraph,
    finalizeRelationReviewArtifacts,
} from "./architecture/relation-review.js";
import {
    loadReviewedRelations,
    writeRelationReviewJobsMarkdown,
} from "./architecture/relation-review-llm.js";
import { readJsonl, writeJsonl } from "./architecture/io.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
    V8EvidenceSpan,
    V8GraphLayer,
    V8GraphEdge,
    V8GraphNode,
    V8HypothesisEdge,
    V8IgnitionEdgeProjection,
    V8IgnitionNodeProjection,
    V8LearningEvent,
    V8MemoryItem,
    V8NarrativeRecord,
    V8RecallBundleProjection,
    V8RelationReviewJob,
    V8SearchFeedbackSignal,
    V8ReviewedRelation,
    V8Unit,
} from "./types_v8.js";

export interface CleanSlateBuildOptions {
    workspace?: string;
    sessionTraceDir?: string;
    maxSessionFiles?: number;
    llmCommand?: string;
    llmCommandTimeoutMs?: number;
    relationReviewLlmCommand?: string;
    relationReviewLlmTimeoutMs?: number;
    startAt?: "source" | "narrative";
    stopAfter?: "evidence" | "memory_ir";
    maxNarrativeDocs?: number;
    emitUnitPreview?: boolean;
    workerCount?: number;
    ruleIrMode?: "off" | "micro_light";
    compilePhase?: "stream" | "final";
    hotTailSkipUnits?: number;
    rebuildMode?: "full" | "incremental" | "hybrid";
    hotWindowHours?: number;
    planOnly?: boolean;
}

// DEV marker: remove this temporary fast-build default before release hardening.
const DEV_FAST_BUILD_MARKER = "TODO_REMOVE_BEFORE_RELEASE__V8_FAST_BUILD_DEFAULTS";
// FROZEN marker: relation-review LLM loop is deferred until core mainline is complete.
const FROZEN_RELATION_REVIEW_LLM = "FROZEN_DEFERRED__RELATION_REVIEW_LLM";
const DEFAULT_HOT_WINDOW_HOURS = 48;

export async function buildCleanSlateGraph(options?: CleanSlateBuildOptions) {
    const workspace = resolveWorkspace(options?.workspace);
    const store = ensureV8StoreDirs(workspace);
    const stageTraceEnabled = process.env.V8_BUILD_TRACE === "1";
    const stageStart = Date.now();
    const stageTimingsMs: Record<string, number> = {};
    const logStage = (label: string) => {
        const elapsedMs = Date.now() - stageStart;
        stageTimingsMs[label] = elapsedMs;
        if (!stageTraceEnabled) return;
        console.error(`[v8-build] ${label} +${elapsedMs}ms`);
    };

    const startAt = options?.startAt ?? (options?.planOnly ? "narrative" : "source");
    const toolCleaningProfiles =
        startAt === "source"
            ? loadResolvedToolCleaningProfiles(workspace)
            : new Map();
    const toolCatalogCheck: ToolCatalogCheckResult =
        startAt === "source"
            ? checkToolCatalogAgainstRules({
                  workspace,
                  profiles: toolCleaningProfiles,
              })
            : {
                  status: "skipped",
                  toolCount: 0,
                  ruleCount: 0,
                  missingRules: [],
                  extraRules: [],
              };
    logStage(
        startAt === "source"
            ? "tool catalog loaded"
            : "tool catalog check skipped(start_at=narrative)"
    );
    let sourcePersistStats: { writtenFiles: number; skippedFiles: number } | null = null;
    let sourceNormalizationStats: {
        recordCount: number;
        rawChars: number;
        cleanChars: number;
        removedChars: number;
        touchedRecords: number;
        removedRatioPct: number;
    } | null = null;
    if (startAt === "source") {
        const traceGroups = loadSessionTraces(workspace, {
            sessionTraceDir: options?.sessionTraceDir,
            maxFiles: options?.maxSessionFiles,
        });
        const sessionTraceDir =
            resolveSessionTraceDir(workspace, options?.sessionTraceDir) ||
            (traceGroups.length > 0
                ? path.dirname(traceGroups[0].sourceRefPrefix)
                : null);

        const traceNarrativeRecords: V8NarrativeRecord[] = [];
        const linkedNarrativeRecords: V8NarrativeRecord[] = [];
        for (const group of traceGroups) {
            const parentSessionId = deriveSessionIdFromSourceRef(group.sourceRefPrefix);
            const baseRecords = normalizeSessionMessages(group.messages, {
                sourceRefPrefix: group.sourceRefPrefix,
                workspace,
                toolCleaningProfiles,
            });
            traceNarrativeRecords.push(...baseRecords);

            const links = extractSessionLinksFromMessages(group.messages);
            if (links.length && sessionTraceDir) {
                linkedNarrativeRecords.push(
                    ...loadLinkedSessionRecords({
                        links,
                        parentSessionId,
                        sessionTraceDir,
                        toolCleaningProfiles,
                        workspace,
                    })
                );
            }
        }
        const traceRecords = [...traceNarrativeRecords, ...linkedNarrativeRecords];
        sourceNormalizationStats = summarizeSourceNormalization(traceRecords);
        const persistResult = persistAssembledObservationMarkdown(store.rawDir, traceRecords);
        sourcePersistStats = {
            writtenFiles: persistResult.writtenFiles,
            skippedFiles: persistResult.skippedFiles,
        };
        logStage("source normalization persisted");
    }

    const loadedNarrativeDocs = loadNarrativeRecords(store.rawDir);
    let allNarrativeDocs = loadedNarrativeDocs;
    logStage(`narratives loaded (${allNarrativeDocs.length})`);
    if (startAt === "narrative" && allNarrativeDocs.length === 0) {
        throw new Error("No narrative docs found in .memory/raw/observations/assembled.");
    }
    const isPartialBuild = typeof options?.maxNarrativeDocs === "number";
    if (options?.maxNarrativeDocs && allNarrativeDocs.length > options.maxNarrativeDocs) {
        allNarrativeDocs = allNarrativeDocs
            .slice()
            .sort((a, b) => {
                const byTime = resolveNarrativeSortTimestamp(a) - resolveNarrativeSortTimestamp(b);
                if (byTime !== 0) return byTime;
                return (a.sourceRef || "").localeCompare(b.sourceRef || "");
            })
            .slice(-options.maxNarrativeDocs);
    }

    const rebuildMode = normalizeRebuildMode(options?.rebuildMode);
    const hotWindowHours = Math.max(1, options?.hotWindowHours ?? DEFAULT_HOT_WINDOW_HOURS);
    const compilePhase =
        options?.compilePhase ?? (rebuildMode === "full" ? "final" : "stream");
    const hotTailSkipUnits = Math.max(
        0,
        options?.hotTailSkipUnits ?? (compilePhase === "stream" ? 6 : 0)
    );
    const llmLayers: V8GraphLayer[] =
        compilePhase === "final" ? ["macro", "meso", "micro"] : ["meso", "micro"];
    const manifest = loadBuildManifest(store.buildManifest);
    const compileState = loadNarrativeCompileState(store.narrativeCompileState);
    const scope = computeBuildScope({
        narratives: allNarrativeDocs,
        manifest,
        compileState,
        mode: rebuildMode,
        requestedPhase: compilePhase,
    });
    const scopePreview = buildScopePreview(scope, allNarrativeDocs);
    logStage(
        `build scope mode=${rebuildMode} hot=${scope.hotDocIds.size} cold=${scope.coldDocIds.size} removed=${scope.removedDocIds.size}`
    );
    logStage(`${DEV_FAST_BUILD_MARKER} hotWindowHours=${hotWindowHours}`);

    const canReuseCache =
        rebuildMode !== "full" &&
        hasReusableArtifacts(store) &&
        scope.coldDocIds.size > 0;
    const cached = canReuseCache
        ? loadCachedArtifactsForDocs(store, scope.coldDocIds, scope.activeDocIds)
        : emptyCachedArtifacts();

    const hotNarratives = allNarrativeDocs.filter((doc) => scope.hotDocIds.has(doc.id));
    const reviewOverlayDirty = hasReviewOverlayUpdates(store);
    const hotBuildIsNoop =
        hotNarratives.length === 0 &&
        scope.removedDocIds.size === 0 &&
        hasReusableArtifacts(store) &&
        !reviewOverlayDirty;
    const buildStats = {
        rebuildMode,
        hotWindowHours,
        partialBuild: isPartialBuild,
        maxNarrativeDocs: options?.maxNarrativeDocs ?? null,
        hotDocs: scope.hotDocIds.size,
        coldDocs: scope.coldDocIds.size,
        removedDocs: scope.removedDocIds.size,
        reusedCache: canReuseCache,
        noopReuse: hotBuildIsNoop,
        sourceNarrativeWrittenFiles: sourcePersistStats?.writtenFiles ?? 0,
        sourceNarrativeSkippedFiles: sourcePersistStats?.skippedFiles ?? 0,
        sourceNormalizationRecordCount: sourceNormalizationStats?.recordCount ?? 0,
        sourceNormalizationRawChars: sourceNormalizationStats?.rawChars ?? 0,
        sourceNormalizationCleanChars: sourceNormalizationStats?.cleanChars ?? 0,
        sourceNormalizationRemovedChars: sourceNormalizationStats?.removedChars ?? 0,
        sourceNormalizationTouchedRecords: sourceNormalizationStats?.touchedRecords ?? 0,
        sourceNormalizationRemovedRatioPct: sourceNormalizationStats?.removedRatioPct ?? 0,
        compilePhase,
        hotTailSkipUnits,
        llmLayers: llmLayers.join(","),
        hotTailDroppedUnits: 0,
        phaseLayerDroppedUnits: 0,
        llmCacheHitUnits: 0,
        llmCacheMissUnits: 0,
        llmCacheEntries: 0,
        irRuleItems: 0,
        irLlmItems: 0,
        irFallbackItems: 0,
        irFallbackApplied: false,
        relationEntityPostings: 0,
        relationScopeCards: 0,
        relationGroupSummaries: 0,
        relationSearchPlans: 0,
        relationShardSelections: 0,
        relationCandidateHits: 0,
        relationReviewJobs: 0,
        relationReviewedAccepted: 0,
        relationReviewedHypothesis: 0,
        relationReviewedRejected: 0,
        relationReviewJobsCompleted: 0,
        learningEvents: 0,
        searchFeedbackSignals: 0,
        relationReviewLlmStatus: "skipped",
    };
    const persistRunReport = (payload: {
        llmStatus: string;
        units: number;
        evidenceSpans: number;
        memoryItems: number;
        nodes: number;
        edges: number;
        ignitionNodes: number;
        ignitionEdges: number;
        recallBundles: number;
    }) => {
        const report: BuildReport = {
            generatedAt: new Date().toISOString(),
            workspace,
            stageTimingsMs,
            buildStats,
            llmStatus: payload.llmStatus,
            scopePreview,
            counts: {
                narrativeDocs: allNarrativeDocs.length,
                units: payload.units,
                evidenceSpans: payload.evidenceSpans,
                memoryItems: payload.memoryItems,
                nodes: payload.nodes,
                edges: payload.edges,
                ignitionNodes: payload.ignitionNodes,
                ignitionEdges: payload.ignitionEdges,
                recallBundles: payload.recallBundles,
            },
        };
        persistBuildReport({
            jsonPath: store.buildReport,
            markdownPath: store.buildReportMd,
            report,
        });
    };

    if (options?.planOnly) {
        logStage("plan_only: stop before unit/evidence build");
        persistRunReport({
            llmStatus: "skipped(plan_only)",
            units: 0,
            evidenceSpans: 0,
            memoryItems: 0,
            nodes: 0,
            edges: 0,
            ignitionNodes: 0,
            ignitionEdges: 0,
            recallBundles: 0,
        });
        return {
            narrativeDocs: allNarrativeDocs,
            units: [],
            evidenceSpans: [],
            memoryItems: [],
            llmJobs: [],
            llmItems: [],
            llmStatus: "skipped(plan_only)",
            toolCatalogCheck,
            nodes: [],
            edges: [],
            ignitionNodes: [],
            ignitionEdges: [],
            recallBundles: [],
            buildStats,
            scopePreview,
        };
    }

    if (hotBuildIsNoop && options?.stopAfter !== "evidence" && options?.stopAfter !== "memory_ir") {
        const reused = loadAllArtifacts(store);
        buildStats.relationEntityPostings = countJsonlRecords(store.entityPostings);
        buildStats.relationScopeCards = countJsonlRecords(store.entityScopeCards);
        buildStats.relationGroupSummaries = countJsonlRecords(store.groupSummaries);
        buildStats.relationSearchPlans = countJsonlRecords(store.relationSearchPlans);
        buildStats.relationShardSelections = countJsonlRecords(store.narrativeShardSelections);
        buildStats.relationCandidateHits = countJsonlRecords(store.relationCandidateHits);
        buildStats.relationReviewJobs = countJsonlRecords(store.relationReviewJobs);
        buildStats.relationReviewJobsCompleted = countRelationReviewJobsByStatus(
            store.relationReviewJobs,
            "completed"
        );
        buildStats.relationReviewedAccepted = countReviewedRelationsByStatus(
            store.reviewedRelations,
            "accepted"
        );
        buildStats.relationReviewedHypothesis = countReviewedRelationsByStatus(
            store.reviewedRelations,
            "hypothesis"
        );
        buildStats.relationReviewedRejected = countReviewedRelationsByStatus(
            store.reviewedRelations,
            "rejected"
        );
        buildStats.learningEvents = countJsonlRecords(store.learningEvents);
        buildStats.searchFeedbackSignals = countJsonlRecords(store.searchFeedbackSignals);
        buildStats.relationReviewLlmStatus = "skipped(no_changes)";
        logStage("no-op incremental build: reused all persisted artifacts");
        persistRunReport({
            llmStatus: "skipped(no_changes)",
            units: reused.units.length,
            evidenceSpans: reused.evidenceSpans.length,
            memoryItems: reused.memoryItems.length,
            nodes: reused.nodes.length,
            edges: reused.edges.length,
            ignitionNodes: reused.ignitionNodes.length,
            ignitionEdges: reused.ignitionEdges.length,
            recallBundles: reused.recallBundles.length,
        });
        return {
            narrativeDocs: allNarrativeDocs,
            units: reused.units,
            evidenceSpans: reused.evidenceSpans,
            memoryItems: reused.memoryItems,
            llmJobs: [],
            llmItems: [],
            llmStatus: "skipped(no_changes)",
            toolCatalogCheck,
            nodes: reused.nodes,
            edges: reused.edges,
            ignitionNodes: reused.ignitionNodes,
            ignitionEdges: reused.ignitionEdges,
            recallBundles: reused.recallBundles,
            buildStats,
            scopePreview,
        };
    }

    const hotUnitsAll = await unitizeNarrativeRecordsParallel(
        hotNarratives,
        undefined,
        options?.workerCount ?? 1
    );
    const hotUnits =
        compilePhase === "stream" && hotTailSkipUnits > 0
            ? trimTrailingUnitsByNarrativeForCompile(hotUnitsAll, hotTailSkipUnits)
            : hotUnitsAll;
    buildStats.hotTailDroppedUnits = Math.max(0, hotUnitsAll.length - hotUnits.length);
    const hotUnitsPhaseFiltered = filterUnitsByCompilePhase(hotUnits, compilePhase);
    buildStats.phaseLayerDroppedUnits = Math.max(0, hotUnits.length - hotUnitsPhaseFiltered.length);
    const units = [...cached.units, ...hotUnitsPhaseFiltered];
    logStage(
        `units built hot=${hotUnitsPhaseFiltered.length} droppedTail=${buildStats.hotTailDroppedUnits} droppedByPhase=${buildStats.phaseLayerDroppedUnits} total=${units.length}`
    );
    if (options?.emitUnitPreview !== false) {
        persistNarrativeUnitPreview(store.rawDir, units, allNarrativeDocs);
        logStage("unit preview written");
    }
    const hotEvidenceSpans = extractEvidenceSpans(hotUnitsPhaseFiltered, hotNarratives);
    const evidenceSpans = [...cached.evidenceSpans, ...hotEvidenceSpans];
    logStage(
        `evidence spans built hot=${hotEvidenceSpans.length} total=${evidenceSpans.length}`
    );
    if (options?.stopAfter === "evidence") {
        writeJsonl(store.units, units);
        writeJsonl(store.evidenceSpans, evidenceSpans);
        clearJsonlFiles([
            store.memoryItems,
            store.graphNodes,
            store.graphEdges,
            store.ignitionNodes,
            store.ignitionEdges,
            store.recallBundles,
            store.entityPostings,
            store.entityScopeCards,
            store.groupSummaries,
            store.relationSearchPlans,
            store.narrativeShardSelections,
            store.relationCandidateHits,
            store.relationReviewJobs,
            store.relationReviewJobsMd,
            store.learningEvents,
            store.searchFeedbackSignals,
        ]);
        logStage("evidence persisted");
        if (!isPartialBuild) {
            persistBuildManifest(store.buildManifest, loadedNarrativeDocs);
        }
        persistRunReport({
            llmStatus: "skipped",
            units: units.length,
            evidenceSpans: evidenceSpans.length,
            memoryItems: 0,
            nodes: 0,
            edges: 0,
            ignitionNodes: 0,
            ignitionEdges: 0,
            recallBundles: 0,
        });
        return {
            narrativeDocs: allNarrativeDocs,
            units,
            evidenceSpans,
            memoryItems: [],
            llmJobs: [],
            llmItems: [],
            llmStatus: "skipped",
            toolCatalogCheck,
            nodes: [],
            edges: [],
            ignitionNodes: [],
            ignitionEdges: [],
            recallBundles: [],
            buildStats,
            scopePreview,
        };
    }

    const llmUnitCacheEntries = loadLlmUnitCacheEntries(store.irLlmUnitCache);
    const llmUnitCacheByKey = new Map(
        llmUnitCacheEntries.map((entry) => [entry.cacheKey, entry])
    );
    const llmUnitsForExtraction: V8Unit[] = [];
    const cachedLlmItems: V8MemoryItem[] = [];
    for (const unit of hotUnitsPhaseFiltered) {
        if (!llmLayers.includes(unit.layer)) continue;
        const cacheKey = buildLlmUnitCacheKey(unit);
        const cachedEntry = llmUnitCacheByKey.get(cacheKey);
        if (cachedEntry) {
            buildStats.llmCacheHitUnits += 1;
            if (cachedEntry.items.length > 0) {
                cachedLlmItems.push(...cloneMemoryItems(cachedEntry.items));
            }
            continue;
        }
        llmUnitsForExtraction.push(unit);
    }
    buildStats.llmCacheMissUnits = llmUnitsForExtraction.length;
    const llmJobs = buildLlmIrJobs(llmUnitsForExtraction, hotEvidenceSpans, {
        layers: llmLayers,
    });
    logStage(
        `llm jobs built missUnits=${llmUnitsForExtraction.length} jobs=${llmJobs.length} cacheHits=${buildStats.llmCacheHitUnits}`
    );
    writeIrLlmJobs(store.irLlmJobs, llmJobs);
    logStage("llm jobs persisted");
    const llmStatus =
        llmJobs.length > 0
            ? maybeRunIrLlm({
                  command: options?.llmCommand,
                  jobsPath: store.irLlmJobs,
                  itemsMdPath: store.irLlmItemsMd,
                  itemsJsonlPath: store.irLlmItems,
                  timeoutMs: options?.llmCommandTimeoutMs,
              })
            : buildStats.llmCacheHitUnits > 0
              ? "skipped(cache_hit)"
              : "skipped(no_hot_jobs)";
    logStage(`llm step finished (${llmStatus})`);
    const freshLlmItems =
        llmJobs.length > 0
            ? loadLlmIrItems(
                  { mdPath: store.irLlmItemsMd, jsonlPath: store.irLlmItems },
                  llmUnitsForExtraction,
                  hotEvidenceSpans
              )
            : [];
    const llmItems = dedupeMemoryItems([...cachedLlmItems, ...freshLlmItems]);
    const nextLlmUnitCacheEntries = mergeLlmUnitCacheEntries({
        existing: llmUnitCacheEntries,
        units: llmUnitsForExtraction,
        llmItems: freshLlmItems,
    });
    buildStats.llmCacheEntries = nextLlmUnitCacheEntries.length;
    writeJsonl(store.irLlmUnitCache, nextLlmUnitCacheEntries);
    const ruleIrMode = options?.ruleIrMode ?? "off";
    const ruleItems =
        ruleIrMode === "micro_light"
            ? extractMemoryItems(hotUnitsPhaseFiltered, hotEvidenceSpans)
            : [];
    const fallbackRuleItems: V8MemoryItem[] = [];
    buildStats.irRuleItems = ruleItems.length;
    buildStats.irLlmItems = llmItems.length;
    buildStats.irFallbackItems = fallbackRuleItems.length;
    buildStats.irFallbackApplied = false;
    const resolvedLlmStatus = llmStatus;
    const hotMemoryItems = [...ruleItems, ...llmItems];
    const memoryItems = [...cached.memoryItems, ...hotMemoryItems];
    logStage(
        `memory items extracted hot(rule=${ruleItems.length}, llm=${llmItems.length}, fallback=${fallbackRuleItems.length}) total=${memoryItems.length}`
    );
    if (options?.stopAfter === "memory_ir") {
        writeJsonl(store.units, units);
        writeJsonl(store.evidenceSpans, evidenceSpans);
        writeJsonl(store.memoryItems, memoryItems);
        clearJsonlFiles([
            store.graphNodes,
            store.graphEdges,
            store.ignitionNodes,
            store.ignitionEdges,
            store.recallBundles,
            store.entityPostings,
            store.entityScopeCards,
            store.groupSummaries,
            store.relationSearchPlans,
            store.narrativeShardSelections,
            store.relationCandidateHits,
            store.relationReviewJobs,
            store.relationReviewJobsMd,
            store.learningEvents,
            store.searchFeedbackSignals,
        ]);
        logStage("memory_ir persisted");
        if (!isPartialBuild) {
            persistBuildManifest(store.buildManifest, loadedNarrativeDocs);
            persistNarrativeCompileState(
                store.narrativeCompileState,
                mergeNarrativeCompileState({
                    existing: compileState,
                    narratives: hotNarratives,
                    phase: compilePhase,
                })
            );
        }
        persistRunReport({
            llmStatus: resolvedLlmStatus,
            units: units.length,
            evidenceSpans: evidenceSpans.length,
            memoryItems: memoryItems.length,
            nodes: 0,
            edges: 0,
            ignitionNodes: 0,
            ignitionEdges: 0,
            recallBundles: 0,
        });
        return {
            narrativeDocs: allNarrativeDocs,
            units,
            evidenceSpans,
            memoryItems,
            llmJobs,
            llmItems,
            llmStatus: resolvedLlmStatus,
            toolCatalogCheck,
            nodes: [],
            edges: [],
            ignitionNodes: [],
            ignitionEdges: [],
            recallBundles: [],
            buildStats,
            scopePreview,
        };
    }
    const { nodes, edges: baseEdges } = materializeGraph(memoryItems, units, evidenceSpans);
    logStage(`graph materialized (nodes=${nodes.length} edges=${baseEdges.length})`);
    const reviewedRelationsInput = readJsonl<V8ReviewedRelation>(store.reviewedRelations);
    const existingHypothesisEdges = readJsonl<V8HypothesisEdge>(store.hypothesisEdges);
    const existingLearningEvents = readJsonl<V8LearningEvent>(store.learningEvents);
    const existingSearchFeedbackSignals = readJsonl<V8SearchFeedbackSignal>(
        store.searchFeedbackSignals
    );
    const reviewedOverlayInitial = applyReviewedRelationsToGraph({
        nodes,
        edges: baseEdges,
        reviewedRelations: reviewedRelationsInput,
        existingHypothesisEdges,
    });
    buildStats.relationReviewedAccepted = reviewedOverlayInitial.stats.accepted;
    buildStats.relationReviewedHypothesis = reviewedOverlayInitial.stats.hypothesis;
    buildStats.relationReviewedRejected = reviewedOverlayInitial.stats.rejected;
    logStage(
        `reviewed relations applied (accepted=${reviewedOverlayInitial.stats.accepted} hypothesis=${reviewedOverlayInitial.stats.hypothesis} rejected=${reviewedOverlayInitial.stats.rejected})`
    );
    const initialEdges = reviewedOverlayInitial.edges;
    const initialProjections = buildRuntimeProjections({
        nodes,
        edges: initialEdges,
        evidenceSpans,
    });
    logStage("runtime projections built");
    const relationPlanning = buildRelationPlanningArtifacts({
        nodes,
        edges: initialEdges,
        evidenceSpans,
        recallBundles: initialProjections.recallBundles,
        searchFeedbackSignals: existingSearchFeedbackSignals,
        learningEvents: existingLearningEvents,
        compilePhase,
    });
    buildStats.relationEntityPostings = relationPlanning.entityPostings.length;
    buildStats.relationScopeCards = relationPlanning.entityScopeCards.length;
    buildStats.relationGroupSummaries = relationPlanning.groupSummaries.length;
    buildStats.relationSearchPlans = relationPlanning.relationSearchPlans.length;
    buildStats.relationShardSelections =
        relationPlanning.narrativeShardSelections.length;
    buildStats.relationCandidateHits = relationPlanning.relationCandidateHits.length;
    buildStats.relationReviewJobs = relationPlanning.relationReviewJobs.length;
    const relationReviewLlmCommand = (options?.relationReviewLlmCommand || "").trim();
    const relationReviewLlmEnabled = relationReviewLlmCommand.length > 0;
    if (relationReviewLlmEnabled) {
        writeRelationReviewJobsMarkdown({
            filePath: store.relationReviewJobsMd,
            jobs: relationPlanning.relationReviewJobs,
            plans: relationPlanning.relationSearchPlans,
            candidateHits: relationPlanning.relationCandidateHits,
            nodes,
            evidenceSpans,
        });
    }
    const relationReviewLlmStatus = relationReviewLlmEnabled
        ? relationPlanning.relationReviewJobs.length > 0
            ? maybeRunRelationReviewLlm({
                  command: relationReviewLlmCommand,
                  jobsPath: store.relationReviewJobsMd,
                  outputMdPath: store.reviewedRelationsMd,
                  outputJsonlPath: store.reviewedRelations,
                  timeoutMs: options?.relationReviewLlmTimeoutMs,
              })
            : "skipped(no_review_jobs)"
        : `skipped(${FROZEN_RELATION_REVIEW_LLM})`;
    buildStats.relationReviewLlmStatus = relationReviewLlmStatus;
    const reviewedFromOutputs =
        relationReviewLlmEnabled && relationPlanning.relationReviewJobs.length > 0
            ? loadReviewedRelations({
                  mdPath: store.reviewedRelationsMd,
                  jsonlPath: store.reviewedRelations,
                  jobs: relationPlanning.relationReviewJobs,
                  nodes,
              })
            : [];
    const mergedReviewedRelations = mergeRecordsById<V8ReviewedRelation>([
        ...reviewedRelationsInput,
        ...reviewedFromOutputs,
    ]);
    const reviewedOverlayFinal = applyReviewedRelationsToGraph({
        nodes,
        edges: baseEdges,
        reviewedRelations: mergedReviewedRelations,
        existingHypothesisEdges,
    });
    const edges = reviewedOverlayFinal.edges;
    const projections = buildRuntimeProjections({
        nodes,
        edges,
        evidenceSpans,
    });
    buildStats.relationReviewedAccepted = reviewedOverlayFinal.stats.accepted;
    buildStats.relationReviewedHypothesis = reviewedOverlayFinal.stats.hypothesis;
    buildStats.relationReviewedRejected = reviewedOverlayFinal.stats.rejected;
    const reviewedArtifacts = finalizeRelationReviewArtifacts({
        reviewedRelations: reviewedOverlayFinal.reviewedRelations,
        relationReviewJobs: relationPlanning.relationReviewJobs,
        relationSearchPlans: relationPlanning.relationSearchPlans,
    });
    const mergedLearningEvents = mergeRecordsById([
        ...existingLearningEvents,
        ...reviewedArtifacts.learningEvents,
    ]);
    const mergedSearchFeedbackSignals = mergeRecordsById([
        ...existingSearchFeedbackSignals,
        ...reviewedArtifacts.searchFeedbackSignals,
    ]);
    buildStats.relationReviewJobsCompleted = reviewedArtifacts.stats.completedJobs;
    buildStats.learningEvents = mergedLearningEvents.length;
    buildStats.searchFeedbackSignals = mergedSearchFeedbackSignals.length;
    logStage("relation planning artifacts built");
    writeJsonl(store.units, units);
    writeJsonl(store.evidenceSpans, evidenceSpans);
    writeJsonl(store.memoryItems, memoryItems);
    writeJsonl(store.graphNodes, nodes);
    writeJsonl(store.graphEdges, edges);
    writeJsonl(store.ignitionNodes, projections.ignitionNodes);
    writeJsonl(store.ignitionEdges, projections.ignitionEdges);
    writeJsonl(store.recallBundles, projections.recallBundles);
    writeJsonl(store.entityPostings, relationPlanning.entityPostings);
    writeJsonl(store.entityScopeCards, relationPlanning.entityScopeCards);
    writeJsonl(store.groupSummaries, relationPlanning.groupSummaries);
    writeJsonl(store.relationSearchPlans, relationPlanning.relationSearchPlans);
    writeJsonl(
        store.narrativeShardSelections,
        relationPlanning.narrativeShardSelections
    );
    writeJsonl(store.relationCandidateHits, relationPlanning.relationCandidateHits);
    writeJsonl(store.relationReviewJobs, reviewedArtifacts.relationReviewJobs);
    writeJsonl(store.reviewedRelations, reviewedOverlayFinal.reviewedRelations);
    writeJsonl(store.hypothesisEdges, reviewedOverlayFinal.hypothesisEdges);
    writeJsonl(store.learningEvents, mergedLearningEvents);
    writeJsonl(store.searchFeedbackSignals, mergedSearchFeedbackSignals);
    if (!isPartialBuild) {
        persistBuildManifest(store.buildManifest, loadedNarrativeDocs);
        persistNarrativeCompileState(
            store.narrativeCompileState,
            mergeNarrativeCompileState({
                existing: compileState,
                narratives: hotNarratives,
                phase: compilePhase,
            })
        );
    }
    persistRunReport({
        llmStatus: resolvedLlmStatus,
        units: units.length,
        evidenceSpans: evidenceSpans.length,
        memoryItems: memoryItems.length,
        nodes: nodes.length,
        edges: edges.length,
        ignitionNodes: projections.ignitionNodes.length,
        ignitionEdges: projections.ignitionEdges.length,
        recallBundles: projections.recallBundles.length,
    });

    return {
        narrativeDocs: allNarrativeDocs,
        units,
        evidenceSpans,
        memoryItems,
        llmJobs,
        llmItems,
        llmStatus: resolvedLlmStatus,
        toolCatalogCheck,
        nodes,
        edges,
        ignitionNodes: projections.ignitionNodes,
        ignitionEdges: projections.ignitionEdges,
        recallBundles: projections.recallBundles,
        buildStats,
        scopePreview,
    };
}

interface BuildManifestDocState {
    id: string;
    sourceRef: string;
    hash: string;
    timelineStart?: string;
    mtimeMs?: number;
}

interface BuildManifest {
    version: number;
    generatedAt: string;
    docs: Record<string, BuildManifestDocState>;
}

interface NarrativeCompileStateDoc {
    id: string;
    hash: string;
    phase: "stream" | "final";
    updatedAt: string;
}

interface NarrativeCompileState {
    version: number;
    generatedAt: string;
    docs: Record<string, NarrativeCompileStateDoc>;
}

interface BuildScope {
    activeDocIds: Set<string>;
    hotDocIds: Set<string>;
    coldDocIds: Set<string>;
    removedDocIds: Set<string>;
}

interface ArtifactSnapshot {
    units: V8Unit[];
    evidenceSpans: V8EvidenceSpan[];
    memoryItems: V8MemoryItem[];
    nodes: V8GraphNode[];
    edges: V8GraphEdge[];
    ignitionNodes: V8IgnitionNodeProjection[];
    ignitionEdges: V8IgnitionEdgeProjection[];
    recallBundles: V8RecallBundleProjection[];
}

interface BuildReport {
    generatedAt: string;
    workspace: string;
    stageTimingsMs: Record<string, number>;
    buildStats: {
        rebuildMode: "full" | "incremental" | "hybrid";
        hotWindowHours: number;
        partialBuild: boolean;
        maxNarrativeDocs: number | null;
        hotDocs: number;
        coldDocs: number;
        removedDocs: number;
        reusedCache: boolean;
        noopReuse: boolean;
        sourceNarrativeWrittenFiles: number;
        sourceNarrativeSkippedFiles: number;
        sourceNormalizationRecordCount: number;
        sourceNormalizationRawChars: number;
        sourceNormalizationCleanChars: number;
        sourceNormalizationRemovedChars: number;
        sourceNormalizationTouchedRecords: number;
        sourceNormalizationRemovedRatioPct: number;
        compilePhase: "stream" | "final";
        hotTailSkipUnits: number;
        llmLayers: string;
        hotTailDroppedUnits: number;
        phaseLayerDroppedUnits: number;
        llmCacheHitUnits: number;
        llmCacheMissUnits: number;
        llmCacheEntries: number;
        irRuleItems: number;
        irLlmItems: number;
        irFallbackItems: number;
        irFallbackApplied: boolean;
        relationEntityPostings: number;
        relationScopeCards: number;
        relationGroupSummaries: number;
        relationSearchPlans: number;
        relationShardSelections: number;
        relationCandidateHits: number;
        relationReviewJobs: number;
        relationReviewedAccepted: number;
        relationReviewedHypothesis: number;
        relationReviewedRejected: number;
        relationReviewJobsCompleted: number;
        learningEvents: number;
        searchFeedbackSignals: number;
        relationReviewLlmStatus: string;
    };
    llmStatus: string;
    scopePreview: {
        hotDocIds: string[];
        coldDocIds: string[];
        removedDocIds: string[];
    };
    counts: {
        narrativeDocs: number;
        units: number;
        evidenceSpans: number;
        memoryItems: number;
        nodes: number;
        edges: number;
        ignitionNodes: number;
        ignitionEdges: number;
        recallBundles: number;
    };
}

const LLM_UNIT_CACHE_VERSION = 1;

interface LlmUnitCacheEntry {
    cacheKey: string;
    version: number;
    layer: V8GraphLayer;
    unitId: string;
    narrativeRecordId: string;
    unitHash: string;
    updatedAt: string;
    items: V8MemoryItem[];
}

function emptyCachedArtifacts(): Pick<
    ArtifactSnapshot,
    "units" | "evidenceSpans" | "memoryItems"
> {
    return {
        units: [],
        evidenceSpans: [],
        memoryItems: [],
    };
}

function trimTrailingUnitsByNarrativeForCompile(
    units: V8Unit[],
    dropPerNarrative: number
): V8Unit[] {
    if (dropPerNarrative <= 0 || units.length === 0) return units;
    const byNarrative = new Map<string, V8Unit[]>();
    for (const unit of units) {
        const list = byNarrative.get(unit.narrativeRecordId) || [];
        list.push(unit);
        byNarrative.set(unit.narrativeRecordId, list);
    }
    const dropIds = new Set<string>();
    for (const list of byNarrative.values()) {
        const ordered = list
            .slice()
            .sort(
                (a, b) =>
                    a.ordinal - b.ordinal || a.charStart - b.charStart || a.id.localeCompare(b.id)
            );
        const keepUntil = Math.max(0, ordered.length - dropPerNarrative);
        for (let idx = keepUntil; idx < ordered.length; idx += 1) {
            const unit = ordered[idx];
            if (unit) {
                dropIds.add(unit.id);
            }
        }
    }
    return units.filter((unit) => !dropIds.has(unit.id));
}

function filterUnitsByCompilePhase(
    units: V8Unit[],
    compilePhase: "stream" | "final"
): V8Unit[] {
    if (compilePhase === "final") return units;
    return units.filter((unit) => unit.layer === "micro" || unit.layer === "meso");
}

function buildLlmUnitCacheKey(unit: V8Unit): string {
    return `${LLM_UNIT_CACHE_VERSION}|${unit.layer}|${unit.id}|${hashUnitForLlmCache(unit)}`;
}

function hashUnitForLlmCache(unit: V8Unit): string {
    return createHash("sha1")
        .update(unit.layer)
        .update("\n")
        .update(unit.narrativeRecordId)
        .update("\n")
        .update(unit.id)
        .update("\n")
        .update(String(unit.charStart))
        .update(":")
        .update(String(unit.charEnd))
        .update("\n")
        .update(unit.text || "")
        .digest("hex");
}

function loadLlmUnitCacheEntries(filePath: string): LlmUnitCacheEntry[] {
    const raw = readJsonl<Partial<LlmUnitCacheEntry>>(filePath);
    if (raw.length === 0) return [];
    const entries: LlmUnitCacheEntry[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        if (item.version !== LLM_UNIT_CACHE_VERSION) continue;
        if (!item.cacheKey || typeof item.cacheKey !== "string") continue;
        if (!item.unitId || typeof item.unitId !== "string") continue;
        if (!item.narrativeRecordId || typeof item.narrativeRecordId !== "string") continue;
        if (!item.unitHash || typeof item.unitHash !== "string") continue;
        if (
            item.layer !== "micro" &&
            item.layer !== "meso" &&
            item.layer !== "macro"
        ) {
            continue;
        }
        entries.push({
            cacheKey: item.cacheKey,
            version: LLM_UNIT_CACHE_VERSION,
            layer: item.layer,
            unitId: item.unitId,
            narrativeRecordId: item.narrativeRecordId,
            unitHash: item.unitHash,
            updatedAt:
                typeof item.updatedAt === "string"
                    ? item.updatedAt
                    : new Date().toISOString(),
            items: Array.isArray(item.items) ? dedupeMemoryItems(item.items as V8MemoryItem[]) : [],
        });
    }
    return entries;
}

function mergeLlmUnitCacheEntries(input: {
    existing: LlmUnitCacheEntry[];
    units: V8Unit[];
    llmItems: V8MemoryItem[];
}): LlmUnitCacheEntry[] {
    if (input.units.length === 0) {
        return input.existing;
    }
    const now = new Date().toISOString();
    const nextByKey = new Map(input.existing.map((entry) => [entry.cacheKey, entry]));
    const itemsByUnitLayer = new Map<string, V8MemoryItem[]>();
    for (const item of input.llmItems) {
        const unitId = item.unitIds?.[0];
        if (!unitId) continue;
        const key = `${item.layer}|${unitId}`;
        const list = itemsByUnitLayer.get(key) || [];
        list.push(item);
        itemsByUnitLayer.set(key, list);
    }
    for (const unit of input.units) {
        const cacheKey = buildLlmUnitCacheKey(unit);
        const unitItems = dedupeMemoryItems(
            itemsByUnitLayer.get(`${unit.layer}|${unit.id}`) || []
        );
        nextByKey.set(cacheKey, {
            cacheKey,
            version: LLM_UNIT_CACHE_VERSION,
            layer: unit.layer,
            unitId: unit.id,
            narrativeRecordId: unit.narrativeRecordId,
            unitHash: hashUnitForLlmCache(unit),
            updatedAt: now,
            items: cloneMemoryItems(unitItems),
        });
    }
    return Array.from(nextByKey.values()).sort((a, b) => a.cacheKey.localeCompare(b.cacheKey));
}

function cloneMemoryItems(items: V8MemoryItem[]): V8MemoryItem[] {
    return items.map((item) => ({
        ...item,
        qualifiers: { ...(item.qualifiers || {}) },
        evidenceSpanIds: [...(item.evidenceSpanIds || [])],
        unitIds: [...(item.unitIds || [])],
    }));
}

function dedupeMemoryItems(items: V8MemoryItem[]): V8MemoryItem[] {
    if (items.length <= 1) return items;
    const seen = new Set<string>();
    const output: V8MemoryItem[] = [];
    for (const item of items) {
        const unitId = item.unitIds?.[0] || "";
        const key = [
            item.layer,
            item.narrativeRecordId,
            unitId,
            item.itemType,
            normalizeMemoryDedupe(item.subject),
            normalizeMemoryDedupe(item.predicate),
            normalizeMemoryDedupe(item.object),
        ].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(item);
    }
    return output;
}

function normalizeMemoryDedupe(text: string): string {
    return (text || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function loadBuildManifest(filePath: string): BuildManifest | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as BuildManifest;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.version !== "number") return null;
        if (!parsed.docs || typeof parsed.docs !== "object") return null;
        return parsed;
    } catch {
        return null;
    }
}

function loadNarrativeCompileState(filePath: string): NarrativeCompileState | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as NarrativeCompileState;
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.version !== "number") return null;
        if (!parsed.docs || typeof parsed.docs !== "object") return null;
        return parsed;
    } catch {
        return null;
    }
}

function persistNarrativeCompileState(
    filePath: string,
    state: NarrativeCompileState
): void {
    try {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    } catch {
        // ignore compile-state persistence errors
    }
}

function mergeNarrativeCompileState(input: {
    existing: NarrativeCompileState | null;
    narratives: V8NarrativeRecord[];
    phase: "stream" | "final";
}): NarrativeCompileState {
    const docs: Record<string, NarrativeCompileStateDoc> = {
        ...(input.existing?.docs || {}),
    };
    const now = new Date().toISOString();
    for (const narrative of input.narratives) {
        docs[narrative.id] = {
            id: narrative.id,
            hash: hashNarrative(narrative),
            phase: maxCompilePhase(
                docs[narrative.id]?.phase || "stream",
                input.phase
            ),
            updatedAt: now,
        };
    }
    return {
        version: 1,
        generatedAt: now,
        docs,
    };
}

function persistBuildReport(input: {
    jsonPath: string;
    markdownPath?: string;
    report: BuildReport;
}): void {
    try {
        fs.writeFileSync(input.jsonPath, JSON.stringify(input.report, null, 2), "utf-8");
    } catch {
        // ignore report persistence errors
    }
    if (!input.markdownPath) return;
    try {
        fs.writeFileSync(input.markdownPath, renderBuildReportMarkdown(input.report), "utf-8");
    } catch {
        // ignore markdown report persistence errors
    }
}

function clearJsonlFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
        try {
            fs.writeFileSync(filePath, "", "utf-8");
        } catch {
            // ignore cleanup failures
        }
    }
}

function countJsonlRecords(filePath: string): number {
    try {
        const raw = fs.readFileSync(filePath, "utf-8").trim();
        if (!raw) return 0;
        return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    } catch {
        return 0;
    }
}

function countReviewedRelationsByStatus(
    filePath: string,
    status: "accepted" | "hypothesis" | "rejected"
): number {
    try {
        return readJsonl<V8ReviewedRelation>(filePath).filter(
            (item) => item.status === status
        ).length;
    } catch {
        return 0;
    }
}

function countRelationReviewJobsByStatus(
    filePath: string,
    status: "pending" | "completed" | "failed"
): number {
    try {
        return readJsonl<V8RelationReviewJob>(filePath).filter(
            (item) => item.status === status
        ).length;
    } catch {
        return 0;
    }
}

function mergeRecordsById<T extends { id: string }>(records: T[]): T[] {
    const map = new Map<string, T>();
    for (const record of records) {
        if (!record?.id) continue;
        map.set(record.id, record);
    }
    return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function buildScopePreview(
    scope: BuildScope,
    narratives: V8NarrativeRecord[]
): BuildReport["scopePreview"] {
    const byId = new Map(narratives.map((narrative) => [narrative.id, narrative]));
    const toRecent = (ids: Set<string>) =>
        Array.from(ids)
            .map((id) => ({
                id,
                ts: byId.has(id) ? resolveNarrativeSortTimestamp(byId.get(id)!) : 0,
            }))
            .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
            .slice(0, 40)
            .map((entry) => entry.id);
    return {
        hotDocIds: toRecent(scope.hotDocIds),
        coldDocIds: toRecent(scope.coldDocIds),
        removedDocIds: Array.from(scope.removedDocIds).slice(0, 40),
    };
}

function renderBuildReportMarkdown(report: BuildReport): string {
    const lines: string[] = [];
    lines.push("# V8 Build Report");
    lines.push("");
    lines.push(`- generatedAt: ${report.generatedAt}`);
    lines.push(`- workspace: ${report.workspace}`);
    lines.push(`- llmStatus: ${report.llmStatus}`);
    lines.push(
        `- mode: ${report.buildStats.rebuildMode} (hotWindowHours=${report.buildStats.hotWindowHours})`
    );
    lines.push(
        `- scope: hot=${report.buildStats.hotDocs}, cold=${report.buildStats.coldDocs}, removed=${report.buildStats.removedDocs}`
    );
    lines.push(
        `- cache: reused=${String(report.buildStats.reusedCache)}, noop=${String(report.buildStats.noopReuse)}`
    );
    lines.push(
        `- sourceNarrativeWrites: written=${report.buildStats.sourceNarrativeWrittenFiles}, skippedExisting=${report.buildStats.sourceNarrativeSkippedFiles}`
    );
    lines.push(
        `- sourceNormalization: records=${report.buildStats.sourceNormalizationRecordCount}, touchedRecords=${report.buildStats.sourceNormalizationTouchedRecords}, rawChars=${report.buildStats.sourceNormalizationRawChars}, cleanChars=${report.buildStats.sourceNormalizationCleanChars}, removedChars=${report.buildStats.sourceNormalizationRemovedChars}, removedRatioPct=${report.buildStats.sourceNormalizationRemovedRatioPct.toFixed(2)}`
    );
    lines.push(
        `- compilePhase: ${report.buildStats.compilePhase} (layers=${report.buildStats.llmLayers}, hotTailSkipUnits=${report.buildStats.hotTailSkipUnits}, hotTailDroppedUnits=${report.buildStats.hotTailDroppedUnits}, phaseLayerDroppedUnits=${report.buildStats.phaseLayerDroppedUnits})`
    );
    lines.push(
        `- llmCache: hitUnits=${report.buildStats.llmCacheHitUnits}, missUnits=${report.buildStats.llmCacheMissUnits}, entries=${report.buildStats.llmCacheEntries}`
    );
    lines.push(
        `- irExtraction: rule=${report.buildStats.irRuleItems}, llm=${report.buildStats.irLlmItems}, fallback=${report.buildStats.irFallbackItems}, fallbackApplied=${String(report.buildStats.irFallbackApplied)}`
    );
    lines.push(
        `- relationPlanning: entityPostings=${report.buildStats.relationEntityPostings}, scopeCards=${report.buildStats.relationScopeCards}, groupSummaries=${report.buildStats.relationGroupSummaries}, searchPlans=${report.buildStats.relationSearchPlans}, shardSelections=${report.buildStats.relationShardSelections}, candidateHits=${report.buildStats.relationCandidateHits}, reviewJobs=${report.buildStats.relationReviewJobs}`
    );
    lines.push(
        `- relationReview: accepted=${report.buildStats.relationReviewedAccepted}, hypothesis=${report.buildStats.relationReviewedHypothesis}, rejected=${report.buildStats.relationReviewedRejected}, completedJobs=${report.buildStats.relationReviewJobsCompleted}, learningEvents=${report.buildStats.learningEvents}, searchFeedbackSignals=${report.buildStats.searchFeedbackSignals}`
    );
    lines.push(`- relationReviewLlmStatus: ${report.buildStats.relationReviewLlmStatus}`);
    lines.push(
        `- partialBuild: ${String(report.buildStats.partialBuild)}${report.buildStats.maxNarrativeDocs ? ` (maxNarrativeDocs=${report.buildStats.maxNarrativeDocs})` : ""}`
    );
    lines.push(
        `- scopePreview: hot=${report.scopePreview.hotDocIds.length}, cold=${report.scopePreview.coldDocIds.length}, removed=${report.scopePreview.removedDocIds.length}`
    );
    lines.push("");
    lines.push("## Counts");
    lines.push("");
    lines.push(`- narrativeDocs: ${report.counts.narrativeDocs}`);
    lines.push(`- units: ${report.counts.units}`);
    lines.push(`- evidenceSpans: ${report.counts.evidenceSpans}`);
    lines.push(`- memoryItems: ${report.counts.memoryItems}`);
    lines.push(`- nodes: ${report.counts.nodes}`);
    lines.push(`- edges: ${report.counts.edges}`);
    lines.push(`- ignitionNodes: ${report.counts.ignitionNodes}`);
    lines.push(`- ignitionEdges: ${report.counts.ignitionEdges}`);
    lines.push(`- recallBundles: ${report.counts.recallBundles}`);
    lines.push("");
    lines.push("## Stage Timings (ms since start)");
    lines.push("");
    for (const [stage, elapsed] of Object.entries(report.stageTimingsMs).sort((a, b) => a[1] - b[1])) {
        lines.push(`- ${stage}: ${elapsed}`);
    }
    lines.push("");
    lines.push("## Scope Preview");
    lines.push("");
    lines.push(`- hotDocIds: ${report.scopePreview.hotDocIds.join(", ") || "(none)"}`);
    lines.push(`- coldDocIds: ${report.scopePreview.coldDocIds.join(", ") || "(none)"}`);
    lines.push(`- removedDocIds: ${report.scopePreview.removedDocIds.join(", ") || "(none)"}`);
    lines.push("");
    return lines.join("\n");
}

function persistBuildManifest(filePath: string, narratives: V8NarrativeRecord[]): void {
    const docs: Record<string, BuildManifestDocState> = {};
    for (const narrative of narratives) {
        docs[narrative.id] = {
            id: narrative.id,
            sourceRef: narrative.sourceRef,
            hash: hashNarrative(narrative),
            timelineStart: narrative.metadata?.timelineStart,
            mtimeMs: safeStatMtime(narrative.sourceRef),
        };
    }
    const payload: BuildManifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        docs,
    };
    try {
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch {
        // ignore manifest persistence errors
    }
}

function computeBuildScope(input: {
    narratives: V8NarrativeRecord[];
    manifest: BuildManifest | null;
    compileState: NarrativeCompileState | null;
    mode: "full" | "incremental" | "hybrid";
    requestedPhase: "stream" | "final";
}): BuildScope {
    const activeDocIds = new Set(input.narratives.map((narrative) => narrative.id));
    const hotDocIds = new Set<string>();
    const coldDocIds = new Set<string>();
    const removedDocIds = new Set<string>();

    if (input.mode === "full" || !input.manifest) {
        for (const narrative of input.narratives) {
            hotDocIds.add(narrative.id);
        }
        return { activeDocIds, hotDocIds, coldDocIds, removedDocIds };
    }

    for (const narrative of input.narratives) {
        const previous = input.manifest.docs[narrative.id];
        const compileDoc = input.compileState?.docs?.[narrative.id];
        const hash = hashNarrative(narrative);
        const changed =
            !previous ||
            previous.hash !== hash ||
            previous.sourceRef !== narrative.sourceRef;
        const phaseMissing =
            !compileDoc ||
            compileDoc.hash !== hash ||
            !phaseAtLeast(compileDoc.phase, input.requestedPhase);
        if (changed || phaseMissing) {
            hotDocIds.add(narrative.id);
        } else {
            coldDocIds.add(narrative.id);
        }
    }

    for (const existingId of Object.keys(input.manifest.docs)) {
        if (!activeDocIds.has(existingId)) {
            removedDocIds.add(existingId);
        }
    }

    return { activeDocIds, hotDocIds, coldDocIds, removedDocIds };
}

function normalizeRebuildMode(
    mode?: "full" | "incremental" | "hybrid"
): "full" | "incremental" | "hybrid" {
    if (mode === "full") return "full";
    if (mode === "hybrid") return "incremental";
    return "incremental";
}

function resolveNarrativeSortTimestamp(narrative: V8NarrativeRecord): number {
    const timelineStart = narrative.metadata?.timelineStart;
    if (timelineStart) {
        const parsed = Date.parse(timelineStart.includes("T") ? timelineStart : timelineStart.replace(" ", "T"));
        if (!Number.isNaN(parsed)) return parsed;
    }
    const byMtime = safeStatMtime(narrative.sourceRef);
    return typeof byMtime === "number" ? byMtime : 0;
}

function compilePhaseRank(phase: "stream" | "final"): number {
    return phase === "final" ? 2 : 1;
}

function phaseAtLeast(
    current: "stream" | "final",
    requested: "stream" | "final"
): boolean {
    return compilePhaseRank(current) >= compilePhaseRank(requested);
}

function maxCompilePhase(
    a: "stream" | "final",
    b: "stream" | "final"
): "stream" | "final" {
    return compilePhaseRank(a) >= compilePhaseRank(b) ? a : b;
}

function safeStatMtime(filePath: string): number | undefined {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return undefined;
    }
}

function hashNarrative(narrative: V8NarrativeRecord): string {
    const content = narrative.cleanText ?? narrative.rawText ?? "";
    return createHash("sha1")
        .update(narrative.id)
        .update("\n")
        .update(content)
        .digest("hex");
}

function hasReusableArtifacts(store: ReturnType<typeof ensureV8StoreDirs>): boolean {
    return (
        fs.existsSync(store.units) &&
        fs.existsSync(store.evidenceSpans) &&
        fs.existsSync(store.memoryItems) &&
        fs.existsSync(store.graphNodes) &&
        fs.existsSync(store.graphEdges) &&
        fs.existsSync(store.ignitionNodes) &&
        fs.existsSync(store.ignitionEdges) &&
        fs.existsSync(store.recallBundles) &&
        fs.existsSync(store.entityPostings) &&
        fs.existsSync(store.entityScopeCards) &&
        fs.existsSync(store.groupSummaries) &&
        fs.existsSync(store.relationSearchPlans) &&
        fs.existsSync(store.narrativeShardSelections) &&
        fs.existsSync(store.relationCandidateHits) &&
        fs.existsSync(store.relationReviewJobs) &&
        fs.existsSync(store.learningEvents) &&
        fs.existsSync(store.searchFeedbackSignals)
    );
}

function hasReviewOverlayUpdates(
    store: ReturnType<typeof ensureV8StoreDirs>
): boolean {
    const reviewedMtime = safeStatMtime(store.reviewedRelations) || 0;
    const hypothesisMtime = safeStatMtime(store.hypothesisEdges) || 0;
    if (reviewedMtime <= 0 && hypothesisMtime <= 0) return false;
    const graphMtime = safeStatMtime(store.graphEdges) || 0;
    const reviewJobMtime = safeStatMtime(store.relationReviewJobs) || 0;
    const learningMtime = safeStatMtime(store.learningEvents) || 0;
    const feedbackMtime = safeStatMtime(store.searchFeedbackSignals) || 0;
    const baseline = Math.max(graphMtime, reviewJobMtime, learningMtime, feedbackMtime);
    return Math.max(reviewedMtime, hypothesisMtime) > baseline;
}

function loadCachedArtifactsForDocs(
    store: ReturnType<typeof ensureV8StoreDirs>,
    coldDocIds: Set<string>,
    activeDocIds: Set<string>
): Pick<ArtifactSnapshot, "units" | "evidenceSpans" | "memoryItems"> {
    if (coldDocIds.size === 0) return emptyCachedArtifacts();
    const units = readJsonl<V8Unit>(store.units).filter(
        (unit) => coldDocIds.has(unit.narrativeRecordId) && activeDocIds.has(unit.narrativeRecordId)
    );
    const coldUnitIds = new Set(units.map((unit) => unit.id));
    const evidenceSpans = readJsonl<V8EvidenceSpan>(store.evidenceSpans).filter(
        (span) => coldUnitIds.has(span.unitId) && activeDocIds.has(span.narrativeRecordId)
    );
    const coldSpanIds = new Set(evidenceSpans.map((span) => span.id));
    const memoryItems = readJsonl<V8MemoryItem>(store.memoryItems).filter((item) => {
        if (!activeDocIds.has(item.narrativeRecordId)) return false;
        if (!coldDocIds.has(item.narrativeRecordId)) return false;
        const hasHotEvidence = item.evidenceSpanIds.some((spanId) => !coldSpanIds.has(spanId));
        const hasHotUnit = item.unitIds.some((unitId) => !coldUnitIds.has(unitId));
        return !hasHotEvidence && !hasHotUnit;
    });
    return {
        units,
        evidenceSpans,
        memoryItems,
    };
}

function loadAllArtifacts(
    store: ReturnType<typeof ensureV8StoreDirs>
): ArtifactSnapshot {
    return {
        units: readJsonl<V8Unit>(store.units),
        evidenceSpans: readJsonl<V8EvidenceSpan>(store.evidenceSpans),
        memoryItems: readJsonl<V8MemoryItem>(store.memoryItems),
        nodes: readJsonl<V8GraphNode>(store.graphNodes),
        edges: readJsonl<V8GraphEdge>(store.graphEdges),
        ignitionNodes: readJsonl<V8IgnitionNodeProjection>(store.ignitionNodes),
        ignitionEdges: readJsonl<V8IgnitionEdgeProjection>(store.ignitionEdges),
        recallBundles: readJsonl<V8RecallBundleProjection>(store.recallBundles),
    };
}

function summarizeSourceNormalization(records: V8NarrativeRecord[]): {
    recordCount: number;
    rawChars: number;
    cleanChars: number;
    removedChars: number;
    touchedRecords: number;
    removedRatioPct: number;
} {
    let rawChars = 0;
    let cleanChars = 0;
    let touchedRecords = 0;
    for (const record of records) {
        const raw = record.rawText || "";
        const clean = record.cleanText ?? raw;
        rawChars += raw.length;
        cleanChars += clean.length;
        if (clean.length < raw.length) touchedRecords += 1;
    }
    const removedChars = Math.max(0, rawChars - cleanChars);
    return {
        recordCount: records.length,
        rawChars,
        cleanChars,
        removedChars,
        touchedRecords,
        removedRatioPct: rawChars > 0 ? (removedChars * 100) / rawChars : 0,
    };
}

function persistAssembledObservationMarkdown(
    rawDir: string,
    records: V8NarrativeRecord[]
): { writtenFiles: number; skippedFiles: number } {
    if (!records.length) {
        return { writtenFiles: 0, skippedFiles: 0 };
    }
    const outDir = path.join(rawDir, "observations", "assembled");
    fs.mkdirSync(outDir, { recursive: true });
    return persistSessionNarratives(outDir, records);
}

interface SessionLinkRef {
    childSessionKey: string;
    runId?: string;
    label?: string;
    runtime?: string;
}

function extractSessionLinksFromMessages(messages: RawSessionMessage[]): SessionLinkRef[] {
    const callMeta = new Map<string, { label?: string; runtime?: string }>();
    for (const msg of messages) {
        const content = msg.message?.content;
        if (!Array.isArray(content)) continue;
        for (const entry of content) {
            if (!entry) continue;
            const toolName =
                (entry.name as string | undefined) ||
                (entry.toolName as string | undefined) ||
                (entry.tool_name as string | undefined) ||
                (entry.tool as string | undefined) ||
                (entry.function as { name?: string } | undefined)?.name;
            if (!toolName || toolName !== "sessions_spawn") continue;
            const toolCallId =
                (entry.id as string | undefined) ||
                (entry.toolCallId as string | undefined) ||
                (entry.tool_call_id as string | undefined) ||
                "";
            if (!toolCallId) continue;
            const args = extractToolArgs(entry);
            const meta: { label?: string; runtime?: string } = {};
            if (typeof args?.label === "string" && args.label.trim()) {
                meta.label = args.label.trim();
            }
            if (typeof args?.runtime === "string" && args.runtime.trim()) {
                meta.runtime = args.runtime.trim();
            }
            callMeta.set(toolCallId, meta);
        }
    }

    const links: SessionLinkRef[] = [];
    const seen = new Set<string>();
    for (const msg of messages) {
        const role =
            (msg.message as { role?: string } | undefined)?.role ||
            msg.role ||
            msg.speaker;
        if (role !== "toolResult" && role !== "tool") continue;
        const toolName =
            msg.message?.toolName ||
            msg.message?.tool_name ||
            msg.message?.name ||
            msg.message?.tool ||
            (msg as { toolName?: string }).toolName;
        if (toolName !== "sessions_spawn") continue;

        const toolCallId =
            msg.message?.toolCallId ||
            msg.message?.tool_call_id ||
            (msg as { toolCallId?: string }).toolCallId ||
            "";
        const details =
            (msg.message?.details as Record<string, unknown> | undefined) ||
            (msg as { details?: Record<string, unknown> }).details ||
            {};
        const parsed = extractChildSessionDetails(details, msg);
        if (!parsed.childSessionKey) continue;
        if (parsed.status && parsed.status !== "accepted") continue;
        if (seen.has(parsed.childSessionKey)) continue;
        seen.add(parsed.childSessionKey);
        const meta = toolCallId ? callMeta.get(toolCallId) : undefined;
        links.push({
            childSessionKey: parsed.childSessionKey,
            runId: parsed.runId,
            label: meta?.label,
            runtime: meta?.runtime || inferOriginKind(parsed.childSessionKey) || undefined,
        });
    }
    return links;
}

function extractToolArgs(entry: {
    arguments?: unknown;
    function?: { arguments?: unknown };
}): Record<string, unknown> | null {
    const raw = entry.arguments ?? entry.function?.arguments;
    if (!raw) return null;
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }
    return typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

function extractChildSessionDetails(
    details: Record<string, unknown>,
    msg: RawSessionMessage
): { childSessionKey?: string; runId?: string; status?: string } {
    const status = typeof details.status === "string" ? details.status : undefined;
    const childSessionKey =
        (typeof details.childSessionKey === "string" && details.childSessionKey) ||
        (typeof (details as any).child_session_key === "string" &&
            (details as any).child_session_key) ||
        (typeof details.sessionKey === "string" &&
            details.sessionKey.includes(":subagent:") ? details.sessionKey : "") ||
        (typeof details.sessionKey === "string" &&
            details.sessionKey.includes(":acp:") ? details.sessionKey : "");
    const runId =
        (typeof details.runId === "string" && details.runId) ||
        (typeof (details as any).run_id === "string" && (details as any).run_id) ||
        undefined;
    if (childSessionKey) {
        return { childSessionKey, runId, status };
    }
    const fallbackText = extractToolResultTextLite(msg);
    if (fallbackText && fallbackText.trim().startsWith("{")) {
        try {
            const parsed = JSON.parse(fallbackText);
            if (parsed && typeof parsed === "object") {
                const child =
                    (parsed as any).childSessionKey ||
                    (parsed as any).child_session_key ||
                    (parsed as any).sessionKey;
                if (typeof child === "string" && child) {
                    const parsedStatus =
                        typeof (parsed as any).status === "string" ? (parsed as any).status : status;
                    const parsedRunId =
                        typeof (parsed as any).runId === "string"
                            ? (parsed as any).runId
                            : runId;
                    return {
                        childSessionKey: child,
                        runId: parsedRunId,
                        status: parsedStatus,
                    };
                }
            }
        } catch {
            // ignore parse errors
        }
    }
    return { status };
}

function extractToolResultTextLite(msg: RawSessionMessage): string {
    const content =
        msg.content ??
        msg.text ??
        msg.body ??
        msg.message?.content ??
        "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((entry) =>
                typeof entry?.text === "string" ? entry.text : ""
            )
            .join("\n");
    }
    return "";
}

function loadLinkedSessionRecords(input: {
    links: SessionLinkRef[];
    parentSessionId: string;
    sessionTraceDir: string;
    toolCleaningProfiles: ReturnType<typeof loadResolvedToolCleaningProfiles>;
    workspace: string;
}): V8NarrativeRecord[] {
    const agentsRoot = resolveAgentsRoot(input.sessionTraceDir);
    if (!agentsRoot) return [];
    const records: V8NarrativeRecord[] = [];
    const sessionIndexCache = new Map<string, Map<string, string>>();

    for (const link of input.links) {
        const agentId = parseAgentIdFromSessionKey(link.childSessionKey);
        if (!agentId) continue;
        const sessionsDir = path.join(agentsRoot, agentId, "sessions");
        if (!fs.existsSync(sessionsDir)) continue;
        const sessionId = resolveSessionIdFromStore(
            sessionsDir,
            link.childSessionKey,
            sessionIndexCache
        );
        if (!sessionId) continue;
        const filePath = resolveSessionTracePath(sessionsDir, sessionId);
        if (!filePath) continue;
        const messages = readSessionTraceFile(filePath);
        if (!messages.length) continue;
        const linkedRecords = normalizeSessionMessages(messages, {
            sourceRefPrefix: filePath,
            sessionId: input.parentSessionId,
            workspace: input.workspace,
            toolCleaningProfiles: input.toolCleaningProfiles,
        });
        const originKind = link.runtime || inferOriginKind(link.childSessionKey) || "subagent";
        for (const record of linkedRecords) {
            record.metadata.originSessionKey = link.childSessionKey;
            record.metadata.originSessionId = sessionId;
            record.metadata.originAgentId = agentId;
            record.metadata.originRuntime = originKind;
            if (link.label) {
                record.metadata.originLabel = link.label;
            }
            record.metadata.sourceOrigin = originKind;
        }
        records.push(...linkedRecords);
    }

    return records;
}

function resolveAgentsRoot(sessionTraceDir: string): string | null {
    if (!sessionTraceDir) return null;
    const resolved = path.resolve(sessionTraceDir);
    const base = path.basename(resolved);
    if (base === "sessions") {
        return path.dirname(path.dirname(resolved));
    }
    return path.dirname(resolved);
}

function parseAgentIdFromSessionKey(sessionKey: string): string | null {
    if (!sessionKey) return null;
    const match = sessionKey.match(/^agent:([^:]+):/i);
    return match ? match[1] : null;
}

function resolveSessionIdFromStore(
    sessionsDir: string,
    sessionKey: string,
    cache: Map<string, Map<string, string>>
): string | null {
    const index = loadSessionIndex(sessionsDir, cache);
    return index.get(sessionKey) || null;
}

function loadSessionIndex(
    sessionsDir: string,
    cache: Map<string, Map<string, string>>
): Map<string, string> {
    const cached = cache.get(sessionsDir);
    if (cached) return cached;
    const index = new Map<string, string>();
    const filePath = path.join(sessionsDir, "sessions.json");
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, { sessionId?: string }>;
        for (const [key, value] of Object.entries(parsed || {})) {
            if (typeof value?.sessionId === "string") {
                index.set(key, value.sessionId);
            }
        }
    } catch {
        // ignore missing or invalid index
    }
    cache.set(sessionsDir, index);
    return index;
}

function resolveSessionTracePath(sessionsDir: string, sessionId: string): string | null {
    const jsonl = path.join(sessionsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(jsonl)) return jsonl;
    const json = path.join(sessionsDir, `${sessionId}.json`);
    if (fs.existsSync(json)) return json;
    return null;
}

function readSessionTraceFile(filePath: string): RawSessionMessage[] {
    if (filePath.endsWith(".jsonl")) {
        return readJsonl<RawSessionMessage>(filePath).filter(isMessageRecord);
    }
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return (parsed as RawSessionMessage[]).filter(isMessageRecord);
        }
        if (Array.isArray(parsed?.messages)) {
            return (parsed.messages as RawSessionMessage[]).filter(isMessageRecord);
        }
    } catch {
        // ignore parse errors
    }
    return [];
}

function isMessageRecord(record: RawSessionMessage): boolean {
    if (!record) return false;
    if ((record as { type?: string }).type === "message") return true;
    return Boolean((record as any).message || (record as any).content || (record as any).text);
}

function deriveSessionIdFromSourceRef(sourceRefPrefix: string): string {
    if (!sourceRefPrefix) return "default";
    const last = sourceRefPrefix.split(/[\\/]/).pop() || sourceRefPrefix;
    return last.replace(/\.[^.]+$/, "") || "default";
}

function sanitizeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

interface NarrativeEntry {
    sessionId: string;
    sourceRef: string;
    sourceCategory: string;
    speaker: V8NarrativeRecord["speaker"];
    timestamp: string | null;
    text: string;
    toolName?: string;
    sourceIndex?: number | null;
    originKind?: string;
    originSessionKey?: string;
    originSessionId?: string;
    originAgentId?: string;
    originLabel?: string;
}

function persistSessionNarratives(
    outDir: string,
    records: V8NarrativeRecord[]
): { writtenFiles: number; skippedFiles: number } {
    const sessions = new Map<string, NarrativeEntry[]>();
    let writtenFiles = 0;
    let skippedFiles = 0;
    for (const record of records) {
        if (record.sourceType !== "session_trace") continue;
        const rawText = record.cleanText || record.rawText || "";
        const text = rawText.trim();
        if (!text) continue;
        const sessionId = record.metadata?.sessionId || "default";
        const sourceCategory = record.metadata?.sourceCategory || "conversation";
        const sourceIndex = toNumber(record.metadata?.sourceIndex);
        const entry: NarrativeEntry = {
            sessionId,
            sourceRef: record.sourceRef,
            sourceCategory,
            speaker: record.speaker,
            timestamp: record.timestamp,
            text:
                sourceCategory === "operation"
                    ? stripOperationHeading(text)
                    : text,
            toolName: record.metadata?.toolName,
            sourceIndex,
            originKind: record.metadata?.sourceOrigin || record.metadata?.originRuntime,
            originSessionKey: record.metadata?.originSessionKey,
            originSessionId: record.metadata?.originSessionId,
            originAgentId: record.metadata?.originAgentId,
            originLabel: record.metadata?.originLabel,
        };
        const bucket = sessions.get(sessionId) || [];
        bucket.push(entry);
        sessions.set(sessionId, bucket);
    }

    for (const [sessionId, entries] of sessions.entries()) {
        entries.sort(compareNarrativeEntries);
        const markdown = renderSessionNarrative(sessionId, entries);
        if (!markdown.trim()) continue;
        const fileName =
            sanitizeFileName(`session_${sessionId}_narrative`) + ".md";
        const fullPath = path.join(outDir, fileName);
        const wrote = appendNarrativeIfExtended(fullPath, markdown);
        if (wrote) writtenFiles += 1;
        else skippedFiles += 1;
    }
    return {
        writtenFiles,
        skippedFiles,
    };
}

function appendNarrativeIfExtended(filePath: string, content: string): boolean {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, content, "utf-8");
            return true;
        }
        const existingRaw = fs.readFileSync(filePath, "utf-8");
        const existing = normalizeLf(existingRaw);
        const incoming = normalizeLf(content);
        if (incoming === existing) return false;

        const existingPrefix = ensureTrailingLf(existing);
        const incomingNormalized = ensureTrailingLf(incoming);
        if (!incomingNormalized.startsWith(existingPrefix)) {
            return false;
        }

        const suffix = incomingNormalized.slice(existingPrefix.length);
        if (!suffix.trim()) return false;
        fs.appendFileSync(filePath, suffix, "utf-8");
        return true;
    } catch {
        return false;
    }
}

function normalizeLf(text: string): string {
    return (text || "").replace(/\r\n/g, "\n");
}

function ensureTrailingLf(text: string): string {
    if (!text) return "\n";
    return text.endsWith("\n") ? text : `${text}\n`;
}

function compareNarrativeEntries(a: NarrativeEntry, b: NarrativeEntry): number {
    const aTime = parseTimestampMs(a.timestamp);
    const bTime = parseTimestampMs(b.timestamp);
    if (aTime !== null && bTime !== null && aTime !== bTime) {
        return aTime - bTime;
    }
    if (aTime !== null && bTime === null) return -1;
    if (aTime === null && bTime !== null) return 1;
    const aKey = computeSortKey(a);
    const bKey = computeSortKey(b);
    if (aKey !== null && bKey !== null && aKey !== bKey) {
        return aKey - bKey;
    }
    if (aKey !== null && bKey === null) return -1;
    if (aKey === null && bKey !== null) return 1;
    return a.sourceRef.localeCompare(b.sourceRef);
}

function computeSortKey(entry: NarrativeEntry): number | null {
    const fromRef = parseSourceRefIndex(entry.sourceRef);
    const base = fromRef ?? entry.sourceIndex ?? null;
    if (base === null) return null;
    return entry.sourceCategory === "operation" ? base + 0.5 : base;
}

function parseSourceRefIndex(sourceRef: string): number | null {
    const opMatch = sourceRef.match(/#op-(\d+)/);
    if (opMatch) return Number(opMatch[1]);
    const msgMatch = sourceRef.match(/#(\d+)/);
    if (msgMatch) return Number(msgMatch[1]);
    return null;
}

function parseTimestampMs(value: string | null): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

function toNumber(value?: string): number | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function renderSessionNarrative(
    sessionId: string,
    entries: NarrativeEntry[]
): string {
    const lines: string[] = [];
    lines.push("# Session Narrative");
    lines.push("");
    lines.push("## Timeline");
    lines.push("");
    for (const entry of entries) {
        const speakerLabel = formatSpeakerLabel(entry);
        const metaParts = buildEntryMeta(entry);
        const header =
            metaParts.length > 0
                ? `### ${speakerLabel} (${metaParts.join(" · ")})`
                : `### ${speakerLabel}`;
        lines.push(header.trim());
        lines.push(entry.text);
        lines.push("");
    }
    return lines.join("\n").trim() + "\n";
}

function persistNarrativeUnitPreview(
    rawDir: string,
    units: V8Unit[],
    sources: V8NarrativeRecord[]
): void {
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const sessions = new Map<
        string,
        Map<string, { source: V8NarrativeRecord; units: V8Unit[] }>
    >();

    for (const unit of units) {
        const source = sourcesById.get(unit.narrativeRecordId);
        if (!source || source.sourceType !== "session_narrative") continue;
        const sessionId = source.metadata?.sessionId || "default";
        const sessionBucket =
            sessions.get(sessionId) ||
            new Map<string, { source: V8NarrativeRecord; units: V8Unit[] }>();
        const recordBucket =
            sessionBucket.get(source.id) ||
            { source, units: [] as V8Unit[] };
        recordBucket.units.push(unit);
        sessionBucket.set(source.id, recordBucket);
        sessions.set(sessionId, sessionBucket);
    }

    if (sessions.size === 0) return;
    const outDir = path.join(rawDir, "observations", "assembled");
    fs.mkdirSync(outDir, { recursive: true });

    for (const [sessionId, recordMap] of sessions.entries()) {
        const lines: string[] = [];
        lines.push("# Narrative Units");
        lines.push("");
        lines.push(`Session: \`${sessionId}\``);
        lines.push("");

        const records = Array.from(recordMap.values());
        records.sort((a, b) => a.source.id.localeCompare(b.source.id));
        for (const entry of records) {
            const record = entry.source;
            const text = (record.cleanText || record.rawText || "").trim();
            lines.push(`## ${record.id}`);
            if (record.metadata?.narrativeLabel) {
                lines.push(`label: ${record.metadata.narrativeLabel}`);
            }
            const originLabel = formatOriginLabel({
                sessionId: record.metadata?.sessionId || "default",
                sourceRef: record.sourceRef,
                sourceCategory: record.metadata?.sourceCategory || "conversation",
                speaker: record.speaker,
                timestamp: record.timestamp,
                text,
                originKind: record.metadata?.sourceOrigin || record.metadata?.originRuntime,
                originSessionKey: record.metadata?.originSessionKey,
                originSessionId: record.metadata?.originSessionId,
                originAgentId: record.metadata?.originAgentId,
                originLabel: record.metadata?.originLabel,
            });
            if (originLabel) {
                lines.push(`origin: ${originLabel}`);
            }
            if (record.speaker) {
                lines.push(`speaker: ${record.speaker}`);
            }
            if (record.timestamp) {
                lines.push(`timestamp: ${formatTimestampShort(record.timestamp) || record.timestamp}`);
            }
            if (text) {
                lines.push("");
                lines.push(text);
                lines.push("");
            }

            const byLayer = new Map<V8Unit["layer"], V8Unit[]>();
            for (const unit of entry.units) {
                const bucket = byLayer.get(unit.layer) || [];
                bucket.push(unit);
                byLayer.set(unit.layer, bucket);
            }
            const layerOrder: V8Unit["layer"][] = ["macro", "meso", "micro"];
            for (const layer of layerOrder) {
                const bucket = byLayer.get(layer);
                if (!bucket || bucket.length === 0) continue;
                bucket.sort((a, b) => a.ordinal - b.ordinal);
                lines.push(`### ${layer} units`);
                for (const unit of bucket) {
                    const unitText = unit.text.trim();
                    lines.push(`- ${unit.id}: ${unitText}`);
                }
                lines.push("");
            }
        }

        const fileName = `session_${sessionId}_units.md`;
        try {
            fs.writeFileSync(
                path.join(outDir, fileName),
                lines.join("\n").trim() + "\n",
                "utf-8"
            );
        } catch {
            // ignore write failures
        }
    }
}

function buildEntryMeta(entry: NarrativeEntry): string[] {
    const parts: string[] = [];
    const originLabel = formatOriginLabel(entry);
    if (originLabel) parts.push(originLabel);
    const shortTs = formatTimestampShort(entry.timestamp);
    if (shortTs) parts.push(shortTs);
    return parts;
}

function formatOriginLabel(entry: NarrativeEntry): string | null {
    const originKind = entry.originKind?.trim();
    const originLabel = entry.originLabel?.trim();
    if (!originKind && !originLabel && !entry.originSessionKey) return null;

    const kind = originKind || inferOriginKind(entry.originSessionKey);
    if (originLabel) {
        return kind ? `${kind} ${originLabel}` : originLabel;
    }
    return kind || null;
}

function inferOriginKind(originKey?: string | null): string | null {
    if (!originKey) return null;
    if (originKey.includes(":acp:")) return "acp";
    if (originKey.includes(":subagent:")) return "subagent";
    return null;
}


function formatSpeakerLabel(entry: NarrativeEntry): string {
    if (entry.sourceCategory === "operation") {
        return "assistant (tool)";
    }
    if (entry.speaker) return entry.speaker;
    return "unknown";
}

function stripOperationHeading(text: string): string {
    const lines = text.split("\n");
    if (!lines.length) return text;
    const first = lines[0].trim().toLowerCase();
    if (
        first.startsWith("#### tool operation") ||
        first.startsWith("### tool operation") ||
        first.startsWith("### tool execution snapshot")
    ) {
        return lines.slice(1).join("\n").trimStart();
    }
    return text;
}

function formatTimestampShort(value: string | null): string | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    const iso = new Date(parsed).toISOString();
    return iso.replace("T", " ").slice(0, 16);
}

function maybeRunIrLlm(input: {
    command?: string;
    jobsPath: string;
    itemsMdPath: string;
    itemsJsonlPath: string;
    timeoutMs?: number;
}): string {
    const command = (input.command || "").trim();
    if (!command) return "skipped";
    const interpolated = command
        .replace(/\{jobs\}/g, input.jobsPath)
        .replace(/\{items_md\}/g, input.itemsMdPath)
        .replace(/\{items_jsonl\}/g, input.itemsJsonlPath)
        .replace(/\{items\}/g, input.itemsMdPath);
    try {
        const result = spawnSync(interpolated, {
            shell: true,
            encoding: "utf-8",
            timeout: input.timeoutMs ?? 30 * 60 * 1000,
            env: {
                ...process.env,
                V8_IR_JOBS: input.jobsPath,
                V8_IR_ITEMS: input.itemsMdPath,
                V8_IR_ITEMS_MD: input.itemsMdPath,
                V8_IR_ITEMS_JSONL: input.itemsJsonlPath,
            },
        });
        if (result.error) {
            return `failed: ${result.error.message}`;
        }
        if (typeof result.status === "number" && result.status !== 0) {
            return `exit ${result.status}`;
        }
        return "completed";
    } catch (err) {
        return `failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
}

function maybeRunRelationReviewLlm(input: {
    command?: string;
    jobsPath: string;
    outputMdPath: string;
    outputJsonlPath: string;
    timeoutMs?: number;
}): string {
    const command = (input.command || "").trim();
    if (!command) return "skipped";
    const interpolated = command
        .replace(/\{jobs\}/g, input.jobsPath)
        .replace(/\{review_jobs\}/g, input.jobsPath)
        .replace(/\{output_md\}/g, input.outputMdPath)
        .replace(/\{output_jsonl\}/g, input.outputJsonlPath);
    try {
        const result = spawnSync(interpolated, {
            shell: true,
            encoding: "utf-8",
            timeout: input.timeoutMs ?? 30 * 60 * 1000,
            env: {
                ...process.env,
                V8_REL_REVIEW_JOBS: input.jobsPath,
                V8_REL_REVIEW_OUTPUT_MD: input.outputMdPath,
                V8_REL_REVIEW_OUTPUT_JSONL: input.outputJsonlPath,
            },
        });
        if (result.error) {
            return `failed: ${result.error.message}`;
        }
        if (typeof result.status === "number" && result.status !== 0) {
            return `exit ${result.status}`;
        }
        return "completed";
    } catch (err) {
        return `failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
}
