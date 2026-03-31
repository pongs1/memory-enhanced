# 2026-03-31 Workspace Cleanup Inventory

## safe_to_delete_now

### obvious temporary / generated artifacts
- `.tmp-test/`
  - test runner output directory. already deleted.
- `.tmp/refresh-fixed-showcase.mjs`
  - one-off local script used to regenerate fixed showcase files.
- `.tmp/ir-showcase-current/`
  - ad hoc local showcase playground, not part of benchmark mainline.
- `.tmp/locomo-smoke/`
  - smoke-run output, not current IR prompt mainline.
- `.tmp/bench-data/`
  - temporary benchmark data staging, if not actively reused.
- `.tmp/benchmark-eval/`
  - temporary benchmark eval output, if not actively reused.

## candidate_archive

### benchmark outputs to keep only if you still want reference baselines
- `.tmp/prompt-eval-run/benchmark/medium-qwen35-now-run1`
  - old medium baseline.
- `.tmp/prompt-eval-run/benchmark/xlarge-qwen35-desummary-run1`
  - older xlarge baseline before later prompt/evaluator changes.
- `.tmp/prompt-eval-run/benchmark/xlarge-base10-run1`
  - baseline reference set.
- `.tmp/prompt-eval-run/benchmark/xlarge-current-prompt-run1..10`
  - one 10-run batch from earlier evaluator/prompt state.
- `.tmp/prompt-eval-run/benchmark/xlarge-current-prompt`
  - current prompt single-run snapshot before later fixes.
- `.tmp/prompt-eval-run/benchmark/xlarge-fullwindow-run`
  - full-window experiment, mainly historical comparison.
- `.tmp/prompt-eval-run/benchmark/xlarge-serial-inspect`
  - serial inspection artifact, mainly debugging reference.
- `.tmp/prompt-eval-run/benchmark/xlarge10-run1`
  - xlarge showcase anchor.
- `.tmp/prompt-eval-run/benchmark/medium-rerun8`
  - medium showcase anchor.
- `.tmp/prompt-eval-run/benchmark/large-current-prompt`
  - latest large sample result.

### docs / notes that may be archival rather than active
- `docs/superpowers/plans/2026-03-16-v8-validation-tuning.md`
- `docs/superpowers/plans/2026-03-21-v8-geometry-runtime-contract-implementation.md`
- `docs/superpowers/plans/2026-03-21-v8-locomo-benchmark-implementation.md`
- `docs/superpowers/plans/2026-03-23-v8-ir-clarify-annotate-implementation.md`
- `docs/superpowers/plans/2026-03-25-ir-meaning-and-doc-alignment.md`
- `docs/superpowers/plans/2026-03-25-v8-narrative-to-ir-serial-window-implementation.md`
- `docs/superpowers/plans/2026-03-26-ir-prompt-iteration-benchmark-plan.md`
- `docs/superpowers/specs/2026-03-18-v8-architecture-rewrite-design-en.md`
- `docs/superpowers/specs/2026-03-21-v8-locomo-benchmark-design.md`
- `docs/superpowers/specs/2026-03-23-v8-3d-memory-graph-ui-design.md`
- `docs/superpowers/specs/2026-03-23-v8-ir-clarify-annotate-design.md`
- `docs/superpowers/specs/2026-03-24-v8-narrative-to-ir-redesign-design.md`

## probably_keep

### core source / build / test
- `src/`
- `tests/`
- `schema/`
- `dist/`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `tsconfig.test.json`

### active benchmark / prompt workflow scripts
- `scripts/benchmark-ir-prompt-runner.mjs`
- `scripts/benchmark-eval-prep.mjs`
- `scripts/benchmark-eval-runner.mjs`
- `scripts/benchmark-answer-siliconflow.mjs`
- `scripts/ir-llm-siliconflow.mjs`

### current human-facing docs likely still useful
- `README.md`
- `README_zh.md`
- `V8_ARCHITECTURE.md`
- `V8_SCHEMA_AND_PIPELINE.md`
- `V8_TYPES_AND_MIGRATION.md`
- `docs/superpowers/specs/2026-03-17-v8-architecture-rewrite-design.md`
- `docs/superpowers/specs/2026-03-20-v8-pipeline-implementation.md`

## old_architecture_or_compatibility_remnants_to_review

### scripts
- `scripts/benchmark-answer-bailian-wsl.sh`
  - WSL-only answer runner. likely removable if Windows-local node runner is now standard.
- `scripts/ir-llm-bailian-wsl.sh`
  - WSL-only IR extraction runner. likely removable if Windows-local node runner is now standard.
- `scripts/benchmark-answer-openai-compatible.mjs`
  - compatibility runner for external OpenAI-compatible endpoints. keep only if cross-provider eval still needed.
- `scripts/openclaw-overlay.mjs`
  - overlay adoption/patch helper. likely separate from current IR prompt work.
- `scripts/benchmark-ir-xlarge-rerun.sh`
  - shell wrapper for older rerun workflow.
- `scripts/archive-search-smoke.mjs`
  - smoke / debug utility, may be archival.
- `scripts/ir-smoke-siliconflow.py`
  - one-off smoke tool, likely archival.
- `scripts/locomo-benchmark-smoke.mjs`
  - keep only if LoCoMo smoke remains in active workflow.

### directories
- `.openclaw-overlay/`
  - overlay workspace / compatibility material. likely archive-or-delete unless overlay still maintained.
- `.memory/`
  - repo-root runtime state. generated, but may still be useful for debugging. candidate archive or delete.
- `.tmp/locomo-prep/`
  - keep only if LoCoMo prep still needed.
- `.tmp/prompt-eval-prepared/`
  - keep if you still rerun benchmark samples locally.
- `.tmp/prompt-eval-run/`
  - keep only selected benchmark outputs; rest already cleaned.

## current_recommended_keep_set_if_you_want_a_minimal_working_workspace
- `src/`
- `tests/`
- `schema/`
- `dist/`
- `scripts/benchmark-ir-prompt-runner.mjs`
- `scripts/benchmark-eval-prep.mjs`
- `scripts/benchmark-eval-runner.mjs`
- `scripts/benchmark-answer-siliconflow.mjs`
- `scripts/ir-llm-siliconflow.mjs`
- `.tmp/prompt-eval-prepared/`
- `.tmp/prompt-eval-run/benchmark/medium-rerun8`
- `.tmp/prompt-eval-run/benchmark/xlarge10-run1`
- `.tmp/prompt-eval-run/benchmark/large-current-prompt`
- `.tmp/prompt-eval-run/benchmark/xlarge-current-prompt-run1..10` (optional if you want one stability batch)

## next_decisions_needed_from_you
1. delete or archive `.openclaw-overlay/`
2. delete repo-root `.memory/` or keep for debug
3. keep or remove WSL-only scripts:
   - `benchmark-answer-bailian-wsl.sh`
   - `ir-llm-bailian-wsl.sh`
   - `benchmark-ir-xlarge-rerun.sh`
4. keep or archive old benchmark outputs beyond:
   - `medium-rerun8`
   - `xlarge10-run1`
   - `large-current-prompt`
