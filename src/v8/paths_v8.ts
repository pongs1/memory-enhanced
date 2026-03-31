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
    irLlmPending: string;
    irLlmUnitCache: string;
    entityPostings: string;
    entityScopeCards: string;
    groupSummaries: string;
    relationSearchPlans: string;
    verticalTriggerCards: string;
    narrativeShardSelections: string;
    relationCandidateHits: string;
    relationReviewJobs: string;
    relationReviewJobsMd: string;
    reviewedRelations: string;
    reviewedRelationsMd: string;
    summaryPacks: string;
    statePacks: string;
    packCache: string;
    feedbackRecords: string;
    feedbackOverrides: string;
    buildManifest: string;
    narrativeCompileState: string;
    sourceSyncState: string;
    learningEvents: string;
    searchFeedbackSignals: string;
    buildReport: string;
    buildReportMd: string;
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
        irLlmPending: path.join(rootDir, "ir_llm_pending.jsonl"),
        irLlmUnitCache: path.join(rootDir, "ir_llm_unit_cache.jsonl"),
        entityPostings: path.join(rootDir, "entity_postings.jsonl"),
        entityScopeCards: path.join(rootDir, "entity_scope_cards.jsonl"),
        groupSummaries: path.join(rootDir, "group_summaries.jsonl"),
        relationSearchPlans: path.join(runtimeDir, "relation_search_plans.jsonl"),
        verticalTriggerCards: path.join(runtimeDir, "vertical_trigger_cards.jsonl"),
        narrativeShardSelections: path.join(runtimeDir, "narrative_shard_selections.jsonl"),
        relationCandidateHits: path.join(runtimeDir, "relation_candidate_hits.jsonl"),
        relationReviewJobs: path.join(runtimeDir, "relation_review_jobs.jsonl"),
        relationReviewJobsMd: path.join(runtimeDir, "relation_review_jobs.md"),
        reviewedRelations: path.join(rootDir, "reviewed_relations.jsonl"),
        reviewedRelationsMd: path.join(rootDir, "reviewed_relations.md"),
        summaryPacks: path.join(rootDir, "summary_packs.jsonl"),
        statePacks: path.join(rootDir, "state_packs.jsonl"),
        packCache: path.join(rootDir, "pack_cache.jsonl"),
        feedbackRecords: path.join(runtimeDir, "feedback_records.jsonl"),
        feedbackOverrides: path.join(runtimeDir, "feedback_overrides.jsonl"),
        buildManifest: path.join(runtimeDir, "build_manifest.json"),
        narrativeCompileState: path.join(runtimeDir, "narrative_compile_state.json"),
        sourceSyncState: path.join(runtimeDir, "source_sync_state.json"),
        learningEvents: path.join(runtimeDir, "learning_events.jsonl"),
        searchFeedbackSignals: path.join(runtimeDir, "search_feedback_signals.jsonl"),
        buildReport: path.join(runtimeDir, "build_report.json"),
        buildReportMd: path.join(runtimeDir, "build_report.md"),
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
