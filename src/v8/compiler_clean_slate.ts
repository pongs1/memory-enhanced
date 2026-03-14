import { resolveWorkspace } from "../utils.js";
import { ensureV8StoreDirs } from "./paths_v8.js";
import { loadSessionTraces } from "./adapters/session-source.js";
import { normalizeSessionMessages } from "./architecture/source-normalizer.js";
import { loadResolvedToolCleaningProfiles } from "./architecture/tool-cleaning-profiles.js";
import { checkToolCatalogAgainstRules } from "./architecture/tool-catalog-check.js";
import { loadNarrativeSourceRecords } from "./architecture/narrative-source.js";
import { unitizeSourceRecords } from "./architecture/unitizer.js";
import { extractEvidenceSpans } from "./architecture/evidence.js";
import { extractMemoryItems } from "./architecture/ir-extractor.js";
import { buildLlmIrJobs, loadLlmIrItems, writeIrLlmJobs } from "./architecture/ir-llm.js";
import { materializeGraph } from "./architecture/graph-materializer.js";
import { buildRuntimeProjections } from "./architecture/runtime-projection.js";
import { writeJsonl } from "./architecture/io.js";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { V8SourceRecord, V8Unit } from "./types_v8.js";

export interface CleanSlateBuildOptions {
    workspace?: string;
    sessionTraceDir?: string;
    maxSessionFiles?: number;
    llmCommand?: string;
    llmCommandTimeoutMs?: number;
}

export function buildCleanSlateGraph(options?: CleanSlateBuildOptions) {
    const workspace = resolveWorkspace(options?.workspace);
    const store = ensureV8StoreDirs(workspace);

    const traceGroups = loadSessionTraces(workspace, {
        sessionTraceDir: options?.sessionTraceDir,
        maxFiles: options?.maxSessionFiles,
    });
    const toolCleaningProfiles = loadResolvedToolCleaningProfiles(workspace);
    const toolCatalogCheck = checkToolCatalogAgainstRules({
        workspace,
        profiles: toolCleaningProfiles,
    });

    const traceSourceRecords = traceGroups.flatMap((group) =>
        normalizeSessionMessages(group.messages, {
            sourceRefPrefix: group.sourceRefPrefix,
            workspace,
            toolCleaningProfiles,
        })
    );
    persistAssembledObservationMarkdown(store.rawDir, traceSourceRecords);

    const narrativeSourceRecords = loadNarrativeSourceRecords(store.rawDir);
    const sourceRecords = mergeNarrativeCoverage(
        narrativeSourceRecords,
        traceSourceRecords
    );
    const units = unitizeSourceRecords(sourceRecords);
    persistNarrativeUnitPreview(store.rawDir, units, sourceRecords);
    const evidenceSpans = extractEvidenceSpans(units, sourceRecords);
    const llmJobs = buildLlmIrJobs(units, evidenceSpans, sourceRecords);
    writeIrLlmJobs(store.irLlmJobs, llmJobs);
    const llmStatus = maybeRunIrLlm({
        command: options?.llmCommand,
        jobsPath: store.irLlmJobs,
        itemsMdPath: store.irLlmItemsMd,
        itemsJsonlPath: store.irLlmItems,
        timeoutMs: options?.llmCommandTimeoutMs,
    });
    const llmItems = loadLlmIrItems(
        { mdPath: store.irLlmItemsMd, jsonlPath: store.irLlmItems },
        units,
        evidenceSpans,
        sourceRecords
    );
    const ruleItems = extractMemoryItems(sourceRecords, units, evidenceSpans);
    const memoryItems = [...ruleItems, ...llmItems];
    const { nodes, edges } = materializeGraph(memoryItems, units, evidenceSpans);
    const projections = buildRuntimeProjections({
        nodes,
        edges,
        evidenceSpans,
        sources: sourceRecords,
    });

    writeJsonl(store.sourceRecords, sourceRecords);
    writeJsonl(store.units, units);
    writeJsonl(store.evidenceSpans, evidenceSpans);
    writeJsonl(store.memoryItems, memoryItems);
    writeJsonl(store.graphNodes, nodes);
    writeJsonl(store.graphEdges, edges);
    writeJsonl(store.ignitionNodes, projections.ignitionNodes);
    writeJsonl(store.ignitionEdges, projections.ignitionEdges);
    writeJsonl(store.recallBundles, projections.recallBundles);

    return {
        sourceRecords,
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
    };
}

function persistAssembledObservationMarkdown(rawDir: string, records: V8SourceRecord[]): void {
    if (!records.length) return;
    const outDir = path.join(rawDir, "observations", "assembled");
    fs.mkdirSync(outDir, { recursive: true });
    persistOperationMarkdown(outDir, records);
    persistSessionNarratives(outDir, records);
}

function mergeNarrativeCoverage(
    narrativeRecords: V8SourceRecord[],
    traceRecords: V8SourceRecord[]
): V8SourceRecord[] {
    if (!traceRecords.length) return narrativeRecords;
    if (!narrativeRecords.length) {
        return traceRecords.map((record, idx) =>
            convertTraceToNarrative(record, idx + 1)
        );
    }

    const merged = [...narrativeRecords];
    const seen = new Set<string>();
    for (const record of narrativeRecords) {
        const key = buildCoverageKey(record);
        if (key) seen.add(key);
    }

    const extraIndexBySession = new Map<string, number>();
    for (const record of traceRecords) {
        const key = buildCoverageKey(record);
        if (!key || seen.has(key)) continue;
        const sessionId = record.metadata?.sessionId || "default";
        const nextIndex = (extraIndexBySession.get(sessionId) ?? 0) + 1;
        extraIndexBySession.set(sessionId, nextIndex);
        merged.push(convertTraceToNarrative(record, nextIndex));
        seen.add(key);
    }

    return merged;
}

