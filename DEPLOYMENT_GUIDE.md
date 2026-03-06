# 🚀 Memory System Deployment Guide (v4 — Plugin)

> **Architecture**: Native OpenClaw tool plugin. Memory operations are real tools
> (`memory_record`, `memory_explore`, `memory_consolidate`, `memory_status`, `memory_focus`, `memory_scratchpad`)
> that run as TypeScript code — no SKILL.md logic injection, saving ~2000+ tokens/turn.

---

## Step 1: Install the Plugin

Clone the plugin repo and install to OpenClaw extensions:

```bash
# Clone from GitHub
git clone https://github.com/pongs1/memory-enhanced.git ~/openclaw/extensions/memory-enhanced

# Install dependencies
cd ~/openclaw/extensions/memory-enhanced
pnpm install

# Or use openclaw's dev link for easier updates
openclaw plugins install -l ~/openclaw/extensions/memory-enhanced
```

Enable it in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["~/openclaw/extensions/memory-enhanced"]
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

## Step 2: Configure OpenClaw Core (openclaw.json)

You must merge the following into your `~/.openclaw/openclaw.json`. OpenClaw uses strict Zod validation; ensure the nesting is exactly as shown.

### 1. Configure Embedding Provider & Model

Add the SiliconFlow (or any OpenAI-compatible) provider to the global `models` section:

```jsonc
{
  "models": {
    "providers": {
      "openai": {
        "apiKey": "YOUR_SILICONFLOW_KEY",
        "baseUrl": "https://api.siliconflow.cn/v1"
      }
    }
  }
}
```

### 2. Configure Memory Search & Compaction

Nest these directly under `agents.defaults`. This enables semantic search and the "Tier 3" memory flush.

```jsonc
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",        // Link to the provider above
        "model": "BAAI/bge-m3",       // Specific embedding model
        "sources": ["memory"],        // 限定仅检索固定记忆，让Agent自行决定是否查阅会话
        "extraPaths": ["memory/skills/verified"],
        "experimental": { "sessionMemory": true },
        "query": {
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.4,      // 对应设计文档中的 α 权重
            "textWeight": 0.6,        // 配合精确匹配
            "temporalDecay": { "enabled": true, "halfLifeDays": 30 }, // 对应设计文档中的 β 权重
            "mmr": { "enabled": true, "lambda": 0.7 }
          }
        }
      },
      "compaction": {
        "reserveTokensFloor": 20000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "systemPrompt": "Session nearing compaction. Use memory_record for important events. Use memory_consolidate to finalize. Reply NO_REPLY when done.",
          "prompt": "Context window is almost full. Execute Tier 3 Full Consolidation NOW: 1) Read ALL unconsolidated events from .memory/events/*.jsonl. 2) Classify each: KEEP (facts/preferences/decisions) or SKILL (reusable patterns) or FORGET. 3) For KEEP items: READ existing memory/knowledge/*.md file first, then OVERWRITE outdated info and merge new insights. 4) For SKILL items: create/update memory/skills/drafts/. 5) Call memory_consolidate with scope=full. Reply NO_REPLY when done."
        }
      },
      "bootstrapExtraFiles": [
        ".memory/active/scratchpad.md",
        "memory/"
      ]
    }
  }
}
```

> **Note**: Providing `memory/` or explicit relative paths to daily log markdown files in `bootstrapExtraFiles` ensures that the user's reasoning buffer (scratchpad) and the current day's events are natively provided by OpenClaw whenever a new session launches. The plugin handles L1 (focus stack) and L3 (knowledge) independently via native hooks.

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
{
  "project_goal": "Goal name",
  "current_path": [],
  "current_focus": "",
  "pending_siblings": [],
  "last_updated": ""
}
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

## Step 5: Update Default Agent Configs (AGENTS.md & USER.md)

OpenClaw's default `AGENTS.md` and `USER.md` files instruct the agent to manually edit `MEMORY.md` and `memory/YYYY-MM-DD.md`. To prevent conflicts with the plugin, you **must redefine these sections** in your workspace.

### 1. Update `$WORKSPACE/AGENTS.md`

Replace the entire `## Memory` and `### 🔄 Memory Maintenance` sections with this:

