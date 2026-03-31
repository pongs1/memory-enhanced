# V8 Architecture Rewrite Design

Status: draft for review
Audience: maintainers, future contributors, agent-memory researchers

## 1. Core Problem

V8 addresses long-term memory formation and recall under constrained context windows.

Three problems define the design target:

1. Important events may have happened and been recorded, but when they are not present in the current context, the model does not reliably realize that memory lookup is needed.
2. Even when the history contains critical clues, deep relations, or state changes, the model still tends to solve from the visible context instead of following memory to retrieve evidence.
3. If the memory system only works on custom examples and cannot perform well on authoritative benchmarks, it is difficult to argue that the design is actually valid.

V8 is meant to let the model know, when needed:

- what happened before;
- which parts of the past are relevant to the current task;
- which line to continue following;
- and, ideally, to receive enough `detail / summary / state` to keep working.

Short form:

> V8 is not a system for merely storing history. It is a system that lets the model know what happened before, where evidence may exist, and how to retrieve it when needed.

## 2. System Definition

V8 is a coupled dual-system memory architecture:

- the background system turns experience into memory structures that are searchable, ignitable, and traceable;
- the foreground system actively recalls those structures during generation and continues searching for evidence when the current memory payload is insufficient.

These two spines coexist.

V8 also includes a `feedback learning side path` attached to foreground recall. It is not a third main spine. It aligns recall delivery with later user/model/tool outcomes as recall-adjustment signals.

The shared memory products of V8 are:

- `narrative`
- `memory IR`
- `graph`
- `bundle`
- `pack`

The overall structure can be compressed into one sentence:

> `narrative` provides the evidence surface, `memory IR` provides the structural skeleton, `graph` provides life and linkage, `bundle` provides runtime aggregation, and `pack` provides final delivery.

## 3. Core Principles

### 3.1 Evidence-Backed Source Policy

All high-level memory objects in V8 must remain evidence-backed and operate primarily on normalized `narrative`. V8 does not allow inferred content to masquerade as original fact.

The evidence chain for high-level objects lands on:

`graph node/edge -> memory IR item + evidence span -> narrative unit -> narrative record -> raw archive`

- `memory IR item`
  - one IR extraction result with evidence anchors.
- `evidence span`
  - a locating property of the `memory IR item` that points the IR result back to the `narrative unit`.
- `narrative record`
  - one normalized narrative record that can be stored, replayed, and traced.

At the source-policy level:

- `raw archive`
  - preserves append-only original records;
  - serves as the lower surface for fallback, validation, drill-down, and recovery.
- `narrative`
  - is assembled from `raw archive` through structural cleaning and temporal ordering;
  - is the default authoritative evidence surface and the starting point for unitization, IR extraction, and most recall.

## 4. Shared Memory Products

### 4.1 Narrative

`narrative` is the continuous evidential narrative surface produced from `raw archive` through structural cleaning and temporal assembly. It is used for `unitization`, IR extraction, recall, and search.

### 4.2 Memory IR

`memory IR` is the intermediate structured layer extracted from `narrative` with explicit evidence anchors. Its role is to transform entities, relations, states, changes, and local summaries in text into intermediate memory structures that can be consolidated, checked, and materialized. One IR extraction output may be referred to as a `memory IR item`.

### 4.3 Graph

`graph` is the long-term relational organization layer formed from `memory IR` after `normalization / consolidation`. It maintains entities, relations, states, cross-time cues, and the propagatable structures needed by recall.

This is where memory begins to gain life:

- `narrative` has text, but not life;
- `memory IR` has structure, but not yet a real lifecycle;
- only at `graph` do durable relation, evolution, replacement, and cross-time linkage appear.

Only once the system reaches `graph` can the same objects and relations persist across slices, enter a local activation region through ignition, move further across relations and slices, and finally be organized into `bundle` and `pack`.

`graph` also contains persistent `serving views` prepared for recall.

### 4.4 Temporal And Oblique Recall Geometry

For recall, memory has at least three directions:

- horizontal: which objects, relations, and states hold together within the same moment or slice;
- temporal: how the same object, relation, or state changes across time;
- oblique: how a change in one object or relation across time affects another object, relation, or state.

