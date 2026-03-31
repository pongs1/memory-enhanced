# V8 Narrative-to-IR Redesign

Status: draft
Date: 2026-03-24
Depends on:
- [2026-03-20-v8-pipeline-implementation.md](d:/E/memory_sys_design/memory-enhanced/docs/superpowers/specs/2026-03-20-v8-pipeline-implementation.md)

## 1. Goal

Redesign the path from `narrative` to `IR` so that:

1. very long narratives can be processed without depending on huge model context
2. extraction proceeds in narrative order instead of requiring full upfront text segmentation
3. already-closed local content can be emitted immediately
4. unfinished tail content can be carried forward as structured pending IR
5. production behavior stays serial and stable, while benchmark runs may use high concurrency for throughput

This spec ends at `completed IR` and `pending IR` outputs and focuses on extraction and handoff.

## 2. Problem

The current direction still assumes a full text segmentation problem before extraction:

1. first cut text into stable units
2. then extract IR from those units
3. then aggregate into higher structure

That is too heavy for the actual constraint:

- the real bottleneck is long narrative length
- complete text-first segmentation is expensive and unstable
- many windows already contain locally complete content that can be extracted now
- only the tail of a window is usually ambiguous

The core problem is:

- how to extract what is already complete
- while carrying what is still incomplete into the next window

## 3. Design Principles

### 3.1 Extraction is the main pass

The main pass is a serial sliding-window extraction pass over the narrative turn stream.

It works through:
- local ordered windows
- immediate completed-item emission
- pending-tail continuation into the next window

### 3.2 The tail remains a continuation state

When the end of the current window is incomplete, the system emits a thin unfinished IR state that continues into the next window.

### 3.3 Overlap is required

Window overlap is part of the semantic handoff mechanism.

It exists to:
- avoid tearing a local sequence at the boundary
- let the next window confirm or complete the unfinished tail

### 3.4 Production is serial-first

Real usage benefits most from stable ordered continuation, so production behavior is serial by default.

Benchmark runs use higher concurrency for throughput while keeping the same overlap policy and window semantics.

## 4. Scope

Core scope:
- `narrative -> text-derived turn sequence`
- serial sliding-window extraction
- completed IR
- pending IR handoff
- overlap-based continuation across windows

Supporting scope:
- graph write inputs from extraction
- benchmark execution model for throughput

## 5. Pipeline Overview

```text
narrative markdown
  -> Phase 1: turn parse
  -> Phase 2: serial sliding-window IR extraction
       -> completed IR
       -> pending IR
  -> next window continues from pending IR
```

## 6. Phase 1: Turn Parse

### Purpose

Convert `narrative` into an ordered turn sequence with stable textual offsets.

### Input

Narrative markdown in the canonical format:

```md
### 2023-05-21 19:48 user:
...
```

### Output

```ts
interface TurnTextSlice {
  idx: number
  charStart: number
  charEnd: number
  role: string
  turnType: "user_message" | "assistant_text" | "tool_call_result" | "other"
  text: string
  timestamp: string | null
  resultStatus?: "completed" | "failed" | "empty"
}
```

### Rules

1. `charStart` and `charEnd` are computed once here and inherited downstream.
2. The header line serves as parse metadata while `turn.text` keeps the turn body only.
3. This phase is pure text parsing. No LLM.
4. This phase preserves order, role, offsets, and body text as the extraction input stream.

## 7. Phase 2: Serial Sliding-Window IR Extraction

### Purpose

Run the main extraction pass directly over the ordered turn stream.

### Window mechanics

Recommended starting configuration:
- window size: `5-8` turns
- overlap: `1-2` turns
- execution order: strictly left-to-right in production

The current window receives:
- current raw turns
- unfinished IR state from the previous window, if any

The extraction prompt carries the full extraction vocabulary for the current layer:
- `Types`
- `Relations`

These sections enumerate the complete type and extraction-relation inventory available to the current layer.

### What the model must do

For the current window, the model must:

1. extract IR for the part that is already locally complete
2. identify any tail content that is still unfinished
3. emit a thin pending IR state for that unfinished tail

