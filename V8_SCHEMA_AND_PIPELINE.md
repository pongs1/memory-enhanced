# V8 Schema and Pipeline

Status: rewrite target  
Depends on: [V8_ARCHITECTURE.md](./V8_ARCHITECTURE.md)

Interface and migration companion:

- [V8_TYPES_AND_MIGRATION.md](./V8_TYPES_AND_MIGRATION.md)

This document defines the implementable V8 data flow.
It replaces the older `event/md -> bundle/node/edge` pipeline with an evidence-backed memory pipeline while preserving V8's online ignition layer as a first-class design concern.

## 1. Pipeline Overview

The new write path is:

`raw or curated source -> source normalization -> unitization -> evidence span extraction -> memory IR extraction -> graph materialization + summary/state materialization`

The new read path is:

`query -> graph/state/summary retrieval -> evidence backtrace -> context assembly`

The new live-generation fast path is:

`stream window + control anchors + scene signals -> ignition scan -> graph propagation -> activated bundles -> context assembly`

The new observation/feedback side path is:

`recall delivery + user/model/tool outcomes -> runtime observation ledger -> attribution -> flash/scene/durable updates + optional source promotion`

This side path is not a return to the old `event` system.
It is an append-only runtime trace used for attribution, correction, and fact validation.

The architecture has six write-path stages:

1. `source ingestion`
2. `source normalization`
3. `unitization`
4. `evidence span extraction`
5. `memory IR extraction`
6. `product materialization`

And four read-path stages:

1. `ignition scan`
2. `graph propagation`
3. `bundle ranking`
4. `context assembly`

## 2. Source Policy (Clean-Slate Mode)

V8 runs in **clean-slate mode** by default.
Only raw session/log evidence is ingested.

### 2.1 Raw evidence sources

Examples:

- session traces (raw message records)
- raw user turns
- raw assistant turns
- assistant `toolCall` blocks and persisted `toolResult` messages when present in the transcript
- daily logs in `memory/YYYY-MM-DD.md` (optional, off by default)

Rules:

- authoritative
- append-only
- offsets must remain valid
- never discarded after higher-level products are built
- transcript-level tool records are useful but may be incomplete; missing execution metadata must be recovered from runtime observation hooks instead of assumed from the transcript alone

### 2.2 Runtime observation channels

OpenClaw exposes runtime hooks that are not equivalent to plain conversation messages.
V8 should treat them as append-only raw observation channels, not as derived `event` artifacts.

Primary observation surfaces:

- `message_received`: inbound user text only
- `after_tool_call`: tool name, params, sanitized result or error, duration
- `tool_result_persist`: `toolResult` message before transcript persistence
- `before_message_write`: any message before session JSONL write
- `llm_input`: final prompt, system prompt, full `historyMessages`, image count
- `llm_output`: assistant texts, last assistant message, usage
- `agent_end`: final message snapshot plus success/error and duration

Rules:

- `message_received` is the user-feedback channel, not the fact channel
- fact-based feedback must come from tool and LLM observation hooks
- observation records are raw runtime traces and stay append-only
- when live hooks are unavailable, session transcript replay may backfill observations, but hook records remain the preferred source

### 2.3 Curated sources (disabled)

Curated documents are not ingested in clean-slate mode.
They are treated as post-hoc outputs (packs), not sources.

Examples:

- `memory/knowledge/*.md`
- `memory/skills/verified/*.md`
- `memory/skills/drafts/*.md`

### 2.4 Legacy derived sources (disabled)

Legacy artifacts are not ingested:

- `.memory/events/*.jsonl`
- old bundle-like draft records
- older graph-derived files

Do not emit new `event` artifacts. Episodic views should be derived from the canonical graph or assembled at runtime.

## 3. Narrative Normalization Policy

Normalization does not mean semantic rewriting.
It means turning heterogeneous sources into a stable source contract while preserving evidence value.

### 3.1 Keep

Keep these fields or reconstruct them if possible:

- source path or source id
- session id, turn id, message id when available
- speaker
- timestamp
- char offsets or line offsets
- original raw text

### 3.2 Clean

Session traces often include injected markers or control tags.
Normalization must produce a cleaned text stream for unitization while preserving provenance.

Rules:

- strip prompt scaffolding, tool wrappers, and injected memory blocks
- preserve a span map so evidence spans can still backtrace to narrative offsets
- narrative text is canonical; `raw_text` and `clean_text` are identical after cleaning
- transcript replay must route `toolCall` and `toolResult` records into narrative assembly instead of dropping them blindly or flattening them into ordinary user/assistant text

### 3.3 Strip or downgrade

Downgrade these into non-authoritative hints:

- legacy event type labels
- old node roles
- old prompt-injected summaries
- historical scaffolding strings
- prompt noise and control boilerplate

These fields may still be stored as `legacyHints`, but they must not be treated as first-class memory facts.

### 3.4 Observation promotion rules

Not every runtime observation becomes a narrative record.
V8 needs an explicit assembly contract between OpenClaw observations and the narrative extraction path.

Rules:

- build the narrative from cleaned observations
- promote only stable, provenance-complete observations into the narrative stream
- do not flatten every tool result into the same text stream as user or assistant turns
- session transcript `toolResult` blocks are fallback provenance, not the only detection path

Special rule for the built-in `read` tool:

- capture `tool_name`, `tool_call_id`, `path|file_path`, `offset`, `limit`, `duration_ms`, and `error`
- persist a bounded result excerpt plus `truncated`, `result_kind`, and media flags
- treat `params.path` or `params.file_path` as the authoritative file locator because the returned result may omit path details
- if the path resolves to a stable workspace or local document and policy allows, create a document-source ref so V8 can later ingest the underlying file directly instead of depending only on the possibly truncated tool result
- image or binary reads should remain observation/media records unless a separate OCR or document adapter promotes them into text evidence

Implementation note:

- `message_received` alone is insufficient because it never contains tool results
- `after_tool_call` and `tool_result_persist` must be part of the canonical observation path
- session transcript `assistant/toolCall` and `toolResult` records should be replayed into the same observation pipeline when rebuilding from disk

### 3.5 Observation cleaning policy

Observation cleaning should stay deliberately shallow.
Its job is only to remove obvious junk and preserve enough structure for later narrative assembly and unitization.
It is not a second semantic summarization layer.

Required pre-clean steps:

- preserve structured metadata first: tool name, params, path, cwd, command, touched files, exit code, error class, duration, status
- strip obvious wrappers and noise: ANSI escapes, transport envelopes, duplicated metadata shells, injected memory blocks, schema echoes, retry wrappers
- cap oversized payloads with deterministic truncation
- keep high-signal regions such as errors, warnings, verdict lines, selected excerpts, result heads/tails
- leave semantic denoising to the later unit/IR stage instead of trying to fully solve it here

Practical rule:

- high-density natural-language tool output may pass through almost unchanged after wrapper stripping
- noisy operational output should be trimmed to metadata plus a small high-signal excerpt
- control/lifecycle text should usually keep only structured fields and minimal user-visible text

Required output per observation:

- `raw_payload_ref`
- `clean_text` or `null`
- `structured_fields`
- `contamination_flags`
- `truncation_info`

Do not introduce a second persistent "clean then summarize again" layer before unitization.
The unitizer and later LLM extraction are expected to ignore the remaining irrelevant content.

### 3.6 Prompt contamination guard

Tool and agent lifecycle observations are especially vulnerable to prompt contamination.
V8 must keep "what the system told the model" separate from "what happened in the world".

Never promote these raw surfaces as ordinary memory text:

- injected memory blocks
- task-ledger or control overlays
- tool schemas or parameter help
- approval notices and wrapper instructions
- system prompt fragments
- retry scaffolding
- model self-instruction copied into tool payloads

Guard rules:

- `llm_input` is attribution-only by default
- `agent_end` is reconciliation-only by default
- if `agent_end` or `llm_output` text is used for memory, only user-visible assistant content may be considered, never hidden prompt scaffolding
- if a tool output contains echoed prompt text or injected memory blocks, strip them before any promotion or attribution
- contamination flags should block durable promotion until the observation is revalidated by cleaner evidence

