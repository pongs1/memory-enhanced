# V8 Narrative-to-IR Serial Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current micro `boundary -> annotation` flow with serial sliding-window extraction that emits `completed IR` and `pending IR` handoff state.

**Architecture:** Add a serial narrative-text window planner in front of the existing LLM execution path. Keep the graph/materializer side minimally changed by translating completed items back into ordinary `V8MemoryItem` records while keeping pending state as an intermediate extraction artifact only.

**Tech Stack:** TypeScript, Node.js, existing V8 compiler pipeline, existing custom test harness in `tests/v8`

---

### Task 1: Lock the new serial-window contracts in tests

**Files:**
- Create: `tests/v8/ir-windowed-extraction.test.ts`
- Modify: `tests/v8/run-tests.ts`

- [ ] **Step 1: Write the failing test for turn parsing from narrative**

```ts
run("parseNarrativeTurns returns ordered turns with offsets", () => {
  const turns = parseNarrativeTurns("### 2023-05-21 19:48 user:\nhello\n\n### 2023-05-21 19:49 assistant:\nworld\n");
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.role, "user");
  assert.equal(turns[1]!.role, "assistant");
  assert.match(turns[0]!.text, /hello/);
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `npm.cmd run test:v8 -- ir-windowed-extraction.test.ts`
Expected: FAIL because `parseNarrativeTurns` does not exist yet.

- [ ] **Step 3: Write the failing test for serial overlap windows**

```ts
run("buildSerialIrWindows creates overlapping windows in narrative order", () => {
  const turns = makeTurns(7);
  const windows = buildSerialIrWindows(turns, { windowSize: 5, overlapTurns: 2 });
  assert.deepEqual(windows.map((w) => [w.turnIdxStart, w.turnIdxEnd]), [[1,5],[4,7]]);
});
```

- [ ] **Step 4: Write the failing test for pending handoff mapping**

```ts
run("buildNextWindowInput carries pending IR into the following window", () => {
  const pending = [{ id: "p1", status: "pending", tensionRole: "open", turnRefs: [4,5], charStart: 10, charEnd: 30 }];
  const next = buildNextWindowInput({ pending, overlapTurns: makeTurns(2), newTurns: makeTurns(3, 6) });
  assert.equal(next.pending.length, 1);
  assert.equal(next.turns.length, 5);
});
```

- [ ] **Step 5: Add the new test file to the test runner**

```ts
import "./ir-windowed-extraction.test.js";
```

### Task 2: Add explicit completed/pending extraction types

**Files:**
- Modify: `src/v8/types_v8.ts`
- Test: `tests/v8/ir-windowed-extraction.test.ts`

- [ ] **Step 1: Write the failing type-usage test expectations from Task 1**
- [ ] **Step 2: Add minimal types**

```ts
export interface V8CompletedIrItem {
  subject: string;
  predicate: string;
  object: string;
  tensionRole: "open" | "advance" | "close" | "state" | "none";
  turnRefs: number[];
  charStart: number;
  charEnd: number;
  evidence: string;
}

export interface V8PendingIr {
  id: string;
  tensionRole: "open" | "advance" | "state" | "none";
  subject?: string;
  predicate?: string;
  object?: string;
  turnRefs: number[];
  charStart: number;
  charEnd: number;
  evidence?: string;
  status: "pending";
}
```

- [ ] **Step 3: Run the focused tests**

Run: `npm.cmd run test:v8 -- ir-windowed-extraction.test.ts`
Expected: still FAIL, now on missing implementation helpers rather than missing types.

### Task 3: Add narrative turn parsing and window planning helpers

**Files:**
- Create: `src/v8/architecture/ir-windowed-extraction.ts`
- Test: `tests/v8/ir-windowed-extraction.test.ts`

- [ ] **Step 1: Implement `parseNarrativeTurns` minimally to satisfy the first failing test**
- [ ] **Step 2: Implement `buildSerialIrWindows` minimally to satisfy the second failing test**
- [ ] **Step 3: Implement `buildNextWindowInput` minimally to satisfy the third failing test**
- [ ] **Step 4: Run focused tests until green**

Run: `npm.cmd run test:v8 -- ir-windowed-extraction.test.ts`
Expected: PASS

### Task 4: Replace micro boundary jobs with serial extract jobs

**Files:**
- Modify: `src/v8/architecture/ir-llm.ts`
- Modify: `src/v8/architecture/ir-llm-workflow.ts`
- Test: `tests/v8/ir-llm-workflow.test.ts`
- Test: `tests/v8/ir-windowed-extraction.test.ts`

- [ ] **Step 1: Write a failing test that `buildLlmIrJobs` creates micro `extract` jobs instead of `boundary` jobs**
- [ ] **Step 2: Add a new micro job kind carrying window text slices and prior pending state**
- [ ] **Step 3: Replace `buildBoundaryPrompt` usage for micro with a new extraction prompt builder that includes full layer `Types` and `Relations` inventories**
- [ ] **Step 4: Keep meso/macro behavior unchanged for this first slice**
- [ ] **Step 5: Run focused tests**

Run: `npm.cmd run test:v8 -- ir-windowed-extraction.test.ts ir-llm-workflow.test.ts`
Expected: PASS

### Task 5: Teach the runner to persist completed and pending outputs

**Files:**
- Modify: `scripts/ir-llm-siliconflow.mjs`
- Modify: `src/v8/architecture/ir-llm.ts`
- Test: `tests/v8/ir-windowed-extraction.test.ts`

- [ ] **Step 1: Write a failing test for parsing a markdown response containing completed and pending sections**
- [ ] **Step 2: Add parser support for completed items and pending items**
- [ ] **Step 3: Keep writing completed items to `ir_llm_items.jsonl`**
- [ ] **Step 4: Add pending state persistence to a separate intermediate file**
- [ ] **Step 5: Run focused tests**

Run: `npm.cmd run test:v8 -- ir-windowed-extraction.test.ts ir-llm-workflow.test.ts`
Expected: PASS

### Task 6: Wire the compiler to the new micro path

**Files:**
- Modify: `src/v8/compiler_clean_slate.ts`
- Modify: `src/v8/architecture/ir-llm.ts`
- Test: `tests/v8/compiler-reuse.test.ts`
- Test: `tests/v8/ir-windowed-extraction.test.ts`

- [ ] **Step 1: Add compiler plumbing for serial micro extraction artifacts**
- [ ] **Step 2: Keep current memory item loading path for completed items only**
- [ ] **Step 3: Expose pending artifact counts in build stats/report**
- [ ] **Step 4: Run focused tests**

Run: `npm.cmd run test:v8 -- ir-windowed-extraction.test.ts compiler-reuse.test.ts`
Expected: PASS

### Task 7: Full verification

**Files:**
- Modify: none expected
- Test: full suite

- [ ] **Step 1: Run the full V8 test suite**

Run: `npm.cmd run test:v8`
Expected: PASS

- [ ] **Step 2: Run TypeScript compile check**

Run: `node .\node_modules\typescript\bin\tsc -p tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Review changed files and clean obvious dead code if introduced**

Run: `git -C d:\E\memory_sys_design\memory-enhanced diff -- src/v8/architecture/ir-llm.ts src/v8/architecture/ir-llm-workflow.ts src/v8/compiler_clean_slate.ts src/v8/types_v8.ts src/v8/architecture/ir-windowed-extraction.ts tests/v8/ir-windowed-extraction.test.ts`
Expected: only the planned narrative-to-IR windowing changes
