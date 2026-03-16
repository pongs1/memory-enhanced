export type V8SourceClass = "raw" | "curated" | "legacy";

export type V8SourceType =
    | "session_trace"
    | "session_narrative"
    | "daily_log"
    | "knowledge_md"
    | "skill_md"
    | "event_jsonl";

export type V8NarrativeSourceCategory = "conversation" | "operation" | "unknown";

export type V8GraphLayer = "micro" | "meso" | "macro";

export type V8EdgeLayer = V8GraphLayer | "cross";

export type V8MemoryOriginType = "asserted" | "aggregated" | "inferred";

export type V8SceneSignalSource =
    | "control"
    | "prompt"
    | "tool"
    | "event"
    | "observation";

export type V8MicroNodeType =
    | "entity"
    | "concept"
    | "method"
    | "event"
    | "attribute"
    | "metric"
    | "claim"
    | "evidence"
    | "context"
    | "discourse_unit";

export type V8MesoNodeType =
    | "scene_block"
    | "situation_frame"
    | "objective_block"
    | "problem_block"
    | "strategy_block"
    | "procedure_block"
    | "interaction_block"
    | "decision_block"
    | "evidence_frame"
    | "shift_block"
    | "outcome_block"
    | "block_function";

export type V8MacroNodeType =
    | "arc"
    | "thread"
    | "phase"
    | "global_scene_type"
    | "regime"
    | "objective_line"
    | "conflict_line"
    | "relationship_arc"
    | "method_line"
    | "theme"
    | "pattern"
    | "turning_point"
    | "global_state";

export type V8MemoryControlNodeType =
    | "preference"
    | "goal"
    | "constraint"
    | "decision"
    | "open_question"
    | "conversation_act"
    | "session_state"
    | "topic_state";

export type V8StateOverlayNodeType =
    | "relationship_state"
    | "workflow_validity_state"
    | "compatibility_state"
    | "preference_state"
    | "belief_state"
    | "risk_state";

export type V8MemoryItemType =
    | V8MicroNodeType
    | V8MesoNodeType
    | V8MacroNodeType
    | V8MemoryControlNodeType
    | V8StateOverlayNodeType;

export type V8DiscourseRoleType =
    | "definition"
    | "background"
    | "event"
    | "cause"
    | "outcome"
    | "condition"
    | "purpose"
    | "evidence"
    | "comparison"
    | "contrast"
    | "opinion"
    | "recommendation"
    | "conclusion"
    | "procedure_steps"
    | "exception";

export type V8CoreEdgeType =
    | "is_a"
    | "instance_of"
    | "part_of"
    | "has_part"
    | "belongs_to"
    | "equivalent_to"
    | "performs"
    | "acts_on"
    | "uses"
    | "produces"
    | "targets"
    | "initiates"
    | "involves"
    | "occurs_at"
    | "results_in_event"
    | "causes"
    | "caused_by"
    | "enables"
    | "prevents"
    | "requires"
    | "conditioned_on"
    | "before"
    | "after"
    | "simultaneous_with"
    | "evolves_to"
    | "better_than"
    | "worse_than"
    | "similar_to"
    | "differs_from"
    | "supports"
    | "contradicts"
    | "cites";

export type V8ExtendedDiscourseEdgeType =
    | "elaborates"
    | "summarizes"
    | "contrasts"
    | "explains"
    | "concludes"
    | "recommends";

export type V8MesoEdgeType =
    | "grounded_in"
    | "oriented_to"
    | "focuses_on"
    | "realized_by"
    | "evidenced_by_block"
    | "functions_as"
    | "triggered_by"
    | "responds_to"
    | "constrained_by"
    | "attempts_to_resolve"
    | "escalates"
    | "mitigates"
    | "reframes"
    | "revises"
    | "culminates_in"
    | "leads_to"
    | "produces_shift"
    | "stabilizes"
    | "destabilizes"
    | "opens"
    | "closes"
    | "precedes_block"
    | "branches_to"
    | "merges_into"
    | "parallels"
    | "contrasts_with_block"
    | "echoes"
    | "sets_up"
    | "mirrors_locally";

