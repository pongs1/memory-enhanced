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

## Consolidation & Distillation Workflow

When triggered to consolidate (e.g., at session end or context compaction):

1. **Read Unconsolidated Events**: Check `.memory/events/*.jsonl` for events with `"consolidated": false`.
2. **Distill Durable Knowledge**:
   - For each important event, determine which `memory/knowledge/*.md` file it belongs to.
   - **CRITICAL**: Do NOT just append text. First, `read` the existing knowledge file.
   - **CRITICAL**: UPDATE or REPLACE outdated information. Merge the new insight naturally.
   - Write the updated content back to the knowledge file.
3. **Trigger Cleanup**: Call `memory_consolidate` with `scope="day"` or `"full"`. (This handles decay, archiving, event marking, and MEMORY.md regeneration automatically).
