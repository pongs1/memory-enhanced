# Memory-Enhanced 协作规范（双 LLM / 同仓库 / 同工作区）

## 1. 角色分工（必须遵守）

- `Core Agent`（我这条线）负责：记忆内核与 OpenClaw 集成。
- `UI Agent`（你要接入的另一个 LLM）负责：图可视化 UI 与交互层。

## 2. 路径边界（哪些别碰 / 哪些可碰）

### 2.1 UI Agent 禁止修改（别碰）

- `src/v8/**`
- `src/hooks/**`
- `src/tools/memory_consolidate.ts`
- `src/index.ts`
- `scripts/openclaw-overlay.mjs`
- `openclaw-patch-guide.md`（除非 Core Agent 明确要求）
- `DEPLOYMENT_GUIDE.md`（除非 Core Agent 明确要求）

### 2.2 UI Agent 可修改（可以碰）

- `ui/**`（建议新建并集中）
- `src/ui/**`（若需与插件代码少量联动）
- `README.md` / `README_zh.md` 的 UI 使用章节
- `V8_*` 文档中“可视化说明”章节（仅文档，不改核心定义）

### 2.3 运行时文件（默认只读）

- `~/.openclaw/openclaw.json`：禁止自动修改或删除。
- `~/.openclaw/workspace-neuro/.memory/**`：只读用于展示与测试；不得由 UI Agent 写入。
- `~/.openclaw/workspace-neuro/memory/**`：只读用于展示上下文；不得由 UI Agent 回写。

## 3. Git 工作流（同账号不同 PAT）

### 3.1 分支命名

- Core: `feature/core-*`
- UI: `feature/ui-*`

### 3.2 提交流程

1. 开工前：`git fetch origin && git rebase origin/master`
2. 只改自己允许路径。
3. 提交信息前缀：
   - Core: `[core] ...`
   - UI: `[ui] ...`
4. 推送到各自分支，不直接推 `master`。
5. 合并顺序：先 Core、后 UI rebase，再合入。

### 3.3 冲突处理

- UI 与 Core 同时改到同一文件时，UI 停止提交，先 rebase 最新 Core 分支再继续。
- 出现核心文件冲突（`src/v8/**`）时，以 Core 版本为准。

## 4. 数据契约（UI 只读）

UI 读取以下图数据，不得改写源文件：

- `.memory/graph/manifest.json`
- `.memory/graph/bundles.jsonl`
- `.memory/graph/nodes_episodic.jsonl`
- `.memory/graph/nodes_semantic.jsonl`
- `.memory/graph/nodes_procedural.jsonl`
- `.memory/graph/edges_associative.jsonl`
- `.memory/graph/edges_structural.jsonl`
- `.memory/graph/edges_supersession.jsonl`

快照对比读取：

- `.memory/graph_snapshots/rebuild_*/pre_rebuild/**`
- `.memory/graph_snapshots/rebuild_*/post_rebuild/**`

## 5. 安全与凭据

- PAT 不写入仓库文件、不写进脚本常量、不出现在 remote URL。
- 每次提交前检查：
  - `rg -n "ghp_|github_pat_|sk-" .`
- 如果泄露，立即废弃并更换。

## 6. 最小交付约定（给 UI Agent）

UI Agent 第一阶段只交付：

1. 图加载（JSONL 解析 + 基本节点边渲染）
2. pre/post rebuild diff 视图
3. 节点详情抽屉（sourceRef、role、hit/adopt/harm）

不做：

- 反向写回图
- 自动改 `.memory` 文件
- 自动改 OpenClaw 配置

## 7. Hand-off 模板（每次交接必须附上）

```
[Agent]: core|ui
[Branch]:
[Commit]:
[Changed Paths]:
[Runtime Verification]:
[Known Risks]:
[Need From Other Agent]:
```