export type V8MacroEdgeType =
    | "unfolds_through"
    | "spans_phase"
    | "organized_as"
    | "governed_by"
    | "centered_on_line"
    | "dominated_by"
    | "transitions_to_phase"
    | "evolves_to"
    | "branches_into"
    | "converges_with"
    | "interrupted_by"
    | "resumes_after"
    | "culminates_at"
    | "resolved_by"
    | "produces_state"
    | "shifts_regime"
    | "stabilizes_state"
    | "destabilizes_state"
    | "constrains"
    | "enables"
    | "competes_with"
    | "reinforces"
    | "undermines"
    | "mirrors"
    | "recurs_as"
    | "foreshadows"
    | "pays_off"
    | "recontextualizes"
    | "opens_arc"
    | "closes_arc";

export type V8MemoryStateEdgeType =
    | "supersedes"
    | "refines"
    | "scoped_to"
    | "valid_during"
    | "conflicts_with"
    | "asserted_by"
    | "evidenced_by";

export type V8EvidenceAnchorEdgeType =
    | "span_in_micro_unit"
    | "mention_maps_to_micro_node"
    | "micro_edge_evidenced_by_span"
    | "meso_block_evidenced_by_span_set"
    | "macro_node_evidenced_by_span_set"
    | "state_evidenced_by_block";

export type V8ContainmentEdgeType =
    | "micro_unit_in_meso_unit"
    | "micro_node_in_meso_block"
    | "micro_edge_in_meso_block"
    | "meso_unit_in_macro_unit"
    | "meso_block_in_phase"
    | "phase_in_arc";

export type V8AbstractionEdgeType =
    | "micro_fact_abstracted_as_block"
    | "micro_claim_summarized_by_block"
    | "block_instantiates_global_type"
    | "block_summarized_by_topic"
    | "block_contributes_to_pattern"
    | "line_summarized_by_theme";

export type V8LineBindingEdgeType =
    | "local_goal_in_objective_line"
    | "local_conflict_in_conflict_line"
    | "local_method_in_method_line"
    | "local_relationship_in_relationship_arc"
    | "local_event_in_thread"
    | "local_shift_to_turning_point";

export type V8ScopeAnchorEdgeType =
    | "state_valid_in_phase"
    | "state_valid_in_timewindow"
    | "block_scoped_to_regime"
    | "block_scoped_to_topicstate"
    | "thread_spans_timewindow"
    | "block_updates_global_state";

export type V8StateTransitionEdgeType =
    | "state_supersedes_state"
    | "state_refines_state"
    | "state_changed_by_event"
    | "state_opened_by_block"
    | "state_closed_by_block"
    | "state_invalidated_under_regime"
    | "state_reactivated_under_regime"
    | "correction_propagates_to_line";

export type V8ExtractionPredicate =
    | V8CoreEdgeType
    | V8ExtendedDiscourseEdgeType
    | V8MesoEdgeType
    | V8MacroEdgeType;

export type V8VerticalEdgeKind =
    | "evidence_anchor"
    | "containment"
    | "abstraction"
    | "line_binding"
    | "scope_anchor"
    | "change";

export type V8CrossLayerEdgeType =
    | V8EvidenceAnchorEdgeType
    | V8ContainmentEdgeType
    | V8AbstractionEdgeType
    | V8LineBindingEdgeType
    | V8ScopeAnchorEdgeType
    | V8StateTransitionEdgeType
    | "mention_maps_to_object"
    | "proposition_summarized_by_topic"
    | "topic_has_timewindow";

export type V8GraphPredicate =
    | V8ExtractionPredicate
    | V8MemoryStateEdgeType
    | V8CrossLayerEdgeType;

export type V8VerticalEdgeStrength = "hard" | "soft";

export interface V8EdgeCatalogEntry {
    type: V8GraphPredicate;
    layer: V8EdgeLayer;
    kind: "semantic" | "discourse" | V8VerticalEdgeKind | "memory_control";
    strength: V8VerticalEdgeStrength | null;
    requiresScope: boolean;
    stateful: boolean;
    description: string;
}

export type V8RecallMode = "profile" | "trajectory" | "oblique" | "audit";

export type V8EdgeRuntimeRole = "spread" | "gate" | "reweight" | "backtrace";

export interface V8EdgeRuntimePolicyEntry {
    kind: "semantic" | "discourse" | V8VerticalEdgeKind | "memory_control";
    mode: V8RecallMode;
    role: V8EdgeRuntimeRole;
    direction: "up" | "down" | "bidirectional" | "none";
    gain: number;
    notes?: string;
}

