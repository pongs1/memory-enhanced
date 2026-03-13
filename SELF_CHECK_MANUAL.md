# ✅ Memory System Self-Check Manual (V8 Clean-Slate)

Use this checklist to confirm the clean-slate pipeline is installed and running.

---

## 1. System Integrity Check

Run the following in your terminal:

```bash
openclaw plugins list
openclaw plugins info memory-enhanced
openclaw doctor
```

---

## 2. Infrastructure & Directories

Verify that the following directories exist in your `$WORKSPACE`:

- [x] `.memory/active/` (Working memory)
- [x] `.memory/graph/` (Clean-slate graph store)
- [x] `.memory/raw/sessions/` (Optional local cache)
- [x] `memory/knowledge/` (Optional curated notes, not ingested)
- [x] `memory/skills/` (Optional SOPs, not ingested)

---

## 3. Mandatory Session Boot Protocol

At the start of **EVERY** session, the agent should:

1. Call `memory_working action="status"`.
2. Confirm the ledger shows `Goal / Active / Next / Deferred / Done`.

---

## 4. Tool Functionality Test

### A. Working Memory Ledger
1. `"Run memory_working action='plan' goal='Check plugin' focus='Verify ledger' siblings=['Build graph','Run recall']"`
2. `"Run memory_working action='reprioritize' focus='Build graph'"`

Check that the ledger updates correctly.

### B. Graph Build
1. `"Run memory_consolidate"`
2. Verify `.memory/graph/graph_nodes.jsonl` and `.memory/graph/graph_edges.jsonl` exist and are non-empty.

---

## 5. Recall (Optional)

If `enableV8GraphRecall` is on:

1. Start a longer reply that mentions a previously discussed topic.
2. Confirm that a memory recall block is injected mid-stream.

---

## Troubleshooting

- **Tools not found**: Restart the gateway (`openclaw gateway restart`) and ensure `pnpm install` was run in the plugin directory.
- **Graph empty**: Confirm the session trace directory is correct and contains JSONL transcripts.