```markdown
## Memory (Powered by `memory-enhanced` Plugin)

You wake up fresh each session, but you have a powerful 4-layer memory system.
**DO NOT manually edit memory files.** Always use your memory tools.

- **To record something:** Use the `memory_record` tool. It automatically writes to `.memory/events/` and `memory/YYYY-MM-DD.md`.
- **To recall connections:** Use the `memory_explore` tool to traverse memory associations.
- **To curate long-term knowledge:** Distill insights into `memory/knowledge/` files.
- **To trigger cleanup:** Use `memory_consolidate` at the end of a session to decay old memories and auto-regenerate `MEMORY.md`.

### 🧠 MEMORY.md - Your Long-Term Index
- **DO NOT edit MEMORY.md manually.** It is automatically generated by the `memory_consolidate` tool.
- To update long-term memory, update specific files in `memory/knowledge/` (e.g., `user-prefs.md`) and run `memory_consolidate`.

### 📝 Write It Down - No "Mental Notes"!
- When someone says "remember this" → use `memory_record` with `importance: 0.9`.
- When you learn a lesson → use `memory_record` (type: insight) or update a `memory/knowledge/` file.

### 🎯 Checkpoint Protocol (ADaPT) — Goal Tracking & Saves
To respect your ~7 chunk working memory limit, DO NOT try to build deep task trees. Keep your focus flat:

1.  **Recall State (Mandatory)**: Call `memory_focus action="status"` at the start of every session.
2.  **Breadcrumbs & Queue**: Use `memory_focus action="plan"` to set your project goal and immediate next steps.
3.  **Focus Shift / Completion**: When `current_focus` is done, call `memory_focus action="complete"`. Provide the `insight` parameter to auto-record durable knowledge.
4.  **Working Memory Guard**: If the queue exceeds 7 items, call `memory_focus action="overflow"` to move excess tasks to `scratchpad.md`. Use `memory_scratchpad action="append"` to log reasoning.
5.  **Refill**: If your focus stack is empty but items remain in scratchpad, call `memory_scratchpad action="refill"`.

**Why this matters**: LLM attention degrades in the middle of long contexts. By checkpointing results natively, you move critical information to durable storage, preserving focus.

### 🔄 Memory Maintenance (During Heartbeats or Session End)
1. Look for unconsolidated events (run `memory_status` or check `.memory/events/`).
2. Distill those events into the appropriate `memory/knowledge/*.md` files.
3. Run the `memory_consolidate` tool (`scope="day"` or `"full"`) to:
   - Apply exponential decay to old events.
   - Archive events whose score drops below 0.2.
   - Automatically regenerate `MEMORY.md` from your curated knowledge.
```

### 2. Update `$WORKSPACE/USER.md`

Replace the `## Context` section with this to prevent the agent from endlessly accumulating raw text in `USER.md`:

```markdown
## Context & Preferences (Dynamic)

> **IMPORTANT**: Do not manually list detailed user preferences, habits, or inside jokes in this file.
> 
> Instead, use the `memory_record` tool to log their preferences (type: preference) during conversations. Over time, distill these into `memory/knowledge/user-prefs.md` and run `memory_consolidate`. 
> 
> This keeps `USER.md` clean and allows the memory plugin's decay and search algorithms to manage context dynamically.
```

---

## Step 5.5: Configure Background Tasks (Heartbeat vs Cron)

OpenClaw supports background tasks. **Heartbeats are the recommended default** for keeping memory fresh, with Cron serving as an optional deep-clean fallback.

### 1. Enable Micro-Distillation (Default: Heartbeat)

Heartbeats run periodically (e.g., every 30 mins) while the agent is idle. Create or update `$WORKSPACE/HEARTBEAT.md` with:

```markdown
# HEARTBEAT.md

- **Memory Distillation Check**: 
  1. Run `memory_status` to check for unconsolidated events.
  2. If there are > 3 unconsolidated events, distill them NOW: Read the events, extract knowledge to `memory/knowledge/*.md`, and then run `memory_consolidate scope="session"`.
```

### 2. Enable Full Consolidation (Optional: Daily Cron)

For long-running agents, you can set up a daily cron job in `~/.openclaw/openclaw.json` to act as an automated Tier 3 deep-cleanup:

```jsonc
{
  "cron": [
    {
      "schedule": "0 3 * * *",   // 3:00 AM daily
      "prompt": "Run Tier 3 Full Consolidation: 1) Read ALL unconsolidated events. 2) Classify: KEEP/SKILL/FORGET. 3) For KEEP: read existing knowledge file, overwrite outdated info, merge new insights. 4) For SKILL: update memory/skills/drafts/. 5) Call memory_consolidate scope=full. Reply NO_REPLY when done.",
      "agentId": "default"
    }
  ]
}
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
Memory plugin deployed with ADaPT lifecycle tools. Verify:
1. Call memory_focus action="status" to initialize state.
2. Call memory_status to check system health.
3. Call memory_focus action="plan" with goal="Test" and focus="Verify tools".
4. Call memory_focus action="complete" with insight="Tools are working".
5. Verify memory/YYYY-MM-DD.md has the auto-recorded insight.
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
Returns: health report (directories, files, sizes, event/knowledge/skill counts)
```

### `memory_focus`
```
Parameters:
  action: status|plan|push|complete|overflow
  goal: string (for 'plan')
  path: string[] (for 'plan')
  focus: string (for 'plan' or 'complete')
  siblings: string[] (for 'plan' or 'push')
  insight: string (for 'complete' — triggers auto memory_record)
  next_focus: string (for 'complete')

Details:
  - 'status' should be called at DOCTOR/SESSION START.
  - 'overflow' handles siblings > 7 limits.
```

### `memory_scratchpad`
```
Parameters:
  action: append|refill
  section: string (e.g., "Reasoning", "Verification")
  content: string (only for 'append')

Details:
  - 'append' allows non-destructive logging.
  - 'refill' pulls overflow items back into JSON focus stack.
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
