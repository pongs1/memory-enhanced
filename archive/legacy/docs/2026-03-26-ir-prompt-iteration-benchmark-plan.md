# IR Prompt Iteration Benchmark Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable prompt-iteration loop that runs benchmark samples, captures failures in human-reviewable form, extracts prompt anti-patterns and preferred patterns, then re-runs the same samples to measure improvement.

**Architecture:** Keep the current narrative-to-IR workflow intact and add a focused evaluation loop around it. The loop should treat prompt wording as a first-class artifact, produce md review files instead of json-only debugging, and maintain a stable bad-case corpus so prompt changes can be tested against the same examples over time.

**Tech Stack:** TypeScript, Node.js, existing V8 benchmark runner, existing md review writers, existing `.tmp/prompt-eval-run` workspace structure

---

### Task 1: Define the stable evaluation artifact layout

**Files:**
- Create: `docs/superpowers/plans/2026-03-26-ir-prompt-iteration-benchmark-plan.md`
- Modify: `scripts/benchmark-ir-prompt-runner.mjs`
- Modify: `src/v8/review/ir-prompt-review-markdown.ts`

- [ ] **Step 1: Fix one canonical workspace layout for prompt iteration runs**

Use:
- `.../.tmp/prompt-eval-run/<benchmark>/<sample>/`
- `showcase/` for human-readable prompt and narrative artifacts
- `.memory/runtime/review/` for md review outputs

- [ ] **Step 2: Ensure each run writes a stable manifest**

Manifest fields:
- sample id
- prompt contract version
- benchmark command
- model/provider command
- summary path
- review path
- bad-case review path

- [ ] **Step 3: Add md-first links to the runner summary output**

Expected result:
- a reviewer can open one directory and understand the whole run without browsing jsonl first

### Task 2: Create a bad-case corpus workflow

**Files:**
- Create: `src/v8/review/ir-prompt-bad-case-corpus.ts`
- Create: `tests/v8/ir-prompt-bad-case-corpus.test.ts`
- Modify: `scripts/benchmark-ir-prompt-runner.mjs`

- [ ] **Step 1: Write the failing test for collecting failed jobs into a stable corpus**

Include:
- sample id
- layer
n- job id
- issue tags
- source turns
- prompt path
- offending completed/pending items

- [ ] **Step 2: Implement corpus writer**

Output path:
- `.memory/runtime/review/ir_prompt_bad_cases.md`
- optional sidecar json for machine use

- [ ] **Step 3: Deduplicate by semantic failure signature**

Suggested signature:
- layer
- issue tags
- normalized offending relation / relation_family presence
- turn range

- [ ] **Step 4: Verify the corpus is readable without jsonl inspection**

Run: `npm.cmd run test:v8 -- ir-prompt-bad-case-corpus.test.ts`
Expected: PASS

### Task 3: Add prompt anti-pattern and preferred-pattern extraction

**Files:**
- Create: `src/v8/review/ir-prompt-patterns.ts`
- Create: `tests/v8/ir-prompt-patterns.test.ts`
- Modify: `scripts/benchmark-ir-prompt-runner.mjs`

- [ ] **Step 1: Write the failing test for extracting anti-patterns from bad cases**

Examples:
- vague pending instructions produce empty pending
- over-canonical predicate wording distorts source semantics
- missing family guidance causes family drift

- [ ] **Step 2: Write the failing test for preferred-pattern extraction**

Examples:
- evidence-first field guidance improves alignment
- explicit pending closure rules improve handoff
- predicate wording tied to evidence span improves fidelity

- [ ] **Step 3: Implement pattern summarizer**

Outputs:
- `ir_prompt_patterns.md`
- `avoid` section
- `prefer` section
- each pattern backed by concrete failed/successful examples

- [ ] **Step 4: Verify md output quality**

Run: `npm.cmd run test:v8 -- ir-prompt-patterns.test.ts`
Expected: PASS

### Task 4: Add a prompt-iteration checklist per run

**Files:**
- Create: `src/v8/review/ir-prompt-iteration-checklist.ts`
- Create: `tests/v8/ir-prompt-iteration-checklist.test.ts`
- Modify: `scripts/benchmark-ir-prompt-runner.mjs`

- [ ] **Step 1: Write the failing test for generating an iteration checklist**

Checklist sections:
- fields that drifted
- wording that caused ambiguity
- wording that improved stability
- candidate prompt edits
- re-run targets

- [ ] **Step 2: Implement checklist writer**

Output:
- `.memory/runtime/review/ir_prompt_iteration_checklist.md`

- [ ] **Step 3: Ensure the checklist references exact md review sections and bad cases**

Run: `npm.cmd run test:v8 -- ir-prompt-iteration-checklist.test.ts`
Expected: PASS

### Task 5: Build a two-sample iterative regression set

**Files:**
- Modify: `.tmp/prompt-eval-prepared/small/session_narrative.md`
- Modify: `.tmp/prompt-eval-prepared/medium/session_narrative.md`
- Create: `docs/superpowers/plans/ir-prompt-regression-samples.md`

- [ ] **Step 1: Lock one small semantic-fidelity sample**

Purpose:
- verify completed item content quality
- verify source wording fidelity for micro predicate

- [ ] **Step 2: Lock one medium handoff sample**

Purpose:
- verify pending continuation quality
- verify 2-3 serial handoffs

- [ ] **Step 3: Document why each sample exists and what failures it should catch**

Expected result:
- prompt iterations always re-run the same two samples first

### Task 6: Add a single-command iteration runner

**Files:**
- Create: `scripts/benchmark-ir-prompt-iterate.mjs`
- Create: `tests/v8/benchmark-ir-prompt-iterate.test.ts`

- [ ] **Step 1: Write the failing test for a single-command iteration flow**

The flow should:
- run benchmark sample(s)
- write summary
- write review md
- write bad-case md
- write patterns md
- write iteration checklist md

- [ ] **Step 2: Implement the iteration runner**

Inputs:
- sample path(s)
- llm command
- output directory
- prompt version tag

- [ ] **Step 3: Verify deterministic artifact paths**

Run: `npm.cmd run test:v8 -- benchmark-ir-prompt-iterate.test.ts`
Expected: PASS

### Task 7: Full verification on current medium sample

**Files:**
- Modify: none expected

- [ ] **Step 1: Run prompt iteration on the current medium sample**

Run: `node scripts/benchmark-ir-prompt-iterate.mjs --prepared-sample .tmp/prompt-eval-prepared/medium --out .tmp/prompt-eval-run/benchmark/medium-iteration --ir-llm-command "wsl-bash:bash /mnt/d/E/memory_sys_design/memory-enhanced/scripts/ir-llm-bailian-wsl.sh"`
Expected:
- summary written
- review md written
- bad-case md written
- patterns md written
- iteration checklist md written

- [ ] **Step 2: Run TypeScript compile check**

Run: `node .\node_modules\typescript\bin\tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Run focused V8 tests**

Run: `npm.cmd run test:v8 -- ir-prompt-effectiveness.test.ts ir-llm-workflow.test.ts ir-llm-prompt.test.ts`
Expected: PASS

- [ ] **Step 4: Review md outputs only**

Open:
- `ir_prompt_review.md`
- `ir_prompt_bad_cases.md`
- `ir_prompt_patterns.md`
- `ir_prompt_iteration_checklist.md`

Expected:
- a reviewer can decide the next prompt edit without reading raw jsonl first
