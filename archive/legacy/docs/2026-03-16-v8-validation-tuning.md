# V8 Validation And Tuning Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the V8 validation workflow around the system's actual work flow instead of benchmark convenience paths. Separate direct-text baselines, background write-loop quality, online recall quality, front-LLM search escalation, backend relation mining, and only then run composed benchmark evaluations.

**Architecture:** Treat V8 as a coupled system with one background memory-formation spine and one online recall spine, plus a separate backend relation-mining lane. Validation must follow those paths in order instead of mixing them inside one LoCoMo-style sample run.

**Tech Stack:** TypeScript, Node.js scripts, JSONL/Markdown runtime artifacts, local benchmark fixtures, prompt-driven extraction/review paths, benchmark runners, and temporary `/tmp/...` output folders for before/after evidence.

---

### Task 1: Classify The Validation Harness Before Running Anything

**Files:**
- Modify: `scripts/benchmark-eval-runner.mjs`
- Modify: `BENCHMARK_EVAL.md`
- Modify: `docs/superpowers/plans/2026-03-16-v8-validation-tuning.md`

- [ ] **Step 1: Add explicit evaluation-path labels**

Every run must declare one of:
- `direct_text_baseline`
- `background_write_loop`
- `compiled_memory_recall`
- `front_search_escalation`
- `backend_relation_mining`
- `composed_system_eval`

Expected: no run summary can exist without stating which system path it exercised.

- [ ] **Step 2: Mark LoCoMo-style sample runs as composed evaluation**

Update runner/docs so LoCoMo sample runs are described as `composed_system_eval`, not as a clean measure of any single subsystem.

Expected: validation output no longer treats one sample run as proof of write-loop quality, recall quality, and relation-mining quality at the same time.

- [ ] **Step 3: Record which loops were actually executed**

Each run summary should state whether it exercised:
- background compile
- online ignition/pack delivery
- front search escalation
- backend relation mining

Expected: missing loops are explicit instead of being silently assumed.

### Task 2: Validate Background Write Loop A - `raw archive -> narrative`

**Files:**
- Read/Modify: `src/v8/compiler_clean_slate.ts`
- Read/Modify: source normalization code paths
- Test artifacts: normalized narrative outputs and source metadata

- [ ] **Step 1: Pick representative raw-input cases**

Use at minimum:
- one noisy runtime-observation sample
- one normal dialogue/session sample
- one long-form source sample

Expected: samples exercise the actual source heterogeneity the system sees.

- [ ] **Step 2: Validate narrative formation**

Check that `raw archive -> narrative` preserves:
- recoverable source identity
- turn/message/session structure
- speaker/timestamp metadata
- narrative readability
- sufficient traceability back to raw source

Expected: narrative is stable enough for unitization and LLM extraction, without becoming an uncontrolled rewrite.

- [ ] **Step 3: Record failure type before editing**

Classify each failure as:
- source-loss
- normalization-noise
- traceability-loss
- narrative-distortion

Expected: later tuning is attached to the right write-loop stage.

### Task 3: Validate Background Write Loop B - `narrative -> unit -> memory IR`

**Files:**
- Read/Modify: `src/v8/architecture/ir-extractor.ts`
- Read/Modify: LLM extraction / prompt paths
- Read/Modify: unitization code and prompt inputs

- [ ] **Step 1: Evaluate unitization as its own stage**

Verify that `micro / meso / macro` segmentation:
- respects discourse closure
- preserves useful local relation carriers
- does not collapse everything into length-based chunks

Expected: units are appropriate inputs for IR extraction.

- [ ] **Step 2: Evaluate IR extraction with LLM prompt in the loop**

Do not reduce this stage to code-only extraction checks.
For chosen samples, inspect whether prompt design materially affects:
- entity coverage
- relation coverage
- state/change coverage
- evidence anchoring quality

Expected: LLM extraction is treated as a primary variable, not an afterthought.

- [ ] **Step 3: Compare code-heavy and prompt-heavy failure modes**

For each miss, identify whether it comes from:
- bad unit boundaries
- poor prompt guidance
- extraction schema mismatch
- weak evidence anchoring

Expected: later tuning targets the real source of IR quality loss.

### Task 4: Validate Background Write Loop C - `memory IR -> graph / serving views / packs`

**Files:**
- Read/Modify: `src/v8/architecture/graph-materializer.ts`
- Read/Modify: `src/v8/architecture/runtime-projection.ts`
- Test artifacts: `.memory/graph/*.jsonl`, `.memory/runtime/*.jsonl`, summary/state pack outputs

- [ ] **Step 1: Verify consolidation before recall**

Inspect whether normalization/consolidation:
- merges aliases correctly
- preserves repeated but meaningful relation/state variants
- rejects weak/noisy outputs without flattening the structure

Expected: graph quality is evaluated before scanner behavior is blamed.

- [ ] **Step 2: Verify serving views and packs**

Check that compiled artifacts provide:
- serving views usable for ignition
- summary/state packs usable for delivery
- evidence-grounded graph neighborhoods

Expected: the background loop actually produces recall-consumable structure.

- [ ] **Step 3: Record graph-stage failures explicitly**

Classify each failure as:
- consolidation-loss
- graph-shape issue
- serving-view issue
- pack-materialization issue

