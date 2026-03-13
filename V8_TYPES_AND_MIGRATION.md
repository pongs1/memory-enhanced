# V8 Types and Migration

Status: rewrite target  
Depends on:

- [V8_ARCHITECTURE.md](./V8_ARCHITECTURE.md)
- [V8_SCHEMA_AND_PIPELINE.md](./V8_SCHEMA_AND_PIPELINE.md)

This document defines the TypeScript-facing contracts and migration plan for the rewritten V8.

It intentionally replaces the older event-centric type plan.

Implementation note:

- new V8 contracts are staged in `src/v8/types_v8.ts`
- legacy contracts remain in `src/v8/types.ts` during migration

## 1. Scope

This document covers:

- source-facing contracts
- unit and evidence contracts
- memory IR contracts
- graph product contracts
- scanner and ignition contracts
- summary and state contracts
- module boundaries
- migration strategy from the current prototype

## 2. New Contract Hierarchy

The new V8 contracts are layered.

### 2.1 Source contracts

These represent normalized inputs before any semantic extraction:

- `V8SourceRecord`
- `V8SourceClass`
- `V8SourceType`

### 2.2 Segmentation contracts

These represent evidence-preserving structure:

- `V8Unit`
- `V8EvidenceSpan`
- `V8GraphLayer`

### 2.3 Semantic extraction contracts

These represent normalized memory content:

- `V8MemoryItem`
- `V8MemoryItemType`
- `V8MemoryOriginType`

### 2.4 Product contracts

These represent what the runtime consumes:

- `V8GraphNode`
- `V8GraphEdge`
- `V8ActivatedBundle`
- `V8ScannerConfig`
- `V8SceneSignal`
- `V8SummaryPack`
- `V8StatePack`
- `V8RecallAssembly`

The old `bundle/node/edge` layer can remain during migration, but it is no longer the primary design center.

## 3. Recommended Module Layout

```text
src/v8/
  architecture/
    source-normalizer.ts
    unitizer.ts
    evidence.ts
    ir-extractor.ts
    graph-materializer.ts
    summary-materializer.ts
    state-materializer.ts
    assembler.ts
  adapters/
    session-source.ts
    daily-log-source.ts
    knowledge-source.ts
    skill-source.ts
    legacy-event-source.ts
  types.ts
  paths.ts
  ids.ts
  manifest.ts
  migration.ts
  offline-annotator.ts
  scanner.ts
  recall.ts
  feedback.ts
```

This layout makes the layering explicit.
The adapters produce normalized source records.
The architecture modules operate on shared contracts.

## 4. Core Literal Types

Recommended literals:

```ts
export type V8SourceClass = "raw" | "curated" | "legacy";

export type V8SourceType =
  | "session_trace"
  | "daily_log"
  | "knowledge_md"
  | "skill_md"
  | "event_jsonl";

export type V8GraphLayer = "micro" | "meso" | "macro";

export type V8EdgeLayer = V8GraphLayer | "cross";

export type V8MemoryOriginType =
  | "asserted"
  | "aggregated"
  | "inferred";

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
  kind:
    | "semantic"
    | "discourse"
    | V8VerticalEdgeKind
    | "memory_control";
  strength: V8VerticalEdgeStrength | null;
  requiresScope: boolean;
  stateful: boolean;
  description: string;
}

export type V8RecallMode =
  | "profile"
  | "trajectory"
  | "oblique"
  | "audit";

export type V8EdgeRuntimeRole =
  | "spread"
  | "gate"
  | "reweight"
  | "backtrace";

export interface V8EdgeRuntimePolicyEntry {
  kind:
    | "semantic"
    | "discourse"
    | V8VerticalEdgeKind
    | "memory_control";
  mode: V8RecallMode;
  role: V8EdgeRuntimeRole;
  direction: "up" | "down" | "bidirectional" | "none";
  gain: number;
  notes?: string;
}
```

