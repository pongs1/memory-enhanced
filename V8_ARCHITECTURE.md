# V8 Architecture

Status: rewrite target  
Audience: maintainers, future contributors, agent-memory researchers

This document defines the new V8 direction for `memory-enhanced`.
It intentionally replaces the earlier event-centric V8 draft.

V8 is no longer defined as:

- `event -> bundle -> node bundle -> graph`
- graph as the primary memory surface
- sleep-time annotation as the place where meaning first appears

V8 is now defined as:

`raw session/log evidence -> units/spans -> memory IR -> memory graph + summary/state -> context assembly`

The companion documents are:

- [V8_SCHEMA_AND_PIPELINE.md](./V8_SCHEMA_AND_PIPELINE.md)
- [V8_TYPES_AND_MIGRATION.md](./V8_TYPES_AND_MIGRATION.md)

## 1. Design Goal

V8 is a memory architecture for long-running agents that must:

- preserve raw evidence
- support structured compression and state tracking
- maintain a graph for cross-memory organization and long-range linking
- use the graph as an online ignition substrate during generation
- assemble the right mix of raw text, summary, and structured state back into context

The user-facing target is:

- after `/new`, the agent can recover the correct branch from evidence-backed memory
- during large tasks, the agent can stay aligned with the current goal and constraints
- long-term preferences, project facts, decisions, and workflows can evolve instead of collapsing into stale summaries
- another model can inspect the same substrate and recover the same memory state without trusting hidden prompts

## 2. What V8 Is Not

The new V8 makes three explicit rejections.

### 2.1 Raw memory is not `event`

`event` is not the raw substrate.
It is a derived artifact from the old system.
It may remain useful during migration, but it is not authoritative raw memory.

Authoritative raw memory should come from:

- session traces
- daily logs
- raw user turns
- raw assistant turns

### 2.2 Graph is not the only memory surface

The graph is not a replacement for raw text or memory summaries.
It is the organization layer.

Raw text is needed for:

- evidence
- exact wording
- boundary conditions
- later correction

Summaries and state are needed for:

- compression
- conflict resolution
- long-term reuse
- task-state injection

### 2.3 `knowledge` and `skill` are not raw sources

`memory/knowledge/*.md` and `memory/skills/*.md` are curated sources.
They are closer to normalized memory than raw logs are, but they are still not the final IR and not the graph itself.

## 3. Layer Model

V8 keeps `L0 Control` and rewrites the rest around a shared ingestion model.

| Layer | Role | Canonical store | Notes |
|---|---|---|---|
| `L0 Control` | active task, priority, handoff, resume | `.memory/active/focus_stack.json` | preserved as-is |
| `L1 Raw Store` | raw evidence substrate | session traces, `memory/YYYY-MM-DD.md` | authoritative evidence |
| `L2 Narrative Normalization` | classify and clean raw/curated/legacy inputs | normalized narrative records | strips old prompt noise and legacy tags |
| `L3 Unit and Evidence` | segment text into `micro/meso/macro` units and evidence spans | unit/span stores | offsets are first-class |
| `L4 Extraction IR` | unit-aligned bounded IR | item store | direct, evidence-backed structured output from units |
| `L5 Normalization and Consolidation` | canonicalize and merge IR into durable memory objects | offline pipeline | alias merge, evidence merge, graph upsert prep |
| `L6 Memory Graph and Packs` | three-layer recall graph, summaries, state packs, trigger indexes | `.memory/graph/*`, summary/state outputs | optimized for recall, not full candidate storage |
| `L7 Context Assembly` | inject raw evidence, summaries, and state into the model | runtime only | query-dependent blend |

`L0` is intentionally separate.
Focus stack is execution control, not long-term memory.

The full-feature relation/taxonomy variant is preserved as a separate reference so V8 can stay lean without losing richer design options.

## 4. The Soul of V8: Online Ignition

The graph is not valuable merely because it stores relations.
The graph matters because it can ignite the right memory during generation, before the model drifts.

That means V8 still needs an explicit fast path:

- scan the live stream and control anchors
- ignite relevant graph nodes cheaply
- propagate energy through sparse graph structure
- elevate a small number of bundles into recall candidates
- assemble evidence-backed memory back into context

Without this layer, V8 collapses into a delayed indexing system.

### 4.1 Ignition inputs

The online ignition path should consume:

- current control anchors from `focus_stack.json`
- recent live stream text
- latest user request
- recent tool observations and errors
- runtime graph products derived from normalized IR materialization, not raw logs directly
- compact indexes such as trigger lexicon, day index, source index, and hard-core index

The runtime graph products are:

- canonical graph nodes and edges derived from normalized IR
- ignition node projections with names, aliases, trigger terms, and bundle membership
- recall bundles or packs with evidence refs, summary text, and source refs

`unit -> bounded extraction IR -> normalization/consolidation -> graph materialization -> ignition projections` is the contract.
Online ignition should not reopen the raw extractors or bypass the normalization layer.