export interface V8NarrativeRecord {
    id: string;
    sourceClass: V8SourceClass;
    sourceType: V8SourceType;
    sourceRef: string;
    speaker: "user" | "assistant" | "system" | "unknown" | null;
    timestamp: string | null;
    rawText: string;
    cleanText?: string;
    cleanMap?: Array<{
        cleanStart: number;
        cleanEnd: number;
        rawStart: number;
        rawEnd: number;
    }>;
    language: "zh" | "en" | "mixed" | "unknown";
    metadata: Record<string, string>;
    legacyHints?: Record<string, string>;
}

export interface V8Unit {
    id: string;
    narrativeRecordId: string;
    narrativeRef: string;
    layer: V8GraphLayer;
    ordinal: number;
    charStart: number;
    charEnd: number;
    text: string;
    parentUnitId: string | null;
    language: "zh" | "en" | "mixed" | "unknown";
    speaker: "user" | "assistant" | "system" | "unknown" | null;
    timestamp: string | null;
    sourceCategory: V8NarrativeSourceCategory;
}

export interface V8EvidenceSpan {
    id: string;
    narrativeRecordId: string;
    narrativeRef: string;
    unitId: string;
    charStart: number;
    charEnd: number;
    text: string;
    speaker: "user" | "assistant" | "system" | "unknown" | null;
    timestamp: string | null;
    sourceClass: V8SourceClass;
    sourceType: V8SourceType;
    score: number;
}

export interface V8EdgeQualifiers {
    aspect?: string | null;
    time?: string | null;
    context?: string | null;
    polarity?: string | null;
    certainty?: string | null;
    evidenceUnitIds?: string[];
    [key: string]: string | number | boolean | null | string[] | undefined;
}

export interface V8MemoryItem {
    id: string;
    narrativeRecordId: string;
    sourceRef: string;
    itemType: V8MemoryItemType;
    originType: V8MemoryOriginType;
    layer: V8GraphLayer;
    subject: string;
    predicate: V8ExtractionPredicate | string;
    object: string;
    label: string;
    qualifiers: V8EdgeQualifiers;
    evidenceSpanIds: string[];
    unitIds: string[];
    confidence: number;
    scope: "global" | "topic" | "session" | "unknown";
    validity: "active" | "tentative" | "superseded" | "session_only";
    createdAt: string;
    updatedAt: string;
}

export interface V8GraphNode {
    id: string;
    memoryType: V8MemoryItemType;
    canonicalLabel: string;
    aliases: string[];
    primaryLayer: V8GraphLayer;
    layerMemberships: V8GraphLayer[];
    sourceItemIds: string[];
    evidenceSpanIds: string[];
    bestEvidenceSpanIds: string[];
    state: {
        scope: "global" | "topic" | "session" | "unknown";
        validity: "active" | "tentative" | "superseded" | "session_only";
        confidence: number;
        supportCount: number;
    };
}

export interface V8GraphEdge {
    id: string;
    type: V8GraphPredicate;
    src: string;
    dst: string;
    layer: V8EdgeLayer;
    originType: V8MemoryOriginType;
    sourceItemIds: string[];
    evidenceSpanIds: string[];
    qualifiers: V8EdgeQualifiers;
    confidence: number;
    state: {
        scope: "global" | "topic" | "session" | "unknown";
        validity: "active" | "tentative" | "superseded" | "session_only";
    };
}

export interface V8HypothesisEdge {
    id: string;
    src: string;
    dst: string;
    suggestedType: V8GraphPredicate | string;
    modeHint: "oblique" | "trajectory";
    supportEvidenceSpanIds: string[];
    inferenceTrace: string;
    confidence: number;
    status: "candidate" | "validated" | "rejected" | "expired";
    expiresAt: string | null;
}

export interface V8IgnitionNodeProjection {
    nodeId: string;
    bundleId: string;
    bundleIds?: string[];
    kind: "episodic" | "semantic" | "procedural";
    names: { zh: string; en: string };
    aliases: string[];
    triggerTerms: string[];
    summary: string;
    searchText: string;
    sourceRef: string | null;
    evidenceSpanIds: string[];
    bestEvidenceSpanIds: string[];
    dayKey: string | null;
}

export interface V8IgnitionEdgeProjection {
    edgeId: string;
    type: V8GraphPredicate;
    srcNodeId: string;
    dstNodeId: string;
    family: "associative" | "structural" | "supersession";
    score: number;
}