Legacy types such as `V8NodeRole` and old narrow `V8EdgeType` may remain for compatibility, but they are not sufficient as the future-facing model.

Catalog notes:

- `V8MemoryStateEdgeType` is a compatibility alias family for older control-oriented code paths.
- Canonical graph materialization should prefer the explicit vertical/state-overlay types above when the semantics are containment, abstraction, scope, or change.
- `mention_maps_to_object`, `proposition_summarized_by_topic`, and `topic_has_timewindow` remain convenience bridge labels for migration, but new schema work should classify them into the explicit vertical taxonomy whenever possible.
- The machine-readable catalog generated from this document lives at `memory-enhanced/schema/v8-edge-catalog.json` and is validated by `memory-enhanced/schema/v8-edge-catalog.schema.json`.
- Default runtime participation profiles live at `memory-enhanced/schema/v8-edge-runtime-policy.json`.

Node catalog summary:

| Family | Members | Notes |
|---|---|---|
| `V8MicroNodeType` | `entity`, `concept`, `method`, `event`, `attribute`, `metric`, `claim`, `evidence`, `context`, `discourse_unit` | object/fact graph; corresponds to the report's micro layer |
| `V8MesoNodeType` | `scene_block`, `situation_frame`, `objective_block`, `problem_block`, `strategy_block`, `procedure_block`, `interaction_block`, `decision_block`, `evidence_frame`, `shift_block`, `outcome_block`, `block_function` | scene/block graph; one coherent local structure |
| `V8MacroNodeType` | `arc`, `thread`, `phase`, `global_scene_type`, `regime`, `objective_line`, `conflict_line`, `relationship_arc`, `method_line`, `theme`, `pattern`, `turning_point`, `global_state` | arc/structure graph; long-range lines and phases |
| `V8MemoryControlNodeType` | `preference`, `goal`, `constraint`, `decision`, `open_question`, `conversation_act`, `session_state`, `topic_state` | control-memory overlay for recall assembly and agent state |
| `V8StateOverlayNodeType` | `relationship_state`, `workflow_validity_state`, `compatibility_state`, `preference_state`, `belief_state`, `risk_state` | state/trajectory overlay for validity windows, change tracking, and correction |

Vertical edge catalog summary:

| Kind | Types | Notes |
|---|---|---|
| evidence anchor | `span_in_micro_unit`, `mention_maps_to_micro_node`, `micro_edge_evidenced_by_span`, `meso_block_evidenced_by_span_set`, `macro_node_evidenced_by_span_set`, `state_evidenced_by_block` | binds every higher-level structure back to evidence |
| containment | `micro_unit_in_meso_unit`, `micro_node_in_meso_block`, `micro_edge_in_meso_block`, `meso_unit_in_macro_unit`, `meso_block_in_phase`, `phase_in_arc` | hard structural membership across layers |
| abstraction | `micro_fact_abstracted_as_block`, `micro_claim_summarized_by_block`, `block_instantiates_global_type`, `block_summarized_by_topic`, `block_contributes_to_pattern`, `line_summarized_by_theme` | soft summarization and type lifting |
| line binding | `local_goal_in_objective_line`, `local_conflict_in_conflict_line`, `local_method_in_method_line`, `local_relationship_in_relationship_arc`, `local_event_in_thread`, `local_shift_to_turning_point` | maps local blocks into long-running lines |
| scope anchor | `state_valid_in_phase`, `state_valid_in_timewindow`, `block_scoped_to_regime`, `block_scoped_to_topicstate`, `thread_spans_timewindow`, `block_updates_global_state` | validity, slicing, regime, and topic-state gating |
| change | `state_supersedes_state`, `state_refines_state`, `state_changed_by_event`, `state_opened_by_block`, `state_closed_by_block`, `state_invalidated_under_regime`, `state_reactivated_under_regime`, `correction_propagates_to_line` | change, supersession, invalidation, and correction propagation |

Detailed horizontal edge glossary:

`micro` edge definitions:

| Group | Edge | Meaning |
|---|---|---|
| ontology | `is_a` | source is a subtype or kind of target |
| ontology | `instance_of` | source is a concrete instance of target class |
| ontology | `part_of` | source is a component of target |
| ontology | `has_part` | source contains target as a component |
| ontology | `belongs_to` | source is affiliated with, owned by, or assigned to target |
| ontology | `equivalent_to` | source and target are aliases or semantically equivalent |
| participation | `performs` | source actor executes the target method or action |
| participation | `acts_on` | source action or method operates on target object |
| participation | `uses` | source depends on or uses target as an input or tool |
| participation | `produces` | source creates, emits, or yields target |
| participation | `targets` | source is directed at target objective or object |
| event structure | `initiates` | source triggers the start of target event |
| event structure | `involves` | source event directly includes target participant or object |
| event structure | `occurs_at` | source event is anchored at target time, place, or phase |
| event structure | `results_in_event` | source event causes the target event to occur |
| causality and condition | `causes` | source causally produces target |
| causality and condition | `caused_by` | source is causally explained by target |
| causality and condition | `enables` | source makes target possible |
| causality and condition | `prevents` | source blocks, stops, or suppresses target |
| causality and condition | `requires` | source needs target as a prerequisite |
| causality and condition | `conditioned_on` | source only holds under target condition or context |
| time and evolution | `before` | source happens earlier than target |
| time and evolution | `after` | source happens later than target |
| time and evolution | `simultaneous_with` | source and target hold at the same time |
| time and evolution | `evolves_to` | source develops into target version, form, or state |
| comparison | `better_than` | source is superior to target along some aspect |
| comparison | `worse_than` | source is inferior to target along some aspect |
| comparison | `similar_to` | source is similar to target |
| comparison | `differs_from` | source differs from target |
| support | `supports` | source evidence or claim supports target claim |
| support | `contradicts` | source evidence or claim opposes target claim |
| support | `cites` | source explicitly cites or references target |
| discourse | `elaborates` | source adds detail to target |
| discourse | `summarizes` | source is a summary of target |
| discourse | `contrasts` | source sets up a contrast with target |
| discourse | `explains` | source explains target |
| discourse | `concludes` | source concludes from target or leads to a conclusion about target |
| discourse | `recommends` | source recommends target action, object, or conclusion |

`meso` edge definitions:

| Group | Edge | Meaning |
|---|---|---|
| anchoring and composition | `grounded_in` | scene block is anchored in a concrete situation frame |
| anchoring and composition | `oriented_to` | block is directed toward an objective block |
| anchoring and composition | `focuses_on` | block centers on a problem, interaction, or decision focus |
| anchoring and composition | `realized_by` | strategy is carried out through a procedure or interaction block |
| anchoring and composition | `evidenced_by_block` | block is supported or weakened by an evidence frame |
| anchoring and composition | `functions_as` | block serves a structural role such as setup, pivot, or resolution |
| local dynamics | `triggered_by` | block or shift is triggered by an earlier block |
| local dynamics | `responds_to` | strategy, decision, or interaction responds to a prior issue or block |
| local dynamics | `constrained_by` | local move is limited by a problem, frame, or prior state |
| local dynamics | `attempts_to_resolve` | local move tries to resolve a problem block |
| local dynamics | `escalates` | source block increases local tension, pressure, or conflict |
| local dynamics | `mitigates` | source block reduces local tension, pressure, or conflict |
| local dynamics | `reframes` | source block changes the problem framing or interpretive frame |
| local dynamics | `revises` | source block revises an earlier local decision, objective, or strategy |
| local transformation | `culminates_in` | block reaches a local climax in a decision, outcome, or shift |
| local transformation | `leads_to` | block directly leads to a subsequent block or outcome |
| local transformation | `produces_shift` | block causes a local stance, state, or strategy shift |
| local transformation | `stabilizes` | block stabilizes the local situation |
| local transformation | `destabilizes` | block destabilizes the local situation |
| local transformation | `opens` | block opens a new issue, branch, or objective |
| local transformation | `closes` | block closes a local issue, branch, or block |
| block organization | `precedes_block` | source block comes before target block |
| block organization | `branches_to` | source block branches into target block |
| block organization | `merges_into` | source block merges into target block |
| block organization | `parallels` | source and target blocks proceed in parallel |
| block organization | `contrasts_with_block` | source and target blocks form a local structural contrast |
| block organization | `echoes` | later block repeats or echoes an earlier block |
| block organization | `sets_up` | source block prepares or foreshadows target block |
| block organization | `mirrors_locally` | source and target have mirrored local structure with opposing stance or outcome |