Here `temporal` specifically refers to the axis of time, validity, and state change. `macro / meso / micro` are the hierarchical scales from narrative to IR, not the temporal axis of graph recall geometry.

The fourth dimension lands on the `graph` layer without breaking the `node / edge` boundary. `node` still carries entity/object meaning, and `edge` still carries relation meaning; the temporal axis operates on the graph through relation-associated time slices and validity slices.

When foreground input arrives, `ignition` opens a local activation region inside the graph under the constraints of the current input. That region does not preselect horizontal, temporal, or oblique motion. Instead, it supports local free movement across slices and relation directions within bounded constraints. Horizontal, temporal, and oblique recall are the propagation paths that actually emerge inside that activated region.

Time slicing follows a hybrid strategy:

- light `turn/window` slices are preserved by default;
- explicit changes create sharper slices when needed;
- a small number of high-value oblique couplings are persisted;
- the remaining oblique relations are assembled dynamically during recall from current cues.

Lifecycle geometry becomes active only at graph recall time.

### 4.5 Bundle

`bundle` is the hot runtime aggregation layer between `graph` and `pack`. It organizes a group of graph objects that are lit together, ranked together, and searched together in the current round into one local memory region for recall-time selection, competition, and propagation.

`bundle` is not delivered directly to the LLM. Its identity is defined by local runtime aggregation.

### 4.6 Pack

`pack` is the foreground working-memory carrier delivered to the LLM. It organizes the `detail / summary / state / raw evidence / search hints` that are actually needed under the current task and control state into directly consumable context.

- `detail`
  - concrete historical details needed to continue the current task.
- `summary`
  - stable background, phase structure, and compressed context.
- `state`
  - current valid state, state changes, and branch-control information.
- `raw evidence`
  - evidence fragments that preserve original wording.
- `search hints`
  - entity, relation, scope, and direction cues for further retrieval.

`pack` serves both question answering and ongoing task execution.

Its evidence binding is inherited from corresponding IR and graph grounding, and continues to be used during evidence expansion and search.

`pack` has two formation paths:

- `direct pack`
  - assembled directly from `narrative / detail / state` fragments.
- `compiled pack`
  - produced after one LLM pass that reorganizes or summarizes the content.

### 4.7 Summary And State Products

`summary pack` and `state pack` both come from evidence-backed IR and graph neighborhoods.

- `summary pack`
  - carries reusable compressed background;
  - its role is to compress stable background, project context, long-term setting, and repeatedly useful information into low-token working memory.
- `state pack`
  - carries current valid state, previous state, direction of change, and branch control;
  - its role is to let the model know what state it is in now, what came before, and how the change happened.

Both pack families remain bound to narrative evidence.

### 4.8 Graph-Derived Products

`knowledge`, `skill`, `setting`, and `agent coordination protocol` are downstream products of graph.

- `knowledge`
  - is produced when a graph neighborhood is repeatedly activated, remains evidence-backed, and is summarized into reusable semantic output.
- `skill`
  - is the procedural branch of the same mechanism;
  - when a stable neighborhood describes reusable workflow, constraints, checkpoints, or recovery paths, it can settle into a skill product.
- `setting`
  - is produced when a stable neighborhood describes long-lived setting, role constraints, world rules, project background, or premises that should not drift across rounds.
- `agent coordination protocol`
  - is produced when a stable neighborhood describes repeatedly reused coordination language, interaction protocol, search style, thinking style, or collaboration signal across agents.

`knowledge` and `skill` are already direct graph-product directions in the current architecture. `setting` and `agent coordination protocol` are higher-order distillations from neighborhoods that stay highly active across repeated activations. As they continue to rise, they are not copied wholesale into the `system prompt`. Instead, the `system prompt` carries stable indices or seeds, while the corresponding `procedure` is a tightly coupled, high-energy bundle cluster that can be lit quickly as a whole. Once one or two key cues are hit at runtime, the entire cluster lights up and triggers the corresponding `pack`, producing a recall shortcut close to conditioned reflex.

These products must continue to bind:

- the node cluster that produced them;
- the evidence spans that support them;
- the graph neighborhood that can reactivate them.

## 5. Background Memory-Formation Spine

At the highest level, the background spine is:

1. `raw archive -> narrative`
2. `narrative -> unit`
3. `unit -> memory IR`
4. `memory IR --(normalization / consolidation)--> graph`
5. `graph -> packs`