## 4. Storage Layout

Recommended graph-adjacent layout:

```text
.memory/
  raw/
    observations/
      assembled/
        session_<id>_narrative.md
        session_<id>_units.md
        op_<toolCallId>.md
  runtime/
    recall_traces.jsonl
    feedback_records.jsonl
    feedback_overrides.jsonl
    feedback_attribution.jsonl
    review_windows.jsonl
  graph/
    manifest.json
    narrative_records.jsonl   # narrative-derived records
    units.jsonl
    evidence_spans.jsonl
    memory_items.jsonl
    graph_nodes.jsonl
    graph_edges.jsonl
    summary_packs.jsonl
    state_packs.jsonl
    trigger_lexicon.json
    day_index.json
    source_index.json
    embedding_index/
```

The old split files such as `nodes_episodic.jsonl` may still exist during migration, but they are legacy compatibility artifacts, not the target storage model.

The ignition layer still depends on compact read-time indexes:

- `trigger_lexicon.json`
- `day_index.json`
- `source_index.json`

## 5. Narrative and Observation Contracts

### 5.1 Narrative record contract

Each ingested narrative entry (assembled from session traces and tool results)
becomes a normalized narrative record.

Example:

```json
{
  "narrative_record_id": "narr_20260312_001",
  "source_class": "raw|curated|legacy",
  "source_type": "session_trace|session_narrative|daily_log|knowledge_md|skill_md",
  "source_ref": "/home/pongs/.openclaw/agents/main/sessions/...jsonl#142",
  "speaker": "user",
  "timestamp": "2026-03-12T09:11:02.000Z",
  "raw_text": "....",
  "language": "zh",
  "metadata": {
    "conversation_id": "conv_001",
    "turn_id": "turn_142"
  }
}
```

### 5.2 Observation record contract

Observation records are append-only runtime facts captured from OpenClaw hooks.
They are not graph nodes and not narrative records by default.

Example:

```json
{
  "observation_id": "obs_20260312_044",
  "observation_type": "tool_result",
  "hook": "after_tool_call",
  "run_id": "run_817",
  "session_id": "sess_22",
  "tool_name": "read",
  "tool_call_id": "call_9F",
  "params": {
    "path": "src/v8/scanner.ts",
    "offset": 1
  },
  "raw_payload_ref": "raw://observations/tool_observations.jsonl#44",
  "result_excerpt": "export class V8GraphScanner ...",
  "clean_text": "read src/v8/scanner.ts from offset 1; scanner class declaration observed",
  "structured_fields": {
    "path": "src/v8/scanner.ts",
    "offset": 1,
    "result_kind": "text"
  },
  "contamination_flags": [],
  "truncation_info": null,
  "result_kind": "text",
  "truncated": false,
  "is_error": false,
  "timestamp": "2026-03-12T09:14:21.000Z",
  "transcript_ref": "/home/pongs/.openclaw/agents/main/sessions/...jsonl#142"
}
```

Observation records are used for:

- runtime scene refresh
- recall attribution
- fact feedback
- optional promotion into narrative records or evidence spans

Rules:

- observations keep structured metadata even when `clean_text` is empty
- an observation may remain useful for attribution without ever becoming a unit
- code-family observations often contribute metadata and evidence refs more than large text spans

### 5.3 Read observation contract

The built-in `read` tool must be treated as a first-class observation source.

Example:

```json
{
  "observation_id": "obs_read_20260312_009",
  "observation_type": "read_artifact",
  "tool_name": "read",
  "tool_call_id": "call_9F",
  "path": "src/v8/scanner.ts",
  "offset": 1,
  "limit": 200,
  "result_kind": "text",
  "excerpt": "export class V8GraphScanner ...",
  "truncated": true,
  "duration_ms": 48,
  "workspace_ref": "workspace://src/v8/scanner.ts"
}
```

Rules:

- path metadata comes from tool params, not from user text
- excerpt text is for runtime attribution and lightweight recall only
- durable extraction should prefer the underlying file or document source when it is stable and re-readable
- if `read` returns image content, keep the media ref and MIME info even when no usable text is available

### 5.4 Tool-call and lifecycle memory policy

Tool-call and lifecycle records are memory-relevant, but not as raw transcript prose.

They should be preserved in three layers:

- `operation metadata`
  - tool name, params, duration, status, path, command, target, exit code
- `operation evidence text`
  - cleaned high-signal excerpts only
- `operation attribution links`
  - which recall pack, state, or decision this operation validated, contradicted, or depended on

Promotion rules:

- tool-call metadata may produce memory items when it establishes stable workflow facts, external state, document provenance, or repeated procedure patterns
- raw `agent_end` text should not become memory evidence directly
- `agent_end` may emit derived lifecycle facts such as success, failure, abort, timeout, unresolved error, or completion of a branch
- if session transcripts lack complete tool execution details, runtime hook observations are canonical for those fields
- promotion must not depend only on built-in tool names; it should also inspect payload shape:
  - artifact/path-bearing inputs
  - query/url-bearing lookups
  - written payloads in tool args
  - rich result text or structured details such as `excerpt`, `summary`, `output`, `result`
- this is required so custom tools can still become operation evidence even when they are not part of a predefined tool catalog

### 5.4.0 Shipped core-tool baseline

Before OpenClaw emits a live `tool_cleaning_profiles.json`, V8 should ship a baseline profile set for the current built-in core tools.

Persistence:

- `schema/v8-core-tool-cleaning-profiles.json`

Rules:

- this baseline exists only to keep the first consolidation passes clean and usable
- runtime-generated `raw/observations/tool_cleaning_profiles.json` overrides or extends the shipped baseline
- built-in file/web/content tools should default to `llm_ir` when they expose real artifact text
- memory/session reflection tools should default to `metadata_only` or `evidence_only` to avoid recursive re-ingestion of already canonical sources
- unknown or changed tools still fall back to payload-shape heuristics until OpenClaw publishes a new runtime profile

### 5.4.0a Tool catalog coverage check (startup)

During `memory_consolidate`, V8 should compare:

- `raw/observations/tool_catalog_snapshot.json` (tool list)
- merged cleaning rules (baseline + runtime)

If the catalog and rules do not match, V8 must:

- write a prompt to `raw/observations/tool_cleaning_profile_review.md`
- include the mismatch summary in the consolidate output

The prompt should instruct an offline LLM to inspect tool implementations and draft cleaning profiles for missing tools, plus mark obsolete entries as `deprecated`.

### 5.4.1 Tool catalog snapshot contract

V8 should **not** query or reconstruct the live OpenClaw tool registry by itself during memory consolidation.
That coupling belongs on the OpenClaw side.

Instead, OpenClaw should publish a stable snapshot for memory consumers:

- `raw/observations/tool_catalog_snapshot.json`
- `raw/observations/tool_cleaning_profiles.json`

Responsibility split:

- OpenClaw:
  - scan the live core + plugin tool registry
  - resolve tool `name`, `label`, `description`, `source`, optional `plugin_id`
  - capture parameter schema shape
  - capture observed result-shape hints from runtime hooks
  - compare the current catalog fingerprint against the previous snapshot
  - regenerate cleaning profiles only when a tool is new or changed
- V8 / memory-enhanced:
  - read the published snapshot/profile files if present
  - apply those profiles during observation cleaning and promotion
  - fall back to generic payload-shape heuristics only when no profile exists

This keeps the memory pipeline stable when OpenClaw adds or changes tools.

### 5.4.2 Tool fingerprint + change detection

OpenClaw should compute a per-tool fingerprint from:

- `tool name`
- `label`
- `description`
- `source` (`core` or `plugin`)
- `plugin_id` when present
- normalized parameter schema
- optional observed top-level result-shape keys

Trigger points for recomputing the catalog:

- process start
- plugin install/update/remove
- agent tool allowlist/profile change
- config reload
- explicit maintenance command or cron

Rules:

- if fingerprint unchanged, keep the existing cleaning profile
- if fingerprint changed or a new tool appears, generate a new draft cleaning profile
- if a tool disappears, mark the profile inactive but keep history for replay/debugging

