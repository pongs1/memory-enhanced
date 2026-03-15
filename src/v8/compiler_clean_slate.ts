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
import { checkToolCatalogAgainstRules } from "./architecture/tool-catalog-check.js";
import {
    buildNarrativeRecordFromMarkdown,
    loadNarrativeRecords,
    sortNarrativeRecords,
} from "./architecture/narrative-source.js";
import { unitizeNarrativeRecordsParallel } from "./architecture/unitizer.js";
import { extractEvidenceSpans } from "./architecture/evidence.js";
import { extractMemoryItems } from "./architecture/ir-extractor.js";
import { buildLlmIrJobs, loadLlmIrItems, writeIrLlmJobs } from "./architecture/ir-llm.js";
import { materializeGraph } from "./architecture/graph-materializer.js";
import { buildRuntimeProjections } from "./architecture/runtime-projection.js";
import { readJsonl, writeJsonl } from "./architecture/io.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
    V8EvidenceSpan,
    V8GraphEdge,
    V8GraphNode,
    V8IgnitionEdgeProjection,
    V8IgnitionNodeProjection,
    V8MemoryItem,
    V8NarrativeRecord,
    V8RecallBundleProjection,
    V8Unit,
} from "./types_v8.js";

export interface CleanSlateBuildOptions {
    workspace?: string;
    sessionTraceDir?: string;
    maxSessionFiles?: number;
    llmCommand?: string;
    llmCommandTimeoutMs?: number;
    startAt?: "source" | "narrative";
    stopAfter?: "evidence" | "memory_ir";
    maxNarrativeDocs?: number;
    emitUnitPreview?: boolean;
    workerCount?: number;
    ruleIrMode?: "off" | "micro_light";
    rebuildMode?: "full" | "incremental" | "hybrid";
    hotWindowHours?: number;
    planOnly?: boolean;
}

