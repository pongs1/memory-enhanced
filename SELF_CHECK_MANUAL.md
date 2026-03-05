# ✅ Memory System Self-Check Manual (v4)

Follow this manual to verify that your memory-enhanced plugin is correctly installed, configured, and operating within the ADaPT cognitive limits.

---

## 1. System Integrity Check

Run the following in your terminal:

```bash
openclaw plugins list              # Confirm 'memory-enhanced' is ENABLED
openclaw plugins info memory-enhanced  # Check version and config
openclaw doctor                     # Ensure no path or dependency errors
```

---

## 2. Infrastructure & Directories

Verify that the following directories exist in your `$WORKSPACE`:

- [ ] `memory/knowledge/` (Semantic memory)
- [ ] `memory/skills/verified/` (Procedural memory)
- [ ] `.memory/active/` (Working memory - hidden)
- [ ] `.memory/events/` (Episodic memory - hidden)

Check initial file state:
```bash
cat .memory/active/focus_stack.json    # Must have project_goal, current_path, etc.
cat .memory/active/scratchpad.md       # Should exist
```

---

## 3. Tool Functionality Test

Ask the Agent the following or verify via tool calls:

### A. Recording & episodic memory
> "Record this: I prefer using 'pnpm' for all my Node.js projects. Use importance 0.8 and tag 'preference'."

- **Check**: Does `.memory/events/YYYY-MM-DD.jsonl` contain the new entry?
- **Check**: Does `memory/YYYY-MM-DD.md` contain the human-readable summary?

### B. Association & exploration
> "Explore the memory related to my Node.js preferences."

- **Check**: Does `memory_explore` return the correct event? Does it show the association chain?

### C. Active Focus (ADaPT)
Ask the agent: "Show me your current focus stack."
- **Check**: It should read `.memory/active/focus_stack.json` and report a flat list of breadcrumbs and siblings, NOT a deep tree.

---

## 4. Maintenance & Compaction

### A. Manual Consolidation
> "Run memory_consolidate with scope='session'."

- **Check**: Does it report events processed?
- **Check**: Is `MEMORY.md` updated/regenerated?

### B. Compaction Trigger (Simulation)
If you reach the context limit, ensure the agent:
1. Performs Tier 3 Full Consolidation.
2. Reads `.memory/events/*.jsonl`.
3. Distills insights into `memory/knowledge/*.md`.
4. Calls `memory_consolidate scope=full`.

---

## 5. Cognitive Guardrails

- [ ] **Working Memory Limit**: If `current_path` + `pending_siblings` in `focus_stack.json` exceeds 7 items, the agent must STOP and consolidate.
- [ ] **No Manual Edits**: The agent must NOT manually edit `MEMORY.md`.
- [ ] **Zero Token Logic**: Ensure no `SKILL.md` is injecting huge instruction blocks (check system prompt if possible).

---

## Troubleshooting

- **"Tools not found"**: Restart the gateway (`openclaw gateway restart`).
- **"Search returns nothing"**: Check your `SiliconFlow` API key and embedding model config in `openclaw.json`.
- **"Memory.md not updating"**: Ensure you have files in `memory/knowledge/` to aggregate from.
