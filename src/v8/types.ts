import type { MemoryEvent } from "../utils.js";

export type V8NodeKind = "episodic" | "semantic" | "procedural";

export type V8NodeRole =
    | "topic"
    | "workflow"
    | "constraint"
    | "condition"
    | "evidence"
    | "checkpoint";

export type V8EdgeType =
    | "associative"
    | "causal"
    | "constraint"
    | "workflow_next"
    | "same_topic"
    | "supersedes"
    | "valid_when"
    | "invalid_when";

export type V8BundleSourceType = "event" | "knowledge_md" | "skill_md";

export type V8DeliveryTier = "critical" | "decision" | "background";

export type V8FeedbackOutcome =
    | "accepted"
    | "ignored"
    | "not_reached"
    | "misapplied"
    | "contradicted"
    | "superseded"
    | "harmful";

export type V8HardCoreGroup =
    | "agent_identity_core"
    | "inter_agent_protocol_core";

export interface V8GraphManifest {
    schemaVersion: number;
    compilerVersion: string;
    embeddingModel: string;
    storageFormat: "jsonl";
    createdAt: string;
    updatedAt: string;
    lastFullRebuildAt: string | null;
    legacyGraphMigrated: boolean;
}

export interface V8MemoryBundle {
    bundleId: string;
    sourceType: V8BundleSourceType;
    sourceRef: string;
    kind: V8NodeKind;
    title: string;
    nodeIds: string[];
    canonicalRef: string;
    summaryRef: string;
    dayKey: string | null;
    episodeKey: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface V8MemoryNode {
    id: string;
    bundleId: string;
    kind: V8NodeKind;
    role: V8NodeRole;
    text: string;
    summary: string;
    keywords: string[];
    language: "zh" | "en" | "mixed" | "unknown";
    sourceRef: string;
    canonicalRef: string;
    confidence: number;
    importance: number;
    hitCount: number;
    adoptCount: number;
    rejectCount: number;
    harmCount: number;
    lastUsedAt: string | null;
    lastVerifiedAt: string | null;
    cooldownUntil: string | null;
    dayKey: string | null;
    episodeKey: string | null;
}

export interface V8MemoryEdge {
    id: string;
    type: V8EdgeType;
    src: string;
    dst: string;
    assocStrength: number;
    utility: number;
    trust: number;
    freshness: number;
    contextFit: number;
    evidenceCount: number;
    activationCount: number;
    adoptCount: number;
    rejectCount: number;
    lastUpdatedAt: string;
    lastVerifiedAt: string | null;
}

export type V8TriggerLexicon = Record<string, string[]>;

export interface V8DayIndexEntry {
    nodeIds: string[];
    episodeKeys: string[];
}

export type V8DayIndex = Record<string, V8DayIndexEntry>;

export interface V8SourceIndexEntry {
    sourceRef: string;
    bundleIds: string[];
    canonicalRef: string;
    summaryRef: string;
    relatedDailyLogRefs: string[];
}

export type V8SourceIndex = Record<string, V8SourceIndexEntry>;

export type V8HardCoreIndex = Record<V8HardCoreGroup, string[]>;

export interface V8UpdateQueueItem {
    id: string;
    targetType: "node" | "edge" | "bundle";
    targetId: string;
    reason:
        | "staleness_suspected"
        | "contradicted"
        | "high_harm"
        | "distribution_shift";
    evidence: string[];
    createdAt: string;
    status: "pending" | "reviewed" | "resolved";
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
}

export interface CompileEventInput {
    event: MemoryEvent;
    workspace: string;
}

export interface CompileEventOutput {
    bundle: V8MemoryBundle;
    nodes: V8MemoryNode[];
    edges: V8MemoryEdge[];
}

export interface V8ActivatedNode {
    nodeId: string;
    energy: number;
}

export interface V8ActivatedBundle {
    bundleId: string;
    energy: number;
    tier: V8DeliveryTier;
    nodeIds: string[];
}

export interface AssembleRecallInput {
    workspace: string;
    bundles: V8ActivatedBundle[];
    goal: string;
    activeTask: string;
    latestUserRequest: string;
}

export interface AssembleRecallOutput {
    tier: V8DeliveryTier;
    prompt: string;
    sourceRefs: string[];
}

export interface V8RecallFeedback {
    bundleId: string;
    nodeIds: string[];
    outcome: V8FeedbackOutcome;
    reason?: string;
    observedAt: string;
}

export interface V8FeedbackUpdate {
    nodeUpdates: Partial<V8MemoryNode>[];
    edgeUpdates: Partial<V8MemoryEdge>[];
    queueItems: V8UpdateQueueItem[];
}

export interface V8HardeningConfig {
    identityCoreMinHits: number;
    identityCoreMinAdoptRate: number;
    protocolCoreMinHits: number;
    protocolCoreMinAdoptRate: number;
    maxHarmRate: number;
}

export interface V8HardeningDecision {
    targetNodeIds: string[];
    group: V8HardCoreGroup;
}