`macro` edge definitions:

| Group | Edge | Meaning |
|---|---|---|
| global structure | `unfolds_through` | arc or thread unfolds through a sequence of phases |
| global structure | `spans_phase` | source line spans the target phase |
| global structure | `organized_as` | source arc is organized as a specific global scene type |
| global structure | `governed_by` | source arc or phase is governed by the target regime |
| global structure | `centered_on_line` | source arc is primarily centered on a specific objective, conflict, or method line |
| global structure | `dominated_by` | source phase is dominated by a theme, conflict, or long-running tension |
| long-range evolution | `transitions_to_phase` | source phase shifts into target phase |
| long-range evolution | `evolves_to` | source line or state develops into a new long-range form |
| long-range evolution | `branches_into` | source line branches into multiple successor lines |
| long-range evolution | `converges_with` | source line converges with target line |
| long-range evolution | `interrupted_by` | source arc or line is interrupted by target event, regime, or turning point |
| long-range evolution | `resumes_after` | source line resumes after target interruption or phase |
| long-range evolution | `culminates_at` | source arc reaches a climax at target turning point |
| long-range evolution | `resolved_by` | source conflict or objective line is resolved by target line or turning point |
| global state and constraint | `produces_state` | source arc, phase, or turning point produces a global state |
| global state and constraint | `shifts_regime` | source turning point causes a regime shift |
| global state and constraint | `stabilizes_state` | source line or phase stabilizes a global state |
| global state and constraint | `destabilizes_state` | source line or turning point destabilizes a global state |
| global state and constraint | `constrains` | source regime, conflict, or theme constrains target line |
| global state and constraint | `enables` | source regime, method, or relation enables target line |
| long-range interaction | `competes_with` | source line competes with target line |
| long-range interaction | `reinforces` | source line, theme, or pattern strengthens target |
| long-range interaction | `undermines` | source line, theme, or pattern weakens target |
| long-range interaction | `mirrors` | source and target arcs or phases mirror one another |
| long-range interaction | `recurs_as` | source pattern recurs as target variant |
| long-range interaction | `foreshadows` | source line, phase, or pattern foreshadows target structure |
| long-range interaction | `pays_off` | source setup, theme, or pattern is fulfilled by target |
| long-range interaction | `recontextualizes` | source turning point or regime changes how target is interpreted |
| long-range interaction | `opens_arc` | source turning point or state opens a new arc |
| long-range interaction | `closes_arc` | source turning point or state closes an arc |

The ignition path also needs stable runtime literals and contracts.

## 5. Source Record Contract

```ts
export interface V8SourceRecord {
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
```

Rules:

- `rawText` is preserved
- `legacyHints` are optional and non-authoritative
- raw and curated sources share the same outer contract
- source class determines extraction profile, not schema shape

## 6. Unit and Evidence Contracts

```ts
export interface V8Unit {
  id: string;
  sourceRecordId: string;
  layer: V8GraphLayer;
  ordinal: number;
  charStart: number;
  charEnd: number;
  text: string;
  parentUnitId: string | null;
  language: "zh" | "en" | "mixed" | "unknown";
}

export interface V8EvidenceSpan {
  id: string;
  sourceRecordId: string;
  unitId: string;
  charStart: number;
  charEnd: number;
  text: string;
  speaker: "user" | "assistant" | "system" | "unknown" | null;
  score: number;
}
```

