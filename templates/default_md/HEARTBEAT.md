# HEARTBEAT.md

- Memory Check:
  1. Run `memory_consolidate` with:
     - `start_at="source"`
     - `rebuild_mode="incremental"`
     - `compile_phase="stream"`
     - `hot_tail_skip_units=6`
     - `rule_ir_mode="off"`
  2. If nothing needs attention after that, reply `HEARTBEAT_OK`.
