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
