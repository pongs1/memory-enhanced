# 🚀 Memory System Deployment Guide (V8 Neuro-Symbolic)

This guide provides step-by-step instructions for deploying the **V8 Memory Architecture**. It is designed to be followed easily by human users or LLM agents.

---

## 📋 Prerequisites

1.  **OpenClaw Core**: Version ≥ 2026.1.26.
2.  **Node.js**: v18.0.0 or higher.
3.  **Package Manager**: `pnpm` (required for OpenClaw extensions).
4.  **External API**: An OpenAI-compatible API key (SiliconFlow, DeepSeek, or Ollama) for **System 2 (Offline Semantic Annotation)**.

---

## 🛠️ Step 1: Install the Plugin Source

Clone the repository into your OpenClaw extensions directory and install its internal dependencies:

```bash
# Navigate to extensions (default location)
cd ~/openclaw/extensions

# Clone the repository
git clone https://github.com/pongs1/memory-enhanced.git

# Install dependencies (Xenova, TypeBox, etc.)
cd memory-enhanced
pnpm install
```

---

## 💉 Step 2: Patch OpenClaw Core (For SAR Support)

The **Subconscious Associative Recall (SAR)** requires intercepting the LLM's generative stream. 

1.  Open [openclaw-patch-guide.md](./openclaw-patch-guide.md).
2.  Follow the instructions to modify `pi-embedded-runner/src/run/attempt.ts` and `types.ts`.
3.  **Why?** This enables the native `wrap_stream_fn` hook so the plugin can inspect live stream deltas. True mid-stream checkpoint/recovery additionally requires the optional `liveInterrupt(...)` bridge described in the patch guide.

---

## ⚙️ Step 3: Global Configuration (`openclaw.json`)

Locate your global config file at `~/.openclaw/openclaw.json`. Merge the following structure. 

> [!IMPORTANT]
> Change `/absolute/path/to/memory-enhanced` to the actual path where you cloned the repo.

`outputCheckpoint*` controls the long-output self-audit watchdog. These settings only produce live interruptions when your OpenClaw fork exposes the optional `liveInterrupt(...)` bridge from the patch guide. Without that bridge, the plugin will observe drift signals but will not fake unsupported stream events.

```jsonc
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/memory-enhanced"]
    },
    "entries": {
      "memory-enhanced": {
        "enabled": true,
        "config": {
          "halfLifeDays": 30,         // Decay rate for events
          "archiveThreshold": 0.2,    // Score at which memories move to archive
          "outputCheckpointChars": 1600,
          "outputCheckpointCooldownChars": 1000,
          "outputCheckpointBoundarySlackChars": 320,
          "outputCheckpointMaxInterrupts": 2,
          "outputCheckpointDriftThreshold": 0.84,
          "outputCheckpointTailChars": 1400
        }
      }
    }
  },
  "models": {
    "providers": {
      "openai": {
        "apiKey": "YOUR_API_KEY",
        "baseUrl": "https://api.siliconflow.cn/v1"
      }
    }
  },
  "agents": {
    "defaults": {
      // These files are automatically injected into the LLM on every turn
      "bootstrapExtraFiles": [
        ".memory/active/scratchpad.md",
        "memory/"
      ]
    }
  }
}
```

---

## 📁 Step 4: Workspace File System Preparation

Inside your active project workspace (`$WORKSPACE`), run the following commands to create the 4-layer directory structure:

```bash
# 1. Searchable Layers (Public to Agent tools)
mkdir -p memory/knowledge
mkdir -p memory/skills/verified
mkdir -p memory/skills/drafts

# 2. System Metadata Layers (Hidden, Plugin-only access)
mkdir -p .memory/active
mkdir -p .memory/events
mkdir -p .memory/archive
```

### Upgrade Cleanup for Older Installs

If this workspace previously used V5/V6/V7 drafts, clean the instruction layer before testing V8:

1. Replace old workspace prompt fragments that mention `memory_focus`, `memory_scratchpad`, `memory_status`, or manual editing of `MEMORY.md`.
2. Remove old heartbeat routines that try to maintain focus/task state. Heartbeat should only do memory distillation and cleanup.
3. Keep `.memory/events/` and `memory/knowledge/` if they contain useful history, but expect `.memory/active/focus_stack.json` to be auto-migrated to the new schema on the first `memory_working` write.
4. If behavior still looks haunted by old instructions, temporarily move the old workspace `AGENTS.md`, `USER.md`, and `HEARTBEAT.md` aside, then re-apply the snippets from Step 5 and Step 6 exactly.