### 4.2 Ignition outputs

The online path should not fire single nodes directly into the model.
It should produce:

- activated nodes
- activated bundles
- delivery tiers such as `critical`, `decision`, `background`
- evidence-backed candidate packs for the assembler

These tiers are delivery policy, not graph ontology.
The graph stores memory state and relations.
The runtime assigns insertion urgency.

### 4.3 Ignition score composition

The ignition model should remain explicit.
At runtime, every candidate node receives an injection score:

`u_i = baseGain * (a * g_lex + b * max(g_scene, g_ctrl) + c * g_time)`

Where:

- `g_lex`: trigger lexicon or lexical cue hit
- `g_scene`: overlap with the rolling scene window
- `g_ctrl`: overlap with control anchors such as goal, active task, and latest user request
- `g_time`: temporal availability, especially episodic day-locality
- `baseGain`: stronger pre-excitation for the initial prompt than for normal streaming chunks

The current scanner implementation already follows this pattern.
For ordinary chunk scans, the active weighting is approximately:

- `0.45 * g_lex`
- `0.35 * max(g_scene, g_ctrl)`
- `0.20 * g_time`

Scene refresh is a separate bias field rather than the same score path.
Its current weighting is approximately:

- `0.60 * lexicalSceneHit`
- `0.25 * max(sceneOverlap, g_ctrl)`
- `0.15 * g_time`

This distinction matters.
Live text ignition and persistent scene carry should not be conflated.

### 4.4 Propagation, inhibition, and second wave

After direct injection, V8 should propagate energy through sparse graph structure:

- forward spread is stronger and models likely continuation
- reverse spread is weaker and models reminder or causal backtracking
- only top-ranked outgoing and incoming edges participate
- transfer is damped by edge score and hub penalty
- stale activations decay between scans
- fired nodes and delivered bundles enter cooldown windows

The current runtime shape is already concrete enough to preserve architecturally:

- forward gain is stronger than reverse gain
- hub penalty suppresses generic high-degree nodes
- node cooldown and bundle cooldown are separate
- second-wave recall remains allowed when propagation crosses a higher threshold after initial ignition

Second-wave recall is important because many useful recalls are not first-hop lexical matches.
They emerge after one sparse propagation pass.

### 4.5 Why the graph is central here

Raw text alone can be recalled, but it cannot cheaply do:

- sparse associative propagation
- multi-hop reminder from `A + B -> C`
- local suppression of stale subconditions
- bundle-level priority and cooldown

That is the part of V8 that should remain graph-native.

### 4.6 Bundle-first delivery remains mandatory

Ignition may score nodes, but delivery should happen at bundle or pack level.

The unit of injection is not:

- an isolated node
- an isolated edge
- a naked graph neighborhood

The unit of injection is a recall bundle or pack that can carry:

- best evidence refs
- summary or decision text
- source refs
- tier
- affected node ids

This is how V8 preserves grounding while still benefiting from graph propagation.

## 5. Source Policy (Clean-Slate Mode)

V8 runs in **clean-slate mode** by default:

- only raw session/log evidence is ingested
- legacy artifacts are ignored
- old event/bundle outputs are not consumed

### 5.1 Raw evidence sources (authoritative)

These are the only authoritative text sources:

- session traces (raw message records)
- raw user messages
- raw assistant messages
- daily logs (optional, off by default)
- raw user messages
- raw assistant messages

Properties:

- append-only
- offset-preserving
- not pre-distilled
- always recoverable

### 5.2 Curated sources (disabled)

Curated `knowledge`/`skill` documents are **not** ingested in clean-slate mode.
They are treated as **post-hoc outputs** (packs) rather than sources.
If needed, they can be regenerated from raw evidence.

### 5.3 Legacy derived sources (disabled)

Legacy artifacts are not ingested:

- `.memory/events/*.jsonl`
- old bundle-like records
- old graph-derived summaries

These should be deleted or archived outside the runtime path.

## 6. Core Principle: Evidence-Backed Memory

Every high-level memory object must remain traceable to raw evidence.

The path is:

`graph node/edge -> memory item -> evidence span -> unit -> narrative record -> raw text`

This gives V8 three recovery modes:

- direct evidence backtrace
- aggregated evidence backtrace
- inferred evidence backtrace

The system must never pretend that an inferred relation was directly stated in raw text.

## 7. Units, Not Events, Define Meso

The earlier V8 conflated `event` with the basic semantic unit.
That is no longer acceptable.

Definitions:

- `micro`: smallest semantically coherent evidence span that can hold a local cue or relation
- `meso`: stable semantic segment sized to one coherent proposition cluster, reasoning step, or discourse function, usually within the report's envelope of `≈300-1500` Chinese chars or `≈150-800` English tokens
- `macro`: topic, section, or phase window used for navigation, coarse grouping, and long-range context, usually within the report's envelope of `≈2k-20k` tokens

Important:

- `meso` is not "an event summary"
- `meso` can come from raw logs, curated knowledge, or skill documents
- `event` is only one possible source reference
- unitization should follow semantic and discourse boundaries first, with character limits used only as fallback guardrails
- the report's size ranges are target envelopes for semantic capacity, not the primary cut rule
- runtime scan windows may still be char-based, but scan windows are not the same thing as stored units

## 8. Extraction IR Is Not the Graph

V8 does not ingest raw text directly into the memory graph.
It first constructs an evidence-backed extraction layer.

Each item should minimally carry:

- `item_type`
- `subject`
- `predicate`
- `object`
- `qualifiers`
- `origin_type = asserted | aggregated | inferred`
- `evidence_refs`
- `scope`
- `validity`
- `confidence`

But this layer is not yet the durable memory graph.
It is the unit-aligned structured layer used to:

- record what the unit actually expresses inside the bounded vocabulary
- guide offline normalization and graph materialization
- keep extraction taxonomy separate from recall runtime semantics
- preserve exact evidence-backed IR before canonical merging

This separation matters.
The earlier V8 failure mode was low-quality node naming and premature graph materialization.
V8 should not turn raw unit text directly into a runtime memory node.

## 9. Memory Graph, Not Generic Knowledge Graph

The V8 graph is a memory graph.
That means it must model:

- who said it
- when it was said
- whether it is still active
- whether it conflicts with something newer
- whether it is session-local, topic-local, or global

So V8 should carry an explicit three-layer graph rather than a flat memory graph.

### 9.1 Three graph layers

V8 should align with the research report's `micro / meso / macro` graph split:

- `micro`: object graph that answers "what objects, facts, and relations are here"
- `meso`: scene/block graph that answers "what local structure, scene, or workflow block is unfolding here"
- `macro`: arc/structure graph that answers "what longer phase, thread, or global structural movement is unfolding"

The layers are not symmetric.
They carry different node densities, relation scopes, and retrieval roles.
`micro` preserves factual grounding, `meso` carries local structural reasoning, and `macro` carries long-range structural bias.

### 9.2 Node taxonomy

The layers do not share one node ontology.
Each family needs an explicit semantic definition so later extraction and graph materialization do not drift into free-form labels.

`micro` keeps the object/fact taxonomy:

| Category | Node | Meaning |
|---|---|---|
| object | `Entity` | concrete person, organization, location, system, module, document, version, or other first-class object |
| object | `Concept` | abstract concept, term, or definition object |
| mechanism | `Method` | method, strategy, mechanism, workflow, algorithm, or operational scheme |
| mechanism | `Event` | occurrence with actor/action/object/time/place structure |
| property | `Attribute` | descriptive property, status, config, or parameter that is not itself a metric value |
| property | `Metric` | quantified or directly measurable dimension and its value expression |
| proposition | `Claim` | proposition, conclusion, evaluation, or judgment that can be supported or contradicted |
| proposition | `Evidence` | evidence source, experimental result, table, log fact, citation, or direct support object |
| proposition | `Context` | prerequisite, environment, scope, scenario, or constraint backdrop |
| discourse | `DiscourseUnit` | paragraph-level discourse role such as definition, cause, comparison, conclusion, or recommendation |

`meso` uses a scene/block ontology:

| Category | Node | Meaning |
|---|---|---|
| block root | `SceneBlock` | a complete local scene, workflow block, argument block, or semantic block |
| frame | `SituationFrame` | the local background, starting state, or situational setup of the block |
| frame | `ObjectiveBlock` | the immediate goal that the block is trying to advance |
| frame | `ProblemBlock` | the obstacle, conflict, risk, or open issue inside the block |
| response | `StrategyBlock` | the local response path, chosen strategy, or coping direction |
| response | `ProcedureBlock` | the ordered step chain or workflow subgraph used inside the block |
| response | `InteractionBlock` | negotiation, confrontation, cooperation, module interaction, or dialogue exchange block |
| response | `DecisionBlock` | a local judgment, commitment, selection, or finalized choice |
| support | `EvidenceFrame` | the evidence cluster that supports or weakens the block |
| support | `ShiftBlock` | a local turn, switch, flip, or structural pivot |
| support | `OutcomeBlock` | the local consequence, result, or direct response produced by the block |
| support | `BlockFunction` | the role the block plays in a larger structure, such as setup, escalation, pivot, recovery, or resolution |

`macro` uses an arc/structure ontology:

| Category | Node | Meaning |
|---|---|---|
| structure | `Arc` | a complete development arc or major line of evolution |
| structure | `Thread` | a recurring topic line, object line, issue line, or continuing strand |
| structure | `Phase` | a bounded stage such as introduction, instability, recovery, or convergence |
| structure | `GlobalSceneType` | a higher-order global scene pattern such as recovery arc or conflict escalation |
| structure | `Regime` | the global environment, operating paradigm, institutional state, or version regime |
| line | `ObjectiveLine` | a long-running goal line |
| line | `ConflictLine` | a long-running tension or conflict line |
| line | `RelationshipArc` | a long-running relationship evolution line |
| line | `MethodLine` | a long-running method, strategy, or capability evolution line |
| theme | `Theme` | the global theme, motif, or long-range meaning carrier |
| theme | `Pattern` | a recurring structural or behavioral pattern across many blocks |
| theme | `TurningPoint` | a major inflection point, switch, or irreversible pivot |
| theme | `GlobalState` | the global state of the session, chapter, project, or system |

