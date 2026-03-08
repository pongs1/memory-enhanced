# 🚀 V8 Neuro-Symbolic Memory Deployment Guide

This guide details how to deploy the **V8 Dual-Intelligence** memory system. This architecture requires a patched OpenClaw core to enable real-time generative stream interception.

---

## 1. Prerequisites

- **OpenClaw Core**: Version ≥ 2026.1.26
- **Node.js**: v18+ (Required for `@xenova/transformers` and standard `fetch`)
- **API Key**: An OpenAI-compatible API key (SiliconFlow, DeepSeek, or Ollama) for **System 2 (Offline Annotation)**.

---

## 2. Installation

```bash
git clone https://github.com/pongs1/memory-enhanced.git ~/openclaw/extensions/memory-enhanced
cd ~/openclaw/extensions/memory-enhanced
pnpm install
# Note: Ensure you have enough disk space for the ONNX model download (~100MB)
```

### OpenClaw Core Patch (Mandatory for SAR)
V8 relies on the `wrap_stream_fn` hook. Follow [openclaw-patch-guide.md](./openclaw-patch-guide.md) to modify your `pi-embedded-runner` source code in WSL/Linux. Without this, real-time memory injection will not fire.

---

## 3. Configuration (`~/.openclaw/openclaw.json`)

Merge the following into your global configuration file:

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
          "halfLifeDays": 30,
          "archiveThreshold": 0.2
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
      "bootstrapExtraFiles": [
        ".memory/active/scratchpad.md",
        "memory/"
      ]
    }
  }
}
```

### Environment Variables
For **System 2** offline annotation, the plugin reads from the environment:
- `OPENAI_API_KEY`: Key for the annotation model.
- `OPENAI_BASE_URL`: API endpoint.
- `MEMORY_ANNOTATION_MODEL`: (Optional) The model to use for graph logic (default: `deepseek-v3` or `gpt-4o-mini`).

---

## 4. Workspace Preparation

Run this inside your project workspace directory:

```bash
# Data layers
mkdir -p memory/knowledge
mkdir -p memory/skills/verified

# Metadata layers (System only)
mkdir -p .memory/active
mkdir -p .memory/events
mkdir -p .memory/archive
```

### Initial Node State
Ensure `.memory/active/focus_stack.json` exists as a valid object:
```json
{
  "project_goal": "Initialize V8",
  "current_path": [],
  "current_focus": "System Check",
  "pending_siblings": []
}
```

---

## 5. Deployment Verification

After restarting OpenClaw (`openclaw gateway restart`), verify the V8 stack:

1.  **System 1 Check**: Start a chat and mention a keyword from your memory files. Observe the console logs. On the first run, you should see `@xenova/transformers` downloading the engine.
2.  **Vector Persistence Check**: After the first `memory_consolidate` run, check that `_associative_graph.json` contains `vector: [...]` arrays for each node.
3.  **System 2 Check**: Run `memory_consolidate scope="day" dry_run=false`. Check the console for `[Memory V8] Sending batch to LLM for semantic wiring...`.
4.  **BP & Hub Check**: Observe activation energy logs. High-degree "hub" nodes should have their energy dampening significantly to prevent activation storms.

---

## 6. Maintenance & RLHF

The system is self-tuning. However, you can manually guide it:
- **Pruning**: If the agent recalls something irrelevant, use `memory_explore` to find the offending edge and manually lower the weight in `_associative_graph.json`, or use the `adaptWeights` hook if integrated via custom UI.
- **Distillation**: Periodically review `.memory/events/` and move core facts to `memory/knowledge/`. The consolidator will automatically pick up the new files and re-wire the graph.
