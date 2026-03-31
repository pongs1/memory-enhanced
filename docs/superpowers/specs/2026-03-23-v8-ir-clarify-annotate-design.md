# V8 IR Clarify-Annotate Workflow Design

Status: draft baseline
Date: 2026-03-23

## Goal

Replace one-shot `micro unit -> final memory item` extraction with a two-step workflow that separates context clarification from final annotation. The purpose is to improve IR quality without hard-coding predicate-specific prompt rules.

## Problem

Current `micro` IR extraction asks one LLM call to do all of the following at once:

1. read local context
2. resolve references and vague objects
3. decide whether the text is stable enough to annotate
4. choose ontology / predicate
5. emit final persisted memory items

This coupling is producing IR that is text-grounded but semantically weak:

- unresolved references are normalized into durable-looking items
- vague objects become generic graph hubs
- oral/discourse filler is upgraded into final graph content

The issue is primarily workflow design, not lack of prompt prohibitions.

## Design Principle

The system must separate:

- `can this text be reliably interpreted?`
- `how should the interpreted content be annotated?`

The first is a clarification problem. The second is an annotation problem. They must not be solved in one free-form generation step.

## Durable vs Persistable

`durable memory` is not a valid front-loaded filter. Whether a memory will later be ignited is a recall concern, not an annotation concern.

The front-loaded gate must only answer:

- can this candidate be reliably written as a memory item now?

So the pipeline uses `annotation validity`, not `future recall value`, as its write gate.

## Workflow

### Step A: Window Assessment

Input:
- default micro job window of up to 8 target-context units

Output:
- whether the current window is sufficient for annotation
- whether bounded left/right expansion is needed
- which target units are affected
- which references are risky / unresolved

This step does not emit memory items.

### Step B: Clarify Pass

Run only when assessment says the current window is insufficient.

Input:
- target units
- bounded left/right context selected by the orchestrator

Output:
- resolved references
- unresolved references
- clarified local objects / state targets
- confidence per clarification

This step does not emit final memory items.

### Step C: Annotation Pass

Input:
- target units
- optional clarification output
- ontology / schema vocabulary

Output:
- candidate memory items tied to target unit ids and evidence spans

The model annotates only target units. Context exists only to help interpretation.

### Step D: Annotation Validity Gate

Programmatic checks only. No future-importance filtering.

Reject only candidates that are not reliably writable, such as:
- unresolved reference still present in core subject/object slots
- no valid evidence span
- malformed schema output
- item anchored outside target unit responsibility

Persist all candidates that pass validity.

## Why This Is Better

Compared with bigger-context one-shot prompting:

- lower prompt entropy
- clearer model objective per call
- avoids forcing the model to simultaneously resolve references and normalize final graph content
- lets the orchestrator control context expansion instead of relying on unstable model attention

Compared with predicate-specific negative prompting:

- generalizes across domains
- avoids overfitting to current benchmark artifacts
- preserves architecture: annotation quality is improved upstream; recall remains responsible for later ignition value

## Scope

This change applies first to `micro` IR only.

`meso` and `macro` remain on the existing path until the micro workflow is stable.

## Initial Constraints

- default window remains 8 units
- at most one bounded expansion per job in the first version
- clarification is optional and only triggered when assessment requires it
- annotation output remains target-unit scoped
- persistence gate checks validity only, not future importance

## Success Criteria

1. known bad cases like unresolved placeholders are no longer persisted as final items
2. generic hub predicates decrease without adding predicate-specific rule prompts
3. evidence alignment remains intact
4. benchmark ignition quality improves after recompiling IR on the same LoCoMo sample

## Files Expected To Change

- `src/v8/architecture/ir-llm.ts`
- `src/v8/architecture/ir-llm-helpers.ts` or equivalent helper split
- `src/v8/types_v8.ts`
- `tests/v8/ir-llm-prompt.test.ts`
- new tests for assessment / clarification / validity gate
