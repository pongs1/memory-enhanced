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
3.  **Why?** This enables the native `wrap_stream_fn` hook, allowing the plugin to inject memories *during* the generation process at zero token cost.

---

## ⚙️ Step 3: Global Configuration (`openclaw.json`)

Locate your global config file at `~/.openclaw/openclaw.json`. Merge the following structure. 

> [!IMPORTANT]
> Change `/absolute/path/to/memory-enhanced` to the actual path where you cloned the repo.

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
          "archiveThreshold": 0.2     // Score at which memories move to archive
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
  "project_goal": "Initialize Memory System",
  "current_path": [],
  "current_focus": "System Verification",
  "pending_siblings": [],
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

- **To manage tasks:** Use `memory_working`. The system maintains a 7-item focus stack.
- **To record insights:** Use `memory_record`. This triggers dual-write episodic encoding.
- **To explore associations:** Use `memory_explore` when you need to follow semantic "linkages".
- **To perform maintenance:** Use `memory_consolidate`. This applies decay to old events and regenerates your memory map.

### 🧠 MEMORY.md - Your Long-Term Gateway
- **DO NOT edit MEMORY.md manually.** It is an auto-generated index maintained by `memory_consolidate`.
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
  1. Run `memory_status` (or check telemetry in system prompt).
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

1.  **Status**: `"Run memory_working action='status'"` → Should show the initial focus from Step 4.
2.  **Episodic Check**: `"Run memory_record content='User likes dark mode' type='preference'"` → Check if `memory/2026-XX-XX.md` is updated.
3.  **System 1 Warmup**: Mention keywords from your recorded preference. Observe logs for `[Scanner] Ignition: User likes dark mode`.
4.  **Consolidation Check**: `"Run memory_consolidate scope='session'"` → Check if `MEMORY.md` is regenerated.

**Congratulations! Your Agent now has a functional, evolving mind.**
