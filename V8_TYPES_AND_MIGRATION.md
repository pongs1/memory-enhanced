# V8 Types and Migration Draft

Status: draft  
Depends on:

- [V8_ARCHITECTURE.md](./V8_ARCHITECTURE.md)
- [V8_SCHEMA_AND_PIPELINE.md](./V8_SCHEMA_AND_PIPELINE.md)

This document defines the TypeScript-facing contracts for V8 and the staged migration plan from the current prototype.

It does not implement these contracts yet.
It defines what the implementation should look like.

## 1. Document Scope

This document covers:

- TypeScript module boundaries
- graph type definitions
- compiler contracts
- scanner contracts
- feedback contracts
- migration phases

This document does not re-explain the full V8 philosophy.
That lives in:

- [V8_ARCHITECTURE.md](./V8_ARCHITECTURE.md)
- [V8_SCHEMA_AND_PIPELINE.md](./V8_SCHEMA_AND_PIPELINE.md)

## 2. Proposed Module Layout

Recommended new module area:

```text
src/v8/
  types.ts
  paths.ts
  ids.ts
  manifest.ts
  annotation.ts
  annotation-prompt.ts
  annotation-stage-parser.ts
  compiler.ts
  compile-event.ts
  compile-knowledge-md.ts
  compile-skill-md.ts
  indexes.ts
  scanner.ts
  recall.ts
  feedback.ts
  sleep.ts
  migration.ts
```

### Module responsibilities

- `types.ts`
  - all core V8 interfaces and literal unions
- `paths.ts`
  - graph path helpers under `.memory/graph/`
- `ids.ts`
  - id generation and parsing helpers
- `manifest.ts`
  - read/write/validate manifest
- `annotation.ts`
  - offline annotator draft contracts and sanitization
- `annotation-prompt.ts`
  - staged sleep-phase prompt builder:
    - scene reconstruction
    - relation scoring
    - final bundle draft
- `annotation-stage-parser.ts`
  - parse staged markdown outputs into a draft bundle before final sanitization
- `compiler.ts`
  - orchestrates bundle compilation
- `compile-event.ts`
  - event -> bundle/node/edge conversion
- `compile-knowledge-md.ts`
  - md block -> bundle/node/edge conversion
- `compile-skill-md.ts`
  - optional procedural compilation from skill md
- `indexes.ts`
  - trigger lexicon, source index, day index, hard core index
- `scanner.ts`
  - online activation, propagation, thresholding
- `recall.ts`
  - bundle grouping and recall assembly
- `feedback.ts`
  - accepted/ignored/harmful pipeline
- `sleep.ts`
  - decay, rebuild, update queue handling
- `migration.ts`
  - legacy graph -> V8 graph migration

## 3. Core Literal Types

Recommended literal unions:

```ts
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

export type V8BundleSourceType =
  | "event"
  | "knowledge_md"
  | "skill_md";

export type V8DeliveryTier =
  | "critical"
  | "decision"
  | "background";

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
```

## 4. Graph Manifest Contract

Recommended manifest shape:

```ts
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
```

### Notes

- `schemaVersion` is for data compatibility
- `compilerVersion` is for rebuild policy
- `embeddingModel` is required because vector indexes are model-specific
- `legacyGraphMigrated` lets the runtime know whether fallback reading is still needed

## 5. Bundle Contract

```ts
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
```

### Design rules

- one source memory normally maps to one bundle
- one bundle may contain multiple nodes with different roles
- bundle is the minimum unit for recall assembly

## 6. Node Contract

```ts
export interface V8MemoryNode {
  id: string;
  bundleId: string;
  kind: V8NodeKind;
  role: V8NodeRole;
  names: {
    zh: string;
    en: string;
  };
  aliases: string[];
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
```

### Validation rules

