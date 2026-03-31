# V8 IR Clarify-Annotate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-shot micro IR extraction with a bounded assessment -> clarify -> annotate -> validity-gate workflow.

**Architecture:** Keep the current graph and recall architecture unchanged. Only the micro IR generation path changes: a small assessment step determines whether the current unit window is sufficient, an optional clarification step resolves local ambiguity, and final annotation writes only evidence-valid items for target units.

**Tech Stack:** TypeScript, existing V8 IR pipeline, Node test harness

---

## File Structure

- Modify: `src/v8/architecture/ir-llm.ts`
  - Add workflow orchestration for assessment / clarification / annotation.
- Create: `src/v8/architecture/ir-llm-workflow.ts`
  - Keep prompt builders, routing, and validity helpers out of `ir-llm.ts`.
- Modify: `src/v8/types_v8.ts`
  - Add typed contracts for assessment and clarification outputs.
- Modify: `tests/v8/ir-llm-prompt.test.ts`
  - Update prompt expectations to the new workflow.
- Create: `tests/v8/ir-llm-workflow.test.ts`
  - Cover routing, expansion limits, and validity gate behavior.

### Task 1: Add workflow contracts

**Files:**
- Create: `src/v8/architecture/ir-llm-workflow.ts`
- Modify: `src/v8/types_v8.ts`
- Test: `tests/v8/ir-llm-workflow.test.ts`

- [ ] **Step 1: Write failing tests for workflow contracts**
- [ ] **Step 2: Add `V8IrWindowAssessment`, `V8IrClarification`, and gate result types**
- [ ] **Step 3: Add helper functions for bounded expansion and target-unit scoping**
- [ ] **Step 4: Run tests and make them pass**

### Task 2: Split prompt builders by stage

**Files:**
- Modify: `src/v8/architecture/ir-llm.ts`
- Create: `src/v8/architecture/ir-llm-workflow.ts`
- Test: `tests/v8/ir-llm-prompt.test.ts`

- [ ] **Step 1: Write failing tests for assessment / clarify / annotate prompts**
- [ ] **Step 2: Move prompt building into stage-specific helpers**
- [ ] **Step 3: Keep the old meso/macro path untouched**
- [ ] **Step 4: Run tests and make them pass**

### Task 3: Route micro jobs through assessment first

**Files:**
- Modify: `src/v8/architecture/ir-llm.ts`
- Create: `src/v8/architecture/ir-llm-workflow.ts`
- Test: `tests/v8/ir-llm-workflow.test.ts`

- [ ] **Step 1: Write failing tests for `micro` jobs that require no expansion vs bounded expansion**
- [ ] **Step 2: Implement `assessment -> maybe clarify -> annotate` routing**
- [ ] **Step 3: Enforce one bounded expansion max in v1**
- [ ] **Step 4: Run tests and make them pass**

### Task 4: Add annotation validity gate

**Files:**
- Modify: `src/v8/architecture/ir-llm.ts`
- Create: `src/v8/architecture/ir-llm-workflow.ts`
- Test: `tests/v8/ir-llm-workflow.test.ts`

- [ ] **Step 1: Write failing tests for unresolved-reference and bad-anchor rejection**
- [ ] **Step 2: Implement the validity gate**
- [ ] **Step 3: Ensure accepted items keep existing evidence alignment rules**
- [ ] **Step 4: Run tests and make them pass**

### Task 5: Regression-check the known bad cases

**Files:**
- Modify: `tests/v8/ir-llm-workflow.test.ts`
- Optional local fixture under: `tests/v8/fixtures/`

- [ ] **Step 1: Add regression fixtures modeled on the known `"That"` and generic-place cases**
- [ ] **Step 2: Verify they no longer persist invalid final items**
- [ ] **Step 3: Run the targeted test file and the full `test:v8` suite**

### Task 6: Re-run one compiled benchmark sample

**Files:**
- No code path change required beyond prior tasks
- Verify using existing benchmark workspace / scripts

- [ ] **Step 1: Rebuild one LoCoMo sample with the new micro IR workflow**
- [ ] **Step 2: Re-run question replay against the rebuilt workspace**
- [ ] **Step 3: Compare IR artifacts and ignition-guided hit quality against the previous sample**
- [ ] **Step 4: Write a short review note under `.tmp/` or `runtime/review/` with before/after examples**