Rules:

- offsets always point back to source record text
- `charStart` and `charEnd` are traceability fields, not the primary unitization policy
- units should be cut by semantic and discourse boundaries first, with size limits only as fallback guardrails
- evidence spans may overlap
- evidence spans are smaller than units and should be referenceable from both items and graph edges

## 7. Extraction IR Contract

```ts
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
  sourceRecordId: string;
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
```

Rules:

- items are the evidence-backed structured contract consumed by normalization, graph materialization, and summary generation
- `asserted` items require direct evidence
- `aggregated` and `inferred` items require support evidence
- `scope` and `validity` are mandatory because V8 is a memory graph, not only a fact graph
- `layer` determines which node and edge ontology is valid for the item

## 8. Graph Contracts

```ts
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
```

Notes:

- `micro`, `meso`, and `macro` no longer share one node or edge ontology
- `Core 32 + Extended 6` remains the bounded vocabulary for `micro`
- `meso` and `macro` use their own bounded scene/block and arc/structure vocabularies
- the runtime stays light through sparse activation, weighting, and propagation policy rather than by shrinking the graph contract itself
- memory-state edges remain separate from the report taxonomy because they express memory validity and scope rather than text-world semantics
- direct and inferred relations must remain distinguishable
- qualifiers are required for high-variance relations such as `better_than`, `worse_than`, `supports`, `contradicts`, and `conditioned_on`
- `V8HypothesisEdge` is non-canonical and is not part of the default ignition graph
- hypothesis edges can be surfaced in `oblique` recall only when support evidence is included

The canonical graph contract stays compact.
It should not be forced to carry every runtime-only field needed by ignition.

For that reason, V8 should materialize explicit runtime projections from the graph layer.

```ts
export interface V8IgnitionNodeProjection {
  nodeId: string;
  bundleId: string;
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
```

Rules:

- graph nodes and edges are canonical memory objects
- ignition projections are denormalized runtime views derived from the graph
- recall bundle projections are the delivery unit for scanner and assembler
- runtime projections must remain traceable back to graph node ids and evidence spans

## 9. Summary and State Contracts

```ts
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

export interface V8RecallAssembly {
  id: string;
  request: V8RecallRequest;
  bundleIds: string[];
  summaryPackIds: string[];
  statePackIds: string[];
  rawEvidenceSpanIds: string[];
  createdAt: string;
}
```

These are first-class runtime products, not ad hoc strings assembled later from graph nodes alone.

## 10. Scanner and Ignition Contracts

The V8 rewrite keeps a dedicated scanner layer.
This is not optional. It is the runtime mechanism that lets the graph participate during generation.

```ts
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
}

export interface V8ActivatedBundle {
  bundleId: string;
  nodeIds: string[];
  tier: "critical" | "decision" | "background";
  energy: number;
  evidenceSpanIds: string[];
  sourceRefs?: string[];
  wave?: 1 | 2;
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
  kind:
    | "semantic"
    | "discourse"
    | V8VerticalEdgeKind
    | "memory_control";
  mode: V8RecallMode;
  role: V8EdgeRuntimeRole;
  direction: "up" | "down" | "bidirectional" | "none";
  gain: number;
  notes?: string;
}
```

Rules:

- ignition is node-level, delivery is bundle-level
- episodic activation must be gateable by day, episode, and source overlap
- semantic and procedural bundles remain globally available
- the scanner consumes ignition projections and recall bundle projections, not raw source records directly
- node cooldown and bundle cooldown are separate runtime controls
- second-wave recall remains allowed after one propagation pass
- tier is delivery policy, not graph ontology
- default recall mode is `profile`; `trajectory`, `oblique`, and `audit` are explicit mode switches
- `scope_anchor` is `gate` role in all modes
- `change` edges are `reweight` in profile and oblique, and `reweight + lineage traversal` in trajectory
- `evidence_anchor` is `backtrace` role rather than propagation role
- runtime policies should be loaded from `memory-enhanced/schema/v8-edge-runtime-policy.json` and mapped into `V8RuntimeEdgeKindPolicy`