### 5.1 Raw Archive To Narrative

`raw archive -> narrative` performs structural cleaning and temporal assembly rather than semantic rewriting. Its goal is to transform heterogeneous raw material into a stable, replayable, sliceable, searchable narrative evidence surface.

### 5.2 Narrative Normalization

Normalization converts heterogeneous source into a stable source contract while preserving evidential value.

Information that must be preserved or reconstructed includes:

- source path or source id;
- session id, turn id, message id;
- speaker;
- timestamp;
- character or line offsets;
- original raw text.

Core normalization rules:

- strip prompt scaffolding, tool wrappers, injected memory blocks, and control noise;
- preserve a span map so that evidence spans still resolve to narrative offsets;
- `narrative` is the canonical cleaned surface;
- most runtime observations should enter `narrative`; only extremely long, noisy, or fragmented content may be trimmed under control, and even then the remaining record must preserve enough information to trace back to the original material.

### 5.3 Unitization

`unit` is the layer where the background spine begins to take on memory structure.

`micro / meso / macro` are the vertical scales from narrative to IR.

Definitions:

- `micro`
  - the smallest storage-grade semantic evidence unit that still remains coherent, typically carrying a local cue, condition, comparison, or relation fragment;
  - in practice, often a clause-level, sentence-level, or short-span semantic fragment.
- `meso`
  - a stable local semantic block, usually sufficient to support one reasoning step, proposition cluster, or discourse function.
- `macro`
  - a longer topic, phase, or time-window context.

Unitization rules:

- offsets are first-class;
- unit text comes from `narrative`;
- cutting follows semantics and discourse closure;
- char/token length acts only as a guardrail.

### 5.4 Unit To Memory IR

`unit -> memory IR` extracts bounded, evidence-backed structured items from narrative units.

IR must at least be able to express:

- entities and objects;
- relations and propositions;
- states and changes;
- local summaries and discourse roles;
- the evidence anchors that support them.

### 5.5 Normalization And Consolidation

`normalization / consolidation` merges IR into stable graph.

Its responsibilities are:

- deduplicate and normalize extraction instances;
- merge aliases and repeated evidence-backed relations;
- reject noisy or weakly supported outputs;
- consolidate durable memory objects;
- preserve semantic separation across layers.

Two things must remain distinct:

- `raw-text instantiation`
  - what the original text actually instantiated here.
- `stable-memory consolidation`
  - how V8 consolidates those expressions into durable memory.

### 5.6 Compiler Boundary

The background compiler boundary can be stated stably as:

1. `source adapters` transform raw records into `narrative records`
2. `unitizers` cut narrative records into `units` while preserving a traceable span map
3. `IR extractors` derive `memory IR items` from units and attach `evidence spans` to claims
4. `graph materializers` consolidate IR into graph nodes / edges and emit the `serving views` needed by recall
5. `summary/state materializers` produce packs consumable at runtime

### 5.7 Cross-Archive Relation Mining

In addition to the main compilation spine, the background system needs a `graph-guided relation mining` lane for graph building. It is initiated by a background LLM around stable anchors such as entities, objects, methods, goals, decisions, constraints, and state objects, and is meant to recover long-range relation structure that cannot fit inside a single context window.

Its goals are:

- to recover distant relation evidence for anchors across the full archive;
- to discover relations that cross time, slices, and topics while still stably attached to the current anchor;
- to supply graph with new horizontal, temporal, and oblique relation candidates.

Its integration with the current graph is:

- graph supplies anchors, existing neighborhoods, relation-direction hints, and time/state cues;
- archive search supplies candidate evidence from full-history `span / unit` indexes;
- the background LLM performs relation review over compact evidence packs and states whether a relation holds, between which anchors, in which direction, under which time/validity slices, and with which evidence support;
- `normalization / consolidation` turns that review result into a graph relation through anchor alignment, deduplication, merge, conflict handling, and slice assignment; semantic judgment itself is not repeated there;
- the cleaned relation result lands directly in graph.

In the current design, temporal cues come from the graph's own time slices, change/evolution relations, validity windows, and other temporal organizations.

The standard path is:

1. select anchor entities / objects / methods / goals / decisions / constraints / state objects from graph;
2. generate a graph-guided search plan from current neighborhood, relation direction, and time/state anchors;
3. search the full archive span corpus with `BM25 + vector`;
4. rerank using graph-guided hints, anchor-class hints, and relation-direction hints;
5. assemble compact evidence packs for the background LLM to perform relation review and produce graph-landable relation conclusions;
6. return those conclusions to `normalization / consolidation` for graph landing.

The search planner still keeps three lanes:

- `focused`
- `broadened`
- `exploratory`

These correspond to high-confidence anchor-near relations, second-ring relations under relaxed priors, and low-prior long-range relations that may still be valuable.

## 6. Online Recall Spine

At the highest level, the foreground spine is:

1. `active text signals + L0 -> ignition`
2. `ignition -> bundle selection`
3. `bundle -> pack injection`
4. `insufficient pack -> search escalation`

`ignition` is the entry step of foreground recall: the system decides which memory regions in graph should be lit first based on the input currently being processed and the current control state. `L0` is the task control plane that carries goal, active task, latest request, handoff, and related control anchors.

### 6.1 Runtime Inputs

Ignition inputs include:

- `active text signals`
  - fragments from the current user / assistant / tool / subagent / feedback / working-state stream.
- `control anchors`
  - explicit current control conditions such as goal, active task, latest user request, and handoff.
- `serving hints`
  - lightweight hints used only for ignition and search, such as trigger terms, entity cues, and search hints.

### 6.2 Key Runtime Formulas

Ignition first performs candidate matching and then injection scoring. Candidate matching is done through `serving views`, which expose names, aliases, trigger terms, short summary text, and bundle membership. Scan-window size and boundary policy belong to the pipeline layer.

The result of ignition is not a preselected decision to go horizontal, temporal, or oblique. Instead, ignition opens a local activation region in graph under the constraints of the current input. Propagation then performs local free movement inside that region, and the actual reachable nodes, slices, and edges determine what bundles emerge.

The direct injection score for a candidate node remains:

`u_i = baseGain * (a * g_lex + b * max(g_scene, g_ctrl) + c * g_time)`

Where:

- `u_i`
  - direct injection score of candidate node `i`.
- `g_lex`
  - strength of lexical or trigger-term match.
- `g_scene`
  - overlap with the current local semantic window. Here `scene` is the local semantic field formed by recently processed text and control signals.
- `g_ctrl`
  - overlap with explicit control anchors.
- `g_time`
  - temporal availability or episodic locality score.
- `baseGain`
  - initial activation gain of the current input fragment. Initial prompt or explicit pre-heating gains are higher; ordinary streaming input gains are lower.
- `a, b, c`
  - tunable weights for lexical, current-signal, and time factors.

This formula describes direct ignition from the current input. Cross-round continuation is carried by `node residual energy`; slice-aware local movement is handled by the propagation stage.

`bundle` ranking is still computed on activated graph runtime products:

`bundle_energy = activated_node_energy + scene_bias + state_bias - cooldown_penalty`

Meaning:

- `activated_node_energy`
  - aggregate contribution of currently hot nodes, already including residual energy after current-round injection.
- `scene_bias`
  - additional lift from the current local semantic window.
- `state_bias`
  - lift from currently active state representations or injected state memory.
- `cooldown_penalty`
  - short suppression applied to recently delivered bundles.

### 6.3 Propagation And Leaky Residual Ignition

Propagation uses `leaky residual ignition`. Every node keeps its own residual energy; before each round starts, the previous residual decays, current-round text injection is added, and then one forward spread and one weaker reverse spread are executed inside the local activation region. Residual energy below threshold is zeroed and no longer participates in the next round.

This propagation process does not switch into a preset horizontal, temporal, or oblique mode. Instead, it performs constrained local free movement along strong edges, slice boundaries, time/validity constraints, and cooldown constraints inside the activated region.

Cross-round node updates remain:

`Energy_i_pre = decayLambda * Energy_i_prev`

`Energy_i_post = Energy_i_pre + u_i`

Single-step added propagation energy remains:

`ΔEnergy_target = Energy_source × SynapseWeight × DirectionGain × (1 / √Degree_target) × CooldownFactor`

Node energy at the end of the round remains:

`Energy_i_next = Energy_i_post + ΔEnergy_i_forward + ΔEnergy_i_reverse`

