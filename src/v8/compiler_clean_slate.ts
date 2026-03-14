import { resolveWorkspace } from "../utils.js";
import { ensureV8StoreDirs } from "./paths_v8.js";
import { loadSessionTraces } from "./adapters/session-source.js";
import { normalizeSessionMessages } from "./architecture/source-normalizer.js";
import { unitizeSourceRecords } from "./architecture/unitizer.js";
import { extractEvidenceSpans } from "./architecture/evidence.js";
import { extractMemoryItems } from "./architecture/ir-extractor.js";
import { buildLlmIrJobs, loadLlmIrItems, writeIrLlmJobs } from "./architecture/ir-llm.js";
import { materializeGraph } from "./architecture/graph-materializer.js";
import { buildRuntimeProjections } from "./architecture/runtime-projection.js";
import { writeJsonl } from "./architecture/io.js";
import { spawnSync } from "node:child_process";

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

    const sourceRecords = traceGroups.flatMap((group) =>
        normalizeSessionMessages(group.messages, {
            sourceRefPrefix: group.sourceRefPrefix,
        })
    );

    const units = unitizeSourceRecords(sourceRecords);
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
        nodes,
        edges,
        ignitionNodes: projections.ignitionNodes,
        ignitionEdges: projections.ignitionEdges,
        recallBundles: projections.recallBundles,
    };
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
