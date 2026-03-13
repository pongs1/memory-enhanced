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

Clone the repository into a directory that is **outside** the OpenClaw git checkout, then install its internal dependencies:

```bash
# Recommended: keep plugin source outside ~/openclaw so git updates stay clean
mkdir -p ~/.openclaw/plugins-src
cd ~/.openclaw/plugins-src

# Clone the repository
git clone https://github.com/pongs1/memory-enhanced.git

# Install dependencies (Xenova, TypeBox, etc.)
cd memory-enhanced
pnpm install
```

> [!IMPORTANT]
> If you keep `memory-enhanced` inside `~/openclaw/extensions/memory-enhanced`, OpenClaw's git updater will treat it as an untracked path and may skip source updates. The overlay workflow in Step 2 can add a local `.git/info/exclude` entry for that path, but the out-of-tree layout above is still the cleanest default.

---

## 💉 Step 2: Patch OpenClaw Core (Overlay Workflow for SAR)

The **Subconscious Associative Recall (SAR)** requires intercepting the LLM's generative stream. 

**Do not keep hand-edited core files drifting in `~/openclaw`.** OpenClaw's source updater requires a clean worktree, and your current 3.1 checkout can be blocked by:

- modified core patch files like `src/plugins/types.ts`, `src/plugins/hooks.ts`, and `attempt.ts`
- untracked in-repo plugin source like `extensions/memory-enhanced/`

The supported workflow for this repo is now an **overlay patch**:

```bash
# Inspect current blockers first
pnpm openclaw:overlay:check -- --openclaw-dir /home/pongs/openclaw

# If this checkout is already hand-patched, adopt it first without rewriting the core files
pnpm openclaw:overlay:adopt -- --openclaw-dir /home/pongs/openclaw

# On a clean checkout, apply the managed 3.1 overlay patch once
pnpm openclaw:overlay:apply -- --openclaw-dir /home/pongs/openclaw
```

What the overlay does:

1. Saves pristine backups of the managed OpenClaw core files into `.openclaw-overlay/` inside this repo.
2. Applies the base `wrap_stream_fn` hook and the 3.1 `liveInterrupt(...)` resume loop.
3. Optionally adds `.git/info/exclude` for `extensions/memory-enhanced` if you keep the plugin source inside the OpenClaw git checkout.

`adopt` is the migration command for environments that already have working manual edits in
`src/plugins/types.ts`, `src/plugins/hooks.ts`, and `attempt.ts`. It does **not** rewrite those
files. It only captures clean `HEAD` backups, writes overlay metadata, and adds the optional
exclude rule so future updates can switch to `pnpm openclaw:overlay:update`.

For **future OpenClaw source updates**, use this instead of `openclaw update` directly:

```bash
pnpm openclaw:overlay:update -- --openclaw-dir /home/pongs/openclaw
```

That command performs:

1. Restores clean core files from backup.
2. Runs `openclaw update --no-restart`.
3. Reapplies the memory-enhanced core bridge.
4. Rebuilds OpenClaw.
5. Restarts the gateway.

> [!NOTE]
> The overlay only manages the three memory-enhanced core patch targets. If `check` still reports unrelated dirty files such as `pnpm-lock.yaml`, you must clean or commit those yourself before expecting OpenClaw's updater to succeed.

> [!TIP]
> The manual file-by-file instructions are still preserved in [openclaw-patch-guide.md](./openclaw-patch-guide.md), but they are now the fallback/reference path. The default installation path is the overlay script above.

---

## ⚙️ Step 3: Global Configuration (`openclaw.json`)

Locate your global config file at `~/.openclaw/openclaw.json`. Merge the following structure. 

> [!IMPORTANT]
> Change `/absolute/path/to/memory-enhanced` to the actual path where you cloned the repo.

`outputCheckpoint*` controls the long-output self-audit watchdog. These settings only produce live interruptions when your OpenClaw fork exposes the optional `liveInterrupt(...)` bridge from the patch guide. Without that bridge, the plugin will observe drift signals but will not fake unsupported stream events.