V8 also needs control and overlay nodes that are not part of the three horizontal ontologies:

| Family | Node | Meaning |
|---|---|---|
| memory-control | `Preference` | stable or scoped response preference |
| memory-control | `Goal` | active or long-term goal |
| memory-control | `Constraint` | explicit limit, exclusion, guardrail, or requirement |
| memory-control | `Decision` | explicit committed decision at agent-memory level |
| memory-control | `OpenQuestion` | unresolved issue that still matters for recall |
| memory-control | `ConversationAct` | dialogue act such as correction, request, rejection, or confirmation |
| memory-control | `SessionState` | session-local control or focus state |
| memory-control | `TopicState` | state of a topic branch, such as active, parked, resolved, or conflicted |
| state-overlay | `RelationshipState` | evolving state of a relation or collaboration line |
| state-overlay | `WorkflowValidityState` | whether a workflow or procedure remains valid under current conditions |
| state-overlay | `CompatibilityState` | compatibility or interoperability state between objects, versions, or methods |
| state-overlay | `PreferenceState` | time-scoped or topic-scoped preference state derived from multiple turns |
| state-overlay | `BeliefState` | current asserted, tentative, or revised belief state |
| state-overlay | `RiskState` | risk posture or hazard state that changes over time or regime |

### 9.3 Bounded relation scope

The bounded operating vocabulary is layer-specific.
It is a scope boundary, not a checklist.
Each unit should emit only the relations actually supported by local evidence.

`micro` uses the report-aligned object/fact relation scope:

| Group | Relations | Meaning |
|---|---|---|
| ontology | `is_a`, `instance_of`, `part_of`, `has_part`, `belongs_to`, `equivalent_to` | type membership, composition, belonging, aliasing |
| participation | `performs`, `acts_on`, `uses`, `produces`, `targets` | actor-action-object and operational participation |
| event structure | `initiates`, `involves`, `occurs_at`, `results_in_event` | event triggering, participation, and anchoring |
| causality and condition | `causes`, `caused_by`, `enables`, `prevents`, `requires`, `conditioned_on` | cause, precondition, enabling, blocking, scoped validity |
| time and evolution | `before`, `after`, `simultaneous_with`, `evolves_to` | temporal order and version or state evolution |
| comparison | `better_than`, `worse_than`, `similar_to`, `differs_from` | comparison under aspect, time, or context qualifiers |
| support | `supports`, `contradicts`, `cites` | evidence and proposition support or opposition |
| discourse | `elaborates`, `summarizes`, `contrasts`, `explains`, `concludes`, `recommends` | paragraph or discourse-function relations |

`meso` uses scene/block relations rather than object relations:

| Group | Relations | Meaning |
|---|---|---|
| anchoring and composition | `grounded_in`, `oriented_to`, `focuses_on`, `realized_by`, `evidenced_by_block`, `functions_as` | what local frame the block sits in and how it is realized |
| local dynamics | `triggered_by`, `responds_to`, `constrained_by`, `attempts_to_resolve`, `escalates`, `mitigates`, `reframes`, `revises` | how the block reacts, escalates, mitigates, or reframes a local issue |
| local transformation | `culminates_in`, `leads_to`, `produces_shift`, `stabilizes`, `destabilizes`, `opens`, `closes` | how one local block produces an outcome, turn, opening, or closure |
| block organization | `precedes_block`, `branches_to`, `merges_into`, `parallels`, `contrasts_with_block`, `echoes`, `sets_up`, `mirrors_locally` | how blocks are ordered, mirrored, contrasted, branched, or woven together |

`macro` uses arc/structure relations rather than proposition relations:

| Group | Relations | Meaning |
|---|---|---|
| global structure | `unfolds_through`, `spans_phase`, `organized_as`, `governed_by`, `centered_on_line`, `dominated_by` | how an arc or thread is staged and what structure or regime governs it |
| long-range evolution | `transitions_to_phase`, `evolves_to`, `branches_into`, `converges_with`, `interrupted_by`, `resumes_after`, `culminates_at`, `resolved_by` | phase change, branching, interruption, recovery, climax, and resolution |
| global state and constraint | `produces_state`, `shifts_regime`, `stabilizes_state`, `destabilizes_state`, `constrains`, `enables` | how arcs and turning points reshape global conditions |
| long-range interaction | `competes_with`, `reinforces`, `undermines`, `mirrors`, `recurs_as`, `foreshadows`, `pays_off`, `recontextualizes`, `opens_arc`, `closes_arc` | interaction between lines, themes, patterns, and long-range structure |

