# V8 Schema and Pipeline Draft

Status: draft  
Depends on: [V8_ARCHITECTURE.md](./V8_ARCHITECTURE.md)

Interface and migration companion:

- [V8_TYPES_AND_MIGRATION.md](./V8_TYPES_AND_MIGRATION.md)

This document turns the V8 architecture into an implementable design.
It defines:

- the graph data model
- the compilation pipeline from `event` and `md` into graph bundles
- the online scanner and recall assembly flow
- the feedback, sleep, and hardening pipeline
- a migration path from the current prototype

This is still a design document, not a claim that the current code already implements it.

## 1. Design Principles

V8 should satisfy these constraints:

- graph is a compiled layer, not the only source of truth
- `event` nodes are included by default
- episodic activation stays local in time unless reactivated
- recalled memory is assembled from node bundles back to source `md` / `event`
- online scanning must be cheap enough for stream-time use
- learning must distinguish "wrong" from "irrelevant" from "outdated"
- some memories may harden into durable agent identity or inter-agent protocol cores

## 2. Storage Layout

Proposed graph directory:

```text
.memory/graph/
  manifest.json
  nodes_episodic.jsonl
  nodes_semantic.jsonl
  nodes_procedural.jsonl
  edges_associative.jsonl
  edges_structural.jsonl
  edges_supersession.jsonl
  bundles.jsonl
  update_queue.jsonl
  trigger_lexicon.json
  day_index.json
  source_index.json
  hard_core_index.json
  embedding_index/
    nodes.f32
    ids.json
    metadata.json
```

### File roles

- `manifest.json`
  - schema version
  - compiler version
  - embedding model id
  - last rebuild time
- `nodes_*.jsonl`
  - node store split by substrate
- `edges_*.jsonl`
  - sparse edges split by role
- `bundles.jsonl`
  - maps source memory -> bundle members
- `update_queue.jsonl`
  - staleness suspicion, contradiction, or review candidates
- `trigger_lexicon.json`
  - compact lexical trigger index for online use
- `day_index.json`
  - episodic date windows and day-to-node mapping
- `source_index.json`
  - source ref -> nodes / bundle / md location
- `hard_core_index.json`
  - agent identity core and inter-agent protocol core entries

## 3. Common IDs

Recommended ids:

- bundle id: `mb_<date>_<seq>`
- node id: `mn_<date>_<seq>`
- edge id: `me_<date>_<seq>`
- update queue id: `mq_<date>_<seq>`

Recommended source references:

- event source: `evt_20260310_003`
- md source block: `memory/knowledge/openclaw.md#mn_block_04`
- daily log source: `memory/2026-03-10.md#evt_20260310_003`

## 4. Bundle Model

One source memory compiles to one bundle.

Bundle shape:

```json
{
  "bundle_id": "mb_20260310_001",
  "source_type": "event|knowledge_md|skill_md",
  "source_ref": "evt_20260310_003",
  "kind": "episodic|semantic|procedural",
  "title": "OpenClaw overlay update workflow",
  "node_ids": [
    "mn_20260310_011",
    "mn_20260310_012",
    "mn_20260310_013"
  ],
  "canonical_ref": "memory/knowledge/openclaw.md#workflow_overlay_update",
  "summary_ref": "memory/knowledge/openclaw.md",
  "day_key": "2026-03-10",
  "episode_key": "openclaw-update-incident",
  "encoding_context": {
    "goal": "恢复插件更新后的运行环境",
    "activeTask": "排查网关断连原因",
    "lastUserRequest": "先排查为什么更新插件后网关断连",
    "topNextTasks": ["梳理部署手册安装步骤"],
    "scopeHints": ["workspace-neuro", "openclaw", "memory-enhanced"],
    "recordedAt": "2026-03-10T08:41:22.000Z"
  },
  "created_at": "2026-03-10T08:41:22.000Z",
  "updated_at": "2026-03-10T08:41:22.000Z"
}
```