If `Energy_i_next < stopThreshold`, the node energy is zeroed.

Meaning:

- `SynapseWeight`
  - long-term edge weight or memory reinforcement weight.
- `DirectionGain`
  - forward spread gain is usually stronger than reverse spread gain.
- `1 / √Degree_target`
  - hub penalty that suppresses over-absorption and rebroadcast by high-degree generic nodes.
- `CooldownFactor`
  - short suppression factor that prevents just-triggered nodes from dominating again too quickly.
- `decayLambda`
  - global decay that clears stale activation across scan rounds; it is not per-edge transfer.
- `stopThreshold`
  - threshold below which a node stops retaining residual energy.

Runtime constraints:

- `topKEdges` restriction in both directions, so each node spreads only through a small number of strongest edges per direction;
- separate `node cooldown` and `bundle cooldown`;
- separate `scene-bias decay` and `activation decay`;
- exactly one forward spread and one weaker reverse spread per round, with no infinite same-round cascade;
- `second-wave recall` is carried only by fresh injection in the next round.

Default parameters and tuning ranges belong in the pipeline document.

### 6.4 Episodic Locality

`episodic / semantic / procedural` here express differences in recall availability.

- graph branches with explicit day, episode, or source identity
  - need local gating at runtime;
- branches representing stable background, long-term facts, or reusable methods
  - can remain globally available and should not be constrained by the same day/episode rules.

Episodic locality is a gating layer on top of graph recall geometry.

Rules:

- branches related to stable factual background and reusable methods remain globally available;
- graph branches with explicit day, episode, or source binding become active only through overlap between those bindings and the current local semantic window;
- if the current local semantic window has no overlap with a given episode window, the corresponding episodic branch stays silent. An `episode window` is the time window associated with one experience segment.

Day-local activation is first-class: once the currently processed text fragment or current local semantic signal hits an episodic node, the corresponding `dayKey` becomes eligible in the current scan window. `dayKey` is the day-bucketed episodic identifier.

### 6.5 Bundle-First Delivery

Delivery happens at the `bundle / pack` layer.

A recall delivery unit needs to carry:

- the most relevant evidence references;
- summary or decision text;
- tier, meaning runtime delivery priority;
- affected node ids, meaning which nodes are covered by this delivery.

The bundle / pack selection order is:

1. aggregate node activation and scene bias into bundle energy;
2. determine bundle tier after aggregation;
3. apply the threshold of that priority tier;
4. suppress bundles still in cooldown;
5. select only a very small top-k for injection.

`bundle tier` is a runtime delivery-priority layer. `bundle` itself does not store energy; it only aggregates the high-energy nodes of the current round.

### 6.6 Pack Injection Policy

This section defines the injection form and injection timing of pack.

`direct pack` is suitable for low-latency injection; `compiled pack` is suitable for more stable context organization. Therefore:

- the default direction favors `compiled pack`;
- `direct pack` is the low-latency fallback;
- after a direct pack is delivered, a more reusable compiled cache should be generated asynchronously;
- `L0` must keep aligning with the current task during injection so that pack does not pull the model away from the main line.

### 6.7 Context Assembly

Runtime recall ultimately assembles context from three pack families:

- `RawEvidencePack`
  - a pack that carries direct raw evidence fragments.
- `MemorySummaryPack`
  - a pack focused on compressed background and long-term structure.
- `StructuredStatePack`
  - a pack focused on current state, before/after change, and branch control.

Selection policy:

- use raw evidence first when original wording matters;
- use summary first when stable background matters;
- use state first when branch control, state conflict, or before/after change matters.

Graph helps select candidates, but final content still lands on concrete evidence.

### 6.8 Search Escalation

When the current pack is insufficient to support further work, search escalation descends along already activated memory cues.

The first principle is to continue searching along narrative evidence directly bound to the currently activated bundle.

The main axis of search scope is the current cue set. Basic narrowing cues include:

- currently activated entities or objects;
- currently activated states, relations, or other evolution cues;
- current task and control anchors.

Time acts as an auxiliary ranking and filtering condition.

How search expands depends on retrieval speed:

1. first inspect the narrative span bound to the activated bundle;
2. if `bm25 + vector` is fast enough, expand to the full narrative for the dates of those activated fragments;
3. if retrieval is not fast enough, restrict first to nearby narrative regions around the activated span, then expand gradually;
4. if narrative is still insufficient, fall back to raw archive last.

Search escalation is initiated by the foreground LLM, while the system supplies bounded search scope.

### 6.9 Feedback Learning Side Path

The V8 `feedback learning side path` is:

`recall delivery + user/model/tool outcomes -> runtime observation ledger -> attribution -> flash / scene / durable updates`

Input sources:

- `user feedback`
  - explicit correction, confirmation, rejection, or clarification from the user;
- `model adoption`
  - whether the model actually used the injected memory;
- `fact outcome`
  - whether tool results, execution outcomes, or later facts support the current recall.

Prerequisites:

- `recall trace` must exist;
- the system must know which packs, nodes, and evidence were delivered in the round being evaluated;
- free-form approval or disapproval without recall alignment counts only as execution feedback, not memory feedback.

Update layers:

- `flash`
  - affects only the current answer or current tool cycle;
- `scene`
  - affects the next short local recall window;
- `durable`
  - enters longer-term recall adjustment only after repeated aligned feedback or strong fact confirmation.

Effect scope:

- short-term suppression or reinforcement of nodes or neighborhoods;
- bundle priority;
- pack-selection bias;
- slice bias;
- search priors;
- later graph-side weight or state adjustment during consolidation.

Constraints:

- rewrite durable graph truth from one ambiguous user sentence;
- bypass attribution and update graph directly;
- collapse execution failure and memory failure into one category.

Architectural role:

- runtime tuning loop for recall;
- longer-term correction source that later consolidation may consume;
- covers both content correction and later recall-timing adjustment.

## 7. L0 Control Plane

`L0 Control Plane` continuously influences the behavioral boundary of recall. It provides control anchors such as goal, current task, handoff, and latest request, and constrains:

- the direction of ignition;
- which bundles are upgraded into packs;
- task alignment during pack injection;
- the scope boundary of search escalation.

The role of L0 is to keep applying "what exactly are we doing now" to the recall system so that the model does not drift away from the main task when a local memory region becomes active.

## 8. Implementation Boundary

The implementation boundary is defined by several contract chains.

It should stay fixed at the following layers:

- `source`
  - raw records and narrative records before semantic extraction.
- `segmentation`
  - offsets, units, and traceable evidence boundaries.
- `semantic extraction`
  - bounded memory IR items extracted from units.
- `graph products`
  - consolidated graph objects and the `serving views` prepared inside graph for recall.
- `runtime recall`
  - ignition, residual propagation, bundle aggregation, pack delivery, and search expansion.
- `feedback learning`
  - recall trace, attribution, flash/scene/durable updates, and longer-term corrections that later consolidation may consume.
- `ordered state`
  - ordered state representations inside one evolution family, which may live on the graph side or the runtime side without precommitting a specific representation.

The implementation direction remains:

1. `source adapters` normalize raw records into `narrative records`
2. `unitizers` cut narrative records into `units` and preserve a span map
3. `IR extractors` produce bounded `memory IR items` with `evidence spans`
4. `graph materializers` consolidate IR into graph objects and emit the `serving views` inside graph
5. `recall` consumes `serving views` and runtime packs to perform ignition, propagation, grouping, and delivery
6. `feedback learning` consumes recall traces and later observations, emits flash/scene/durable updates, and supplies longer-term correction input to later consolidation
7. `scanner ignition` is the foreground runtime entry point

Boundary meaning:

- background is responsible for stable memory structure formation;
- foreground is responsible for matching, activation, aggregation, delivery, and further search;
- the feedback side path is responsible for aligning recall outcome back to delivered memory and adjusting future recall;
- foreground recall primarily consumes `serving views`.

## 9. External Validation Goal

Benchmark and SOTA goals are external validation targets.

The internal main line of V8 remains:

- forming high-quality memory;
- recalling the right memory when needed;
- using what happened before to guide present behavior accurately.

Benchmark / SOTA are used to validate whether this main line actually works:

- it can find the needed memory;
- it can find it accurately;
- it does not drop deep critical semantics;
- it remains consistent under long-horizon tasks and complex text conditions.

Benchmark exists as an external constraint and validation target.