Within each layer, extraction should stay inside that layer's bounded relation range.
Absent relation types are simply absent.

The fuller expansion path is still preserved in a separate reference, but the bounded relation scope itself belongs to current V8.

### 9.4 Vertical mappings and state/trajectory overlay

Horizontal edges are not enough.
V8 also needs a classified vertical taxonomy for cross-layer mapping, abstraction, scope, and state change.
This section defines type coverage only.
Whether an edge propagates runtime energy is a separate scanner policy.

| Kind | Count | Purpose |
|---|---|---|
| evidence anchor | `6` | bind higher-level structures back to exact spans, units, and lower-level facts |
| containment | `6` | express hard membership from micro up to meso and macro structures |
| abstraction | `6` | express soft abstraction, summarization, and type lifting |
| line binding | `6` | attach local blocks to long-running lines and arcs |
| scope anchor | `6` | mark phase, time-window, regime, or topic-state validity |
| change and correction | `8` | preserve supersession, activation, invalidation, and correction propagation |

The bounded vertical taxonomy is:

- evidence anchor:
  - `span_in_micro_unit`
  - `mention_maps_to_micro_node`
  - `micro_edge_evidenced_by_span`
  - `meso_block_evidenced_by_span_set`
  - `macro_node_evidenced_by_span_set`
  - `state_evidenced_by_block`
- containment:
  - `micro_unit_in_meso_unit`
  - `micro_node_in_meso_block`
  - `micro_edge_in_meso_block`
  - `meso_unit_in_macro_unit`
  - `meso_block_in_phase`
  - `phase_in_arc`
- abstraction:
  - `micro_fact_abstracted_as_block`
  - `micro_claim_summarized_by_block`
  - `block_instantiates_global_type`
  - `block_summarized_by_topic`
  - `block_contributes_to_pattern`
  - `line_summarized_by_theme`
- line binding:
  - `local_goal_in_objective_line`
  - `local_conflict_in_conflict_line`
  - `local_method_in_method_line`
  - `local_relationship_in_relationship_arc`
  - `local_event_in_thread`
  - `local_shift_to_turning_point`
- scope anchor:
  - `state_valid_in_phase`
  - `state_valid_in_timewindow`
  - `block_scoped_to_regime`
  - `block_scoped_to_topicstate`
  - `thread_spans_timewindow`
  - `block_updates_global_state`
- change and correction:
  - `state_supersedes_state`
  - `state_refines_state`
  - `state_changed_by_event`
  - `state_opened_by_block`
  - `state_closed_by_block`
  - `state_invalidated_under_regime`
  - `state_reactivated_under_regime`
  - `correction_propagates_to_line`

### 9.5 Layer allocation and vertical semantics

Not every layer answers the same question.
The three runtime layers should specialize as follows:

- `micro` focuses on objects, facts, exact evidence anchors, and local relation cues
- `meso` focuses on local scene structure, workflow blocks, shifts, and local resolutions
- `macro` focuses on phases, threads, arcs, regimes, turning points, and long-range structure

Vertical mappings are mandatory, not optional helpers.
They are what keep `graph -> evidence span -> raw text` reliable across layers and what prevent later designers from confusing:

- hard membership with soft summarization
- local scene structure with long-range line membership
- state validity with ordinary semantic relations

### 9.6 Edge qualifiers and classification metadata

For full-text multilingual understanding, edges need structured qualifiers.
At minimum the architecture should reserve:

- `aspect`
- `time`
- `context`
- `polarity`
- `certainty`
- `evidence_unit_ids`

Vertical and state-overlay edges also need explicit classification metadata so later implementations do not infer semantics from names alone:

- `kind`: `evidence_anchor | containment | abstraction | line_binding | scope_anchor | change`
- `hardness`: `hard | soft`
- `requires_scope`: whether the edge is incomplete without phase, time-window, topic-state, or regime context
- `stateful`: whether the edge participates in state validity, supersession, or correction logic

This is especially important for relations like `better_than`, `worse_than`, `supports`, `contradicts`, `conditioned_on`, and for all scope or change edges.
Without qualifiers and classification metadata, the graph will flatten nuanced text into brittle generic edges.

### 9.7 Runtime graph and propagation

The online three-layer graph still matters, and it should propagate across these different semantics without flattening them.
The runtime constraint is sparse activation, not ontology collapse:

- each layer carries its own semantics
- each node only carries the relations actually supported by evidence
- vertical edges remain typed even when runtime propagation chooses not to transmit through them
- propagation remains top-k, damped, cooldown-aware, and scene-gated
- online scoring can weight `micro`, `meso`, and `macro` differently without forcing them into one shared relation family

This keeps online ignition lean without distorting the extracted relation space.

## 10. Online Trigger Windows and Propagation

The ignition layer should remain boundary-aware and cheap.
The old V8 instinct was correct here, even if the surrounding architecture was wrong.