function buildCoverageKey(record: V8SourceRecord): string | null {
    const sessionId = record.metadata?.sessionId || "default";
    const sourceCategory =
        record.metadata?.sourceCategory || inferSourceCategory(record);
    const sourceIndex =
        record.metadata?.sourceIndex || extractSourceIndexFromRef(record.sourceRef);
    if (sourceIndex) return `${sessionId}:${sourceCategory}:${sourceIndex}`;
    if (record.sourceRef) return `${sessionId}:${sourceCategory}:${record.sourceRef}`;
    return null;
}

function convertTraceToNarrative(
    record: V8SourceRecord,
    ordinal: number
): V8SourceRecord {
    const sessionId = record.metadata?.sessionId || "default";
    const sourceCategory =
        record.metadata?.sourceCategory || inferSourceCategory(record);
    const sourceIndex =
        record.metadata?.sourceIndex || extractSourceIndexFromRef(record.sourceRef);
    const id = `src_${sessionId}_narr_x${ordinal}`;
    const rawText = record.cleanText || record.rawText || "";
    const metadata: Record<string, string> = {
        sessionId,
        sourceRef: record.sourceRef,
        sourceCategory,
        narrativeLabel: sourceIndex
            ? sourceCategory === "operation"
                ? `op-${sourceIndex}`
                : `#${sourceIndex}`
            : "",
        narrativeSpeaker: record.speaker || "unknown",
        mergedFrom: "session_trace",
    };
    if (sourceIndex) {
        metadata.sourceIndex = sourceIndex;
    }

    return {
        id,
        sourceClass: "curated",
        sourceType: "session_narrative",
        sourceRef: record.sourceRef,
        speaker: record.speaker,
        timestamp: record.timestamp,
        rawText,
        cleanText: rawText,
        cleanMap: record.cleanMap || [],
        language: record.language,
        metadata,
    };
}

function extractSourceIndexFromRef(sourceRef: string): string | undefined {
    if (!sourceRef) return undefined;
    const opMatch = sourceRef.match(/#op-(\d+)/);
    if (opMatch) return opMatch[1];
    const msgMatch = sourceRef.match(/#(\d+)/);
    if (msgMatch) return msgMatch[1];
    return undefined;
}

function inferSourceCategory(record: V8SourceRecord): "conversation" | "operation" {
    const ref = record.sourceRef || "";
    if (ref.includes("#op-")) return "operation";
    const label = record.metadata?.narrativeLabel || "";
    if (label.toLowerCase().includes("op-")) return "operation";
    return "conversation";
}

function sanitizeFileName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function persistOperationMarkdown(outDir: string, records: V8SourceRecord[]): void {
    for (const record of records) {
        if (record.metadata?.sourceCategory !== "operation") continue;
        const toolCallId = record.metadata?.toolCallId;
        const base = toolCallId ? `op_${toolCallId}` : `op_${record.id}`;
        const fileName = sanitizeFileName(base) + ".md";
        try {
            fs.writeFileSync(path.join(outDir, fileName), record.rawText || "", "utf-8");
        } catch {
            // ignore write failures to keep consolidation moving
        }
    }
}

interface NarrativeEntry {
    sessionId: string;
    sourceRef: string;
    sourceCategory: string;
    speaker: V8SourceRecord["speaker"];
    timestamp: string | null;
    text: string;
    toolName?: string;
    sourceIndex?: number | null;
}

function persistSessionNarratives(outDir: string, records: V8SourceRecord[]): void {
    const sessions = new Map<string, NarrativeEntry[]>();
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
        try {
            fs.writeFileSync(path.join(outDir, fileName), markdown, "utf-8");
        } catch {
            // ignore write failures to keep consolidation moving
        }
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
    lines.push(`Session: \`${sessionId}\``);
    lines.push("");
    lines.push("## Timeline");
    lines.push("");
    for (const entry of entries) {
        const label = buildEntryLabel(entry);
        const speakerLabel = formatSpeakerLabel(entry);
        const header = label ? `### [${label}] ${speakerLabel}` : `### ${speakerLabel}`;
        lines.push(header.trim());
        lines.push(entry.text);
        lines.push("");
    }
    return lines.join("\n").trim() + "\n";
}

function persistNarrativeUnitPreview(
    rawDir: string,
    units: V8Unit[],
    sources: V8SourceRecord[]
): void {
    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const sessions = new Map<
        string,
        Map<string, { source: V8SourceRecord; units: V8Unit[] }>
    >();

    for (const unit of units) {
        const source = sourcesById.get(unit.sourceRecordId);
        if (!source || source.sourceType !== "session_narrative") continue;
        const sessionId = source.metadata?.sessionId || "default";
        const sessionBucket =
            sessions.get(sessionId) ||
            new Map<string, { source: V8SourceRecord; units: V8Unit[] }>();
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

function buildEntryLabel(entry: NarrativeEntry): string | null {
    const parts: string[] = [];
    const refLabel = buildSourceLabel(entry);
    if (refLabel) parts.push(refLabel);
    const shortTs = formatTimestampShort(entry.timestamp);
    if (shortTs) parts.push(shortTs);
    return parts.length ? parts.join(" | ") : null;
}

function buildSourceLabel(entry: NarrativeEntry): string | null {
    if (entry.sourceRef) {
        const opMatch = entry.sourceRef.match(/#op-(\d+)/);
        if (opMatch) return `op-${opMatch[1]}`;
        const msgMatch = entry.sourceRef.match(/#(\d+)/);
        if (msgMatch) return `#${msgMatch[1]}`;
    }
    if (typeof entry.sourceIndex === "number") {
        return `#${entry.sourceIndex}`;
    }
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
