# Collaboration Protocol

Run the current prompt version on the fixed sample below 10 times.

## Input
`D:\E\memory_sys_design\memory-enhanced\.tmp\prompt-eval-prepared\medium`

## Command Template
`node .\scripts\benchmark-ir-prompt-runner.mjs --prepared-sample .\.tmp\prompt-eval-prepared\medium --out .\.tmp\prompt-eval-run\benchmark\<run-name> --ir-llm-command "wsl-bash:bash /mnt/d/E/memory_sys_design/memory-enhanced/scripts/ir-llm-bailian-wsl.sh"`

## Output
Use 10 separate output directories:
- `medium-external-run1`
- `medium-external-run2`
- `medium-external-run3`
- `medium-external-run4`
- `medium-external-run5`
- `medium-external-run6`
- `medium-external-run7`
- `medium-external-run8`
- `medium-external-run9`
- `medium-external-run10`

## Return
Append results below in this format:
- average `coverageHealth`
- average `schemaHealth`
- average `handoffHealth`
- min/max for the three headline metrics
- average failed job count
- union of issue tags
- short conclusion on stability

## Agent Results
