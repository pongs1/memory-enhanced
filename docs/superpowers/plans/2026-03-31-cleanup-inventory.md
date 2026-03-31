# 2026-03-31 Cleanup Inventory

## Kept benchmark directories
- medium-qwen35-now-run1
- medium-rerun8
- small-rerun4
- large-current-prompt
- xlarge10-run1
- xlarge-base10-run1
- xlarge-current-prompt
- xlarge-current-prompt-run1..10
- xlarge-fullwindow-run
- xlarge-qwen35-desummary-run1
- xlarge-serial-inspect

## Deleted outdated test/debug directories
- diag-*
- focus*
- retest-*
- xlarge-latest-run*
- xlarge-local-run*
- xlarge-local-smoke
- xlarge-seriallane-run*
- .tmp-test

## Candidate old-architecture / compatibility remnants (not deleted)

### Scripts
- scripts/benchmark-answer-bailian-wsl.sh
- scripts/ir-llm-bailian-wsl.sh
- scripts/benchmark-answer-openai-compatible.mjs
- scripts/openclaw-overlay.mjs

### Top-level docs to review
- V8_ARCHITECTURE.md
- V8_SCHEMA_AND_PIPELINE.md
- V8_TYPES_AND_MIGRATION.md
- openclaw-patch-guide.md
- DEPLOYMENT_GUIDE.md

### Top-level directories to review
- .openclaw-overlay/
- .memory/

## Notes
- Kept one usable set of current benchmark outputs plus baseline/showcase directories.
- Removed only outdated debugging and one-off rerun artifacts.