### Why bundles exist

- recall should not inject isolated nodes blindly
- online matching works on nodes, but insertion often needs the local bundle
- bundle is the bridge from fast graph math back to human-readable source memory
- `encoding_context` is a side-channel summary of the task stack at record time, not part of node text

### Encoding context rule

`encoding_context` should stay compact and side-channel only.

Use it for:

- scene reconstruction
- context-fit scoring
- detecting when current scene drift is too far from the original encoding scene
- stage-1 offline annotation as a weak historical cue

Do not use it as the main memory content.
Do not dump the full historical stack into node text.

## 5. Node Schema

Base node shape:

```json
{
  "id": "mn_20260310_011",
  "bundle_id": "mb_20260310_001",
  "kind": "episodic|semantic|procedural",
  "role": "topic|workflow|constraint|condition|evidence|checkpoint",
  "names": {
    "zh": "网关断连恢复",
    "en": "gateway recovery"
  },
  "aliases": ["网关恢复", "gateway disconnected recovery"],
  "text": "overlay update should restore clean core before patch reapply",
  "summary": "short normalized summary for retrieval",
  "keywords": ["overlay", "update", "clean core", "patch"],
  "language": "zh|en|mixed",
  "source_ref": "evt_20260310_003",
  "canonical_ref": "memory/knowledge/openclaw.md#workflow_overlay_update",
  "confidence": 0.86,
  "importance": 0.82,
  "hit_count": 0,
  "adopt_count": 0,
  "reject_count": 0,
  "harm_count": 0,
  "last_used_at": "2026-03-10T08:41:22.000Z",
  "last_verified_at": "2026-03-10T08:41:22.000Z",
  "cooldown_until": null,
  "day_key": "2026-03-10",
  "episode_key": "openclaw-update-incident"
}
```

### Required fields

- `bundle_id`
- `kind`
- `role`
- `text`
- `source_ref`
- `canonical_ref`

### Notes

- `names.zh` and `names.en` point to the same node identity and should both be indexed for trigger matching
- `aliases` are optional equivalent labels, shorthand, or bilingual variants
- `text` is optimized for fast matching, not full recall insertion
- `canonical_ref` is where assembled recall should ultimately read from
- `cooldown_until` prevents short-term repeated firing
- `day_key` and `episode_key` help build small episodic subgraphs

## 6. Edge Schema

Base edge shape:

```json
{
  "id": "me_20260310_014",
  "type": "associative|causal|constraint|workflow_next|same_topic|supersedes|valid_when|invalid_when",
  "src": "mn_20260310_011",
  "dst": "mn_20260310_013",
  "assoc_strength": 0.74,
  "utility": 0.88,
  "trust": 0.81,
  "freshness": 0.93,
  "context_fit": 0.79,
  "evidence_count": 3,
  "activation_count": 0,
  "adopt_count": 0,
  "reject_count": 0,
  "last_updated_at": "2026-03-10T08:41:22.000Z",
  "last_verified_at": "2026-03-10T08:41:22.000Z"
}
```

### Score meanings

- `assoc_strength`
  - how strongly one node should activate the other
- `utility`
  - how often the edge led to useful recall
- `trust`
  - whether the relationship has remained reliable
- `freshness`
  - whether the relation still appears current
- `context_fit`
  - whether it fits the present repo / task / environment

### Effective propagation score

At runtime, edge propagation can use:

```text
prop_score = assoc_strength * utility * trust * freshness * context_fit
```

This can later be weighted rather than purely multiplied.
The important point is that one failed condition should not collapse the whole memory.

## 7. Indexes

### 7.1 Trigger lexicon

`trigger_lexicon.json` should map normalized triggers to candidate node ids.

Example:

```json
{
  "overlay": ["mn_20260310_011"],
  "gateway disconnected": ["mn_20260310_021", "mn_20260310_045"],
  "字幕": ["mn_20260310_051"]
}
```

