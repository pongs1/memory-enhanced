# 🚀 Memory System Deployment Guide (v4 — Plugin)

> **Architecture**: Native OpenClaw tool plugin. Memory operations are real tools
> (`memory_record`, `memory_explore`, `memory_consolidate`, `memory_status`)
> that run as TypeScript code — no SKILL.md logic injection, saving ~2000+ tokens/turn.

---

## Step 1: Install the Plugin

Clone the plugin repo and install to OpenClaw extensions:

```bash
# Clone from GitHub
git clone https://github.com/pongs1/memory-enhanced.git ~/.openclaw/extensions/memory-enhanced

# Install dependencies
cd ~/.openclaw/extensions/memory-enhanced
pnpm install

# Or use openclaw's dev link for easier updates
openclaw plugins install -l ~/.openclaw/extensions/memory-enhanced
```

Enable it in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/memory-enhanced"]
    },
    "entries": {
      "memory-enhanced": {
        "enabled": true,
        "config": {
          "halfLifeDays": 30,         // Decay half-life
          "archiveThreshold": 0.2,    // Archive events below this score
          "memoryMdMaxChars": 5000    // Target MEMORY.md size
        }
      }
    }
  }
}
```

---

## Step 2: Configure Memory Search

Merge into `~/.openclaw/openclaw.json` (alongside the plugin config):

```jsonc
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "extraPaths": ["memory/skills/verified"],
        "experimental": { "sessionMemory": true },
        "sources": ["memory", "sessions"],
        "query": {
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.7,
            "textWeight": 0.3,
            "temporalDecay": { "enabled": true, "halfLifeDays": 30 },
            "mmr": { "enabled": true, "lambda": 0.7 }
          }
        },
        "cache": { "enabled": true, "maxEntries": 50000 }
      },
      "compaction": {
        "reserveTokensFloor": 20000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "systemPrompt": "Session nearing compaction. Use memory_record for important events. Use memory_consolidate to finalize. Reply NO_REPLY when done.",
          "prompt": "Compaction imminent. Record unsaved events, distill knowledge, run memory_consolidate. Reply NO_REPLY."
        }
      }
    }
  }
}
```

---

## Step 3: Create Workspace Directories

```bash
cd $WORKSPACE

# Searchable (memory_get + memory_search)
mkdir -p memory/knowledge
mkdir -p memory/skills/verified
mkdir -p memory/skills/drafts

# Metadata (read tool only)
mkdir -p .memory/active
mkdir -p .memory/events
mkdir -p .memory/archive
```

---

## Step 4: Create Initial Files

### `$WORKSPACE/.memory/active/scratchpad.md`
```markdown
# Scratchpad
## Current Focus
(auto-filled on session start)
## Reasoning Notes
(intermediate steps)
## Pending Verification
(hypotheses needing confirmation)
```

### `$WORKSPACE/.memory/active/focus_stack.json`
```json
{ "stack": [], "last_updated": "" }
```

### `$WORKSPACE/.memory/events/_schema.json`
```json
{
  "version": "1.0",
  "event_format": {
    "id": "evt_YYYYMMDD_NNN",
    "timestamp": "ISO8601",
    "type": "decision|observation|insight|error|preference|correction",
    "content": "string",
    "tags": ["string"],
    "importance": "0.0-1.0",
    "associations": ["evt_ID or ke_ID"],
    "consolidated": "boolean",
    "decay_score": "0.0-1.0"
  }
}
```

### `$WORKSPACE/memory/knowledge/user-prefs.md`
```markdown
# User Preferences
> Auto-maintained via memory_record + consolidation.
```

### `$WORKSPACE/memory/knowledge/project-context.md`
```markdown
# Project Context
> Persistent project knowledge distilled from events.
```

### `$WORKSPACE/memory/knowledge/decisions.md`
```markdown
# Key Decisions
> Important decisions and their rationale.
```

### `$WORKSPACE/memory/knowledge/debug-insights.md`
```markdown
# Debug Insights
> Lessons learned from debugging sessions.
```

### `$WORKSPACE/memory/skills/_registry.json`
```json
{ "version": "1.0", "skills": [], "last_updated": null }
```

### `$WORKSPACE/MEMORY.md`
```markdown
# Long-Term Memory