### Initial State Files

Create the following files manually to initialize the mental state.

#### A. `.memory/active/scratchpad.md`
```markdown
# Scratchpad
## Current Focus
(Wait for memory_working plan...)
## Reasoning Notes
(Intermediate logic steps)
## Pending Verification
(Hypotheses needing confirmation)
```

#### B. `.memory/active/focus_stack.json`
```json
{
  "schema_version": 2,
  "project_goal": "Initialize Memory System",
  "context_path": ["deployment"],
  "active_task": "System Verification",
  "next_tasks": ["Record first preference", "Run first consolidation"],
  "deferred_tasks": [],
  "done_recent": [],
  "last_user_request": "",
  "last_updated": ""
}
```

---

## 🤖 Step 5: Updating Agent Instructions (AGENTS.md & USER.md)

OpenClaw's default instructions often conflict with modern plugins. **Replace** specific sections in your workspace files with the following text blocks.

### 1. Update `$WORKSPACE/AGENTS.md`
Find the `## Memory` section and replace it entirely:

```markdown
## Memory (V8 Neuro-Symbolic Cognitive Layer)

You possess a 4-layer memory system. **DO NOT manually edit text files in the memory/ directory.** Always use your cognitive tools.

- **To manage tasks:** Use `memory_working`. It maintains a passive task ledger (`Goal / Active / Next / Deferred / Done Recently`) that is injected every turn.
- **Idle capture:** If the ledger is waiting for work, the newest user request is automatically promoted into `Active`.
- **Priority rule:** The latest user request is always authoritative. Stored tasks are resumable backlog, not hard commands.
- **To record insights:** Use `memory_record`. This triggers dual-write episodic encoding.
- **To explore associations:** Use `memory_explore` when you need to follow semantic "linkages".
- **To perform maintenance:** Use `memory_consolidate`. This applies decay to old events and regenerates your memory map.

### 🧠 MEMORY_INDEX.md - Your Long-Term Gateway
- **DO NOT edit MEMORY_INDEX.md manually.** It is an auto-generated index maintained by `memory_consolidate`.
- To update knowledge, update files in `memory/knowledge/` and run consolidation.
```

### 2. Update `$WORKSPACE/USER.md`
Modify the `## Context` section to prevent the LLM from bloating the file:

```markdown
## Context & Preferences (Managed)

> **IMPORTANT**: Use `memory_record` to capture new user preferences. Do not append them manually here.
> The background `agent_end` hook also auto-sniffs preferences.
> Periodically distill insights into `memory/knowledge/user-prefs.md`.
```

---

## 🔄 Step 6: Background Maintenance (Heartbeat & Cron)

### 1. Micro-Distillation (Heartbeat)
Add this to `$WORKSPACE/HEARTBEAT.md` to ensure the agent cleans up while idle:

```markdown
# HEARTBEAT.md
- **Memory Check**: 
  1. Check the telemetry in the system prompt or inspect `.memory/events/*.jsonl`.
  2. If unconsolidated events > 3: Distill knowledge to `memory/knowledge/*.md` then run `memory_consolidate scope="session"`.
```

### 2. Deep Sleep Cleanup (Cron)
Add a daily cron job to `openclaw.json` for deep archiving:

```jsonc
{
  "cron": [
    {
      "schedule": "0 3 * * *",
      "prompt": "Execute Tier 3 Full Consolidation: 1) Read ALL unconsolidated events. 2) Distill knowledge. 3) Call memory_consolidate scope=full. Reply NO_REPLY.",
      "agentId": "default"
    }
  ]
}
```

---

## ✅ Step 7: Final Verification

Restart OpenClaw: `openclaw gateway restart`. Start a session and run this sequence:

1.  **Status**: `"Run memory_working action='status'"` → Should show the passive task ledger from Step 4.
2.  **Episodic Check**: `"Run memory_record content='User likes dark mode' type='preference'"` → Check if `memory/2026-XX-XX.md` is updated.
3.  **Reprioritization Check**: `"Run memory_working action='reprioritize' focus='Handle a new urgent request'"` → The new active task should move to the top and the previous task should fall back into `Next`.
4.  **Consolidation Check**: `"Run memory_consolidate scope='session'"` → Check if `MEMORY_INDEX.md` is regenerated.

**Congratulations! Your Agent now has a functional, evolving mind.**
