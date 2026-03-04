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

## Consolidation Workflow

1. Read unconsolidated events: `.memory/events/*.jsonl` (filter `consolidated: false`)
2. Distill durable knowledge → write to `memory/knowledge/*.md`
3. Mark events as consolidated
4. Call `memory_consolidate` → handles decay + MEMORY.md regeneration
