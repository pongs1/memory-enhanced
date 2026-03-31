# V8 LoCoMo Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a workflow-first LoCoMo benchmark harness that defaults to a 10-sample smoke suite, emits workflow scorecards plus markdown review artifacts, and diagnoses failures by V8 workflow instead of by one aggregate score.

**Architecture:** Reuse the existing LoCoMo prep and benchmark runner entrypoints, but add explicit evaluation-path identity, workflow execution tracing, scorecard generation, and benchmark-facing markdown review artifacts. Keep machine-readable benchmark outputs for automation while adding stable markdown outputs for human diagnosis.

**Tech Stack:** TypeScript/Node.js scripts, existing benchmark prep/runner scripts, markdown review writers, JSON/JSONL outputs, LoCoMo fixture input, V8 recall/runtime traces.

---

### Task 1: Add Benchmark Run Identity And Workflow Execution Labels

**Files:**
- Modify: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Modify: `memory-enhanced/docs/superpowers/specs/2026-03-21-v8-locomo-benchmark-design.md`
- Test: `memory-enhanced/tests/v8/benchmark-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/benchmark-runner.test.ts` with a case that runs the runner summary builder without `evaluationPath` and asserts that the run is rejected.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL in the new benchmark runner test because run identity is not enforced yet.

- [ ] **Step 3: Implement evaluation-path identity**

In `memory-enhanced/scripts/benchmark-eval-runner.mjs`, add explicit handling for:
- `direct_text_baseline`
- `background_write_loop`
- `compiled_memory_recall`
- `front_search_escalation`
- `backend_relation_mining`
- `composed_system_eval`

Also record executed workflows:
- `backgroundCompile`
- `compiledRecall`
- `frontSearchEscalation`
- `backendRelationMining`

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for benchmark-runner identity test.

### Task 2: Add LoCoMo 10-Sample Smoke Suite Selection

**Files:**
- Modify: `memory-enhanced/scripts/benchmark-eval-prep.mjs`
- Create: `memory-enhanced/scripts/locomo-smoke-selection.mjs`
- Test: `memory-enhanced/tests/v8/locomo-smoke-selection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/locomo-smoke-selection.test.ts` with a deterministic fixture asserting that the smoke selector returns exactly 10 stable sample ids for the same input.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL because the selector does not exist.

- [ ] **Step 3: Implement stable smoke selection**

Create `memory-enhanced/scripts/locomo-smoke-selection.mjs` that selects a deterministic 10-sample subset and expose it through `benchmark-eval-prep.mjs`.

Selection contract:
- deterministic ordering
- default size 10
- hard minimum filters:
  - `session_count >= 4`
  - `turn_count >= 30`
  - `narrative_chars >= 12000`
- preferred target band:
  - `session_count >= 6`
  - `turn_count >= 50`
  - `narrative_chars >= 20000`
- coverage for state/time/multi-hop/search-heavy cases when metadata allows
- fallback to the first stable ordered subset only after the minimum filters are applied
- samples below the minimum filters are excluded from the default smoke suite

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for smoke selection test.

### Task 3: Emit Workflow Scorecard Output

**Files:**
- Modify: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Create: `memory-enhanced/src/v8/review/benchmark-scorecard.ts`
- Test: `memory-enhanced/tests/v8/benchmark-scorecard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/benchmark-scorecard.test.ts` asserting that a benchmark result set produces a scorecard with:
- run id
- dataset
- evaluation path
- executed workflows
- sample count
- correctness summary
- grounding summary
- attribution summary
- latency summary
- token summary

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL because no scorecard builder exists.

- [ ] **Step 3: Implement scorecard builder**

Create `memory-enhanced/src/v8/review/benchmark-scorecard.ts` with a pure function that builds the workflow scorecard object and integrate it into `benchmark-eval-runner.mjs`.

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for scorecard test.

### Task 4: Add Evidence Grounding Evaluation

**Files:**
- Modify: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Create: `memory-enhanced/src/v8/review/grounding-eval.ts`
- Test: `memory-enhanced/tests/v8/grounding-eval.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/grounding-eval.test.ts` covering:
- grounded answer with selected units and source refs
- weak grounding when answer claims exceed supporting units
- missing grounding when no selected units exist

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL because no grounding evaluator exists.

- [ ] **Step 3: Implement programmatic grounding evaluation**

Create `memory-enhanced/src/v8/review/grounding-eval.ts`.

Default checks:
- selected units exist
- selected units map to source refs
- supporting memory items resolve to evidence spans
- answer claim coverage can be approximated from unit excerpts or compiled pack excerpts

Keep LLM judge hooks optional and unimplemented unless already present.

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for grounding evaluation test.

