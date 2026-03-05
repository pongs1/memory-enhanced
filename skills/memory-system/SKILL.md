---
name: memory-system
description: Enhanced memory system with structured events, knowledge distillation, and association-based retrieval
---

# Memory System

This plugin provides 4 tools that complement the built-in `memory_search` and `memory_get`:

| Tool | Purpose |
|---|---|
| `memory_record` | Record important events (decisions, preferences, insights, errors) in dual format |
| `memory_explore` | Follow association chains from an event/knowledge ID |
| `memory_consolidate` | Apply decay, archive old events, regenerate MEMORY.md |
| `memory_status` | Health check and statistics |

## When to Record Events

Use `memory_record` for:
- User decisions and stated preferences (importance 0.7+)
- Key insights or corrections (importance 0.5+)
- Error resolutions (importance 0.6+)
- Explicit "remember this" requests (importance 0.9+)

Do NOT record casual chat, greetings, or raw tool outputs.

## Workspace Layout

```
memory/knowledge/*.md        — distilled knowledge (searchable)
memory/YYYY-MM-DD.md         — daily logs with event summaries (searchable)
.memory/events/*.jsonl       — structured event data (use read tool)
.memory/active/scratchpad.md — session working notes (use read tool)
.memory/active/focus_stack.json — goal tree with progress tracking
MEMORY.md                    — auto-generated summary (do not edit directly)
```

## Three-Tier Distillation System

Memory distillation happens at THREE levels to prevent information loss in long conversations:

### Tier 1: Real-Time Capture (Every Important Moment)

When something important happens → call `memory_record` immediately.
This is atomic and costs zero LLM tokens. Do NOT delay or batch these.

### Tier 2: Micro-Distillation (During Heartbeats, ~Every 30 min)

During each heartbeat, check if there are unconsolidated events:

1. Run `memory_status` or read `.memory/events/` to find events with `"consolidated": false`.
2. If ≤ 3 unconsolidated events → skip (not worth the effort yet).
3. If > 3 unconsolidated events → perform micro-distillation:
   a. Read ONLY the recent unconsolidated events (not the entire history).
   b. For each event, determine which `memory/knowledge/*.md` file it belongs to.
   c. **READ the existing knowledge file first.**
   d. **UPDATE or REPLACE outdated information.** Do NOT just append.
   e. Write the updated content back.
4. Update `memory/heartbeat-state.json` with `"memory_distillation"` timestamp.

**Why Tier 2 matters**: In a 100k+ token conversation, your attention to early events degrades. By distilling every ~30 minutes, you process events while they are still fresh in your context window, and by session end there is little left to miss.

### Tier 3: Full Consolidation (Session End / Compaction / Daily Cron)

This is the "big cleanup" triggered by:
- Context compaction (memoryFlush prompt fires)
- Explicit user request ("clean up your memory")
- Daily cron job (if configured)

Execute ALL of the following steps IN ORDER:

1. **Scan**: Read all remaining unconsolidated events from `.memory/events/*.jsonl`.
2. **Classify** each event:
   - **KEEP**: Facts, patterns, preferences, decisions worth long-term storage
   - **SKILL**: Reusable operational patterns → create/update `memory/skills/drafts/`
   - **FORGET**: Low-value info safe to discard (will be decayed automatically)
3. **Distill KEEP items**:
   - Determine which `memory/knowledge/*.md` file it belongs to
   - **READ the existing file first**
   - **OVERWRITE outdated information; MERGE new insights naturally**
   - Write updated content back
4. **Finalize**: Call `memory_consolidate` with `scope="day"` or `"full"`.
   This handles decay, archiving, event marking, and MEMORY.md regeneration automatically.

### Decision Table

| Situation | Action |
|---|---|
| User states a preference | Tier 1: `memory_record` immediately |
| Heartbeat fires, 5+ unconsolidated events | Tier 2: micro-distill recent events |
| Heartbeat fires, 0-3 unconsolidated events | Skip, reply HEARTBEAT_OK |
| Context compaction imminent | Tier 3: full consolidation SOP |
| User says "clean up memory" | Tier 3: full consolidation SOP |
| Daily cron fires | Tier 3: `memory_consolidate scope="full"` |