This is the fast lexical ignition path.

### 7.2 Day index

`day_index.json` should map dates to episodic nodes and episodes.

Example:

```json
{
  "2026-03-10": {
    "node_ids": ["mn_20260310_011", "mn_20260310_012"],
    "episode_keys": ["openclaw-update-incident"]
  }
}
```

This supports the "silent unless activated" episodic rule.

### 7.3 Source index

`source_index.json` maps `source_ref` to:

- bundle ids
- canonical md file
- related daily log path
- related event ids

This lets the recall assembler rehydrate from source quickly.

### 7.4 Hard core index

`hard_core_index.json` contains hardened durable memory.

Example:

```json
{
  "agent_identity_core": ["mn_20260310_111", "mn_20260310_117"],
  "inter_agent_protocol_core": ["mn_20260310_211", "mn_20260310_219"]
}
```

## 8. Compilation Pipeline

### 8.1 Inputs

Compiler reads from:

- `.memory/events/*.jsonl`
- `memory/knowledge/*.md`
- optionally `memory/skills/**/*.md`

It should not compile directly from raw chat unless raw chat was already promoted into `event`.

### 8.2 Event compilation

Event memories are included by default.

Why:

- `event` has already been filtered once compared with raw logs
- many useful recalls begin with recent failures, discoveries, checkpoints, and user constraints

Default event pipeline:

1. load event
2. normalize text
3. extract bundle title
4. detect candidate roles:
   - topic
   - constraint
   - checkpoint
   - workflow
   - evidence
5. build `2-6` nodes depending on structure
6. create bundle record
7. update day index and source index

### 8.3 MD compilation

Long-term md should be compiled from explicit structured blocks when possible.

Preferred authoring pattern:

```md
<!-- memory-node
kind: procedural
role: workflow
confidence: 0.88
importance: 0.83
source_refs: [evt_20260310_003]
name_zh: 网关断连恢复
name_en: gateway recovery
aliases: [网关恢复, gateway disconnected recovery]
-->
OpenClaw overlay update should restore clean core before patch reapply.
<!-- /memory-node -->
```

The compiler may also fall back to heuristic extraction from headings and short sections, but explicit blocks are preferred.
The offline annotator should fill `name_zh`, `name_en`, and optional `aliases` whenever it can do so reliably.

### 8.4 Node bundle sizing

Bundle sizing should be adaptive, not fixed.

Default rule:

- short simple memory: `2-3` nodes
- medium memory: `3-6` nodes
- long structured memory: more than `6` only if each node keeps a clean role boundary

Decision heuristics:

- number of clauses
- number of constraints
- number of artifacts or evidence references
- whether there is a restart point or handoff payload

## 9. Online Scanner

### 9.1 Stream windows

The scanner should maintain three rolling char windows:

- `micro`
- `meso`
- `macro`

Recommended defaults:

```json
{
  "micro_chars_zh": 20,
  "micro_chars_en": 40,
  "meso_chars_zh": 96,
  "meso_chars_en": 144,
  "macro_chars_zh": 256,
  "macro_chars_en": 384
}
```

Checks should run on:

- punctuation boundaries
- code fence boundaries
- hard char intervals

### 9.2 Injection gates

For each node:

```text
u_i = a * g_lex + b * g_emb + c * g_ctrl + d * g_time
```

Where:

- `g_lex`
  - lexical or phrase hit from trigger lexicon
- `g_emb`
  - local embedding similarity against micro/meso/macro windows
- `g_ctrl`
  - alignment with `goal`, `active_task`, `last_user_request`
- `g_time`
  - episodic recency, resumption hint, or day-window bonus

### 9.3 Episodic day window

Episodic nodes are globally stored but not globally active.

Default policy:

- scanner opens a rolling day window over recent event days
- if a day or episode cluster is not activated by current cues, nodes from that cluster stay silent
- semantic and procedural nodes remain globally eligible