export interface V8RecallBundleProjection {
    bundleId: string;
    title: string;
    kind: "episodic" | "semantic" | "procedural";
    nodeIds: string[];
    sourceRefs: string[];
    evidenceSpanIds: string[];
    bestEvidenceSpanIds: string[];
    summaryText: string;
    packType: "raw_evidence" | "summary" | "state" | "mixed";
}

export interface V8SummaryPack {
    id: string;
    packType: "profile" | "project" | "topic" | "workflow";
    title: string;
    text: string;
    sourceItemIds: string[];
    evidenceSpanIds: string[];
    updatedAt: string;
}

export interface V8StatePack {
    id: string;
    stateType: "active_branch" | "constraints" | "open_questions" | "conflicts";
    slots: Record<string, string>;
    sourceItemIds: string[];
    evidenceSpanIds: string[];
    updatedAt: string;
}

export interface V8PackCacheRecord {
    id: string;
    packType: "summary" | "state";
    fingerprint: string;
    text: string;
    sourceItemIds: string[];
    evidenceSpanIds: string[];
    strengthScore: number;
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string | null;
    retentionPolicy: "default_7d" | "pinned";
    pinReason?: "user" | "llm" | "system";
}

export type V8RelationSearchScope = "local_active" | "global_archive";

export type V8RelationSearchMode = "bm25" | "vector" | "hybrid";

export type V8HintSource =
    | "type_prior"
    | "history"
    | "coanchor"
    | "active_mode"
    | "novelty"
    | "feedback";

export type V8SearchLane = "focused" | "broadened" | "exploratory";

export interface V8ScoredHint {
    id: string;
    score: number;
    source: V8HintSource;
    label?: string;
}

export interface V8EntityPosting {
    id: string;
    entityNodeId: string;
    canonicalLabel: string;
    alias: string;
    shardId: string;
    bundleIds: string[];
    dayKey: string | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
    hitCount: number;
}

export interface V8EntityScopeCard {
    id: string;
    entityNodeId: string;
    canonicalLabel: string;
    aliases: string[];
    entityKind: string;
    shardHints: V8ScoredHint[];
    coanchorHints: V8ScoredHint[];
    stateHints: V8ScoredHint[];
    topicHints: V8ScoredHint[];
    edgeFamilyHints: V8ScoredHint[];
    updatedAt: string;
}

export interface V8GroupSummary {
    id: string;
    title: string;
    summaryText: string;
    nodeIds: string[];
    bundleIds: string[];
    evidenceSpanIds: string[];
    updatedAt: string;
}

export interface V8RelationSearchPlan {
    id: string;
    anchorNodeIds: string[];
    anchorLabels: string[];
    anchorKinds: string[];
    edgeFamilyHints: V8ScoredHint[];
    recallMode: V8RecallMode;
    searchScope: V8RelationSearchScope;
    searchMode: V8RelationSearchMode;
    lane: V8SearchLane;
    queryTerms: string[];
    hintBundleIds: string[];
    hintSpanIds: string[];
    scopeCardIds: string[];
    createdAt: string;
}

export interface V8NarrativeShardSelection {
    id: string;
    planId: string;
    lane: V8SearchLane;
    selectedShardHints: V8ScoredHint[];
    droppedShardIds: string[];
    createdAt: string;
}

export interface V8RelationCandidateHit {
    id: string;
    planId: string;
    candidateEdgeType: string;
    spanId: string;
    unitId: string;
    narrativeRef: string;
    score: number;
    spanText: string;
    createdAt: string;
}

export interface V8RelationReviewJob {
    id: string;
    planId: string;
    anchorNodeIds: string[];
    candidateNodeIds: string[];
    candidateEdgeTypes: string[];
    candidateHitIds: string[];
    evidenceSpanIds: string[];
    bundleIds: string[];
    reviewQuestion: string;
    modeHint: V8RecallMode;
    status: "pending" | "completed" | "failed";
    createdAt: string;
}

export interface V8ReviewedRelation {
    id: string;
    reviewJobId: string;
    srcNodeId: string;
    dstNodeId: string;
    edgeType: string;
    status: "accepted" | "hypothesis" | "rejected";
    supportEvidenceSpanIds: string[];
    confidence: number;
    rationale: string;
    createdAt: string;
}