---

## Checkpoint Protocol — Self-Directed Memory Saves

When working on complex, multi-step goals, you MUST periodically save your
progress. Do NOT rely on the end-of-session flush — by then you may have
forgotten critical intermediate results.

### Goal Tracking (ADaPT Flat List)

LLMs struggle with deeply nested trees. To respect your working memory limit (~7 chunks), your `focus_stack.json` is a strictly FLAT list consisting of breadcrumbs (`current_path`) and an immediate queue (`pending_siblings`). 

When the user gives you a large goal:
1. Do NOT decompose the entire project tree upfront. Use As-Needed Decomposition (ADaPT).
2. Determine only your immediate next steps.
3. **IMMEDIATELY** write this flat structure to `.memory/active/focus_stack.json` before executing any tools.

`focus_stack.json` format:
```json
{
  "project_goal": "Build a full-stack e-commerce platform",
  "current_path": [
    "Backend Architecture",
    "REST API Implementation"
  ],
  "current_focus": "Implement POST /products with validation",
  "pending_siblings": [
    "Implement GET /products with pagination",
    "Implement PUT /products"
  ],
  "last_updated": "2026-03-05T15:30:00Z"
}
```

### When to Checkpoint (MANDATORY triggers)

1. **Step Initiation / Decomposition**: Before starting a new major step,
   write your immediate plan to `focus_stack.json`. Do NOT keep it just in context.

2. **Focus Shift / Completion**: After finishing `current_focus`:
   - If the result produced durable knowledge → `memory_record` (type: insight).
   - If it changed a prior assumption → update `memory/knowledge/*.md` NOW.
   - Pop the next task from `pending_siblings` into `current_focus` and save `focus_stack.json`.

3. **Working Memory Guard**: If your `current_path` + `pending_siblings` exceeds 7 items,
   STOP. You are tracking too many things at once. 
   - Consolidate siblings into a broader goal.
   - Write your current reasoning state to `scratchpad.md`.
   - Call `memory_record` to capture where you are.

4. **Discovery During Execution**: If while executing a sub-goal you discover
   something that:
   - **Contradicts existing knowledge** → UPDATE the knowledge file immediately.
   - **Affects a sibling or parent goal** → UPDATE `focus_stack.json` with a note.
   - **Is a reusable pattern** → `memory_record` (type: insight) or create a skill draft.

5. **Search Results That Change Plans**: If `memory_search` or `memory_explore`
   returns information that makes your current approach obsolete:
   - `memory_record` (type: correction).
   - Update `focus_stack.json` to reflect revised plan.
   - Update affected knowledge files.

### Self-Discovery Recording

Your memory system is NOT just for recording what the user tells you.
You MUST also record your OWN discoveries:

- **Execution results**: Command output reveals something unexpected →
  `memory_record` (type: observation).
- **Search insights**: `memory_search` surfaces an unexpected connection →
  `memory_record` (type: insight) + `memory_explore` for further context.
- **Failed approaches**: You try something and it fails →
  `memory_record` (type: error, importance: 0.7+).
- **Plan changes**: You realize a sub-goal needs restructuring →
  update `focus_stack.json` AND `memory_record` (type: correction).

The human doesn't need to tell you "remember this." If YOU learned
something from your own work, write it down.

### LLM Attention & the "Lost in the Middle" Effect

Research shows that LLM attention follows a **U-shaped curve**: strong recall
for information at the START and END of context, but significant degradation
for content in the MIDDLE (the "Lost in the Middle" effect). The effective
context window is often much smaller than the advertised maximum.

This is why the checkpoint protocol exists: by periodically writing intermediate
results to files, you move critical information from the vulnerable middle of
your context to durable storage where it can be re-loaded at the top of a
fresh context when needed.