It returns:
- completed IR for the locally closed part of the window
- thin pending IR for the unfinished tail

### Extraction focus

The system focuses on two extraction questions inside the current window:
- what inside the current window is already complete enough to emit now?
- what at the end of the current window is still open and must be carried?

This keeps the main process local, serial, and replayable.

## 8. Completed IR

### Purpose

`completed IR` is the part of the window that is already locally closed and can be written immediately.

### Output

```ts
interface CompletedIRItem {
  subject: string
  predicate: string
  object: string
  tensionRole: "open" | "advance" | "close" | "state" | "none"
  turnRefs: number[]
  charStart: number
  charEnd: number
  evidence: string
}
```

### Rules

1. Every completed item must anchor to turns inside the current window.
2. Completed items remain supported by content already visible inside the current window.
3. `open / advance / close` is allowed as an IR property.

## 9. Pending IR

### Purpose

`pending IR` is the structured handoff state for the unfinished tail of the current window.

It is the minimal structured continuation state that lets the next window continue extraction.

### Output

```ts
interface PendingIR {
  id: string
  tensionRole: "open" | "advance" | "state" | "none"
  subject?: string
  predicate?: string
  object?: string
  turnRefs: number[]
  charStart: number
  charEnd: number
  evidence?: string
  status: "pending"
}
```

### Rules

1. Pending IR must stay thin and structured.
2. Pending IR must only describe the unfinished tail.
3. Pending IR is passed to the next window as context.
4. If the next window closes it, the result becomes completed IR.
5. A still-open continuation state keeps moving forward until a later window closes it.

## 10. Overlap and Handoff

Overlap exists so the next window can re-see the tail boundary under fresh context.

The handoff mechanism is:

1. current window emits completed IR
2. current window emits pending IR for the unfinished tail
3. next window reads:
   - overlap turns
   - pending IR
   - new turns
4. next window either closes the pending IR or carries it forward again

This is the core \"knitting\" behavior of the pipeline.

## 11. Execution Policy

### Production

Production behavior is serial:
- one window after another
- each window consumes pending IR from the previous window
- semantic order is preserved

### Benchmark

Benchmark runs use throughput-oriented execution:
- sample-level concurrency across independent samples
- window-level concurrency inside a sample when the benchmark flow chooses approximation over strict handoff fidelity
- the same window size and overlap policy as production

Benchmark therefore keeps the same local extraction contract while raising concurrency for diagnosis speed.

## 12. Error Isolation

### Window-local extraction error

A bad extraction only affects:
- completed IR emitted from that window
- pending IR passed forward from that window

The replay surface remains local because the architecture uses direct windowed extraction with local handoff.

### Pending-state error

A bad pending IR affects:
- the immediate continuation into the next window

Earlier completed IR stays stable while the continuation state is retried in later windows.

This keeps failure scope local and serial.

## 13. Design Rationale

### 13.1 Windowed extraction matches the actual bottleneck

The narrative is long, while the useful local work is concentrated in bounded windows. The pipeline therefore extracts what is already complete and carries only the unfinished tail.

### 13.2 `open / advance / close` remains useful inside IR

`open / advance / close` gives each completed or pending item a stable local role. This supports continuation across windows without requiring any graph-level aggregation in this spec.

### 13.3 Benchmark throughput stays separate from production semantics

Production uses ordered continuation. Benchmark uses high concurrency over the same local extraction contract. This keeps the architecture stable while giving the benchmark a much faster micro-level diagnosis loop.

## 14. Validation Targets

The redesign is successful when:

1. long narratives can be processed in bounded windows
2. production uses serial window-to-window continuation
3. finished local content is emitted immediately
4. unfinished tails are carried as thin pending IR with structured continuation
5. benchmark runs can raise concurrency without redefining the core semantics

## 15. Expected File Impact

Primary files likely affected later:
- `src/v8/compiler_clean_slate.ts`
- `src/v8/architecture/ir-llm.ts`
- `src/v8/types_v8.ts`

Likely new concepts:
- explicit `Turn`
- explicit `CompletedIRItem`
- explicit `PendingIR`