### 10.1 Window model

Recommended online windows remain char-based rather than tokenizer-bound:

| Window | English heuristic | Chinese heuristic | Purpose |
|---|---|---|---|
| `micro` | `24-48` chars | `12-24` chars | lexical ignition and phrase cue |
| `meso` | `96-192` chars | `64-128` chars | sentence or clause semantics |
| `macro` | `256-512` chars | `192-384` chars | rolling thought state |

These windows are not storage units.
They are runtime scan windows.

### 10.2 Boundary policy

Scans should run at:

- punctuation boundaries
- code fence boundaries
- paragraph boundaries
- hard char thresholds

Not every chunk should trigger a full scan.

### 10.3 Ignition score composition

The runtime score should be explicit and stable enough to reason about.

Recommended decomposition:

`u_i = baseGain * (a * g_lex + b * max(g_scene, g_ctrl) + c * g_time)`

Recommended default intuition, aligned with the current `scanner.ts` implementation:

- `a = 0.45` for lexical ignition
- `b = 0.35` for scene or control overlap
- `c = 0.20` for temporal availability
- `baseGain = 1.4` for initial prompt pre-excitation and `1.0` for normal stream scans

Scene bias is separate from direct chunk injection.
Its current shape is roughly:

- `0.60` lexical scene hit
- `0.25` scene or control overlap
- `0.15` temporal availability

The architecture should preserve the split between direct ignition and scene carry.

### 10.4 Propagation rule: Biomimetic Spreading Activation

The graph should support sparse bidirectional propagation modeled after biological neural activation (Spreading Activation). The propagation equation ensures that energy decays predictably and avoids memory storms.

The biomimetic propagation follows this core formula per propagation step:
`ΔEnergy_target = Energy_source × SynapseWeight × DirectionGain × (1 / √Degree_target) × CooldownFactor`

Where:
- `SynapseWeight` models long-term potentiation (LTP) and starts at 1.0 but adapts over time.
- `DirectionGain` enforces stronger forward spread for likely continuation (e.g. `0.30`) and weaker reverse spread for causal backtracking/reminder (e.g. `0.15`).
- `1 / √Degree_target` is the critical **Hub Penalty**. It acts as lateral inhibition, suppressing generic high-degree nodes (e.g., "API", "system") from absorbing and rebroadcasting uninformative energy.
- `CooldownFactor` enforces a refractory period, preventing nodes that just fired from dominating consecutive cognitive cycles.
- A global `decayLambda` removes stale energy between scans.

The runtime should preserve:

- `topKEdges` restriction in both directions
- distinct node and bundle cooldown windows
- separate scene-bias decay from activation decay
- second-wave recall after one propagation pass

The current defaults are a reasonable architectural anchor:

- `forwardGain = 0.30`
- `reverseGain = 0.15`
- `hubPenaltyPower = 0.50`
- `topKEdges = 6`
- `decayLambda = 0.95`

### 10.5 Episodic locality

Episodic memory should not be globally loud.
Day and episode windows should gate activation.

Rules:

- semantic and procedural memory remain globally available
- episodic nodes activate locally through day, episode, and evidence overlap
- if the scene has no overlap with an episode window, that episodic branch stays silent

Day-local activation should remain a first-class runtime rule.
When a live chunk or scene signal warms an episodic node, its `dayKey` becomes eligible for that scan window.
Propagation into episodic memory outside the active day set should be suppressed.

### 10.6 Bundle-first delivery

Online ignition may score at node level, but delivery should happen at bundle level.
This is how V8 avoids injecting isolated graph fragments without source grounding.

Delivery should preserve three more rules:

- bundle energy is aggregated from warm nodes and scene bias
- tier threshold is applied after bundle aggregation, not before
- bundle tier is an insertion strategy, not a graph node type

Current defaults in `scanner.ts` are also useful as architectural guidance:

- `criticalThreshold = 0.82`
- `decisionThreshold = 0.74`
- `backgroundThreshold = 0.68`
- `secondWaveThreshold = 0.78`
- `maxInjectedBundles = 2`

### 10.7 Edge-kind propagation policy

V8 should not apply one propagation policy to all edge kinds.
The graph remains fully typed, and runtime decides how each edge kind participates.

| Edge kind | Runtime role | `profile` recall | `trajectory` recall | `oblique` recall | `audit` recall |
|---|---|---|---|---|---|
| semantic and discourse (horizontal) | associative spread | full spread | medium spread | medium spread | low spread |
| containment | structural bridge | strong bi-directional spread | strong bi-directional spread | medium spread | low spread |
| abstraction and line_binding | structural abstraction | weak upward spread | medium upward spread | strong upward spread | low spread |
| scope_anchor | validity gate | gate only | gate only | gate only | gate only |
| change | state reweighting | reweight only | reweight + lineage traversal | reweight + local review marks | lineage traversal only |
| evidence_anchor | grounding/backtrace | backtrace only | backtrace only | backtrace only | backtrace mandatory |

