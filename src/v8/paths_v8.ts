import * as path from "node:path";
import { ensureDir, paths } from "../utils.js";

export interface V8StorePaths {
    rootDir: string;
    rawDir: string;
    runtimeDir: string;
    sessionsDir: string;
    sourceRecords: string;
    units: string;
    evidenceSpans: string;
    memoryItems: string;
    graphNodes: string;
    graphEdges: string;
    ignitionNodes: string;
    ignitionEdges: string;
    recallBundles: string;
    summaryPacks: string;
    statePacks: string;
    packCache: string;
    feedbackRecords: string;
    feedbackOverrides: string;
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
        sourceRecords: path.join(rootDir, "source_records.jsonl"),
        units: path.join(rootDir, "units.jsonl"),
        evidenceSpans: path.join(rootDir, "evidence_spans.jsonl"),
        memoryItems: path.join(rootDir, "memory_items.jsonl"),
        graphNodes: path.join(rootDir, "graph_nodes.jsonl"),
        graphEdges: path.join(rootDir, "graph_edges.jsonl"),
        ignitionNodes: path.join(runtimeDir, "ignition_nodes.jsonl"),
        ignitionEdges: path.join(runtimeDir, "ignition_edges.jsonl"),
        recallBundles: path.join(runtimeDir, "recall_bundles.jsonl"),
        summaryPacks: path.join(rootDir, "summary_packs.jsonl"),
        statePacks: path.join(rootDir, "state_packs.jsonl"),
        packCache: path.join(rootDir, "pack_cache.jsonl"),
        feedbackRecords: path.join(runtimeDir, "feedback_records.jsonl"),
        feedbackOverrides: path.join(runtimeDir, "feedback_overrides.jsonl"),
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