Expected: recall-layer tuning does not hide write-loop failures.

### Task 5: Validate Online Recall Loop - `ignition -> propagation -> bundle -> pack`

**Files:**
- Read/Modify: `src/v8/scanner.ts`
- Read/Modify: online recall wiring
- Read/Modify: pack assembly code paths

- [ ] **Step 1: Treat online recall as consumer-only**

Verify the online loop consumes compiled graph artifacts, serving views, and packs rather than standing in for missing background compilation.

Expected: a recall miss is only attributed to scanner/runtime when the needed structure already exists in compiled memory.

- [ ] **Step 2: Validate ignition input sources**

Check that online recall can be triggered by:
- user text
- assistant text
- tool result text
- subagent output
- feedback text
- goal / working-state text

Expected: ignition reflects the real front-loop signal bus.

- [ ] **Step 3: Validate node activation and delivery**

For chosen samples, inspect:
- candidate matching quality
- residual-energy behavior
- bundle ranking
- pack selection and injection

Expected: recall quality is measured as a real runtime path, not as a text-only QA shortcut.

### Task 6: Validate Front-LLM Search Escalation Loop

**Files:**
- Read/Modify: front search escalation code paths
- Read/Modify: benchmark runner summaries for search requests
- Test artifacts: archive-search traces used during front recall

- [ ] **Step 1: Only enter this task after pack insufficiency is proven**

Do not test front search escalation on samples where pack delivery already contained enough information.

Expected: this loop is exercised only for true "need more evidence now" cases.

- [ ] **Step 2: Verify front search follows recall anchors**

Check that the front LLM expands search from:
- activated bundle evidence
- active entities/objects
- active relation/state cues
- current task control anchors

Expected: front search is a continuation of recall, not a detached global search.

- [ ] **Step 3: Measure information recovery, not graph growth**

Success criteria here are:
- did the front LLM obtain the missing evidence
- did the answer/task continue correctly

Not a success criterion:
- whether the system built new durable graph relations

### Task 7: Validate Backend Relation-Mining Loop

**Files:**
- Read/Modify: relation-planning code paths
- Read/Modify: relation-review LLM paths
- Test artifacts: relation-mining traces, candidate relation outputs, consolidation write-back decisions

- [ ] **Step 1: Treat relation mining as a background lane**

This loop is not front recall and not front search escalation.
It is used when one anchor's full historical relationship structure cannot fit inside a short runtime context.

Expected: validation notes describe this as graph-building work.

- [ ] **Step 2: Pick anchor-centered cases**

Use samples where a stable anchor has evidence spread far apart across the corpus:
- entity relationship evolution
- cross-day decision/constraint linkage
- oblique but durable cross-topic relation

Expected: the task actually tests distant-relation recovery rather than local recall.

- [ ] **Step 3: Validate the graph-guided mining path**

Inspect whether the lane can:
- choose useful anchors
- generate graph-guided search plans
- gather distant evidence packs
- let backend LLM judge relation candidates
- send reviewed candidates back into consolidation

Expected: relation mining is evaluated as "does this produce trustworthy graph candidates".

- [ ] **Step 4: Keep write-back standards explicit**

For every proposed relation candidate, record:
- evidence sufficiency
- anchor stability
- relation direction (`horizontal` / `vertical` / `oblique`)
- whether it is written to graph now, deferred, or rejected

Expected: backend mining does not silently become speculative graph mutation.

### Task 8: Run Composed System Evaluation Last

**Files:**
- Modify: benchmark runner/reporting
- Review: selected benchmark fixture outputs
- Review: generated summaries under `/tmp/...`

- [ ] **Step 1: Run composed evaluations only after Tasks 1-7 are separated**

LoCoMo-style or other sample-benchmark runs should only happen after each loop has its own validation identity.

Expected: composed results are interpreted as integration evidence, not subsystem proof.

- [ ] **Step 2: Tag every composed run with the loops it actually used**

For each benchmark sample, record whether it relied on:
- prebuilt compiled memory
- online recall only
- front search escalation
- backend relation mining

Expected: failures in composed runs can be traced back to the right loop.

- [ ] **Step 3: Preserve before/after evidence**

Keep summary outputs and traces for:
- one front-recall-dominant sample
- one front-search sample
- one backend-relation-mining sample
- one fully composed sample

Expected: tuning changes can be evaluated by loop, not just by one aggregate score.

### Task 9: Final Verification And Handoff

**Files:**
- Review: `docs/superpowers/plans/2026-03-16-v8-validation-tuning.md`
- Review: touched source/docs files

- [ ] **Step 1: Run the validation matrix by workflow**

At minimum:
- one `direct_text_baseline`
- one background write-loop sample
- one compiled-memory recall sample
- one front search escalation sample
- one backend relation-mining sample
- one composed system sample

- [ ] **Step 2: Summarize boundaries honestly**

State explicitly:
- which workflow stages were verified
- which results are still sample-only
- which loops remain under-specified
- where benchmark pressure still does not match system work flow

- [ ] **Step 3: Commit in workflow-aligned increments**

Commit separately when possible:
- validation harness classification
- write-loop fixes
- online recall fixes
- front-search fixes
- backend relation-mining fixes
- composed evaluation/reporting updates