This keeps event recall local without discarding event memory.

### 9.4 Propagation

Suggested update:

```text
h(t+1) = lambda * h(t) + U(t) + P * h(t) - I * h(t) + C(t)
```

Where:

- `lambda`
  - passive decay
- `U(t)`
  - new gate injection
- `P * h(t)`
  - forward propagation
- `I * h(t)`
  - inhibition, hub penalty, and competition
- `C(t)`
  - coincidence bonus when multiple distinct cues converge

### 9.5 Stability controls

The scanner must include:

- top-k propagation per node
- node cooldown
- bundle cooldown
- hub penalty
- refractory period after fire
- max injected recall count per window

### 9.6 Recall thresholding

When many nodes exceed threshold:

1. group them by bundle
2. score bundles by max or aggregate energy
3. inject only top `k` bundles first
4. if later checkpoints still show strong energy in suppressed bundles, inject them as second-wave recall

This preserves delayed insight without flooding the prompt.

## 10. Recall Assembly

The scanner never injects raw node text directly unless the node itself is the whole intended payload.

Default recall assembly:

1. get top activated bundle ids
2. resolve each bundle through `source_index.json`
3. read the canonical `md` or `event`
4. build an insertion block based on delivery tier
5. inject only the compact assembled recall

### Delivery tiers

- `critical`
  - validated workflow
  - hard constraint
  - known fix
  - checkpoint / handoff
- `decision`
  - prior decision, stable preference, durable policy
- `background`
  - supporting context

### Tier selection signals

Tier should be derived from:

- node roles present in the bundle
- hard-core membership
- source type
- prior adoption / harm profile
- optional LLM annotation

## 11. Feedback Pipeline

### 11.1 Outcome classes

Every recall attempt should be classified into one of:

- `accepted`
- `ignored`
- `not_reached`
- `misapplied`
- `contradicted`
- `superseded`
- `harmful`

### 11.2 Signals

Signals may come from:

- model adopts recall and changes behavior
- model updates `memory_working`
- user explicitly rejects output
- tool execution succeeds or fails after recall
- later correction or rollback event is recorded

### 11.3 Update actions

Outcome should map to one of:

- edge score update
- node / bundle cooldown adjustment
- update queue enqueue
- `supersedes` edge creation
- `valid_when` / `invalid_when` edge creation

### 11.4 Important rule

Do not punish the whole workflow just because one invocation failed.

Often the correct action is:

- lower `context_fit`
- lower `freshness`
- enqueue review
- add a condition edge

Not "delete the memory".

## 12. Update Queue

`update_queue.jsonl` stores suspicious or review-worthy items.

Example item:

```json
{
  "id": "mq_20260310_004",
  "target_type": "node|edge|bundle",
  "target_id": "mb_20260310_001",
  "reason": "staleness_suspected|contradicted|high_harm|distribution_shift",
  "evidence": [
    "recalled 5 times in 2 days",
    "adopted once",
    "contradicted by evt_20260310_021"
  ],
  "created_at": "2026-03-10T09:00:00.000Z",
  "status": "pending|reviewed|resolved"
}
```

### Staleness suspicion signals

Recommended queue trigger when multiple signals co-occur:

- trigger distribution shifts significantly
- node is frequently recalled but rarely adopted
- adopted recalls increasingly fail
- newer evidence repeatedly conflicts with it
- nearby bundles capture most of its former activations

## 13. Sleep Pipeline

Sleep should keep three jobs separate:

### 13.1 Raw cleanup

- decay and archive low-value events
- remove obvious noise

### 13.2 Graph consolidation

- rebuild or incrementally update bundles
- refresh bilingual node identity:
  - backfill `name_zh`
  - backfill `name_en`
  - normalize `aliases`
- refresh indexes
- recompute or revise edge scores
- materialize new `supersedes` and condition edges