## User Preferences
→ See memory/knowledge/user-prefs.md

## Project Context
→ See memory/knowledge/project-context.md

## Key Decisions
→ See memory/knowledge/decisions.md

## Debug Insights
→ See memory/knowledge/debug-insights.md
```

---

## Step 5: Update AGENTS.md

**Append** to `$WORKSPACE/AGENTS.md`:

```markdown

## Memory System (plugin)

You have 4 memory tools from the memory-enhanced plugin:

| Tool | When to use |
|---|---|
| `memory_record` | Record decisions, preferences, insights, errors (importance 0.5+) |
| `memory_explore` | Follow association chains from an event/knowledge ID |
| `memory_consolidate` | After distilling knowledge: run decay + regenerate MEMORY.md |
| `memory_status` | Check system health |

These complement `memory_search` and `memory_get` (built-in).

Session start: also read `.memory/active/scratchpad.md` (use `read` tool).
Before compaction: record events → distill knowledge → `memory_consolidate`.
MEMORY.md: auto-generated — do not edit directly.
```

---

## Step 6: Restart and Verify

```bash
openclaw gateway restart
openclaw plugins list        # Should show memory-enhanced
openclaw plugins info memory-enhanced
openclaw doctor
```

Activation message:

```
Memory plugin deployed. Verify:
1. Call memory_status to check system health
2. Call memory_record with content="Deployment test", type="observation", importance=0.5
3. Confirm memory/YYYY-MM-DD.md has the event summary
4. Call memory_consolidate with scope="session"
```

---

## Tool Reference

### `memory_record`
```
Parameters:
  content: string (required)     — what happened
  type: enum (required)          — decision|observation|insight|error|preference|correction
  importance: number (optional)  — 0.0-1.0, default 0.5
  tags: string[] (optional)      — categorization
  associations: string[] (opt)   — linked evt_IDs or ke_IDs

Returns: event ID (evt_YYYYMMDD_NNN)

Writes to BOTH:
  .memory/events/YYYY-MM-DD.jsonl  (structured data)
  memory/YYYY-MM-DD.md             (searchable summary)
```

### `memory_explore`
```
Parameters:
  entry_id: string (required)    — evt_* or ke_* ID to start from
  depth: number (optional)       — max hops, 1-3, default 2
  direction: enum (optional)     — forward|backward|both, default both

Returns: association graph with content, importance, scores
Side effect: reinforces accessed entries (resets decay_score to 1.0)
```

### `memory_consolidate`
```
Parameters:
  scope: enum (optional)         — session|day|full, default session
  dry_run: boolean (optional)    — preview without writing

Actions (zero token cost):
  1. Apply decay: score × e^(-(ln2/30) × ageInDays)
  2. Archive events with score < 0.2
  3. Regenerate MEMORY.md from knowledge files

Returns: consolidation report
```

### `memory_status`
```
Parameters: none

Returns: health report (directories, files, sizes, event/knowledge counts)
```

---

## Architecture: Plugin vs SKILL.md

| Aspect | v3 (SKILL.md) | v4 (Plugin) |
|---|---|---|
| Token cost per turn | ~2000 (SKILL.md injected) | ~200 (minimal SKILL.md) |
| Event recording | LLM writes 2 files manually | Plugin writes both atomically |
| Association traversal | LLM reads + follows links | Plugin does BFS, returns graph |
| Decay calculation | Bash script | Plugin does it natively |
| Health check | Bash script | Plugin returns structured report |
| MEMORY.md generation | Bash script | Plugin generates it |
| Knowledge distillation | LLM (required) | LLM (still required) |
| Tool signatures | Prose instructions | Typed parameters with descriptions |

**Net result**: Structural operations at zero token cost. LLM focuses on semantic work only.