// DEV marker: remove this temporary fast-build default before release hardening.
const DEV_FAST_BUILD_MARKER = "TODO_REMOVE_BEFORE_RELEASE__V8_FAST_BUILD_DEFAULTS";
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

    const toolCleaningProfiles = loadResolvedToolCleaningProfiles(workspace);
    const toolCatalogCheck = checkToolCatalogAgainstRules({
        workspace,
        profiles: toolCleaningProfiles,
    });
    logStage("tool catalog loaded");

    const startAt = options?.startAt ?? (options?.planOnly ? "narrative" : "source");
    let sourceNarrativeDocs: V8NarrativeRecord[] | null = null;
    let sourcePersistStats: { writtenFiles: number; skippedFiles: number } | null = null;
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
            const baseRecords = normalizeSessionMessages(group.messages, {
                sourceRefPrefix: group.sourceRefPrefix,
                workspace,
                toolCleaningProfiles,
            });
            traceNarrativeRecords.push(...baseRecords);

            const parentSessionId = deriveSessionIdFromSourceRef(group.sourceRefPrefix);
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
        const persistResult = persistAssembledObservationMarkdown(store.rawDir, traceRecords);
        sourceNarrativeDocs = persistResult.docs;
        sourcePersistStats = {
            writtenFiles: persistResult.writtenFiles,
            skippedFiles: persistResult.skippedFiles,
        };
        logStage("source normalization persisted");
    }

    const loadedNarrativeDocs =
        startAt === "source" && sourceNarrativeDocs
            ? sourceNarrativeDocs
            : loadNarrativeRecords(store.rawDir);
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

    const rebuildMode = options?.rebuildMode ?? "hybrid";
    const hotWindowHours = Math.max(1, options?.hotWindowHours ?? DEFAULT_HOT_WINDOW_HOURS);
    const manifest = loadBuildManifest(store.buildManifest);
    const scope = computeBuildScope({
        narratives: allNarrativeDocs,
        manifest,
        mode: rebuildMode,
        hotWindowHours,
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
    const hotBuildIsNoop =
        hotNarratives.length === 0 &&
        scope.removedDocIds.size === 0 &&
        hasReusableArtifacts(store);
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

    const hotUnits = await unitizeNarrativeRecordsParallel(
        hotNarratives,
        undefined,
        options?.workerCount ?? 1
    );
    const units = [...cached.units, ...hotUnits];
    logStage(`units built hot=${hotUnits.length} total=${units.length}`);
    if (options?.emitUnitPreview !== false) {
        persistNarrativeUnitPreview(store.rawDir, units, allNarrativeDocs);
        logStage("unit preview written");
    }
    const hotEvidenceSpans = extractEvidenceSpans(hotUnits, hotNarratives);
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

    const llmJobs = buildLlmIrJobs(hotUnits, hotEvidenceSpans);
    logStage(`llm jobs built hot=${llmJobs.length}`);
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
            : "skipped(no_hot_jobs)";
    logStage(`llm step finished (${llmStatus})`);
    const llmItems = loadLlmIrItems(
        { mdPath: store.irLlmItemsMd, jsonlPath: store.irLlmItems },
        hotUnits,
        hotEvidenceSpans
    );
    const ruleIrMode = options?.ruleIrMode ?? "off";
    const ruleItems =
        ruleIrMode === "micro_light"
            ? extractMemoryItems(hotUnits, hotEvidenceSpans)
            : [];
    const hotMemoryItems = [...ruleItems, ...llmItems];
    const memoryItems = [...cached.memoryItems, ...hotMemoryItems];
    logStage(
        `memory items extracted hot(rule=${ruleItems.length}, llm=${llmItems.length}) total=${memoryItems.length}`
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
        ]);
        logStage("memory_ir persisted");
        if (!isPartialBuild) {
            persistBuildManifest(store.buildManifest, loadedNarrativeDocs);
        }
        persistRunReport({
            llmStatus,
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
            llmStatus,
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
    const { nodes, edges } = materializeGraph(memoryItems, units, evidenceSpans);
    logStage(`graph materialized (nodes=${nodes.length} edges=${edges.length})`);
    const projections = buildRuntimeProjections({
        nodes,
        edges,
        evidenceSpans,
    });
    logStage("runtime projections built");
    writeJsonl(store.units, units);
    writeJsonl(store.evidenceSpans, evidenceSpans);
    writeJsonl(store.memoryItems, memoryItems);
    writeJsonl(store.graphNodes, nodes);
    writeJsonl(store.graphEdges, edges);
    writeJsonl(store.ignitionNodes, projections.ignitionNodes);
    writeJsonl(store.ignitionEdges, projections.ignitionEdges);
    writeJsonl(store.recallBundles, projections.recallBundles);
    if (!isPartialBuild) {
        persistBuildManifest(store.buildManifest, loadedNarrativeDocs);
    }
    persistRunReport({
        llmStatus,
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
        llmStatus,
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
        `- sourceNarrativeWrites: written=${report.buildStats.sourceNarrativeWrittenFiles}, skippedUnchanged=${report.buildStats.sourceNarrativeSkippedFiles}`
    );
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
    mode: "full" | "incremental" | "hybrid";
    hotWindowHours: number;
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

    const hotCutoff =
        input.mode === "hybrid"
            ? Date.now() - input.hotWindowHours * 60 * 60 * 1000
            : Number.NEGATIVE_INFINITY;

    for (const narrative of input.narratives) {
        const previous = input.manifest.docs[narrative.id];
        const hash = hashNarrative(narrative);
        const changed =
            !previous ||
            previous.hash !== hash ||
            previous.sourceRef !== narrative.sourceRef;
        const recent =
            input.mode === "hybrid"
                ? resolveNarrativeSortTimestamp(narrative) >= hotCutoff
                : false;
        if (changed || recent) {
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

function resolveNarrativeSortTimestamp(narrative: V8NarrativeRecord): number {
    const timelineStart = narrative.metadata?.timelineStart;
    if (timelineStart) {
        const parsed = Date.parse(timelineStart.includes("T") ? timelineStart : timelineStart.replace(" ", "T"));
        if (!Number.isNaN(parsed)) return parsed;
    }
    const byMtime = safeStatMtime(narrative.sourceRef);
    return typeof byMtime === "number" ? byMtime : 0;
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
        fs.existsSync(store.recallBundles)
    );
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

function persistAssembledObservationMarkdown(
    rawDir: string,
    records: V8NarrativeRecord[]
): { docs: V8NarrativeRecord[]; writtenFiles: number; skippedFiles: number } {
    if (!records.length) {
        return { docs: [], writtenFiles: 0, skippedFiles: 0 };
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
): { docs: V8NarrativeRecord[]; writtenFiles: number; skippedFiles: number } {
    const sessions = new Map<string, NarrativeEntry[]>();
    const docs: V8NarrativeRecord[] = [];
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
        const doc = buildNarrativeRecordFromMarkdown({
            sourceRef: fullPath,
            content: markdown,
            fileNameHint: fileName,
            sessionId,
        });
        docs.push(doc);
        const wrote = writeFileIfChanged(fullPath, markdown);
        if (wrote) writtenFiles += 1;
        else skippedFiles += 1;
    }
    return {
        docs: sortNarrativeRecords(docs),
        writtenFiles,
        skippedFiles,
    };
}

function writeFileIfChanged(filePath: string, content: string): boolean {
    try {
        const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
        if (current === content) return false;
        fs.writeFileSync(filePath, content, "utf-8");
        return true;
    } catch {
        // ignore write failures to keep consolidation moving
        return false;
    }
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