- `names.zh` and `names.en` should be non-empty equivalent labels for the same node when reliable annotation exists
- `aliases` should be deduplicated and may include old labels or bilingual shorthand
- `text` must be non-empty and short enough for fast retrieval
- `keywords` should be deduplicated
- `confidence` and `importance` must be clamped to `[0, 1]`
- `canonicalRef` must resolve through the source index

## 7. Edge Contract

```ts
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
```

### Validation rules

- all score fields are clamped to `[0, 1]`
- `src` and `dst` must exist in some node store
- `supersedes` edges must not be symmetric by default
- `same_topic` may be symmetric but should still be stored explicitly

## 8. Index Contracts

### Trigger lexicon

```ts
export type V8TriggerLexicon = Record<string, string[]>;
```

Maps normalized lexical triggers to candidate node ids.

### Day index

```ts
export interface V8DayIndexEntry {
  nodeIds: string[];
  episodeKeys: string[];
}

export type V8DayIndex = Record<string, V8DayIndexEntry>;
```

### Source index

```ts
export interface V8SourceIndexEntry {
  sourceRef: string;
  bundleIds: string[];
  canonicalRef: string;
  summaryRef: string;
  relatedDailyLogRefs: string[];
}

export type V8SourceIndex = Record<string, V8SourceIndexEntry>;
```

### Hard core index

```ts
export type V8HardCoreIndex = Record<V8HardCoreGroup, string[]>;
```

## 9. Update Queue Contract

```ts
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
```

## 10. Scanner Config Contract

```ts
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
```

### Validation notes

- all thresholds and gains should be bounded to sane ranges
- `reverseGain` should stay configurable for smoke testing
- `maxInjectedBundles` should default small, probably `1-2`

## 11. Compiler Contracts

### 11.1 Event compiler

```ts
export interface CompileEventInput {
  event: MemoryEvent;
  workspace: string;
}

export interface CompileEventOutput {
  bundle: V8MemoryBundle;
  nodes: V8MemoryNode[];
  edges: V8MemoryEdge[];
}

export function compileEventToBundle(
  input: CompileEventInput
): CompileEventOutput;
```

### 11.2 Knowledge md compiler

```ts
export interface CompileKnowledgeMdInput {
  filePath: string;
  workspace: string;
}

export interface CompileKnowledgeMdOutput {
  bundles: V8MemoryBundle[];
  nodes: V8MemoryNode[];
  edges: V8MemoryEdge[];
}

export function compileKnowledgeMdToBundles(
  input: CompileKnowledgeMdInput
): CompileKnowledgeMdOutput;
```

Structured MD blocks should support optional bilingual naming metadata:

```md
<!-- memory-node
name_zh: 网关断连恢复
name_en: gateway recovery
aliases: [网关恢复, gateway disconnected recovery]
-->
...
<!-- /memory-node -->
```

### 11.3 Offline annotation draft contracts

The offline annotator should emit a draft bundle, not final graph rows.
The compiler owns final acceptance.

Recommended contract shape:

```ts
export interface V8AnnotationBundleDraft {
  sourceType: V8BundleSourceType;
  sourceRef: string;
  kind?: V8NodeKind;
  title?: string;
  canonicalRef?: string;
  summaryRef?: string;
  dayKey?: string | null;
  episodeKey?: string | null;
  nodes: V8AnnotationNodeDraft[];
  edges?: V8AnnotationEdgeDraft[];
  notes?: string[];
}
```

The runtime should sanitize:

- bilingual names
- aliases
- confidence / importance ranges
- edge score ranges
- missing topic nodes
- empty or overlong text

The sleep-phase prompt builder should:

- require bilingual equivalent node names
- forbid splitting zh/en labels into separate nodes
- prefer sparse `2-6` node bundles
- split the job into:
  - scene reconstruction
  - relation scoring
  - final JSON draft
- demand raw JSON only

### 11.4 Build graph pass

