# 🛡️ Self-Check Manual (v4 — Plugin)

> Run after `openclaw update`, weekly, or when memory behaves unexpectedly.

---

## Quick Check

```bash
# Plugin loaded?
openclaw plugins list | grep memory-enhanced

# Or ask the agent:
# → memory_status
```

---

## `openclaw update` Impact

| Action | Impact | Risk |
|---|---|---|
| Code update | No workspace/plugin files touched | 🟢 |
| `openclaw doctor` | May migrate config keys | 🟡 Check plugin config |
| Gateway restart | Reloads plugins | 🟢 |
| `openclaw setup` re-run | May reset AGENTS.md | 🔴 Re-append Step 5 |
| Manual config overwrite | Loses plugin + memory config | 🔴 Re-apply Steps 1-2 |

---

## Fix Guide

| Issue | Cause | Fix |
|---|---|---|
| Tools not available | Plugin not loaded | `openclaw plugins list`, re-install |
| `memory_record` fails | Workspace path unresolved | Check working directory |
| `memory_search` misses knowledge | Files under `.memory/` not `memory/` | Move to `memory/knowledge/` |
| `memory_get` rejects path | Path outside `memory/` | Use `read` tool for `.memory/` |
| MEMORY.md too large | Not running consolidation | `memory_consolidate scope=full` |
| AGENTS.md reset | `openclaw setup` re-run | Re-append Step 5 content |

---

## Backup

```bash
# Before update
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak
cd $WORKSPACE && git add -A && git commit -m "pre-update $(date +%Y-%m-%d)"

# After update
openclaw plugins list | grep memory-enhanced
# If missing: openclaw plugins install -l ~/.openclaw/extensions/memory-enhanced
```

---

## Token Budget

| Operation | Method | Token cost |
|---|---|---|
| Record events | `memory_record` tool | 0 |
| Explore associations | `memory_explore` tool | 0 |
| Decay + archive + MEMORY.md regen | `memory_consolidate` tool | 0 |
| Health check | `memory_status` tool | 0 |
| Session recall | `memory_search` (built-in) | 0 |
| SKILL.md context | Minimal reference doc | ~200/turn |
| **Knowledge distillation** | **LLM semantic work** | **~200-500/cycle** |
| **Creating/promoting skills** | **LLM pattern recognition** | **~100-200/skill** |
