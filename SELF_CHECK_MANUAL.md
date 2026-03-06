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

- [x] `memory/knowledge/` (Semantic memory)
- [x] `memory/skills/verified/` (Procedural memory)
- [x] `.memory/active/` (Working memory - hidden)
- [x] `.memory/events/` (Episodic memory - hidden)

---

## 3. Mandatory Session Boot Protocol

At the start of **EVERY** session, the Agent MUST:
1.  **Recall State**: Call `memory_focus action="status"`.
2.  **Verify Output**: Does it show the current project goal and focus?
3.  **Refill Check**: If the stack is empty but items remain in `scratchpad.md`, call `memory_scratchpad action="refill"`.

---

## 4. Tool Functionality Test

Ask the Agent the following or verify via tool calls:

### A. Recording & Insight Automation
> "Record this: I prefer using 'pnpm' for all my Node.js projects."
> "Now call memory_focus action='complete' focus='Test Done' insight='Insight recording is working'."

- **Check**: Does `.memory/events/` contain the entry for 'pnpm'?
- **Check**: Does `.memory/events/` contain the entry for 'Insight recording is working'? (Created automatically via `complete`)

### B. ADaPT Lifecycle (Working Memory Guard)
> "Add 10 sibling tasks to the stack using memory_focus action='push'."

- **Check**: Does the tool return a **Working Memory Limit Exceeded** warning?
- **Check**: Call `memory_focus action='overflow'`. Does it move excess items to `scratchpad.md`?

### C. Scratchpad Persistence
> "Add a reasoning note: 'Testing persistent logging' using memory_scratchpad action='append'."

- **Check**: Does `.memory/active/scratchpad.md` contain the note under `## Reasoning Notes`?

---

## 5. Maintenance & Compaction

### A. Manual Consolidation
> "Run memory_consolidate with scope='session'."

- **Check**: Does it report events processed?
- **Check**: Is `MEMORY.md` updated/regenerated?

---

## 6. Cognitive Guardrails

- [x] **Working Memory Limit**: The 7-chunk limit is now enforced NATIVELY by the `memory_focus` tool.
- [x] **Session Recall**: The Agent is commanded in `AGENTS.md` to run `memory_focus status` on wake.
- [x] **No Manual Edits**: The agent must NOT manually edit `MEMORY.md` or `focus_stack.json`.

---

## Troubleshooting

- **"Tools not found"**: Restart the gateway (`openclaw gateway restart`) and ensure `pnpm install` was run in the plugin directory.
- **"7 Limit Not Triggering"**: Ensure you are using the latest `src/tools/memory_focus.ts`.
- **"Refill Fails"**: Ensure `scratchpad.md` has the `## Pending Items (Overflow)` header.