### 13.3 Hardening

Promote some memories into durable cores.

#### Agent identity core

Examples:

- stable execution habits
- durable preference patterns
- persistent working style that defines the agent's operating character

#### Inter-agent protocol core

Examples:

- shared coordination language
- handoff conventions
- durable multi-agent agreement terms

### Hardening criteria

Hardening is not based on semantic fit alone.

Minimum conditions:

- hit count above threshold
- adopt rate above threshold
- low harm rate
- stable across multiple sessions
- consistent with declared agent identity or protocol role

## 14. Configuration Surface

V8 should expose scanner and graph config explicitly.

Recommended config groups:

### 14.1 Scanner

```json
{
  "microCharsZh": 20,
  "microCharsEn": 40,
  "mesoCharsZh": 96,
  "mesoCharsEn": 144,
  "macroCharsZh": 256,
  "macroCharsEn": 384,
  "scanIntervalChars": 24,
  "maxInjectedBundles": 2
}
```

### 14.2 Propagation

```json
{
  "forwardGain": 0.30,
  "reverseGain": 0.15,
  "decayLambda": 0.95,
  "hubPenaltyPower": 0.5,
  "topKEdges": 6,
  "nodeCooldownMs": 15000,
  "bundleCooldownMs": 30000
}
```

`reverseGain` should remain configurable and tuned by smoke tests.

### 14.3 Recall

```json
{
  "criticalThreshold": 0.82,
  "decisionThreshold": 0.74,
  "backgroundThreshold": 0.68,
  "secondWaveThreshold": 0.78
}
```

### 14.4 Hardening

```json
{
  "identityCoreMinHits": 8,
  "identityCoreMinAdoptRate": 0.75,
  "protocolCoreMinHits": 10,
  "protocolCoreMinAdoptRate": 0.80,
  "maxHarmRate": 0.10
}
```

## 15. Migration from Current Prototype

Current prototype:

- single-file `.memory/_associative_graph.json`
- scalar edge `weight`
- mixed node store
- whitespace-biased scanner
- recall assembled directly from file path hit

Migration path:

1. add new `.memory/graph/` directory alongside existing files
2. compile current graph nodes into `bundles + nodes + edges`
3. keep reading legacy graph as fallback during migration
4. switch scanner to new indexes
5. switch consolidate to build new graph layout
6. remove legacy graph after stability window

### Legacy mapping

- old node -> one provisional bundle with one node
- old `weight` -> initialize:
  - `assoc_strength = weight`
  - `utility = 0.7`
  - `trust = 0.7`
  - `freshness = 0.8`
  - `context_fit = 0.8`

This is only a bootstrap heuristic.

## 16. Implementation Order

Recommended coding order:

1. define JSONL schema types in TypeScript
2. add graph path helpers in `utils.ts`
3. write bundle compiler from `event` and explicit md blocks
4. build new indexes
5. rewrite scanner to char-based windows and bundle scoring
6. implement cooldown, top-k, and second-wave recall
7. implement feedback logging and update queue
8. move sleep/consolidate to incremental graph updates
9. add hard-core promotion

## 17. Benchmark Mapping

First benchmark should measure:

- new session recovery without context
- recall speed
- correctness under chunked reading
- resistance to drift

Suggested benchmark sources:

- LongBench single-document QA
- Qasper paper QA
- later, repository-scale structured corpora with answer keys

Recommended evaluation metrics:

- answer accuracy
- retrieval steps
- recall latency
- drift incidents
- memory pollution rate
- false critical recall rate

## 18. Open Design Questions

- should `episodic` bundles ever be injected raw, or always summarized first?
- when should a bundle split by `episode_key` versus by source item?
- should hard-core memories have their own propagation gains?
- should second-wave recall be timer-based, checkpoint-based, or both?
- how large should the rolling episodic day window be by default?

These are the next design questions to close before code.
