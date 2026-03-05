# 🧠 memory-enhanced — OpenClaw 增强记忆插件

> **一句话介绍**：让你的 AI agent（OpenClaw）拥有像人类天才一样工作的记忆系统——能记住重要事件、积累知识、触类旁通、自动遗忘不重要的细节。

---

## 目录

1. [为什么需要这个？](#为什么需要这个)
2. [这个系统是怎么工作的？](#这个系统是怎么工作的)
3. [四层记忆架构详解](#四层记忆架构详解)
4. [四个工具的功能](#四个工具的功能)
5. [安装部署](#安装部署)
6. [使用示例](#使用示例)
7. [文件结构全览](#文件结构全览)
8. [技术实现原理](#技术实现原理)

---

## 为什么需要这个？

### AI agent 天生的记忆缺陷

普通的 AI agent（比如 OpenClaw）在默认状态下有一个根本性的问题：**每次对话结束，它就"失忆"了**。

想象一下，你雇了一个助手：
- 你告诉他你喜欢简洁的代码风格 ✅
- 下次对话——他完全不记得了 ❌
- 你花20分钟解释了一个复杂项目的背景 ✅
- 下次对话——从零开始解释 ❌
- 解决了一个刁钻的 bug ✅
- 三周后遇到同样的问题——完全不记得解决方案 ❌

这就是 AI agent 的"鱼的记忆"问题。

### OpenClaw 原有的记忆方案的局限

OpenClaw 本身有基础的记忆功能：
- `MEMORY.md`：一个长期记忆文件，手动维护
- `memory/YYYY-MM-DD.md`：每日日志文件
- `memory_search`：在这些文件里搜索

**问题**：
1. 完全依赖 AI 自己决定"写什么"——缺乏结构化
2. 没有关联性——知识孤立，无法触类旁通
3. 没有遗忘机制——时间长了 `MEMORY.md` 会膨胀到几万字，消耗大量 token
4. 没有技能积累——解决过的问题不会变成可复用的方法

### 这个插件解决了什么？

**memory-enhanced** 给 OpenClaw 装上了一套仿照人类大脑认知科学设计的记忆系统：

| 人脑 | memory-enhanced |
|---|---|
| 工作记忆（当前思考） | L1 活跃上下文（scratchpad） |
| 情节记忆（发生了什么） | L2 事件记忆（结构化日志） |
| 语义记忆（积累的知识） | L3 知识记忆（领域知识库） |
| 程序记忆（怎么做事） | L4 技能记忆（可复用步骤） |
| 遗忘曲线 | 指数衰减算法 |
| 联想记忆 | 关联图遍历 |

---

## 这个系统是怎么工作的？

### 整体流程

```
用户 ←→ OpenClaw agent
              ↕
    ┌─────────────────────┐
    │   memory-enhanced   │  ← 本插件
    │  插件（4个工具）     │
    └─────────────────────┘
              ↕
    ┌─────────────────────┐
    │   磁盘文件系统       │
    │  .memory/  memory/  │
    └─────────────────────┘
```

### 一次典型的对话发生了什么？

**对话开始时**：
1. OpenClaw 自动加载 `MEMORY.md`（摘要索引）
2. OpenClaw 自动加载今天和昨天的日志文件
3. Agent 读取 `.memory/active/scratchpad.md`（上次留下的工作笔记）

**对话过程中**：
- 用户说了重要的事 → Agent 调用 `memory_record` 记录事件
- Agent 检索到某条记忆 → 可以调用 `memory_explore` 沿关联链追溯相关信息
- Agent 需要了解某领域知识 → 调用 `memory_search` 搜索

**对话结束时 / 上下文快满时**：
1. Agent 阅读今天还没处理的事件（`consolidated: false`）
2. Agent 提炼出持久知识，写入 `memory/knowledge/*.md`
3. Agent 调用 `memory_consolidate` → 插件自动执行：衰减旧事件、归档低分事件、重新生成 `MEMORY.md`

---

## 四层记忆架构详解

### L1：活跃上下文（工作记忆）

**存储位置**：`.memory/active/`

**文件**：
- `scratchpad.md`：当前会话的工作草稿纸，记录推理过程和待验证假设。
- `focus_stack.json`：**目标执行流与待办队列**（基于 ADaPT 按需拆解算法）。

**核心机制 (Checkpoint Protocol)**：
为了对抗 LLM 在极长对话中注意力衰减的 "Lost in the Middle" 效应，Agent 会执行自我存档：
1. **扁平行进**：不建立庞大的深层任务树，而是把当前大任务拆解为最近下一步，写入 `focus_stack.json` 的扁平队列中。
2. **步步追踪**：每完成焦点任务，更新状态出队列，并记录中间成果。
3. **工作记忆保护**：如果任务压栈过长（面包屑+队列 ≥ 7项），Agent 会强制暂停，把当前思路写入 `scratchpad.md` 保存、精简焦点。
4. **自我发现**：在执行中自己摸索出的经验/报错教训，会当场主动写入记忆，无需等用户下令。

**类比**：就像你桌上摊开的草稿纸和待办清单。当你脑容量不够用时，先把中间结果写在纸上，清理大脑缓存再继续。

---

### L2：事件记忆（情节记忆）

**存储位置**：双格式存储

```
.memory/events/2026-03-04.jsonl   ← 结构化数据（机器处理）
memory/2026-03-04.md              ← 人类可读摘要（可被 memory_search 搜索）
```

**一条事件长什么样？**

JSONL 格式（给程序用）：
```json
{
  "id": "evt_20260304_003",
  "timestamp": "2026-03-04T14:22:00Z",
  "type": "decision",
  "content": "用户决定所有 API 接口使用 REST 风格，不用 GraphQL",
  "tags": ["api", "架构决策"],
  "importance": 0.85,
  "associations": ["evt_20260304_001"],
  "consolidated": false,
  "decay_score": 1.0
}
```

MD 格式（给搜索用，也方便人查看）：
```markdown
### 14:22 — decision [importance: 0.85]
用户决定所有 API 接口使用 REST 风格，不用 GraphQL
Tags: api, 架构决策 | ID: evt_20260304_003 | Assoc: evt_20260304_001
```

**为什么双格式？**
- JSONL 保存精确的元数据（重要性评分、关联关系、衰减值）
- MD 文件能被 OpenClaw 的原生 `memory_search` 搜索，保持兼容性

---

### L3：知识记忆（语义记忆）

**存储位置**：`memory/knowledge/`

**文件**：
```
memory/knowledge/
├── user-prefs.md        ← 用户偏好（代码风格、习惯、喜好）
├── project-context.md   ← 项目持久背景知识
├── decisions.md         ← 关键决策及理由
└── debug-insights.md    ← 调试经验教训
```

**知识从哪来？** 由 AI 从 L2 事件中提炼。比如：
- 连续3天的事件里都提到"用户不喜欢注释过多"→ 提炼成用户偏好知识条目
- 一次复杂 bug 的完整解决过程 → 提炼成调试见解

**这一层是"精华"**：去掉了具体时间、地点等细节，保留了通用性强的知识。

---

### L4：技能记忆（程序记忆）

**存储位置**：`memory/skills/`

```
memory/skills/
├── verified/            ← 经过验证的技能（可直接复用）
│   └── fix-ts-import/
│       └── SKILL.md     ← 详细步骤
├── drafts/              ← 待验证的技能草稿
└── _registry.json       ← 所有技能的索引
```

**类比**：就像你积累的"操作手册"——下次遇到类似问题，直接查手册执行，不用重新摸索。

---

## 四个工具的功能

### 🔴 `memory_record` — 记录事件

**什么时候用**：发生了值得记住的事情时

```
输入：
  content: "用户确认：所有数据库操作必须加事务"
  type: decision        # 类型：decision/observation/insight/error/preference/correction
  importance: 0.9       # 重要性 0-1（用户明确表达的决策 → 0.9+）
  tags: ["database", "规范"]
  associations: ["evt_20260303_002"]  # 关联的之前的事件ID

输出：evt_20260304_007  # 生成的事件ID，可用于关联
```

**触发时机示例**：
- ✅ 用户明确说"记住，我以后都要..."（importance 0.9+）
- ✅ 确认了架构决策（importance 0.7-0.8）
- ✅ 发现并解决了一个 bug（importance 0.6）
- ❌ 普通的问答对话（不记录）
- ❌ 执行工具的原始输出（不记录）

---

### 🟡 `memory_explore` — 关联探索

**什么时候用**：找到了一条记忆，想看看和它相关的其他记忆

```
输入：
  entry_id: "evt_20260304_003"   # 起始事件或知识条目ID
  depth: 2                        # 追溯深度（最多3跳）
  direction: "both"               # forward/backward/both

输出：
  [event] evt_20260304_003 (imp: 0.85, score: 0.71)
    用户决定 REST 风格，不用 GraphQL
    → [evt_20260303_012, ke_015]

    [event] evt_20260303_012 (imp: 0.7, score: 0.65)
      初次讨论 API 设计方案时，用户表示倾向于简单接口
```

**副作用**：被访问的事件的衰减值会重置到 1.0（就像人脑"用到的记忆得到强化"）

---

### 🟢 `memory_consolidate` — 整理归档

**什么时候用**：会话结束后、或手动触发清理

```
输入：
  scope: "day"    # session（今天）/ day（最近7天）/ full（全部）
  dry_run: false  # true = 只预览不实际执行

执行（全部零 token 消耗）：
  1. 对所有"已提炼"的事件应用衰减公式
     新分数 = 当前分数 × e^(-(ln2/30) × 天数)
     → 30天后分数降到0.5，90天后降到0.125
  
  2. 分数 < 0.2 的事件移入 .memory/archive/
  
  3. 重新生成 MEMORY.md（从 knowledge/ 文件汇总）

输出报告：
  事件扫描: 47 | 未提炼: 8 | 衰减应用: 23 | 归档: 3
  MEMORY.md: 3240 chars (regenerated)
```

---

### 🔵 `memory_status` — 健康检查

**什么时候用**：部署后验证、排查问题时

```
输入：无

输出：
  === Memory System Status ===

  Directories:
    ✅ memory/knowledge
    ✅ memory/skills/verified
    ✅ .memory/events
    ❌ .memory/archive MISSING

  MEMORY.md:
    📏 3240 chars (target: <5000)

  Events:
    📄 3 event files, 47 total events
    ⚠️ 8 unconsolidated events — run knowledge distillation

  知识: 📚 4 domain files, 23 entries
  技能: 🔧 2 verified, 1 drafts

  ===========================
  ✅ 9 passed  ⚠️ 1 warnings  ❌ 1 failed
```

---

## 安装部署

### 前提条件

- OpenClaw 已安装（版本 ≥ 2026.1.26）
- pnpm 已安装（OpenClaw 默认使用 pnpm）

### 第一步：克隆并安装插件

```bash
# 克隆到 OpenClaw 的扩展目录
git clone https://github.com/pongs1/memory-enhanced.git ~/openclaw/extensions/memory-enhanced

# 安装依赖（@types/node, @sinclair/typebox 等开发类型）
cd ~/openclaw/extensions/memory-enhanced
pnpm install

# 用 OpenClaw 的插件链接方式接入（开发模式，修改源码后无需重新安装）
openclaw plugins install -l ~/openclaw/extensions/memory-enhanced
```

> [!TIP]
> 推荐配合 SiliconFlow 的 `BAAI/bge-m3` 模型使用以获得最佳搜索效果，详见 [部署手册](DEPLOYMENT_GUIDE.md)。


### 第二步：配置 openclaw.json

在 `~/.openclaw/openclaw.json` 里合并以下配置：

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
          "halfLifeDays": 30,         // Decay half-life (days)
          "archiveThreshold": 0.2,    // Archive events below this score
          "memoryMdMaxChars": 5000    // Target MEMORY.md size (chars)
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "memorySearch": {
        "experimental": { "sessionMemory": true },
        "sources": ["memory", "sessions"]
      },
      "compaction": {
        "memoryFlush": {
          "enabled": true,
          "prompt": "Context window is almost full. Execute Tier 3 Full Consolidation NOW: 1) Read ALL unconsolidated events from .memory/events/*.jsonl. 2) Classify each: KEEP (facts/preferences/decisions) or SKILL (reusable patterns) or FORGET. 3) For KEEP items: READ existing memory/knowledge/*.md file first, then OVERWRITE outdated info and merge new insights. 4) For SKILL items: create/update memory/skills/drafts/. 5) Call memory_consolidate with scope=full. Reply NO_REPLY when done."
        }
      }
    }
  }
}
```

### 第三步：创建工作区目录结构

在 agent 的工作区目录（`$WORKSPACE`）中执行：

```bash
# 可被搜索的目录（memory_search 和 memory_get 可访问）
mkdir -p memory/knowledge
mkdir -p memory/skills/verified
mkdir -p memory/skills/drafts

# 元数据目录（只能用 read 工具访问，不可被 memory_get 访问）
mkdir -p .memory/active
mkdir -p .memory/events
mkdir -p .memory/archive
```

### 第四步：创建初始文件

**`.memory/active/scratchpad.md`**：
```markdown
# Scratchpad
## Current Focus
(auto-filled on session start)
## Reasoning Notes
(intermediate steps)
## Pending Verification
(hypotheses needing confirmation)
```

**`.memory/active/focus_stack.json`**：
```json
{
  "project_goal": "Goal name",
  "current_path": [],
  "current_focus": "",
  "pending_siblings": [],
  "last_updated": ""
}
```

**`memory/knowledge/user-prefs.md`**：
```markdown
# User Preferences
> Auto-maintained via memory_record + knowledge distillation.
```

**`memory/skills/_registry.json`**：
```json
{ "version": "1.0", "skills": [], "last_updated": null }
```

**`MEMORY.md`**：
```markdown
# Long-Term Memory

## User Preferences
→ See memory/knowledge/user-prefs.md

## Project Context
→ See memory/knowledge/project-context.md
```

### 第五步半（可选）：配置每日定时整理

对于 24 小时运行的 Agent，可以配置 cron 任务在凌晨自动运行 Tier 3 全量整理：

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

这确保即使 Agent 不重启，旧事件也会定期被衰减和归档。

### 第五步：修改默认配置文件（AGENTS.md & USER.md）

OpenClaw 默认的配置会指导 Agent 手动去编辑 `MEMORY.md`。为避免冲突，你需要**替换**工作区下面这两个文件的相关段落。

**1. 修改 `$WORKSPACE/AGENTS.md`**

找到里面的 `## Memory` 以及后面的维护段落，**全部替换成以下内容**：

```markdown
## Memory (Powered by `memory-enhanced` Plugin)

You wake up fresh each session, but you have a powerful 4-layer memory system.
**DO NOT manually edit memory files.** Always use your memory tools.

- **To record something:** Use the `memory_record` tool. It automatically writes to `.memory/events/`.
- **To curate long-term knowledge:** Distill insights into `memory/knowledge/` files.
- **To trigger cleanup:** Use `memory_consolidate` at the end of a session to decay old memories and auto-regenerate `MEMORY.md`.

### 🧠 MEMORY.md - Your Long-Term Index
- **DO NOT edit MEMORY.md manually.** It is automatically generated by the `memory_consolidate` tool.
- To update long-term memory, update specific files in `memory/knowledge/` and run `memory_consolidate`.

### 🔄 Memory Maintenance (During Heartbeats or Session End)
1. Look for unconsolidated events (run `memory_status` or check `.memory/events/`).
2. Distill those events into the appropriate `memory/knowledge/*.md` files.
3. Run the `memory_consolidate` tool (`scope="day"` or `"full"`) to:
   - Apply exponential decay to old events.
   - Archive events whose score drops below 0.2.
   - Automatically regenerate `MEMORY.md`.
```

**2. 修改 `$WORKSPACE/USER.md`**

把文件下半部分的 `## Context` 替换为以下内容，防止 Agent 在这个文件里无限疯狂堆叠你的喜好：

```markdown
## Context & Preferences (Dynamic)

> **IMPORTANT**: Do not manually list detailed user preferences in this file.
> 
> Instead, use the `memory_record` tool to log their preferences during conversations. Over time, distill these into `memory/knowledge/user-prefs.md` and run `memory_consolidate`. 
> 
> This keeps `USER.md` clean and allows the memory plugin's decay and search algorithms to manage context dynamically.
```

### 第六步：重启并验证

```bash
openclaw gateway restart
openclaw plugins list    # 应显示 memory-enhanced
openclaw doctor          # 健康检查
```

验证：对 agent 说以下内容：
1. `"请调用 memory_status 检查记忆系统"` → 应显示健康报告
2. `"请记录一条测试事件：我喜欢简洁的代码"` → 应调用 `memory_record`，返回事件ID
3. `"请检查 memory/YYYY-MM-DD.md 里有没有刚才的事件"` → 应能看到记录

---

## 使用示例

### 示例1：记录用户偏好

```
你：我之后所有项目都用 TypeScript 严格模式，不要允许 any 类型

Agent：我记住了。
  [调用 memory_record]
    content: "用户要求所有项目使用 TypeScript 严格模式，禁止 any 类型"
    type: preference
    importance: 0.85
    tags: ["typescript", "代码规范"]
  → 事件已记录：evt_20260304_001
```

### 示例2：记录并关联一个 bug 解决过程

```
[调试问题中...]

Agent：[调用 memory_record]
  content: "修复：ESM 环境下 __dirname 不存在，需用 import.meta.url + fileURLToPath 替代"
  type: error
  importance: 0.75
  tags: ["nodejs", "esm", "debug"]
  associations: ["evt_20260304_001"]  ← 关联到之前的 TS 偏好，因为都涉及 ESM
→ 事件ID：evt_20260304_007
```

### 示例3：会话结束前的知识提炼

```
你：对话快结束了，整理一下吧

Agent：好的，我来整理今天的记忆。

  1. 读取未提炼事件（.memory/events/2026-03-04.jsonl）
     → 发现 8 条 consolidated: false 的事件
  
  2. 分析提炼：
     - 3条关于代码规范 → 更新 memory/knowledge/user-prefs.md
     - 2条关于 ESM 调试 → 更新 memory/knowledge/debug-insights.md
     - 1条关于项目背景 → 更新 memory/knowledge/project-context.md
  
  3. [调用 memory_consolidate, scope="day"]
     → 衰减应用: 23条事件
     → 归档: 3条（分数 < 0.2）
     → MEMORY.md 重新生成: 3240 chars
  
  整理完成！明天开始新对话时，我会自动加载这些记忆。
```

---

## 文件结构全览

```
$WORKSPACE/
├── MEMORY.md                          ← 🤖 插件自动生成的索引（不要手动编辑）
├── AGENTS.md                          ← 你手动配置的 agent 指令
│
├── memory/                            ← ✅ 可被 memory_search + memory_get 搜索
│   ├── 2026-03-04.md                  ← 今日事件摘要（人类可读）
│   ├── 2026-03-03.md                  ← 昨日事件摘要
│   ├── knowledge/                     ← 提炼的领域知识
│   │   ├── user-prefs.md              ← 用户偏好
│   │   ├── project-context.md         ← 项目背景
│   │   ├── decisions.md               ← 关键决策
│   │   └── debug-insights.md          ← 调试经验
│   └── skills/
│       ├── verified/                  ← 验证过的技能文档
│       │   └── fix-esm-dirname/
│       │       └── SKILL.md
│       ├── drafts/                    ← 草稿技能
│       └── _registry.json             ← 技能注册表
│
└── .memory/                           ← 🔒 只能用 read 工具访问（隐藏目录）
    ├── events/                        ← 结构化事件数据（JSONL）
    │   ├── 2026-03-04.jsonl           ← 今日结构化事件
    │   ├── 2026-03-03.jsonl
    │   └── _schema.json               ← 数据格式说明
    ├── active/                        ← 当前会话工作状态
    │   ├── scratchpad.md              ← 草稿本
    │   └── focus_stack.json           ← 任务焦点栈
    └── archive/                       ← 衰减到阈值以下的旧事件
        └── 2026-01-15.jsonl
```

---

## 技术实现原理

### 为什么做成 OpenClaw 插件，而不是 SKILL.md 指令？

OpenClaw 有一个机制叫做 SKILL.md：可以把操作指令写成文档，每次对话时注入到 AI 的上下文里，让 AI 按照指令行事。

**SKILL.md 方式的问题**：

```
每次对话开始：
  上下文 = 系统提示 + SKILL.md(~2000 token) + 用户消息 + ...
                          ^^^^^^^^^^^^^^^^^^^
                          每轮都要烧掉，无论本次用不用
```

**插件方式**：

```
每次对话开始：
  上下文 = 系统提示 + 工具注册表(~50 token/工具) + 用户消息 + ...
                          ^^^^^^^^^^^^^^^^^^^^^^
                          只有工具名+参数描述，超级精简
  
  当AI真正需要记录事件时：调用工具 → TypeScript代码直接执行
                                           无需AI理解和解释指令
```

**节省效果**：每轮节省约 1800 token。一个月100次对话 = 省 18 万 token。

### 衰减算法

采用与人类遗忘曲线相同的指数衰减。**重大改进：按 Agent 的"活跃天数"计算，而不是自然日。** 
如果你的 Agent 关机休息了三个月，下次启动时它不会把三个月前的记忆全忘光——时间只在它"醒着并工作"的日子里流逝。

```
新分数 = 当前分数 × e^(-(ln2 ÷ 半衰期) × 活跃天数)

以半衰期30天为例：
  0天后：  1.000  （刚记录）
  7天活跃：0.857  （工作了一周）
  30天活跃：0.500 （工作了一个月）
  90天活跃：0.125 （工作了三个月）← 低于 0.2 阈值，自动归档
```

**"检索强化"**：当一条记忆被 `memory_explore` 访问到，它的衰减值重置为 1.0。
这模拟了人脑"经常用到的记忆不会忘"的原理。

### 评分公式

当 `memory_explore` 返回关联记忆时，会对每条结果打分排序：

```
最终得分 = 0.60 × 搜索相关度
          + 0.25 × 重要性评分
          + 0.15 × 关联密度（链接数量 ÷ 5）
```

- **搜索相关度**：来自 OpenClaw 内置的向量搜索 + BM25 混合评分
- **重要性评分**：记录事件时人工设定的 0-1 分值
- **关联密度**：这条记忆被其他多少条记忆引用？引用越多说明越核心

---

## 故障排查

| 问题 | 原因 | 解决方法 |
|---|---|---|
| 工具列表里没有 `memory_record` | 插件未加载 | `openclaw plugins list`，重新安装 |
| `memory_get` 拒绝读取 `.memory/` | 路径不在 `memory/` 下 | 用 `read` 工具访问 `.memory/` 目录 |
| `memory_search` 搜不到知识 | 知识文件放错了目录 | 确保在 `memory/knowledge/`，不是 `.memory/knowledge/` |
| MEMORY.md 越来越大 | 没有定期执行整理 | 定期调用 `memory_consolidate scope=full` |
| 插件更新后行为变化 | `openclaw update` 可能重置配置 | 检查 `openclaw.json` 里的插件配置是否还在 |

---

## 关于本插件的设计理念

这套系统的设计灵感来源于：

1. **神经科学**：人类记忆的海马体-皮质转移机制（情节记忆→语义记忆的提炼）
2. **认知心理学**：艾宾浩斯遗忘曲线、间隔重复学习
3. **信息检索**：BM25 + 向量语义搜索的混合检索
4. **图论**：关联图的 BFS 遍历用于触类旁通

核心哲学：**AI agent 的记忆应该像真正聪明的人的记忆一样工作——主动遗忘不重要的细节，从经验中积累知识，触类旁通，而不是死记硬背所有原始对话。**