export type V8LearningSubsystem = "retrieval" | "fact" | "recall";

export type V8LearningEventType =
    | "retrieval_hit_confirmed"
    | "retrieval_hit_rejected"
    | "review_relation_accepted"
    | "review_relation_rejected"
    | "recall_bundle_helpful"
    | "recall_bundle_wrong"
    | "user_corrected_memory"
    | "llm_reported_missing_history";

export interface V8LearningEvent {
    id: string;
    subsystem: V8LearningSubsystem;
    eventType: V8LearningEventType;
    subjectIds: string[];
    polarity: "positive" | "negative" | "neutral";
    features: Record<string, string | number | boolean | null>;
    createdAt: string;
}

export interface V8SearchFeedbackSignal {
    id: string;
    anchorNodeIds: string[];
    lane: V8SearchLane;
    hintIds: string[];
    outcome: "confirmed" | "rejected" | "ignored";
    scoreDelta: number;
    createdAt: string;
}

export interface V8ControlAnchors {
    goal: string;
    activeTask: string;
    latestUserRequest: string;
}

export interface V8SceneSignal {
    source: V8SceneSignalSource;
    text: string;
    weight?: number;
}

export interface V8ScannerConfig {
    microCharsZh: number;
    microCharsEn: number;
    mesoCharsZh: number;
    mesoCharsEn: number;
    macroCharsZh: number;
    macroCharsEn: number;
    scanIntervalChars: number;
    maxInjectedBundles: number;
    forwardGain: number;
    reverseGain: number;
    decayLambda: number;
    hubPenaltyPower: number;
    topKEdges: number;
    nodeCooldownMs: number;
    bundleCooldownMs: number;
    criticalThreshold: number;
    decisionThreshold: number;
    backgroundThreshold: number;
    secondWaveThreshold: number;
    sceneSignalGain: number;
    sceneCarryGain: number;
    sceneBundleBiasGain: number;
    sceneDecayLambda: number;
    sceneTopKNodes: number;
    sceneOverlapThreshold: number;
    groupTriggerScoreThreshold: number;
    groupAllowSemanticFallback: boolean;
    groupEnergyGain: number;
}

export interface V8FeedbackConfig {
    modelAdoptionThresholdZh: number;
    modelAdoptionThresholdEn: number;
    toolAdoptionThresholdZh: number;
    toolAdoptionThresholdEn: number;
}

export interface V8ActivatedBundle {
    bundleId: string;
    nodeIds: string[];
    tier: "critical" | "decision" | "background";
    energy: number;
    evidenceSpanIds: string[];
    sourceRefs?: string[];
    wave?: 1 | 2;
    diagnostics?: {
        triggerScore?: number;
        coverage?: number;
        jaccard?: number;
        irSimilarity?: number;
    };
}

export interface V8ScanResult {
    activatedBundles: V8ActivatedBundle[];
    recentWindow: string;
}

export interface AssembleRecallInput {
    workspace: string;
    bundles: V8ActivatedBundle[];
    goal: string;
    activeTask: string;
    latestUserRequest: string;
    mode?: V8RecallMode;
    packCacheTtlDays?: number;
}

export interface AssembleRecallOutput {
    bundleId: string;
    nodeIds: string[];
    tier: V8ActivatedBundle["tier"];
    prompt: string;
    sourceRefs: string[];
}

export interface V8RecallRequest {
    query: string;
    mode?: V8RecallMode;
    phaseId?: string;
    timeWindowId?: string;
    topicStateId?: string;
    maxPacks?: number;
}

export interface V8RuntimeEdgeKindPolicy {
    kind: "semantic" | "discourse" | V8VerticalEdgeKind | "memory_control";
    mode: V8RecallMode;
    role: V8EdgeRuntimeRole;
    direction: "up" | "down" | "bidirectional" | "none";
    gain: number;
    notes?: string;
}

export interface V8RecallAssembly {
    id: string;
    request: V8RecallRequest;
    bundleIds: string[];
    summaryPackIds: string[];
    statePackIds: string[];
    rawEvidenceSpanIds: string[];
    createdAt: string;
}

export interface V8GraphManifest {
    schemaVersion: number;
    compilerVersion: string;
    migrationMode: "compat" | "hybrid" | "ir_first";
    storageFormat: "jsonl";
    createdAt: string;
    updatedAt: string;
    lastFullRebuildAt: string | null;
}