### 5.4.3 Cleaning profile generation flow

OpenClaw should own the onboarding flow for new tools:

1. Scan the live tool registry and write `tool_catalog_snapshot.json`.
2. For each new/changed tool, generate a draft cleaning profile from:
   - description
   - parameter schema
   - tool source (`core` / plugin)
   - observed result payload samples from `after_tool_call` / `tool_result_persist`
3. Classify the tool into a memory-facing cleaning mode such as:
   - `read_artifact`
   - `web_lookup`
   - `artifact_write`
   - `content_extraction`
   - `filesystem_probe`
   - `process_control`
   - `status_only`
   - `generic_payload`
4. Emit a resolved profile into `tool_cleaning_profiles.json`.
5. V8 consumes the resolved profile without needing code changes.

The important point is that new tool support should usually mean:

- OpenClaw updates the snapshot/profile
- V8 re-runs consolidation

not:

- manually patch memory code for every new tool

### 5.4.4 Cleaning profile shape

Recommended per-tool profile fields:

```json
{
  "tool_name": "read",
  "fingerprint": "sha256:...",
  "source": "core",
  "plugin_id": null,
  "description": "Read file contents",
  "input_hints": {
    "artifact_keys": ["path", "file_path", "file", "url"],
    "query_keys": [],
    "payload_keys": []
  },
  "result_hints": {
    "text_keys": ["content", "excerpt", "text", "output", "result"],
    "metadata_keys": ["status", "durationMs", "exitCode", "mime", "truncated"]
  },
  "cleaning_mode": "read_artifact",
  "promotion": "llm_ir",
  "max_chars": 2600,
  "max_lines": 90,
  "status": "active"
}
```

This file is not the raw observation ledger.
It is a runtime-maintained normalization contract between OpenClaw and V8.

### 5.5 Assembled operation text view

For unitization, V8 may assemble one high-density text view from:

- session transcript `assistant/toolCall`
- session transcript `toolResult`
- live `after_tool_call` observation
- selected lifecycle metadata such as `status`, `duration`, `exit_code`, `error`

This assembled view is a unitization aid, not a replacement for the underlying structured records.

Persistence (recommended):

- persist the assembled view as a Markdown file so it can be replayed without recombining raw fragments
- store under `raw/observations/assembled/` (e.g., `raw/observations/assembled/op_<tool_call_id>.md`)
- this Markdown is the **full, natural-language, high-density** view after merging multi-source observations and removing low-value noise
  - it is not an `event` summary and should not replace raw observation JSONL

Session-grounded source shape (observed in real traces):

- assistant message with `content[].type = toolCall`, carrying `id`, `name`, and `arguments`
- following message with `role = toolResult`, carrying `toolCallId`, `toolName`, `content[]`, optional `details`, and `isError`

Recommended Markdown form (natural language first, not rigid key-value):

```text
### Tool Execution Snapshot

The assistant called `read` on `src/v8/scanner.ts` from offset `1`.
The call completed successfully in about `48ms`.

The returned content starts with:

`export class V8GraphScanner ...`
```

Rules:

- build it by `tool_call_id` when available, otherwise by local execution order
- use cleaned params/result text plus structured metadata
- exclude hidden prompt scaffolding, wrapper text, and internal control strings
- keep a span map from assembled text back to the contributing observation fields
- use this assembled Markdown text as the preferred unitizer input for tool operations because it is denser and easier to segment than raw fragmented transcript records
- do not force unrelated lifecycle records into the same assembled text block

### 5.6 Session narrative view (assembled)

In addition to tool-specific assembly, V8 should persist a **session-level narrative** that merges all cleaned text:

- user + assistant conversation
- system/agent lifecycle messages that are part of the visible trace
- assembled tool operation snapshots (from 5.5)

This narrative is a **derived, high-density Markdown view** for replay and offline LLM extraction.
In V8, it is also the **canonical input** for unitization and IR extraction.
Raw session traces are only used to assemble the narrative and validate coverage; they are not persisted as
graph inputs.

Persistence (recommended):

- store under `raw/observations/assembled/`
- filename: `session_<session_id>_narrative.md`
- ordering: prefer timestamps; fall back to transcript order when timestamps are missing
- keep it natural-language, not JSON or key-value dumps
- avoid embedding internal IDs (record/unit/tool-call ids); keep those in metadata only
- strip prompt scaffolding, hidden control tags, and other machine-only noise
- coverage: if the narrative misses any trace entries, inject the cleaned trace text back
  into the narrative stream (timestamp order) before unitization
- subagent/acp coverage: when `sessions_spawn` returns `childSessionKey`, resolve the child
  session transcript via `sessions.json`, clean it, and merge its entries into the parent
  narrative timeline with an explicit `subagent:`/`acp:` label (timestamp order)

This view is the primary input for IR extraction and graph materialization.
Evidence spans still trace back to the narrative-derived records.

## 6. Unitization

All narrative records are segmented into `micro`, `meso`, and `macro` units.

### 6.1 Definitions

- `micro`
  - smallest semantically coherent evidence span that can carry a local cue, comparison, condition, or relation, often close to one sentence or short span
- `meso`
  - stable semantic segment that can support one coherent proposition cluster or discourse function, usually within `≈300-1500` Chinese chars or `≈150-800` English tokens
- `macro`
  - topic, section, or time-window context, usually within `≈2k-20k` tokens

### 6.2 Rules

- offsets are first-class
- unit text is derived from the narrative record, not from old event summaries
- unit boundaries are driven primarily by semantic and discourse closure:
  - speaker-turn boundaries
  - sentence and clause completion
  - paragraph and list-item boundaries
  - heading, section, code-fence, or block boundaries
- unit size should roughly match the relation/discourse range it needs to carry:
  - `micro` should usually hold only a small local relation neighborhood
  - `meso` should usually hold one coherent reasoning step, proposition cluster, or discourse role block
  - `macro` should usually hold one stable topic or phase window
- the report's size ranges are secondary envelopes for semantic capacity, not the primary segmentation rule
- character length is only a fallback guardrail when semantic boundaries are too loose or when a source block grows beyond the intended `meso` or `macro` range
- unitization is source-aware:
  - session and daily logs rely on message and paragraph boundaries
  - knowledge and skill documents also respect markdown headings and block structure
- tool observations are unitized only after observation cleaning and promotion
- `event` is not a unit type and not the base segmentation model
- runtime scan windows may remain char-based, but those windows are not storage units

### 6.4 Observation unitization policy

Not every observation should become a text unit.

Rules:

- ordinary user and assistant text go through normal `micro/meso/macro` unitization
- tool observations first remain structured observation records
- only promoted observations with meaningful cleaned text become units
- promotion to LLM IR should follow information density and evidence completeness, not a fixed allowlist of tool names
- when a tool operation has both transcript fragments and runtime observation fields, unitize the assembled operation text view rather than the raw fragments independently
- promoted code-family observations usually become `micro` evidence units or structured state updates, not large `meso` text blocks
- promoted high-density non-code observations may become `micro` or `meso` units when the cleaned text carries stable facts or state transitions
- lifecycle records such as `agent_end` usually become state/attribution updates, not text units

This prevents noisy tool payloads from polluting the unit layer while still preserving memory-relevant operational facts.

### 6.3 Unit example

```json
{
  "unit_id": "unit_20260312_013",
  "narrative_record_id": "narr_20260312_001",
  "layer": "meso",
  "ordinal": 3,
  "char_start": 186,
  "char_end": 266,
  "text": "raw should come from session logs rather than event records ...",
  "language": "zh",
  "parent_unit_id": "unit_20260312_macro_01"
}
```

## 7. Evidence Span Extraction

Units are not enough.
V8 also needs narrower evidence spans.

Example evidence types:

- explicit preference wording
- direct constraint wording
- decision phrases
- path or file mentions
- procedure step boundaries
- error messages

Evidence spans should be extracted before IR so that:

- graph nodes can stay compact
- graph edges can still resolve back to exact wording
- inferred items can cite support evidence instead of pretending direct quotation

Example:

```json
{
  "evidence_span_id": "es_20260312_021",
  "narrative_record_id": "narr_20260312_001",
  "unit_id": "unit_20260312_013",
  "char_start": 202,
  "char_end": 223,
  "text": "不要接 event",
  "speaker": "user",
  "score": 0.94
}
```

## 8. Extraction IR

The extraction IR is the evidence-backed candidate layer between raw text and durable memory.
It is not identical to the runtime memory graph.

### 8.1 IR requirements

Each item must include:

- `item_type`
- `subject`
- `predicate`
- `object`
- `qualifiers`
- `origin_type`
- `evidence_refs`
- `scope`
- `validity`
- `confidence`

### 8.2 Item families

For raw conversational sources, common item types are:

- `preference`
- `constraint`
- `goal`
- `decision`
- `claim`
- `open_question`
- `conversation_act`
- `session_state`

For curated knowledge sources:

- `concept`
- `claim`
- `context`
- `evidence`
- `method`
- `discourse_unit`

For curated skill sources:

- `method`
- `workflow_step`
- `precondition`
- `constraint`
- `checkpoint`
- `failure_mode`
- `recovery`

### 8.3 Origin types

Use explicit origin labels:

- `asserted`
  - directly stated in source text
- `aggregated`
  - merged from several asserted items
- `inferred`
  - system- or model-derived relation based on support evidence

### 8.4 IR example

```json
{
  "memory_item_id": "mi_20260312_004",
  "narrative_record_id": "narr_20260312_001",
  "source_ref": "memory/2026-03-12.md#session-14",
  "item_type": "constraint",
  "origin_type": "asserted",
  "subject": "v8_rewrite",
  "predicate": "exclude_raw_source",
  "object": "event_records",
  "qualifiers": {
    "scope": "global_v8_design",
    "validity": "active"
  },
  "evidence_refs": ["es_20260312_021"],
  "confidence": 0.96
}
```

### 8.5 Text-to-points extraction surfaces

The report's full-text model should stay explicit in V8.
IR is not produced by one flat extractor.
It comes from four coordinated extraction surfaces:

- lexical extraction: keywords, keyphrases, trigger phrases, cue terms
- object extraction: normalized entities, concepts, methods, metrics, contexts
- proposition extraction: typed relations plus open relations when needed
- discourse extraction: paragraph or segment function such as definition, evidence, contrast, conclusion, or recommendation

This matters because V8 is not only building a fact graph.
It is trying to preserve how full text functions, including comparisons, conditions, recommendations, and discourse structure.

The discourse surface should also carry an explicit engineering role set, not an implicit free-form label:

- `definition`, `background`, `event`, `cause`, `outcome`
- `condition`, `purpose`, `evidence`, `comparison`, `contrast`
- `opinion`, `recommendation`, `conclusion`, `procedure_steps`, `exception`

A practical extraction stack remains tiered:

- cue-based rules first
- lightweight classifier second
- LLM only for low-confidence or high-value meso units

### 8.6 Layer-scoped IR

Extraction IR is not one shared ontology across all three layers.

`micro` IR should describe object/fact structure:

- entities, concepts, methods, events, claims, evidence
- object/fact relations inside the bounded `Core 32 + Extended 6` scope

`meso` IR should describe local scene/block structure:

- scene blocks, local objectives, problems, strategies, procedures, decisions, shifts, outcomes
- scene/block relations such as grounding, response, constraint, reframing, culmination, and setup

`macro` IR should describe arc/structure movement:

- arcs, threads, phases, regimes, themes, patterns, turning points, global states
- arc/structure relations such as phase transition, branching, convergence, payoff, foreshadowing, and regime shift

This is the key correction from the earlier draft:
`meso` and `macro` are not enlarged `micro` graphs.

Additional contract:

- `Core 32 + Extended 6` defines the allowed `micro` relation range during extraction.
- it is not a "per-unit checklist" and not a post-extraction candidate pruning stage.
- each unit should emit only relations directly supported in that unit's evidence scope.
- normalization may merge, denoise, or reject weak output, but should not reinterpret this bounded range as a second-stage taxonomy filter.

### 8.7 Normalization and consolidation

V8 should still add an explicit normalization step between extraction IR and graph materialization, but this step is not a type-level pruning pass.

Its job is to:

- deduplicate and normalize extraction instances
- merge aliases and repeated evidence-backed relations
- reject noisy or weakly supported outputs
- consolidate durable memory objects without collapsing the three layer ontologies into one

This is the key separation between `what the raw text instantiated here` and `how V8 consolidates it into stable memory`.

## 9. Graph Materialization

The graph consumes normalization and consolidation outputs derived from extraction IR, not raw text directly.

### 9.1 Layer policy

Graph materialization should preserve the report's three graph layers:

- `micro`: object graph for mentions, cues, objects, facts, and local relations
- `meso`: scene/block graph for local structure and workflow movement
- `macro`: arc/structure graph for threads, phases, and long-range global movement

The layers should not be collapsed into one flat adjacency space.
Different retrieval and recall behaviors depend on this separation.

### 9.2 Node policy

Graph nodes should represent layer-specific normalized structures:

| Layer | Families | Intended meaning |
|---|---|---|
| `micro` | `Entity`, `Concept`, `Method`, `Event`, `Attribute`, `Metric`, `Claim`, `Evidence`, `Context`, `DiscourseUnit` | object/fact graph: concrete objects, abstract concepts, mechanisms, facts, evidence, context, and discourse roles |
| `meso` | `SceneBlock`, `SituationFrame`, `ObjectiveBlock`, `ProblemBlock`, `StrategyBlock`, `ProcedureBlock`, `InteractionBlock`, `DecisionBlock`, `EvidenceFrame`, `ShiftBlock`, `OutcomeBlock`, `BlockFunction` | scene/block graph: one coherent local structure, workflow block, interaction block, or reasoning block |
| `macro` | `Arc`, `Thread`, `Phase`, `GlobalSceneType`, `Regime`, `ObjectiveLine`, `ConflictLine`, `RelationshipArc`, `MethodLine`, `Theme`, `Pattern`, `TurningPoint`, `GlobalState` | arc/structure graph: long-range lines, stages, regimes, patterns, and structural turning points |
| overlay | `Preference`, `Goal`, `Constraint`, `Decision`, `OpenQuestion`, `ConversationAct`, `SessionState`, `TopicState`, `RelationshipState`, `WorkflowValidityState`, `CompatibilityState`, `PreferenceState`, `BeliefState`, `RiskState` | control and state overlay: explicit memory-control slots plus evolving validity and correction states |

Nodes should not store long raw sentences as primary identity.
They should store:

- canonical label
- type
- primary layer or layer membership
- state metadata
- evidence refs
- support counts

### 9.3 Layer-specific bounded taxonomies

The report no longer supports one shared relation taxonomy for all three layers.

Instead:

- `micro` uses the bounded object/fact vocabulary: `Core 32 + Extended 6`
- `meso` uses a scene/block relation vocabulary
- `macro` uses an arc/structure relation vocabulary

The operational groups are:

| Layer | Group | Relations |
|---|---|---|
| `micro` | ontology | `is_a`, `instance_of`, `part_of`, `has_part`, `belongs_to`, `equivalent_to` |
| `micro` | participation | `performs`, `acts_on`, `uses`, `produces`, `targets` |
| `micro` | event structure | `initiates`, `involves`, `occurs_at`, `results_in_event` |
| `micro` | causality and condition | `causes`, `caused_by`, `enables`, `prevents`, `requires`, `conditioned_on` |
| `micro` | time and evolution | `before`, `after`, `simultaneous_with`, `evolves_to` |
| `micro` | comparison | `better_than`, `worse_than`, `similar_to`, `differs_from` |
| `micro` | support | `supports`, `contradicts`, `cites` |
| `micro` | discourse | `elaborates`, `summarizes`, `contrasts`, `explains`, `concludes`, `recommends` |
| `meso` | anchoring and composition | `grounded_in`, `oriented_to`, `focuses_on`, `realized_by`, `evidenced_by_block`, `functions_as` |
| `meso` | local dynamics | `triggered_by`, `responds_to`, `constrained_by`, `attempts_to_resolve`, `escalates`, `mitigates`, `reframes`, `revises` |
| `meso` | local transformation | `culminates_in`, `leads_to`, `produces_shift`, `stabilizes`, `destabilizes`, `opens`, `closes` |
| `meso` | block organization | `precedes_block`, `branches_to`, `merges_into`, `parallels`, `contrasts_with_block`, `echoes`, `sets_up`, `mirrors_locally` |
| `macro` | global structure | `unfolds_through`, `spans_phase`, `organized_as`, `governed_by`, `centered_on_line`, `dominated_by` |
| `macro` | long-range evolution | `transitions_to_phase`, `evolves_to`, `branches_into`, `converges_with`, `interrupted_by`, `resumes_after`, `culminates_at`, `resolved_by` |
| `macro` | global state and constraint | `produces_state`, `shifts_regime`, `stabilizes_state`, `destabilizes_state`, `constrains`, `enables` |
| `macro` | long-range interaction | `competes_with`, `reinforces`, `undermines`, `mirrors`, `recurs_as`, `foreshadows`, `pays_off`, `recontextualizes`, `opens_arc`, `closes_arc` |