Rules:

- `scope_anchor` edges should not inject energy; they only mask, enable, or slice candidates.
- `change` edges should not behave like ordinary associative edges; they should suppress superseded states and lift active states.
- `evidence_anchor` edges are for provenance traversal and pack grounding, not spread amplification.
- propagation weights remain scanner configuration, but this edge-kind contract is architectural.

Machine-readable defaults live in:

- `memory-enhanced/schema/v8-edge-runtime-policy.json`

### 10.8 Recall slicing modes

V8 needs explicit recall modes so "current snapshot answer" and "full lifecycle answer" do not fight each other.

| Mode | Primary question | Main edges | Default output |
|---|---|---|---|
| `profile` | what is true now | semantic + containment + scope + change reweight | concise `SummaryPack + StatePack`, optional minimal raw evidence |
| `trajectory` | how it changed over time | change + scope + containment + evidence backtrace | lifecycle summary with phase/time slices and key turning spans |
| `oblique` | what related lines may matter | abstraction + line_binding + selective semantic expansion | cross-line hypothesis bundle plus supporting evidence |
| `audit` | why the system answered this | evidence_anchor + change lineage + scope anchors | provenance-first pack with explicit span citations |

Mode selection should be query-driven:

- default to `profile` for ordinary Q&A and live generation support
- switch to `trajectory` when the request asks for history, evolution, versions, or "how we got here"
- switch to `oblique` when the request asks for analogies, side effects, adjacent risks, or indirect relations
- force `audit` for debugging, compliance, or memory-quality inspection

This is how V8 answers both:

- "What is the relationship now?" -> likely latest active state
- "How did this relationship evolve?" -> preserved historical lineage

### 10.9 Evidence-safe exploration lane

V8 can support long-distance association discovery without violating evidence-backed memory.

Rules:

- exploration edges are stored as `hypothesis` artifacts, not canonical graph facts
- hypothesis edges carry `supportEvidenceSpanIds` and `inferenceTrace` but remain low-confidence
- hypothesis edges are excluded from `profile` mode by default
- `oblique` mode may use hypothesis edges only when bundled with explicit support evidence
- promotion to canonical inferred edges requires consolidation validation and evidence checks
- stale or repeatedly unsupported hypotheses should decay out

This keeps exploratory creativity available while protecting day-to-day recall precision.

### 10.10 Graph-guided archive search (anti-noise-storm retrieval)

Status: frozen/deferred until V8 core delivery is complete.

V8 should include an explicit second-stage archive search path, but keep it graph-guided.

Goal:

- avoid pure top-k lexical/vector noise storms
- let the model retrieve deeper evidence only when needed
- preserve span-grounded provenance

Serving contract:

- first inject compact graph memory (`micro`/`group` bundle hints, active state hints)
- if memory is incomplete for the current answer, let the model call archive search
- archive search returns `span` hits first, then raw narrative slices by offsets

Interface (contract-level):

- `memory_search_archive(query, mode=hybrid|bm25|vector, top_k, hint_span_ids?, hint_bundle_ids?)`
- returned item should contain at least:
  - `span_id`, `unit_id`, `score`
  - `narrativeRef`, `charStart`, `charEnd`
  - `span_text`, `raw_text`

Rerank priority:

- structural fit to activated graph neighborhood
- scope and mode fit (`profile|trajectory|oblique|audit`)
- evidence density and contradiction risk

This is the missing piece over plain Mem0/LanceDB-style retrieval:

- graph gives the model high-quality search direction
- BM25/vector gives broad candidate coverage
- span-first grounding prevents large irrelevant payload injection
- vertical/oblique relations can be searched deliberately, not by chance

## 11. Where `knowledge` and `skill` Fit

`knowledge` and `skill` remain first-class inputs, but their role changes.

### 11.1 `knowledge`

`knowledge` is curated long-term semantic memory.
It usually produces items such as:

- concept
- claim
- evidence
- context
- method

### 11.2 `skill`

`skill` remains important.
It should not be reduced to "knowledge with kind = procedural".

It usually produces items such as:

- method
- workflow step
- precondition
- constraint
- checkpoint
- failure mode
- recovery path

`skill` therefore becomes a procedural branch inside the same memory graph, not a separate graph system.

## 12. What Replaces Old V8 Distillation

The old design often treated distillation as:

- event filtering
- md rewrite
- optional graph rebundling

The new design replaces that with:

1. raw evidence preserved
2. source normalization
3. unitization and span extraction
4. IR extraction
5. graph materialization
6. summary and state materialization

Distillation is therefore no longer "write a smaller event".
It is "derive stable memory products from evidence-backed IR".

### 12.1 Decay scope (what ages, what never ages)

V8 still needs decay, but not on raw evidence.

Decay applies to:

- runtime projections (activation, cooldown, hit/adopt counters)
- graph node/edge weights and recency features
- hypothesis edges and other non-canonical exploratory artifacts
- bundle/pack hotness caches