```ts
export interface BuildGraphInput {
  workspace: string;
  includeEvents: boolean;
  includeKnowledgeMd: boolean;
  includeSkillMd: boolean;
}

export interface BuildGraphOutput {
  manifest: V8GraphManifest;
  bundles: V8MemoryBundle[];
  nodes: V8MemoryNode[];
  edges: V8MemoryEdge[];
  triggerLexicon: V8TriggerLexicon;
  dayIndex: V8DayIndex;
  sourceIndex: V8SourceIndex;
}

export async function buildV8Graph(
  input: BuildGraphInput
): Promise<BuildGraphOutput>;
```

## 12. Recall Contracts

### 12.1 Scanner output

```ts
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
```

### 12.2 Recall assembly

```ts
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

export function assembleRecallPrompt(
  input: AssembleRecallInput
): AssembleRecallOutput[];
```

### Rules

- assembly should resolve through `sourceIndex`
- raw node text is not the default payload
- bundle recall may read md or event source to build a compact insertion block

## 13. Feedback Contracts

```ts
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

export function applyRecallFeedback(
  feedback: V8RecallFeedback,
  graph: {
    nodes: V8MemoryNode[];
    edges: V8MemoryEdge[];
  }
): V8FeedbackUpdate;
```

### Rules

- `ignored` is not the same as `harmful`
- `superseded` should often emit queue items or supersession edges
- `harmful` is the strongest penalty path

## 14. Hardening Contracts

```ts
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

export function evaluateHardeningCandidates(
  nodes: V8MemoryNode[],
  config: V8HardeningConfig
): V8HardeningDecision[];
```

## 15. Migration Phases

Migration should be staged, not atomic.

### Phase 0: Design freeze

- finalize schema docs
- freeze current prototype behavior enough to compare later

### Phase 1: Types and paths

- add `src/v8/types.ts`
- add graph path helpers
- add manifest read/write helpers

No behavior change yet.

### Phase 2: Legacy-compatible graph directory

- create `.memory/graph/`
- write manifest and empty indexes
- keep current `_associative_graph.json` untouched

### Phase 3: Legacy bootstrap migration

- read legacy `_associative_graph.json`
- bootstrap provisional bundles/nodes/edges
- map scalar `weight` into multi-score edge defaults

This is a compatibility bridge, not final truth.

### Phase 4: Event compiler

- compile `.memory/events/*.jsonl` into episodic bundles
- write day index and source index

At this phase, event nodes should exist even if online scanner still uses legacy graph.

### Phase 5: MD compiler

- compile `memory/knowledge/*.md` structured blocks
- create semantic and procedural bundles

### Phase 6: New scanner behind a flag

- add char-based scanner over new graph indexes
- keep legacy scanner as fallback
- compare recall behavior using smoke tests

### Phase 7: Feedback and update queue

- persist feedback outcomes
- materialize `update_queue.jsonl`
- begin staleness suspicion tracking

### Phase 8: Sleep integration

- switch `memory_consolidate` to update new graph layout
- include offline bilingual naming refresh:
  - propose `name_zh`
  - propose `name_en`
  - normalize `aliases`
- keep legacy graph output during compatibility window if needed

### Phase 9: Cutover

- default to new graph
- retain one release worth of fallback read support
- then remove legacy graph writer

## 16. Compatibility Rules

During migration:

- old data must remain readable
- new graph may coexist with legacy graph
- scanner should not mix two graph systems in one recall pass unless explicitly in debug mode

Recommended rule:

- legacy graph remains read-only once the new compiler is stable

## 17. Acceptance Criteria Before Coding the Scanner Rewrite

These should be true first:

- TypeScript types exist
- graph directory helpers exist
- compiler can write valid bundles/nodes/edges/indexes
- source index can rehydrate a bundle back to md or event source
- migration bootstrap from legacy graph works on one real workspace

Only then should the online scanner switch to the new graph by default.

## 18. Immediate Next Coding Entry Points

When coding starts, recommended first files:

- `src/v8/types.ts`
- `src/v8/paths.ts`
- `src/v8/manifest.ts`
- `src/v8/compile-event.ts`

These are low-risk and unblock everything else.
