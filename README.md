# 🧠 memory-enhanced — OpenClaw Plugin

Brain-inspired four-layer memory system for OpenClaw agents.

## Features

| Tool | Description |
|---|---|
| `memory_record` | Record decisions, insights, errors in dual format (JSONL + searchable MD) |
| `memory_explore` | Traverse association chains from any event/knowledge ID |
| `memory_consolidate` | Apply decay, archive old events, regenerate MEMORY.md |
| `memory_status` | Health check and system statistics |

These complement (not replace) OpenClaw's built-in `memory_search` and `memory_get`.

## Architecture

- **L1 Active Context** — Session scratchpad + focus stack
- **L2 Event Memory** — Dual-format JSONL (structured) + MD (searchable)
- **L3 Knowledge Memory** — Distilled knowledge organized by domain
- **L4 Skill Memory** — Verified/draft procedural templates

## Quick Install

```bash
git clone https://github.com/pongs1/memory-enhanced.git ~/.openclaw/extensions/memory-enhanced
cd ~/.openclaw/extensions/memory-enhanced
pnpm install
openclaw plugins install -l ~/.openclaw/extensions/memory-enhanced
openclaw gateway restart
```

See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for full setup.

## Token Savings vs SKILL.md Approach

| Operation | SKILL.md | Plugin |
|---|---|---|
| Context injection per turn | ~2000 tokens | ~200 tokens |
| Event recording | LLM writes 2 files | **0 tokens** |
| Association traversal | LLM follows links | **0 tokens** |
| Decay/archive/MEMORY.md | bash script | **0 tokens** |