## 11. Compiler Boundary Changes

The old compiler contracts are no longer the target design:

- `compileEventToBundle`
- `compileKnowledgeMdToBundles`
- direct `skill_md -> knowledge-style bundle`

The new boundary is:

1. source adapters produce `V8SourceRecord[]`
2. unitizer produces `V8Unit[]`
3. evidence extractor produces `V8EvidenceSpan[]`
4. IR extractor produces `V8MemoryItem[]`
5. graph materializer produces graph nodes and edges
6. summary/state materializers produce runtime packs

Old bundle contracts can remain in a compatibility layer during migration because scanner and recall still depend on them today.

## 12. Migration Strategy

Clean-slate mode (default):

- do not ingest legacy artifacts
- do not emit new `event` or bundle summaries
- skip compatibility layers unless explicitly needed

Migration is optional. Use it only when you need to preserve old data.
Otherwise, start from raw session/log evidence and rebuild forward.

If migration is required, the rewrite should happen in phases.

### Phase 0: freeze control plane

- keep `focus_stack.json` untouched
- do not redesign L0 while rewriting the memory substrate

### Phase 1: establish raw authority

- introduce raw source adapters for session traces and daily logs
- preserve existing logs as the authoritative text base
- stop treating `event` as the raw substrate

### Phase 2: normalize curated memory

- adapt `knowledge_md` and `skill_md` into source records
- strip legacy tags and scaffolding
- preserve source anchors

### Phase 3: introduce units, evidence, and IR

- build `V8Unit`
- build `V8EvidenceSpan`
- build `V8MemoryItem`
- keep old graph outputs alive only if needed for compatibility

### Phase 4: re-materialize graph

- graph is rebuilt from IR, not from direct event/md compilers
- direct compiler-side bundle creation becomes deprecated
- runtime bundle-first delivery remains required through recall bundle projections

### Phase 5: move recall and feedback

- recall consumes graph plus summary/state packs
- recall still depends on ignition scanner outputs instead of direct item dumping
- feedback updates item-level and graph-level state
- raw evidence backtrace becomes standard

### Phase 6: legacy retirement

- old event-centric node roles become compatibility-only
- old bundle-first compilers can be removed after downstream consumers migrate

## 13. Deprecated Concepts

These old ideas are now deprecated as architecture primitives:

- `event` as the primary memory unit
- `bundle` as the first semantic structure
- narrow six-role node splitting as the main abstraction
- graph nodes without evidence backtrace
- sleep-phase annotation as the place where meaning first appears

Operational consequence:

- new pipelines should not emit fresh `event` artifacts; episodic recall should be derived from IR-backed graph packs

What is not deprecated:

- online ignition
- sparse propagation
- day-local episodic gating
- bundle-level delivery
- cooldown-aware reactivation

They may still exist temporarily in code, but they are no longer the architectural target.

## 14. Manifest and Versioning

The manifest should now track:

- schema version
- compiler version
- migration mode
- whether old graph compatibility files are still being emitted

Recommended direction:

```ts
export interface V8GraphManifest {
  schemaVersion: number;
  compilerVersion: string;
  migrationMode: "compat" | "hybrid" | "ir_first";
  storageFormat: "jsonl";
  createdAt: string;
  updatedAt: string;
  lastFullRebuildAt: string | null;
}
```

## 15. Implementation Rule

The rewrite should prefer:

- introducing new contracts first
- adding adapters second
- swapping compiler orchestration third

It should avoid:

- patching old `event -> node` heuristics further
- encoding more semantics into legacy node roles
- using legacy `event` labels as authoritative memory meaning