### Task 5: Add Workflow Attribution Evaluation

**Files:**
- Modify: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Create: `memory-enhanced/src/v8/review/workflow-attribution.ts`
- Test: `memory-enhanced/tests/v8/workflow-attribution.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/workflow-attribution.test.ts` with cases asserting that trace metadata is translated into a workflow attribution verdict without LLM judging.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL because no attribution evaluator exists.

- [ ] **Step 3: Implement workflow attribution evaluator**

Create `memory-enhanced/src/v8/review/workflow-attribution.ts`.

Required outputs:
- executed workflows
- expected evaluation path
- attribution mismatch flag
- failure category when the path and trace disagree

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for workflow attribution test.

### Task 6: Emit Benchmark Markdown Review Artifact

**Files:**
- Modify: `memory-enhanced/src/v8/review/markdown-writer.ts`
- Modify: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Test: `memory-enhanced/tests/v8/benchmark-review-markdown.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/benchmark-review-markdown.test.ts` asserting that `benchmark_review.md` is produced with:
- run context
- workflow scorecard summary
- failed sample links
- per-sample review snippets

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL because benchmark markdown output is not implemented.

- [ ] **Step 3: Implement markdown writer integration**

Extend `memory-enhanced/src/v8/review/markdown-writer.ts` with:
- `writeBenchmarkReviewMarkdown(...)`

Integrate it into `benchmark-eval-runner.mjs` after machine-readable outputs are written.

Required file:
- `.memory/runtime/review/benchmark_review.md`

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for benchmark markdown test.

### Task 7: Add Failure Taxonomy To Benchmark Results

**Files:**
- Modify: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Create: `memory-enhanced/src/v8/review/failure-taxonomy.ts`
- Test: `memory-enhanced/tests/v8/failure-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/failure-taxonomy.test.ts` with representative cases for:
- `answer_wrong`
- `grounding_missing`
- `compiled_recall_failure`
- `workflow_attribution_mismatch`
- `runner_or_eval_failure`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL because benchmark failures are not classified yet.

- [ ] **Step 3: Implement failure taxonomy classifier**

Create `memory-enhanced/src/v8/review/failure-taxonomy.ts` and integrate it into runner result aggregation.

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for taxonomy test.

### Task 8: Add Smoke Runner Command And Output Layout

**Files:**
- Modify: `memory-enhanced/package.json`
- Modify: `memory-enhanced/scripts/benchmark-eval-prep.mjs`
- Modify: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Test: `memory-enhanced/tests/v8/benchmark-smoke-command.test.ts`

- [ ] **Step 1: Write the failing test**

Create `memory-enhanced/tests/v8/benchmark-smoke-command.test.ts` that verifies the runner accepts a smoke mode or equivalent config and emits the expected output layout.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run test:v8`
Expected: FAIL because no dedicated smoke path exists.

- [ ] **Step 3: Implement smoke command wiring**

Add a dedicated package script, for example:
- `bench:locomo:smoke`

Ensure outputs include:
- machine-readable run summary
- workflow scorecard
- `.memory/runtime/review/benchmark_review.md`
- sample-level review files or linked sections

- [ ] **Step 4: Re-run tests**

Run: `npm.cmd run test:v8`
Expected: PASS for smoke command test.

### Task 9: Verify End-To-End Smoke Workflow

**Files:**
- Review: `memory-enhanced/scripts/benchmark-eval-prep.mjs`
- Review: `memory-enhanced/scripts/benchmark-eval-runner.mjs`
- Review: `memory-enhanced/src/v8/review/*.ts`
- Review: `memory-enhanced/tests/v8/*.test.ts`

- [ ] **Step 1: Run the V8 test suite**

Run: `npm.cmd run test:v8`
Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 3: Run one LoCoMo smoke benchmark**

Run a 10-sample LoCoMo smoke command against a local LoCoMo JSON input.
Expected:
- run summary produced
- workflow scorecard produced
- `benchmark_review.md` produced
- failures classified instead of left as raw output only

- [ ] **Step 4: Review output quality**

Check that failed samples can be reviewed without opening raw JSONL files directly.

- [ ] **Step 5: Commit**

```bash
git add memory-enhanced/package.json \
  memory-enhanced/scripts/benchmark-eval-prep.mjs \
  memory-enhanced/scripts/benchmark-eval-runner.mjs \
  memory-enhanced/src/v8/review \
  memory-enhanced/tests/v8 \
  memory-enhanced/docs/superpowers/specs/2026-03-21-v8-locomo-benchmark-design.md \
  memory-enhanced/docs/superpowers/plans/2026-03-21-v8-locomo-benchmark-implementation.md
git commit -m "feat: add workflow-first locomo benchmark harness"
```

