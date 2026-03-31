Status: draft for review
Audience: maintainers, UI implementers, agent-memory researchers
Depends on:
- `2026-03-17-v8-architecture-rewrite-design.md`
- `2026-03-20-v8-pipeline-implementation.md`

# V8 3D Memory Graph UI Design

## 1. Goal

Redesign the current `memory-enhanced` graph UI into a higher-quality front-end that reflects the approved V8 architecture instead of the old graph-debug page and old API assumptions.

The first delivery target is a **static visual demo** that:

- presents the graph as the primary visual surface
- adopts a more premium visual language closer to `MiroFish` than the current Sigma debug panel
- supports node selection and memory inspection
- treats time/state evolution as part of the graph itself rather than as a separate afterthought
- leaves clear extension points for later runtime activation / energy propagation overlays

The UI must work for both:

- internal research and debugging
- external demonstration and presentation

## 2. Problem Statement

The current UI is misaligned with the approved V8 model in three ways:

1. It is still shaped like an old debug console and old interface contract.
2. It visually treats the graph as a cheap generic relation viewer rather than as recall geometry.
3. It under-represents the architecture's core value:
   - graph as activation/routing structure
   - bundle/pack as delivery-facing products
   - evidence-backed memory inspection
   - temporal/state evolution as persistent graph geometry

The redesign must therefore change both the visual style and the information architecture.

## 3. Architectural Alignment

The UI must follow these approved architecture constraints:

- `graph` is not the final delivery object; it is the long-term organization and routing layer.
- runtime recall follows:
  - `ignition`
  - `activated IR / graph neighborhood`
  - `bundle resolution`
  - `pack assembly`
  - `search escalation`
- `bundle` is a unit-centered recall candidate, not a pre-authored node cluster.
- `pack` is the delivery-facing expression of selected units.
- temporal/state evolution is part of persistent recall geometry.
- evidence chains must remain visible:
  - `graph node/edge -> IR item + evidence span -> unit -> narrative record -> raw archive`

This means the UI should not be designed as a raw graph database explorer. It should be designed as a **memory recall geometry explorer**.

## 4. Phase Scope

### 4.1 Phase 1: Static 3D graph demo

In scope:

- true 3D graph canvas
- premium visual redesign
- node selection
- right-side memory detail drawer
- related-connection jumps
- visible time/state evolution structure inside the graph
- left-top minimal control cluster
- static data loading from the new graph-side interface

Out of scope:

- runtime activation overlay
- ignition scoring visualization
- energy propagation animation
- dynamic bundle/pack delivery traces
- live search escalation visualization

### 4.2 Phase 2: Runtime dynamic overlay

Later work may add:

- activated regions
- dominant anchor highlighting
- active aspect highlighting
- `T_forward / T_backward` propagation overlays
- bundle tier display
- pack delivery trace
- retrospective reconstruction flow

Phase 1 must not block these additions.

## 5. Primary Layout

Phase 1 uses this top-level layout:

- full-screen 3D graph canvas as the dominant visual
- minimal left-top floating controls
- right-side detail drawer

Explicitly excluded:

- old left sidebar
- old lower-left stats panel
- multi-panel console layout
- dashboard-style permanent metrics blocks

The interface should feel like a spatial memory field, not a control room.

## 6. Spatial Model

### 6.1 Base model

The 3D scene should use a **Stratified Memory Field** model.

- `X / Y` encode semantic neighborhood and relational clustering
- `Z` encodes time/state evolution depth

Result:

- horizontally, the user sees a free memory information field
- vertically, the user sees evolution structure

### 6.2 Why real 3D

True 3D is preferred over pseudo-3D because the system's geometry is genuinely multi-dimensional:

- semantic neighborhood
- time ordering
- state transition
- oblique coupling

Using a true depth axis makes it possible to later express:

- `T_forward`
- `T_backward`
- state-line continuity
- regime/validity gating
- local activation propagation

without collapsing all semantics into one 2D plane.

## 7. Visual Semantics

### 7.1 Nodes

Nodes should not all use the same weight.

Three visual tiers:

1. anchor/thread/regime-class nodes
   - larger
   - brighter
   - more stable presence
2. normal memory nodes
   - medium scale
   - typed by color
3. supporting or secondary nodes
   - smaller
   - lower emphasis

Selection behavior:

- selecting one node should slightly lift its local neighborhood, not only the single node itself

### 7.2 Standard relation edges

Standard semantic relation edges should be:

- thin
- light
- low-emphasis

They provide structural context, but should not dominate the visual field.

### 7.3 Evolution lines

Evolution lines are first-class visual objects, not ordinary thick edges.

For a given `anchor + aspect`:

- states should be connected along a spatial evolution rail
- the rail should remain readable as a coherent line
- `T_forward` should be clearer and stronger
- `T_backward` should remain visible but weaker

When applicable:

- superseded or invalidated states should visually desaturate
- branch points should read as meaningful divergence, not accidental clutter

### 7.4 Status encoding

Recommended status semantics:

- current/dominant state: brightest and most stable
- previous state: readable but dimmer
- superseded/invalid: desaturated and partially transparent
- tentative/uncertain: lower clarity or softer edge treatment

## 8. Camera And Interaction

### 8.1 Default mode

Default mode is presentation-first.

Requirements:

- stable oblique perspective
- enough tilt to reveal both planar cluster structure and depth-based evolution
- no aggressive auto-rotation
- only subtle ambient motion, if any

### 8.2 Explore mode

The scene must also support free exploration:

- rotate
- pan
- zoom

This mode is needed for internal analysis.

### 8.3 Mode model

The UI should support:

- presentation-first default framing
- optional free exploration at any time

### 8.4 Selection camera behavior

When the user selects a node:

- do not perform a dramatic camera jump
- do a short smooth focus adjustment
- preserve enough local structure in view so the user can still understand context

When the selected node belongs to a visible evolution line:

- the camera may slightly favor an angle that reveals predecessor/successor continuity

## 9. Left-Top Controls

Only three control groups are allowed in the main floating cluster.

### 9.1 Layer / View

`Layer`:

- `micro`
- `meso`
- `macro`
- `all`

`View`:

- `semantic`
- `evolution`
- `hybrid`

Meaning:

- `semantic`: emphasize general semantic relation field
- `evolution`: emphasize state/time rails
- `hybrid`: balanced default

### 9.2 Static / Dynamic

This slot is reserved now even if Phase 1 only implements static mode.

Values:

- `static`
- `dynamic`

Phase 1:

- `static` usable
- `dynamic` placeholder only

Future dynamic mode can attach:

- activation highlights
- ignition overlays
- propagation effects
- bundle/pack runtime emphasis

### 9.3 Search

Search should match:

- node label
- aliases
- memory keywords
- thread/anchor/pack naming cues

Behavior:

- locate target in graph
- focus it
- open drawer

This cluster must remain minimal and must not grow into a second toolbar row.

## 10. Right-Side Detail Drawer

The drawer is a memory interpreter, not a generic metadata sheet.

It should have four fixed sections.

### 10.1 Semantic Summary

Show:

- label
- type
- scale
- aliases/canonical name
- short summary
- current status tags

Purpose:

- tell the user what this node means in semantic terms

### 10.2 Evidence & Memory

Show:

- supporting IR items
- evidence span references
- unit excerpt
- narrative source / session / turn
- expandable rawer memory fragment when needed

Purpose:

- re-ground the graph object in evidence-backed memory

### 10.3 Related Connections

This section is not a raw adjacency list.

It should offer semantically grouped jumps such as:

- same state line
- related anchor
- pack-related
- oblique related
- supporting or contradicting memory

Each item must support:

- jump in graph
- update selection
- refresh drawer

### 10.4 State / Evolution Context

This section explains the selected node's place in evolution:

- previous
- current
- next
- aspect
- regime / phase / validity

Important:

- the main evolution structure is still expressed in the graph
- this drawer section explains and supplements it

## 11. Graph-Drawer Coupling

Coupling rules:

- single-click node
  - update drawer
  - lightly focus camera
  - highlight local structure
- click related connection
  - jump to connected node
  - preserve semantic continuity
- click same-line relation
  - emphasize the whole evolution rail
- open evidence references
  - expand evidence detail without discarding current graph selection

The graph is for structure. The drawer is for meaning and evidence.

## 12. Time / State As Graph Geometry

Time/state evolution must not be treated as a side widget or detached mini-timeline.

It is part of the graph's visible geometry because the architecture requires:

- persistent temporal/oblique recall geometry
- time/locality gating
- dominant anchor + active aspect interpretation
- `T_forward / T_backward` propagation
- retrospective reconstruction by aspect and time/regime buckets

Therefore Phase 1 must already visualize evolution in-graph.

Recommended strategy:

- keep the overall scene as a free information field
- embed evolution rails as second-layer structural lines
- when a node is selected, locally strengthen the related `anchor + aspect` evolution rail

This preserves both:

- premium free-form graph aesthetics
- architecture-faithful recall geometry

## 13. Demo Success Criteria

The first demo succeeds if:

1. the scene clearly feels unlike the old Sigma debug console
2. the graph reads as a premium memory field rather than a cheap relation map
3. evolution is visible as part of the graph
4. node click reveals meaningful memory information, not only graph metadata
5. related-connection jumps feel natural
6. the UI obviously leaves room for future runtime activation overlays

## 14. Implementation Implications

The static demo should be implemented against the current approved V8-side data contracts, not the legacy UI assumptions.

The implementation is expected to require:

- a new front-end rendering layer or substantial renderer replacement
- a new data adapter between graph/runtime artifacts and the UI scene
- removal of old debug-layout assumptions from the current single-page UI

These are implementation concerns and will be detailed in the later implementation plan.

## 15. Out-of-Scope Decisions For This Spec

This design intentionally does not yet lock:

- final rendering library choice
- exact animation system
- exact shader/post-processing stack
- final API endpoint naming
- final mobile behavior

Those belong in the implementation planning step after design approval.
