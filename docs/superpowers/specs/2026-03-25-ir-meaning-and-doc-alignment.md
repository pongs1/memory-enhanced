# IR Meaning And Doc Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the implementation doc and runtime extraction prompt with the new three-layer recall-geometry contract.

**Architecture:** Keep the architecture doc as a summary-only contract, move detailed three-layer tables and minimal inter-layer relations into the implementation doc, then rewrite runtime prompt Types/Relations to consume only layer boundary plus formation-side meanings.

**Tech Stack:** Markdown docs, TypeScript prompt builder, Node test runner.

---

### Task 1: Clean implementation doc old state wording
- [ ] Remove old state/control overlay wording from the detailed type/relation contract area.
- [ ] Keep only the pure three-layer tables plus minimal inter-layer relations and temporal/vertical coordination.

### Task 2: Rewrite runtime prompt meaning blocks
- [ ] Update `src/v8/architecture/ir-llm-workflow.ts` so prompt meaning uses layer boundary + family/type formation entries + family/relation formation entries.
- [ ] Exclude recall-role and propagation-shape text from front-end prompt.

### Task 3: Update tests
- [ ] Update prompt tests to match the new prompt structure.
- [ ] Run targeted tests.

### Task 4: Regenerate showcase and verify
- [ ] Regenerate prompt showcase files.
- [ ] Check `prompt.micro.md`, `prompt.meso.md`, and `prompt.macro.md`.
