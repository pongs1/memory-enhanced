# V8 LoCoMo Benchmark Design

Status: proposed benchmark design
Date: 2026-03-21
Depends on:
- [2026-03-20-v8-pipeline-implementation.md](d:/E/memory_sys_design/memory-enhanced/docs/superpowers/specs/2026-03-20-v8-pipeline-implementation.md)
- [2026-03-16-v8-validation-tuning.md](d:/E/memory_sys_design/memory-enhanced/docs/superpowers/plans/2026-03-16-v8-validation-tuning.md)

## 1. Goal

This benchmark exists to diagnose V8 by workflow, not to collapse the system into one aggregate benchmark score.

Primary goal:
- identify which workflow stage degraded
- preserve before/after evidence for tuning
- keep a small LoCoMo-based smoke suite that can run after significant pipeline or runtime changes

Secondary goal:
- preserve reportable benchmark scores after the workflow-level diagnosis is available

## 2. Dataset Policy

Default dataset:
- LoCoMo

Default operating size:
- `10-sample smoke`

Deferred sizes:
- `50-sample tuning batch`
- `full dataset nightly`

The default development rhythm uses the 10-sample smoke suite only. Larger runs are follow-up validation, not the default edit loop.

## 3. Evaluation Identity

Every benchmark run must declare exactly one evaluation path:
- `direct_text_baseline`
- `background_write_loop`
- `compiled_memory_recall`
- `front_search_escalation`
- `backend_relation_mining`
- `composed_system_eval`

A LoCoMo run is not automatically a clean recall benchmark. It becomes `composed_system_eval` unless the run configuration explicitly constrains the exercised workflow.

## 4. Workflow-First Interpretation

The benchmark is interpreted in this order:
1. direct text baseline
2. background write loop
3. compiled-memory recall
4. front search escalation
5. backend relation mining
6. composed system evaluation

A composed LoCoMo score is integration evidence only. It must not be used as proof that any one workflow is healthy in isolation.

## 5. Scoring Axes

The benchmark uses three scoring axes.

### 5.1 Answer correctness

Answer correctness is the primary externally reportable metric.

Default policy:
- use LoCoMo gold answers when available
- use exact or normalized match first
- use existing benchmark answer comparison logic as fallback

### 5.2 Evidence grounding quality

Evidence grounding is a diagnosis metric.

Default policy:
- programmatic checks first
- limited LLM judge spot checks second

Programmatic checks must verify:
- the answer cites or depends on selected units actually used by recall
- selected units resolve to supporting `memory_items`
- the supporting `memory_items` contain evidence spans traceable to narrative text
- key answer claims are covered by selected unit content or compiled pack content derived from those units

LLM judging is optional and bounded. It is used only for a small sample of ambiguous cases.

### 5.3 Workflow attribution accuracy

Workflow attribution is an internal diagnosis metric.

Default policy:
- trace/rule only
- no LLM judging

Attribution must state which workflows actually executed:
- background compile
- compiled-memory recall
- front search escalation
- backend relation mining

## 6. Benchmark Outputs

Each run must emit two output layers.

### 6.1 Workflow scorecard

The scorecard is the primary run summary.

Required fields:
- run id
- benchmark dataset
- evaluation path
- executed workflows
- sample count
- answer correctness summary
- evidence grounding summary
- workflow attribution summary
- latency summary
- token usage summary
- hard-failure count

### 6.2 Sample review pack

The review pack is the primary tuning artifact.

Each selected sample review must include:
- sample id
- question
- expected answer
- produced answer
- evaluation path
- executed workflows
- recall trace summary
- selected unit ids
- selected unit excerpts
- supporting source refs
- grounding verdict
- workflow attribution verdict
- failure classification when applicable

## 7. Markdown Review Artifacts

Benchmark runs must produce markdown review artifacts in addition to machine-readable outputs.

Required review files:
- `runtime/review/pipeline_review.md`
- `runtime/review/source_narrative_review.md`
- `runtime/review/unit_review.md`
- `runtime/review/ir_review.md`
- `runtime/review/graph_review.md`
- `runtime/review/pack_review.md`
- `runtime/review/benchmark_review.md`

`benchmark_review.md` is the benchmark-facing wrapper that links the workflow scorecard with sample review packs.

## 8. Smoke Cadence

Default cadence:
1. run `10-sample smoke` after significant compile/runtime/recall changes
2. inspect workflow scorecard first
3. inspect sample review packs for failed samples second
4. only run larger LoCoMo batches after the smoke suite is stable

A failed smoke run blocks larger benchmark runs until the failure is classified.

## 9. Sample Selection Policy

The 10-sample smoke suite must be stable across iterations.

The selected LoCoMo subset must first satisfy minimum scale constraints:
- `session_count >= 4`
- `turn_count >= 30`
- `narrative_chars >= 12000`

Preferred smoke candidates should fall inside this stronger target band:
- `session_count >= 6`
- `turn_count >= 50`
- `narrative_chars >= 20000`

The selected LoCoMo subset should then cover at minimum:
- one direct-answer sample
- one state-change sample
- one time-dependent sample
- one multi-hop recall sample
- one sample likely to require search escalation
- one sample likely to require relation reconstruction

The remaining slots should balance answer length, dialogue density, and temporal spread.
Samples below the minimum scale constraints must not enter the default smoke suite because they can be answered by short-context attention alone and do not exercise the memory system honestly.

## 10. Failure Taxonomy

Benchmark failures must be classified before tuning.

Required classes:
- `answer_wrong`
- `answer_partial`
- `grounding_missing`
- `grounding_weak`
- `write_loop_failure`
- `compiled_recall_failure`
- `search_escalation_failure`
- `relation_mining_failure`
- `workflow_attribution_mismatch`
- `runner_or_eval_failure`

A run summary without failure taxonomy is incomplete.

## 11. LoCoMo Integration Boundary

Existing scripts remain the integration boundary:
- [benchmark-eval-prep.mjs](d:/E/memory_sys_design/memory-enhanced/scripts/benchmark-eval-prep.mjs)
- [benchmark-eval-runner.mjs](d:/E/memory_sys_design/memory-enhanced/scripts/benchmark-eval-runner.mjs)

Required changes should stay inside the current script path unless a new file is needed to keep runner logic isolated and readable.

## 12. Non-Goals

This benchmark does not attempt to:
- prove full model quality from one aggregate score
- replace workflow-level validation with benchmark convenience
- make LLM judging the default source of truth
- treat a composed LoCoMo run as proof that every V8 subsystem works

## 13. Acceptance Criteria

This design is implemented when:
- a LoCoMo 10-sample smoke run can be prepared and executed repeatably
- every run declares one evaluation path and lists actual executed workflows
- every run emits a workflow scorecard and markdown benchmark review artifact
- failed samples preserve enough evidence for tuning without opening raw JSONL files directly
- larger LoCoMo runs are gated behind smoke stability rather than used as the default inner loop