If you are testing on OpenClaw 3.1 and checkpoint steering never changes the reply, the usual cause is simple: the overlay patch was never applied, or OpenClaw was updated later without re-running `pnpm openclaw:overlay:update`.

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
          "enableV8GraphRecall": true,
          "v8CleanSlateMode": true,
          "v8SessionTraceDir": "/home/pongs/.openclaw/agents/main/sessions",
          "v8PackCacheTtlDays": 7,
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
# 1. Optional curated outputs (not ingested by clean-slate)
mkdir -p memory/knowledge
mkdir -p memory/skills/verified
mkdir -p memory/skills/drafts

# 2. System Metadata Layers (Hidden, Plugin-only access)
mkdir -p .memory/active
mkdir -p .memory/graph
mkdir -p .memory/raw/sessions
```

### Upgrade Cleanup for Older Installs

If this workspace previously used V5/V6/V7 drafts, clean the instruction layer before testing V8:

1. Replace old workspace prompt fragments that mention `memory_focus`, `memory_scratchpad`, `memory_status`, or manual editing of `MEMORY.md`.
2. Remove old heartbeat routines that try to maintain focus/task state. Heartbeat should only do memory distillation and cleanup.
3. Keep `memory/knowledge/` and `memory/skills/` only if they contain useful notes. The clean-slate graph will be rebuilt from session traces, and `.memory/graph/` can be deleted safely.
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
- **To build the memory graph:** Use `memory_consolidate`. It ingests raw session traces and materializes the clean-slate graph.
- **Do not hand-edit** `.memory/graph/`. Treat it as a generated store.

### 🧠 MEMORY_INDEX.md - Optional Reference
- `MEMORY_INDEX.md` is optional in clean-slate mode. If you maintain curated notes in `memory/knowledge/`, treat them as post-hoc outputs rather than sources.
```

### 2. Update `$WORKSPACE/USER.md`
Modify the `## Context` section to prevent the LLM from bloating the file:

```markdown
## Context & Preferences (Managed)

> **IMPORTANT**: Do not manually append preferences here. The clean-slate graph is built from raw session traces, and curated notes are optional post-hoc outputs.
```

---

## 🔄 Step 6: Background Maintenance (Heartbeat & Cron)

### 1. Micro-Distillation (Heartbeat)
Add this to `$WORKSPACE/HEARTBEAT.md` to ensure the agent cleans up while idle:

```markdown
# HEARTBEAT.md
- **Memory Check**:
  1. Run `memory_consolidate` to rebuild the clean-slate graph from session traces.
  2. If the workspace is heavy, prune or archive optional `memory/knowledge/` notes manually (they are not sources).
```

### 2. Deep Sleep Cleanup (Cron)
Add a daily cron job to `openclaw.json` for a clean-slate rebuild:

```jsonc
{
  "cron": [
    {
      "schedule": "0 3 * * *",
      "prompt": "Run memory_consolidate to rebuild the clean-slate graph. Reply NO_REPLY.",
      "agentId": "default"
    }
  ]
}
```

---

## ✅ Step 7: Final Verification

Run this sequence:

```bash
pnpm openclaw:overlay:check -- --openclaw-dir /home/pongs/openclaw
/home/pongs/openclaw/openclaw.mjs gateway restart
/home/pongs/openclaw/openclaw.mjs plugins list
/home/pongs/openclaw/openclaw.mjs plugins info memory-enhanced
/home/pongs/openclaw/openclaw.mjs doctor
```

Then start a session and run this sequence:

1.  **Status**: `"Run memory_working action='status'"` → Should show the passive task ledger from Step 4.
2.  **Graph Build Check**: `"Run memory_consolidate"` → Verify `.memory/graph/graph_nodes.jsonl` and `.memory/graph/graph_edges.jsonl` are populated.
3.  **Reprioritization Check**: `"Run memory_working action='reprioritize' focus='Handle a new urgent request'"` → The new active task should move to the top and the previous task should fall back into `Next`.
4.  **Recall Check (optional)**: Enable `enableV8GraphRecall` and ensure live recall injects a memory block during a long answer.

**Congratulations! Your Agent now has a functional, evolving mind.**
