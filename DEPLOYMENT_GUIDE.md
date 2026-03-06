# 🚀 Memory System Deployment Guide (v5)

> **Architecture**: Native OpenClaw tool plugin with Lifecycle Hooks. Memory operations are real tools and event-listeners
> (`memory_record`, `memory_explore`, `memory_consolidate`, `memory_status`, `memory_focus`, `memory_scratchpad`)
> that run as TypeScript code — zero SKILL.md logic injection and zero "Session blindness", saving ~2000+ tokens/turn.

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
## Memory (Powered by `memory-enhanced` Plugin v5)

You wake up fresh each session, but you have a powerful 4-layer memory system.
**DO NOT manually edit memory files.** Always use your memory tools.

- **To navigate tasks:** The system automatically injects your top 7 focus items at boot. Use `memory_focus` (plan, push, complete) to update your queue. The system will auto-truncate the view to 7 items.
- **To curate long-term knowledge:** Distill insights into `memory/knowledge/*.md` files.
- **To trigger cleanup:** Use `memory_consolidate` at the end of a session to compile knowledge into the master `MEMORY.md`.

### 🧠 MEMORY.md - Your Long-Term Index
- **DO NOT edit MEMORY.md manually.** It is automatically generated by the `memory_consolidate` tool.
- To update long-term memory, update specific files in `memory/knowledge/` (e.g., `user-prefs.md`) and run `memory_consolidate`.

### 🎯 Checkpoint Protocol (ADaPT) — Goal Tracking & Saves
To respect your working memory limit, DO NOT try to build deep task trees. Keep your focus flat:

1.  **Breadcrumbs & Queue**: Use `memory_focus action="plan"` to set your project goal and immediate next steps.
2.  **Focus Shift / Completion**: When `current_focus` is done, call `memory_focus action="complete"`. The system will automatically pull the next task from the unbounded backing queue.
3.  **Auto-Recording**: The system silently listens to your final answers. If you establish a preference or make a decision, it will auto-record the event in the background. You only need to manually call `memory_record` for extremely critical standalone facts.

**Why this matters**: LLM attention degrades in the middle of long contexts. By checkpointing results natively, you move critical information to durable storage, preserving focus.

### 🔄 Memory Maintenance (During Heartbeats or Session End)
1. Look for unconsolidated events (run `memory_status` or check `.memory/events/`).
2. Distill those events into the appropriate `memory/knowledge/*.md` files.
3. Run the `memory_consolidate` tool (`scope="day"` or `"full"`) to:
   - Apply exponential decay to old events.
   - Archive events whose score drops below 0.2.
   - Automatically concatenate `memory/knowledge/*.md` contents into `MEMORY.md`.
```

### 2. Update `$WORKSPACE/USER.md`

Replace the `## Context` section with this to prevent the agent from endlessly accumulating raw text in `USER.md`:

```markdown
## Context & Preferences (Dynamic)

> **IMPORTANT**: Do not manually list detailed user preferences, habits, or inside jokes in this file.
> 
> The `agent_end` hook automatically captures new preferences and decisions in the background. Periodically, you should distill these events from `.memory/events/` into `memory/knowledge/user-prefs.md` and run `memory_consolidate`. 
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
Memory v5 Hook Architecture deployed. Verify:
1. Check that my active focus has been automatically injected into the context above.
2. Call memory_status to check system health.
3. Call memory_focus action="plan" with goal="Test" and focus="Verify tools".
4. I have decided to always rely on the hooks for auto-recording (this statement triggers auto-record!).
5. Call memory_focus action="complete".
6. Verify memory/YYYY-MM-DD.md has the auto-recorded insight from step 4.
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
  action: status|plan|push|complete 
  goal: string (for 'plan')
  path: string[] (for 'plan')
  focus: string (for 'plan' or 'complete')
  siblings: string[] (for 'plan' or 'push')
  insight: string (for 'complete' — triggers auto memory_record)
  next_focus: string (for 'complete')

Details:
  - Backed by an unbounded JSON queue, but auto-generates a strictly 7-item Markdown list for the LLM.
```

### `memory_scratchpad`
```
Parameters:
  action: append|refill
  section: string (e.g., "Reasoning", "Verification")
  content: string (only for 'append')

Details:
  - 'append' allows non-destructive logging into .memory/active/scratchpad.md.
```

---

## Architecture: Plugin vs SKILL.md

| Aspect | v3 (SKILL.md) | v5 (Hooks + TS Plugin) |
|---|---|---|
| Token cost per turn | ~2000 (SKILL.md injected) | ~200 (minimal SKILL.md) |
| Event recording | LLM writes 2 files manually | `agent_end` hook auto-records heuristically |
| Association traversal | LLM reads + follows links | Plugin does BFS, returns graph |
| Decay calculation | Bash script | Plugin does it natively |
| Health check | Bash script | Plugin returns structured report |
| Focus Stack (L1) | LLM edits JSON | MD-frontend injected via `before_agent_start` |
| MEMORY.md generation(L3) | Bash script via soft-links| Native physical file concatenation |
| Tool signatures | Prose instructions | Typed parameters with descriptions |

**Net result**: Structural operations run on native hooks at zero token cost. The LLM focuses instantly on the 7 active chunks and semantic distillation.