Within each layer, the correct rule is sparse instantiation:

- only instantiate the relations actually supported by the local evidence
- do not emit absent relation types
- do not introduce free-form relation labels outside the bounded layer vocabulary unless explicitly versioned as an extension

Every promoted graph edge must carry either direct evidence refs or support evidence refs.
High-value relations should also reserve normalized qualifiers:

- `aspect`
- `time`
- `context`
- `polarity`
- `certainty`
- `evidence_unit_ids`

The full-feature expansion path remains preserved in a separate reference.

### 9.4 Vertical mappings and state-overlay taxonomy

Not every promoted relation belongs equally to every layer.
The expected runtime placement is still:

- `micro`: objects, facts, evidence, and local relation cues
- `meso`: scene blocks, local objectives, strategies, decisions, and block-to-block structure
- `macro`: phases, arcs, threads, regimes, patterns, and turning points

But horizontal placement is only half of the contract.
The graph also needs explicit vertical edges.
These edges define semantics only.
Whether runtime energy propagates through them is a separate scanner policy.

| Kind | Edge | Src -> Dst | Strength | Meaning |
|---|---|---|---|---|
| evidence_anchor | `span_in_micro_unit` | `Span -> MicroUnit` | hard | exact evidence span belongs to a micro unit |
| evidence_anchor | `mention_maps_to_micro_node` | `Span -> MicroNode` | hard | mention resolves to a concrete micro object or concept node |
| evidence_anchor | `micro_edge_evidenced_by_span` | `MicroEdge -> Span` | hard | micro relation is directly supported by a span |
| evidence_anchor | `meso_block_evidenced_by_span_set` | `MesoBlock -> SpanSet` | hard | meso block is supported by a contiguous or near-contiguous evidence set |
| evidence_anchor | `macro_node_evidenced_by_span_set` | `MacroNode -> SpanSet` | soft | macro structure is supported by a distributed evidence set |
| evidence_anchor | `state_evidenced_by_block` | `StateNode -> MesoBlock` | soft | state is supported by a concrete local block rather than a raw span only |
| containment | `micro_unit_in_meso_unit` | `MicroUnit -> MesoBlock` | hard | a micro unit belongs to one meso block |
| containment | `micro_node_in_meso_block` | `MicroNode -> MesoBlock` | hard | a micro node participates in a specific meso block |
| containment | `micro_edge_in_meso_block` | `MicroEdge -> MesoBlock` | hard | a micro relation belongs structurally to a meso block |
| containment | `meso_unit_in_macro_unit` | `MesoBlock -> MacroNode` | hard | a meso block belongs to one macro structure |
| containment | `meso_block_in_phase` | `MesoBlock -> Phase` | hard | a meso block occurs inside a phase |
| containment | `phase_in_arc` | `Phase -> Arc/Thread` | hard | a phase belongs to a larger arc or thread |
| abstraction | `micro_fact_abstracted_as_block` | `MicroNode/MicroEdge -> MesoBlock` | soft | local facts are lifted into a scene or workflow block |
| abstraction | `micro_claim_summarized_by_block` | `Claim/Evidence/Context -> MesoBlock` | soft | one or more claims or evidence objects are summarized by a meso block |
| abstraction | `block_instantiates_global_type` | `MesoBlock -> GlobalSceneType` | soft | local block realizes a reusable macro scene type |
| abstraction | `block_summarized_by_topic` | `MesoBlock -> Theme/Thread` | soft | local block is summarized by a higher-level theme or thread |
| abstraction | `block_contributes_to_pattern` | `MesoBlock -> Pattern` | soft | local block is one instance of a recurring pattern |
| abstraction | `line_summarized_by_theme` | `Arc/Thread/MethodLine/... -> Theme` | soft | long-running line is summarized by a theme |
| line_binding | `local_goal_in_objective_line` | `ObjectiveBlock/OutcomeBlock -> ObjectiveLine` | soft | local goal belongs to a long-running goal line |
| line_binding | `local_conflict_in_conflict_line` | `ProblemBlock/InteractionBlock -> ConflictLine` | soft | local conflict belongs to a long-running conflict line |
| line_binding | `local_method_in_method_line` | `StrategyBlock/ProcedureBlock -> MethodLine` | soft | local strategy or procedure belongs to a method evolution line |
| line_binding | `local_relationship_in_relationship_arc` | `InteractionBlock/ShiftBlock -> RelationshipArc` | soft | local interaction or shift belongs to a relationship arc |
| line_binding | `local_event_in_thread` | `SceneBlock/Event/EvidenceFrame -> Thread` | soft | local event block belongs to a recurring issue thread |
| line_binding | `local_shift_to_turning_point` | `ShiftBlock/OutcomeBlock -> TurningPoint` | soft | local shift contributes to a larger turning point |
| scope_anchor | `state_valid_in_phase` | `StateNode -> Phase` | hard | state is only valid during a specific phase |
| scope_anchor | `state_valid_in_timewindow` | `StateNode -> TimeWindow` | hard | state is only valid during a concrete time window |
| scope_anchor | `block_scoped_to_regime` | `MesoBlock -> Regime` | hard | local block is constrained by a version, environment, or operating regime |
| scope_anchor | `block_scoped_to_topicstate` | `MesoBlock -> TopicState` | hard | local block belongs to a specific topic branch state |
| scope_anchor | `thread_spans_timewindow` | `Thread/Arc -> TimeWindow` | soft | a long-running line spans a time range |
| scope_anchor | `block_updates_global_state` | `MesoBlock -> GlobalState` | soft | local block updates the global state |
| change | `state_supersedes_state` | `StateNode -> StateNode` | hard | new state replaces old state without deleting history |
| change | `state_refines_state` | `StateNode -> StateNode` | soft | new state narrows or qualifies the previous state |
| change | `state_changed_by_event` | `StateNode -> Event/TurningPoint` | hard | a state changes because of an event or turning point |
| change | `state_opened_by_block` | `StateNode -> MesoBlock` | hard | a local block opens or activates a state |
| change | `state_closed_by_block` | `StateNode -> MesoBlock` | hard | a local block closes a state |
| change | `state_invalidated_under_regime` | `StateNode -> Regime/Version` | hard | a state becomes invalid under a regime or version |
| change | `state_reactivated_under_regime` | `StateNode -> Regime/Version` | hard | a state becomes valid again under a new regime |
| change | `correction_propagates_to_line` | `StateNode/MesoBlock -> Thread/MethodLine/RelationshipArc` | soft | a correction affects a larger line and marks related structures for review |

Cross-layer mapping edges must remain explicit and typed.
Do not collapse containment, abstraction, scope, and change into one generic `cross-layer` bucket.

### 9.5 Graph ingestion rules