Decay does not apply to:

- raw sources, units, or evidence spans
- canonical evidence-backed facts (only their activation weight and recency metadata)

## 13. Context Assembly and Procedural Memory

The system should not inject only one kind of memory object.
Further, to mimic biological **Procedural Memory (Chunking)**, the system should actively cache and reuse the outputs of frequently triggered bundles to avoid redundantly invoking LLM reasoning for settled history.

V8 should assemble three runtime products:

- `Raw Evidence Pack`
- `Memory Summary Pack`
- `Structured State Pack`

### 13.1 Bundle Output Caching (Procedural Shortcut)

When the online ignition scanner elevates a graph neighborhood into an `ActivatedBundle`, the context assembly layer should attempt an output shortcut before forcing the LLM to process the raw nodes again:

1. **Fingerprinting**: Generate a signature (hash or ID set) for the current highly-active node-cluster.
2. **Lookup**: Check if this exact cluster was recently resolved into a `Memory Summary Pack` or `Structured State Pack`.
3. **Shortcut**: If found, directly assemble the cached text output into the Context. This turns expensive declarative reasoning into fast procedural memory.
4. **Resolution**: If the bundle is new or significantly altered (e.g., a node was introduced indicating a new conflict), pass the bundle to the LLM for resolution.
5. **Default persistence**: Persist summary/state outputs even for low-frequency bundles. The cache is small relative to raw logs.
6. **Default TTL**: Cached packs expire after 7 days unless marked as required by the user or LLM.

This keeps the system light while avoiding repeated LLM summaries, even for low-frequency bundles.

### 13.2 Selection policy

- prefer raw evidence when wording matters
- prefer summary when stable background matters
- prefer state when branch control or conflict resolution matters
- active branch state and unresolved conflicts favor structured state

### 13.3 Immediate Correction Loop (Hot-Patching)

The offline pipeline (`L1 -> L6`) can be slow. When the user asserts a strong correction ("No, stop using Redis, use MySQL immediately"), waiting for the next offline graph consolidation is unacceptable. The system must support **Instantaneous Weights and Shadow Nodes**.

1. **Correction Detection**: The scanner flags `Correction` dialogue acts from the raw stream.
2. **Shadow Node Insertion**: A temporary `BeliefState(Revised)` node is immediately spawned in memory (L0/L7 hybrid layer), bypassing the L1-L6 pipeline.
3. **Negative Spike**: The superseded entity ("Redis") receives a massive, temporary negative activation spike (`-1.0`), effectively silencing it in the current propagation cycle.
4. **Hot-Patch Assembly**: The Context Assembler injects the Shadow Node directly into the active Context.
5. **Offline Consolidation**: During the next offline cycle, the L5 Consolidator promotes the temporary Shadow Node into a permanent `state_supersedes_state` edge in L6, formally overwriting the historic weights in the long-term graph.

## 14. Consequences for the Existing Codebase

The old V8 compiler path is effectively deprecated:

- direct `event -> bundle/node/edge`
- direct `knowledge -> bundle/node/edge`
- direct `skill -> bundle/node/edge`

The new target path is:

- source adapters produce normalized narrative records
- unitizers produce units and evidence spans
- extractors produce memory items
- graph materializer produces graph nodes and edges
- summary/state materializer produces recall products

Offline annotation still matters, but only as a secondary stage:

- for low-confidence meso units
- for conflict resolution
- for difficult relation extraction
- for controlled rebuild of graph structure

It is no longer the place where basic memory structure first appears.

### 14.1 Build Profiles (Development)

- `full`: compile all narrative docs
- `incremental`: compile only changed docs
- `hybrid` (default): changed docs + recent hot window (current default `48h`)
- optional dev knob: `max_narrative_docs` for tuning speed during prompt/parameter iteration
- optional diagnostics-only run: `plan_only=true` to inspect hot/cold scope without recompiling artifacts
- each run writes diagnostics to `.memory/runtime/build_report.json` and `.memory/runtime/build_report.md` for tuning
- diagnostics include source cleaning volume and impact (`rawChars/cleanChars/removedChars`, `touchedRecords/removedRatioPct`) for cleaning-regression checks
- partial runs (`max_narrative_docs`) do not update the incremental manifest baseline
- source-stage narrative assembly is append-only for `session_*_narrative.md` (no stale file pruning)

Temporary marker is kept in code to avoid forgetting cleanup:

- `TODO_REMOVE_BEFORE_RELEASE__V8_FAST_BUILD_DEFAULTS`

## 15. Migration Rule

During migration:

- keep `L0 Control` untouched
- preserve raw daily logs and session traces as the new authority
- treat old `event` records as legacy hints
- continue to read old curated `knowledge` and `skill` documents
- rebuild graph and summary/state from the new IR path instead of patching old node bundles

This means the rewrite is not a cosmetic rename.
It is a shift from event-centric compilation to evidence-backed memory compilation.
