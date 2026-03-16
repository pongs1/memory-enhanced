# Benchmark Eval

This repo now has a lightweight benchmark-prep layer so we can test V8 using the same flow we use for real dialogue:

1. benchmark conversation/history
2. `session_narrative.md`
3. `questions.jsonl`
4. optional graph / archive-search / relation-review evaluation

The goal is not to hard-code to one benchmark. The goal is to normalize several memory-style benchmarks into a common evaluation surface that matches our architecture.

## Benchmarks

### LoCoMo

Best first integration.

Why:

- already conversation-shaped
- comes with QA and evidence references
- good for:
  - timeline recall
  - relationship/state change
  - multi-hop long-dialogue questions

Current support:

- `scripts/benchmark-eval-prep.mjs --benchmark locomo`
- expects the official `locomo10.json` / compatible file
- writes:
  - `session_narrative.md`
  - `questions.jsonl`
  - `turn_map.jsonl`
  - `metadata.json`

`turn_map.jsonl` preserves `dia_id -> narrative span` mapping outside the narrative itself, so we keep the narrative LLM-friendly while still supporting evidence checks.

### LongMemEval

Used to test:

- long-horizon recall
- haystack/noise tolerance
- retrieval quality under partial context

Current support:

- `scripts/benchmark-eval-prep.mjs --benchmark longmemeval`
- currently a flexible local-subset adapter
- accepts local JSON subsets with conversation/history-like fields and turns them into the same narrative/question format

This is intentionally thin for now. We want to start with small local subsets before wiring a full official runner.

### MemoryAgentBench

Used to test:

- retrieval accuracy
- long-range understanding
- test-time learning / conflict handling
- more agent-like multi-step memory use

Current support:

- `scripts/benchmark-eval-prep.mjs --benchmark memoryagentbench`
- currently a flexible local-subset adapter
- intended for thin subsets first, then later full protocol integration

## Synthetic Cases

Real benchmarks are important, but they do not perfectly target our architecture.

We also keep synthetic short cases for:

- alias bridge retrieval
- state/relationship trajectory
- context-cleared multi-hop recall
- graph-guided archive search vs raw lexical/vector search

Current script:

- `scripts/archive-search-smoke.mjs`

These cases are not replacements for benchmarks. They are targeted probes for architecture risks that public benchmarks may under-measure.

## Commands

### Prepare LoCoMo

```bash
node scripts/benchmark-eval-prep.mjs \
  --benchmark locomo \
  --input /path/to/locomo10.json \
  --limit 2
```

### Prepare local LongMemEval subset

```bash
node scripts/benchmark-eval-prep.mjs \
  --benchmark longmemeval \
  --input /path/to/longmemeval_subset.json \
  --limit 8
```

### Prepare local MemoryAgentBench subset

```bash
node scripts/benchmark-eval-prep.mjs \
  --benchmark memoryagentbench \
  --input /path/to/memoryagentbench_subset.json \
  --limit 8
```

### Run synthetic archive-search smoke

```bash
node scripts/archive-search-smoke.mjs
```

### Run prepared benchmark sample through V8 build + archive-search baseline

```bash
node scripts/benchmark-eval-runner.mjs \
  --prepared-sample /path/to/prepared/locomo/sample_dir \
  --top-k 5
```

Optional:

```bash
node scripts/benchmark-eval-runner.mjs \
  --prepared-sample /path/to/prepared/locomo/sample_dir \
  --top-k 5 \
  --ir-llm-command "<offline llm batch command>" \
  --rule-ir-mode micro_light
```

This runner currently gives a first baseline:

- prepare benchmark sample
- build V8 artifacts from `session_narrative.md`
- run archive search per question
- score whether top-k hits overlap expected evidence

The runner now evaluates three retrieval paths:

- `raw`: plain archive search from the question
- `static-guided`: question + relation-search-plan hints
- `ignition-guided`: replay the cleaned turn stream, project text signals into horizontal and vertical cues, then search with activated bundles plus vertical trigger hints

It is intentionally a baseline, not the final full protocol. Its job is to tell us whether the current memory pipeline is moving in the right direction before we add relation-review and full answer-generation scoring.

Important current limitation:

- without stronger semantic IR (especially LLM-produced semantic anchors), `relation_search_plans` may stay empty
- in that case the runner still gives a valid raw archive-search baseline, but graph-guided retrieval is not meaningfully active yet

## What To Measure

For each prepared sample, we eventually want to score at least:

- answer correctness
- evidence hit correctness
- whether multi-hop retrieval was required
- whether graph-guided search beat raw search
- whether the system promoted wrong intermediate diagnoses into durable memory

## Near-Term Plan

1. use `LoCoMo` as the first real benchmark adapter
2. add thin local subsets for `LongMemEval` and `MemoryAgentBench`
3. connect `memory_search_archive -> relation review -> accepted relation` into the eval loop
4. only after that, consider full benchmark protocol automation
