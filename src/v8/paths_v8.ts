import * as path from "node:path";
import { ensureDir, paths } from "../utils.js";

export interface V8StorePaths {
    rootDir: string;
    rawDir: string;
    runtimeDir: string;
    sessionsDir: string;
    units: string;
    evidenceSpans: string;
    memoryItems: string;
    graphNodes: string;
    graphEdges: string;
    ignitionNodes: string;
    ignitionEdges: string;
    recallBundles: string;
    hypothesisEdges: string;
    irLlmJobs: string;
    irLlmItems: string;
    irLlmItemsMd: string;
    summaryPacks: string;
    statePacks: string;
    packCache: string;
    feedbackRecords: string;
    feedbackOverrides: string;
    buildManifest: string;
    buildReport: string;
}

export function v8StorePaths(workspace: string): V8StorePaths {
    const base = paths(workspace);
    const rootDir = path.join(base.dotMemory, "graph");
    const rawDir = path.join(base.dotMemory, "raw");
    const runtimeDir = path.join(base.dotMemory, "runtime");
    const sessionsDir = path.join(rawDir, "sessions");
    return {
        rootDir,
        rawDir,
        runtimeDir,
        sessionsDir,
        units: path.join(rootDir, "units.jsonl"),
        evidenceSpans: path.join(rootDir, "evidence_spans.jsonl"),
        memoryItems: path.join(rootDir, "memory_items.jsonl"),
        graphNodes: path.join(rootDir, "graph_nodes.jsonl"),
        graphEdges: path.join(rootDir, "graph_edges.jsonl"),
        ignitionNodes: path.join(runtimeDir, "ignition_nodes.jsonl"),
        ignitionEdges: path.join(runtimeDir, "ignition_edges.jsonl"),
        recallBundles: path.join(runtimeDir, "recall_bundles.jsonl"),
        hypothesisEdges: path.join(runtimeDir, "hypothesis_edges.jsonl"),
        irLlmJobs: path.join(rootDir, "ir_llm_jobs.jsonl"),
        irLlmItems: path.join(rootDir, "ir_llm_items.jsonl"),
        irLlmItemsMd: path.join(rootDir, "ir_llm_items.md"),
        summaryPacks: path.join(rootDir, "summary_packs.jsonl"),
        statePacks: path.join(rootDir, "state_packs.jsonl"),
        packCache: path.join(rootDir, "pack_cache.jsonl"),
        feedbackRecords: path.join(runtimeDir, "feedback_records.jsonl"),
        feedbackOverrides: path.join(runtimeDir, "feedback_overrides.jsonl"),
        buildManifest: path.join(runtimeDir, "build_manifest.json"),
        buildReport: path.join(runtimeDir, "build_report.json"),
    };
}

export function ensureV8StoreDirs(workspace: string): V8StorePaths {
    const paths = v8StorePaths(workspace);
    ensureDir(paths.rootDir);
    ensureDir(paths.rawDir);
    ensureDir(paths.runtimeDir);
    ensureDir(paths.sessionsDir);
    return paths;
}
