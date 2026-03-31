# V8 Geometry Runtime Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the existing V8 code with the approved implementation contract for graph evidence ownership, build config entry points, and edge-based recall geometry.

**Architecture:** Keep the current codebase running while replacing the most blocking old-model contracts first. Phase 1 fixes type contracts and graph materialization outputs. Phase 2 adds a minimal test harness and verifies geometry dimension mapping. Later runtime rewrites can build on these corrected contracts without carrying `RecallMode`, projection, or graph-level evidence span mistakes forward.

**Tech Stack:** TypeScript, Node built-in test runner, existing V8 compiler/runtime modules

---

### Task 1: Add minimal TypeScript test harness

**Files:**
- Create: `tests/v8/graph-materializer.test.ts`
- Create: `tsconfig.test.json`
- Modify: `package.json`

- [ ] Step 1: Write failing tests for graph materialization dimension mapping and graph evidence ownership.
- [ ] Step 2: Run test compile and verify failure.
- [ ] Step 3: Add minimal test runner wiring.
- [ ] Step 4: Re-run tests and keep them failing for the intended reasons.

### Task 2: Correct core V8 contracts

**Files:**
- Modify: `src/v8/types_v8.ts`
- Modify: `src/v8/paths_v8.ts`

- [ ] Step 1: Replace graph-level evidence span ownership with source-item ownership.
- [ ] Step 2: Add propagation dimensions and scanner/runtime fields needed by the new geometry contract.
- [ ] Step 3: Add missing config entry points (`startAt`, `compilePhase`) and geometry weights.
- [ ] Step 4: Run TypeScript compile and fix contract fallout.

### Task 3: Update graph materialization to emit geometry dimensions

**Files:**
- Modify: `src/v8/architecture/graph-materializer.ts`
- Test: `tests/v8/graph-materializer.test.ts`

- [ ] Step 1: Write assertions for edge dimension mapping and absence of graph `evidenceSpanIds`.
- [ ] Step 2: Implement minimal graph materializer changes to satisfy the new contracts.
- [ ] Step 3: Re-run tests and TypeScript compile.

### Task 4: Stabilize recall entrypoints against the new contracts

**Files:**
- Modify: `src/v8/scanner.ts`
- Modify: `src/v8/recall.ts`
- Modify: `src/v8/edge-runtime-policy.ts`

- [ ] Step 1: Remove the most blocking compile-time dependencies on deleted graph/projection contracts.
- [ ] Step 2: Keep current runtime behavior building on the corrected graph contracts.
- [ ] Step 3: Re-run tests and TypeScript compile.