- merge by canonical identity and type, not by raw string equality only
- do not merge conflicting active states without explicit supersession logic
- preserve `scope`, `validity`, `confidence`, qualifiers, and provenance
- separate asserted and inferred relations
- keep discourse relations separate from memory-state edges even when both affect recall
- require direct evidence refs for `evidence_anchor` edges and support evidence refs for abstraction or line-binding edges
- keep `kind`, `strength`, `requires_scope`, and `stateful` as first-class metadata for vertical edges
- do not infer scope or change semantics from edge names alone; store the corresponding phase, time-window, regime, or topic-state ids explicitly
- allow runtime to ignore propagation over a vertical edge without changing the graph type system

The machine-readable source of truth for this section now lives at:

- `memory-enhanced/schema/v8-edge-catalog.schema.json`
- `memory-enhanced/schema/v8-edge-catalog.json`

### 9.6 Runtime projections

The scanner should not consume raw extraction-IR items directly.
It should consume runtime projections derived from the graph materialization step:

- ignition node projections
- ignition edge projections
- recall bundles or packs
- trigger lexicon
- day index
- source index
- hard-core index

This keeps the architecture clean:

`raw source -> unit/span -> extraction IR -> normalization/consolidation -> graph -> runtime projections -> ignition -> recall assembly`

The graph remains the canonical relation layer.
The runtime projections are optimized views for fast matching and sparse propagation.

### 9.7 Incremental update contract

The report's `open window` rule should be preserved.
V8 should not rebuild the whole corpus for every append.
Instead it should reprocess only the affected neighborhood around changed source ranges.

Recommended rule:

- append raw narrative records immutably
- identify touched `micro / meso / macro` units by source offsets
- reopen a bounded neighborhood around the touched units
- rerun extraction and graph materialization only inside that open window
- preserve stable ids and evidence refs outside the window

This is what keeps long-lived graph ids, evidence refs, and recall bundles stable under continuous updates.

Practical compile switches:

- `rebuild_mode=full`: recompile everything
- `rebuild_mode=incremental`: only changed narrative docs
- `rebuild_mode=hybrid`: changed docs + recent hot window (`hot_window_hours`, current default `48h`)
- optional dev acceleration: `max_narrative_docs` (temporary knob, marked for removal before release)
- optional runtime tuning: `worker_count`, `emit_unit_preview`

### 9.8 Multi-path retrieval contract

The report also requires multi-path retrieval.
V8 should not depend on one retrieval channel.
The serving side should preserve at least:

- lexical retrieval over units, trigger terms, and canonical names
- vector retrieval over meso and macro units
- structural retrieval over objects, propositions, and graph neighbors
- evidence-span alignment back to `micro` units before final recall assembly

The practical retrieval flow is:

1. coarse recall at `macro` and `meso`
2. object- and proposition-centric graph expansion
3. rerank by structural fit and current task anchors
4. align final candidates back to evidence spans

### 9.8.1 Archive search tool contract (integrated into V8)

Status: frozen/deferred until V8 core implementation is stable.

V8 should expose an explicit archive search interface to complete multi-path retrieval:

- `memory_search_archive(query, mode=hybrid|bm25|vector, top_k, hint_span_ids?, hint_bundle_ids?)`
- step 1: retrieve candidate `evidence_span` ids via BM25 + vector
- step 2: apply optional graph-guided rerank using hint spans, bundles, and active mode (`profile|trajectory|oblique|audit`)
- step 3: resolve `span -> narrativeRef + charStart/charEnd`
- step 4: read original narrative text slice by offsets, then return to LLM

This keeps online recall light while avoiding retrieval noise storms:

- ignition injects compact IR/map hints first, not heavy raw payloads
- deep evidence loading happens only when the model explicitly asks for search
- evidence always returns as span-backed raw text, not regenerated summaries
- graph hints constrain lexical/vector search to the right semantic neighborhood

### 9.8.2 Graph-guided search planning contract

To improve over plain Mem0/LanceDB-style top-k retrieval, V8 should add a light query planning layer before archive search:

- build `search_hints` from activated memory:
  - hot `micro` bundle ids
  - linked `group` summary ids
  - relation-direction hints (`horizontal`, `vertical`, `oblique`)
  - optional time/state anchors from control context
- generate high-quality query terms from active IR labels + relation context, not from user text alone
- run search with both:
  - semantic intent terms (what the model wants now)
  - anchored terms (what V8 says is likely relevant evidence)

This contract should ensure:

- if current recalled memory is incomplete, the model can still climb from injected span/unit anchors to the exact evidence it needs
- same-attribute/same-semantic but cross-topic evidence is retrievable with much lower noise
- vertical and oblique relationships can be searched deliberately instead of relying on random vector neighbors

### 9.9 Edge participation profiles for runtime

Edge typing and runtime propagation are separate, but runtime still needs a stable participation contract.

| Edge kind | Runtime role | Spread behavior |
|---|---|---|
| semantic/discourse (horizontal) | associative activation | normal sparse spread |
| containment | structure bridge | stronger bidirectional spread |
| abstraction and line_binding | cross-scale linking | upward-biased spread with stricter damping |
| scope_anchor | validity slicing | no spread, gate/filter only |
| change | state transition control | no generic spread, reweight lineage states |
| evidence_anchor | provenance | no spread, backtrace only |

This resolves the old conflict where all edges were treated as one propagation family.
The scanner can still tune numeric gains, but the above role split should not change per run.

Machine-readable defaults live in:

- `memory-enhanced/schema/v8-edge-runtime-policy.json`

### 9.10 Recall mode contract

Serving should support explicit recall slicing modes:

- `profile`: prioritize "what is active now" with superseded states suppressed
- `trajectory`: prioritize lifecycle and historical evolution through change and scope edges
- `oblique`: prioritize side-line and cross-line associations through abstraction/line-binding edges
- `audit`: prioritize provenance and evidence lineage over compression

Recommended request contract:

```json
{
  "query": "...",
  "mode": "profile|trajectory|oblique|audit",
  "time_slice": "optional phase/timewindow anchor",
  "topic_slice": "optional topic-state anchor",
  "max_packs": 3
}
```

Recommended defaults:

- ordinary QA and live generation: `profile`
- "how did this evolve / what changed / timeline" queries: `trajectory`
- "what related lines or hidden links matter" queries: `oblique`
- debugging/compliance/memory validation: `audit`

Mode selection must happen before treating a mismatch as a memory error.
Temporal or state-shift anchors such as `之前`, `前面`, `前几章`, `前几步`, `一开始`, `后来`, `现在`, `改了`, `变成`, `从头到尾`, and `完整脉络` should bias recall toward `trajectory` or `audit`.
If the user is asking for a historical slice or a state transition, returning a non-current state is not automatically a memory failure.

### 9.11 Hypothesis exploration contract

V8 may generate exploratory associations when context limits prevent direct co-reading of distant evidence.
These outputs must stay non-canonical until validated.

Rules:

- store exploratory links as `hypothesis` records, not canonical graph edges
- hypotheses require support evidence refs and an extraction or inference trace
- hypotheses remain excluded from default `profile` recall
- `oblique` mode may include hypotheses only with explicit support evidence in the returned pack
- promotion to canonical `inferred` edges happens in consolidation after validation checks
- unsupported hypotheses decay and are removed from active runtime projections

## 10. Online Ignition Pipeline

This is the runtime path that makes V8's graph useful during generation instead of only after the fact.

### 10.1 Inputs

The ignition scan should consume:

- control anchors from the focus stack
- recent live stream text
- latest user request
- tool observations, warnings, and errors
- compact graph indexes
- recall bundles or packs already materialized from graph-backed IR

Concrete runtime inputs should include:

- `triggerLexicon` for lexical ignition
- `dayIndex` for episodic locality
- `sourceIndex` for raw and curated source backtrace
- `hardCoreIndex` for tier escalation
- ignition node projections with names, aliases, short summary text, and bundle membership

### 10.2 Trigger windows

Recommended scan windows remain char-based:

| Window | English heuristic | Chinese heuristic | Purpose |
|---|---|---|---|
| `micro` | `24-48` chars | `12-24` chars | lexical ignition |
| `meso` | `96-192` chars | `64-128` chars | sentence or clause semantics |
| `macro` | `256-512` chars | `192-384` chars | rolling scene state |

These are scan windows, not storage units.

The current implementation in `src/v8/scanner.ts` gives a reasonable default profile:

- `microCharsZh = 20`, `microCharsEn = 40`
- `mesoCharsZh = 96`, `mesoCharsEn = 144`
- `macroCharsZh = 256`, `macroCharsEn = 384`
- `scanIntervalChars = 24`

### 10.3 Boundary policy

The scanner should run at:

- punctuation boundaries
- code fence boundaries
- paragraph boundaries
- hard char thresholds

The practical runtime loop is:

1. pre-excite from the initial prompt
2. refresh scene signals from control, prompt, and tool channels
3. accumulate a rolling macro window from the live stream
4. only scan on boundary or interval
5. decay previous activation before the new injection pass

### 10.4 Node ignition score

Direct chunk injection should remain explicit.

Recommended form:

`u_i = baseGain * (a * g_lex + b * max(g_scene, g_ctrl) + c * g_time)`

Where:

- `g_lex` comes from trigger lexicon hits
- `g_scene` comes from overlap between the rolling window and ignition node projection text
- `g_ctrl` comes from overlap with control anchors
- `g_time` encodes temporal availability and episodic day locality
- `baseGain` is higher during initial prompt pre-excitation

The current implementation is already close to this contract:

- `0.45 * g_lex`
- `0.35 * max(g_scene, g_ctrl)`
- `0.20 * g_time`
- `baseGain = 1.4` for initial prompt and `1.0` otherwise

Scene refresh should stay separate from direct chunk injection.
Its current form is a bias field, not the same score path:

- `0.60 * lexicalSceneHit`
- `0.25 * max(sceneOverlap, g_ctrl)`
- `0.15 * g_time`

This separation is important because V8 uses both immediate lexical ignition and slower scene carry.

### 10.5 Propagation

Propagation should remain sparse:

- stronger forward spread for likely continuation
- weaker reverse spread for reminder and backtracking
- hub or degree penalty to suppress generic nodes
- decay over time

The runtime should also preserve:

- `topKEdges` restriction in both directions
- distinct node and bundle cooldown windows
- separate scene-bias decay from activation decay
- second-wave recall after one propagation pass

The current implementation gives useful defaults:

- `forwardGain = 0.30`
- `reverseGain = 0.15`
- `hubPenaltyPower = 0.50`
- `topKEdges = 6`
- `decayLambda = 0.95`
- `sceneDecayLambda = 0.985`

Second-wave recall should remain in the architecture because many relevant memories are one sparse hop away from the direct lexical match.

### 10.6 Episodic gating

Episodic memory should activate locally:

- by day overlap
- by episode overlap
- by source overlap
- by scene overlap

Semantic and procedural memory remain globally available, but episodic activation should stay quiet unless justified by the current scene.

The active day set is the key runtime bridge here.
When a live chunk or scene signal touches an episodic node, its `dayKey` becomes eligible for that scan window.
Propagation into episodic nodes outside the active day set should be suppressed.

### 10.7 Delivery unit

Ignition may score at node level, but recall should be delivered at bundle or pack level.
That is how V8 preserves coherent source-backed recall instead of spraying isolated node fragments into context.

Bundle or pack selection should follow this order:

1. aggregate node activation and scene bias to bundle energy
2. classify bundle tier after aggregation
3. apply per-tier thresholds
4. suppress bundles still inside cooldown
5. select only a very small top-k set for insertion

The current implementation exposes the right architectural defaults:

- `criticalThreshold = 0.82`
- `decisionThreshold = 0.74`
- `backgroundThreshold = 0.68`
- `secondWaveThreshold = 0.78`
- `maxInjectedBundles = 2`

Tier remains a recall insertion policy.
It must not leak backward into graph ontology.

### 10.8 New graph interface alignment

The new graph interface does not remove bundle-first recall.
It changes where bundles come from.

Old model:

- compiler creates bundles first, then nodes and edges

New model:

- IR creates canonical graph objects first
- runtime materialization groups them into ignition bundles or recall packs
- packs carry evidence refs, source refs, best summary text, and the node ids that made them hot

This keeps the graph canonical while preserving the old V8 runtime strength.

### 10.9 Recall trace and review window

Whenever V8 injects recall, it should append a `recall_trace` record and open a short review window.

Minimum trace payload:

- `run_id`, `session_id`
- `mode` (`profile|trajectory|oblique|audit`)
- delivered pack ids
- delivered node ids
- delivered evidence ids
- active time/topic slice
- control-anchor snapshot
- prompt hash or prompt ref

Review-window rules:

- open for the next `1-2` user turns and the immediately following tool/assistant cycle
- only feedback that can be resolved back to delivered recall objects may adjust memory weights
- free-form approval or disapproval without recall alignment should be treated as execution feedback, not memory feedback

### 10.10 Feedback attribution stack

V8 must not map one user sentence directly to a durable weight change.
It should reconstruct an attribution chain from runtime observations.

Observation sources:

- `user_feedback`: later user turns, especially inside the review window
- `model_adoption_feedback`: `llm_input` plus `llm_output`
- `fact_outcome_feedback`: `after_tool_call`, `tool_result_persist`, and final `agent_end` snapshot

Before attribution, each source must be normalized with its family-specific cleaner.
Attribution must consume cleaned observations plus structured metadata, not raw payload blobs.

Fast-path requirement:

- the default attribution path should be code-only and non-LLM
- use recall-trace alignment, structured metadata, simple lexical matching, and explicit user feedback cues first
- only when attribution remains ambiguous should V8 call a lightweight LLM judge
- the LLM fallback should receive only a small local slice: delivered recall summary, one or two user turns, and compact tool/outcome snippets

Recommended internal attribution fields:

- `M_present`: was the memory or pack actually delivered
- `M_surface`: did the model surface or paraphrase it
- `M_used`: did the model plan or tool behavior depend on it
- `M_consistent`: did later tool or textual facts support it under the active scope
- `O_delta`: did the outcome improve, degrade, or stay neutral

Recommended internal attribution labels:

- `memory_content_error`
- `memory_scope_selection_error`
- `task_stack_drift`
- `memory_induced_execution_error`
- `memory_helped`
- `memory_ignored_neutral`
- `memory_missed_relevant`

### 10.10.1 Feedback record contract

Feedback should be recorded explicitly before any weight change is applied.

Recommended record:

```json
{
  "feedback_id": "fb_20260313_021",
  "session_id": "sess_22",
  "run_id": "run_817",
  "recall_trace_id": "rt_20260313_004",
  "source": "user|tool|model",
  "label": "memory_content_error",
  "polarity": "negative",
  "targets": ["node:rel_192", "pack:pk_12"],
  "scope": "flash|scene|durable",
  "evidence_refs": ["es_20260312_021"],
  "reason": "user correction aligned to delivered recall",
  "timestamp": "2026-03-13T12:03:22.000Z"
}
```

Rules:

- always link back to the `recall_trace_id` when available
- do not apply weight changes directly from raw user text
- store enough provenance to replay or undo a feedback decision

### 10.10.2 Fast-path detection logic

The fast path should be deterministic and cheap.

Minimum logic:

1. Check review window and the last `recall_trace`.
2. Align user or tool feedback to delivered packs or nodes using:
   - explicit ids, if present
   - lexical overlap with delivered summaries
   - evidence span overlap when available
3. Classify into one of the attribution labels.
4. Emit `feedback record`, then apply `flash` or `scene` updates.

If alignment fails, record `memory_ignored_neutral` and do not change durable weights.

### 10.10.3 Weight update rules

Use a two-step rule:

- `flash` or `scene` updates may be applied immediately
- `durable` updates require repeated aligned feedback or strong fact confirmation

Recommended safeguards:

- clamp deltas to a small range
- never apply `durable` updates from a single ambiguous signal
- allow later feedback to neutralize earlier mistaken deltas

### 10.10.4 Fact feedback from tools

Tool outcomes are the primary fact channel.

Rules:

- `after_tool_call` errors should bias toward `memory_induced_execution_error` unless a recall was explicitly used as a fact claim
- structured tool success that contradicts a recalled claim is `memory_content_error`
- tool success that indicates a different time slice or state is `memory_scope_selection_error`
- tool output that merely adds detail without contradiction is `memory_helped` or `memory_ignored_neutral`

### 10.10.5 Minimal feedback dataflow example

```text
1) Recall injection
   - V8 injects pack `pk_12` with nodes [`node:rel_192`, `node:claim_44`]
   - recall trace `rt_20260313_004` is recorded

2) Observation
   - user says: "你记错了，我们没有用 Redis"
   - or tool returns: "grep found no redis usage"

3) Fast-path alignment
   - feedback aligns to `pk_12` and `node:rel_192`
   - classify as `memory_content_error`

4) Feedback record
   - write `feedback_record` with `recall_trace_id`, targets, label, polarity

5) Weight updates
   - apply `flash`/`scene` suppress on `node:rel_192`
   - schedule `durable` change only after repeated aligned evidence
```

This keeps the feedback path explicit and replayable without requiring a heavy LLM judge in the normal case.

### 10.10.6 Persistence and application model

Feedback should be stored in two layers:

- `feedback_records.jsonl`
  - append-only facts about what feedback was observed and how it was classified
- `feedback_overrides.jsonl`
  - append-only applied deltas or state overrides used by runtime recall

Recommended override record:

```json
{
  "override_id": "fo_20260313_011",
  "feedback_id": "fb_20260313_021",
  "target_id": "node:rel_192",
  "layer": "flash|scene|durable",
  "operation": "reinforce|suppress|scope_shift|clear",
  "delta": -0.25,
  "ttl_sec": 86400,
  "created_at": "2026-03-13T12:03:22.000Z"
}
```

Rules:

- runtime scanners should consume overrides, not recompute feedback every turn
- `flash` overrides are session-local and may stay in memory or a lightweight session file
- `scene` overrides should persist briefly and expire by TTL
- `durable` overrides should persist until superseded, neutralized, or consolidated into graph state

### 10.10.7 Priority and conflict rules

When multiple feedback sources disagree, apply this priority order:

1. explicit aligned user correction
2. strong structured tool fact
3. repeated model-adoption evidence
4. weak textual or ambiguous signals

Conflict rules:

- user correction wins over weak model-adoption evidence
- strong tool contradiction wins over model self-consistency
- scope-shift evidence should not erase older valid states; it should bias mode selection or state validity instead
- ambiguous feedback should degrade to `memory_ignored_neutral`, not force a content-error label

### 10.10.8 Replay, rollback, and consolidation

Feedback must be replayable and reversible.

Replay rules:

- rebuilding a workspace should replay `feedback_records` into `feedback_overrides`
- expired `flash` and `scene` overrides should be skipped during replay
- replay order must follow `created_at`

Rollback rules:

- a later corrective feedback record may emit `clear` or opposite-sign overrides
- rollback should target prior `override_id` or the same `target_id` plus layer
- the system must be able to rebuild the effective feedback state by replay alone

Consolidation rules:

- `durable` overrides may periodically consolidate into graph-side weight/state fields
- consolidation must keep the original `feedback_records` and `feedback_overrides`
- after consolidation, replay must still be deterministic

### 10.10.9 Feedback storage footprint and retention

Feedback data must stay small and bounded.

Rules:

- `feedback_records.jsonl` keeps compact records only; avoid duplicating large tool outputs
- `feedback_overrides.jsonl` stores only applied deltas and short TTLs for `flash` and `scene`
- expired `flash` and `scene` overrides should be pruned during replay or compaction
- `durable` overrides should be sparse; if they grow too large, consolidate them into graph state

Suggested defaults:

- `flash` TTL: session lifetime only
- `scene` TTL: 1 to 7 days
- `durable` TTL: none (until superseded or consolidated)

### 10.10.10 Feedback-driven recall tuning

Feedback should also influence recall behavior, not only node weights.

Rules:

- repeated `memory_scope_selection_error` should bias mode selection toward `trajectory` or `audit` for related topics
- repeated `memory_induced_execution_error` should down-weight aggressive recall for the affected tool or topic
- repeated `memory_helped` should increase pack priority for similar queries
- these adjustments should be implemented as lightweight runtime biases, not graph rewrites

Weight updates must remain layered:

- `flash_weight`: current answer or current tool cycle only
- `scene_weight`: next `1-2` turns of ignition and recall
- `durable_weight`: long-lived graph adjustment only after repeated evidence or strong fact confirmation

Interpretation rules:

- explicit user correction inside the review window may adjust `flash_weight` and `scene_weight` immediately
- plain agreement or disagreement that is not tied to the delivered recall should not move durable graph weights
- a mismatch caused by asking for `before/after/earlier/later` slices should prefer `trajectory` or `audit` recall, not direct suppression
- fact-based feedback can strengthen or weaken memory even when the user never explicitly says "you remembered this wrong"
- tool noise must not be mistaken for fact contradiction; shallow pre-clean plus structured metadata is enough for the fast path
- control-family observations may support attribution but should not directly produce durable factual memory without an external or user-visible grounding source

### 10.11 OpenClaw integration contract

OpenClaw's runtime surfaces should be used with distinct roles:

- `message_received`: user-intent and explicit feedback detection only
- `after_tool_call`: real-time tool observation, including `read` results and execution errors
- `tool_result_persist`: canonical transcript-side copy of tool results before write
- `before_message_write`: last interception point before session persistence
- `llm_input`: what context, including prior tool results, actually reached the model
- `llm_output`: what the model actually produced after recall injection
- `agent_end`: final reconciliation snapshot

The current clean-slate code path already uses `after_tool_call` for transient scene refresh, but the target architecture requires durable observation logging in addition to that transient use.
Likewise, session normalization must not rely only on user or assistant text when tool outcomes are required for fact feedback or lifecycle reconstruction.
Session replay should also stop treating transcript text as complete tool evidence: transcript `toolCall/toolResult` records, live `after_tool_call`, and lifecycle hooks must be merged into one observation ledger with source-priority rules.

## 11. Summary and State Materialization

The same IR should generate two runtime-friendly products.

### 11.1 Summary packs

Examples:

- user preference summary
- project background summary
- topic summary

Purpose:

- compression
- stable long-term reuse
- low-token recall

### 11.2 State packs

Examples:

- active goal
- current constraints
- unresolved questions
- conflict and resolution state

Purpose:

- task continuity
- branch control
- scope-sensitive recall

### 11.3 Pack cache (default persistence)

Summary/state packs are assembled at runtime.
To avoid repeated LLM cost, persist packs by default even for low-frequency bundles.

Default retention policy:

- TTL = 7 days
- do not expire if explicitly marked as required by the user or LLM

### 11.3 Decay scope

Decay only targets runtime weights and projections:

- node/edge activation weights, recency features, cooldowns
- hypothesis edges and exploratory artifacts
- bundle/pack hotness caches

Decay must not alter raw sources, units, or evidence spans.

## 12. Context Assembly

Runtime recall should assemble from three sources:

- `RawEvidencePack`
- `MemorySummaryPack`
- `StructuredStatePack`

Selection policy:

- prefer raw evidence when wording matters
- prefer summary when stable background matters
- prefer state when branch control or conflict resolution matters

The graph helps select candidates.
Evidence backtrace provides the final grounding.

## 13. Role of Offline Annotation

Offline annotation remains in V8, but its job changes.

It is used for:

- low-confidence meso units
- ambiguous relation extraction
- conflict resolution suggestions
- graph cleanup and rebuild proposals

It is not used for:

- defining raw authority
- inventing the primary segmentation
- replacing evidence-backed IR
- replacing the online ignition layer

## 14. Migration Notes

The old V8 pipeline treated these as first-class compilers:

- `compile-event`
- `compile-knowledge-md`
- `compile-skill-md`

The new V8 should instead use:

- source adapters
- unitizers
- evidence extractors
- IR extractors
- graph and summary/state materializers

Legacy `event` inputs may still be read during migration, but only as secondary hints.

## 15. Non-Goals

This design does not require:

- eliminating curated `knowledge` or `skill`
- removing the graph
- replacing `focus_stack.json`

This design does require:

- raw evidence authority
- source normalization
- IR as the central contract
- evidence-backed graph and summary/state outputs
