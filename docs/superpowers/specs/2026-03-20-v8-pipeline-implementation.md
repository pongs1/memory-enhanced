# V8 Pipeline Implementation Design

Status: implementation-ready draft
Date: 2026-03-20
Depends on: `2026-03-17-v8-architecture-rewrite-design.md` (architecture)

本文档是面向编码的实现规格。架构层定义（产物语义、principles、bounded vocabulary tables）见架构文档，本文不重复。

---

## 1. Implementation Principles

1. **后台是一次 pipeline pass**。一次 tool call 触发整条链（raw → narrative → IR/evidence → graph → packs，并可选派生 compatibility units），不是 10 个独立可调度的 stage。实现为一个 orchestrator 顺序调用各 step 函数。
2. **Narrative 是 canonical delivery/source surface；unit 只是 compatibility shell**。graph 负责 activation / routing；前台最终交付的是 selected narrative evidence 的最合适表达。unit 只为旧缓存、旧 review 与旧接口保留。
3. **Bundle = narrative/evidence-first recall candidate**。不是预定义的 graph node grouping。运行时从 activated IR / graph neighborhood 解析 supporting evidence spans / narrative regions，并在需要时附带 compatibility unit handles。
4. **Pack = selected narrative evidence 的最合适表达**。两种：direct（近原文组织）和 compiled（压缩表达）。预编译缓存是 compiled pack 的常见实现路径，不是它的定义本体。
5. **Evidence span = canonical offset pointer**。落盘 canonical 指针只需要 `(narrativeRecordId, charStart, charEnd)`；`unitId` 若保留，只能作为可选 compatibility metadata，不存文本副本。
6. **IR 提取 LLM-primary**。bounded vocabulary 约束 LLM 的提取范围（见架构 §9），rules 只做轻量后置过滤（数量提示 + 强行抽取筛除）。
7. **Serving views = trigger vocabulary**。从 graph 产生的触发词表（canonical labels + aliases + keywords + summary keywords），用于前台 scan window 匹配。
8. **无 recall modes**。无 profile/trajectory/oblique/audit。无 projection types。无 pre-materialized bundle。
9. **Temporal / Oblique Recall Geometry 通过 edge-based 扩展实现**。pipeline 保持 `node = object/state-object`、`edge = relation` 的哲学边界；geometry 优先落在 `edge taxonomy + edge qualifiers + edge-aware propagation`，但具体策略仍保留实现选择空间。

---

## 2. Module Layout

```
src/v8/
├── types.ts                      # 所有 type contracts
├── paths.ts                      # 存储路径常量
├── ids.ts                        # ID 生成 (nanoid-based)
├── config.ts                     # 默认配置与 schema
│
├── pipeline/
│   ├── orchestrator.ts           # 单次 pipeline pass 编排
│   ├── narrative-normalizer.ts   # raw → narrative
│   ├── unitizer.ts               # narrative → compatibility units (optional shell)
│   ├── ir-extractor.ts           # narrative spans / optional units → IR items + evidence spans
│   ├── graph-materializer.ts     # IR → graph nodes/edges + trigger vocab
│   └── pack-compiler.ts          # graph neighborhoods → pre-compiled packs
│
├── recall/
│   ├── scanner.ts                # scan window 生命周期
│   ├── ignition.ts               # trigger matching + scoring
│   ├── propagation.ts            # energy propagation
│   ├── bundle-resolver.ts        # activated nodes → evidence bundles
│   ├── pack-assembler.ts         # bundles → packs → injection
│   └── search-escalation.ts     # 逐级搜索扩圈
│
├── feedback/
│   ├── trace-recorder.ts         # recall trace
│   ├── attribution.ts            # feedback alignment
│   └── override-applier.ts       # flash/scene/durable overrides
│
├── mining/
│   ├── anchor-selector.ts        # 从 graph 选 anchor
│   ├── search-planner.ts         # 生成 search plans
│   ├── candidate-retriever.ts    # BM25 + vector retrieval
│   └── relation-reviewer.ts      # LLM relation review
│
├── review/
│   └── markdown-writer.ts        # pipeline_review.md + 阶段附录 md 生成
│
└── storage/
    ├── jsonl.ts                  # JSONL append/read/scan utilities
    └── manifest.ts               # build manifest 管理
```

---

## 3. Storage Layout

```
.memory/
├── raw/
│   └── assembled/
│       └── session_{id}_narrative.md         # assembled narrative (debug/replay)
│
├── graph/
│   ├── manifest.json                         # build manifest
│   ├── narrative_records.jsonl               # V8NarrativeRecord[]
│   ├── units.jsonl                           # V8Unit[] (compatibility shell only)
│   ├── memory_items.jsonl                    # V8MemoryIRItem[]
│   ├── graph_nodes.jsonl                     # V8GraphNode[]
│   ├── graph_edges.jsonl                     # V8GraphEdge[]
│   │
│   ├── serving/
│   │   ├── trigger_lexicon.json              # V8TriggerLexicon
│   │   ├── day_index.json                    # V8DayIndex
│   │   ├── source_index.json                 # V8SourceIndex
│   │   └── node_summary_map.json            # nodeId → short summary
│   │
│   ├── packs/
│   │   ├── compiled_packs.jsonl              # V8PreCompiledPack[]
│   │   └── pack_cache_meta.jsonl             # fingerprint + optional TTL / validity
│   │
│   ├── mining/
│   │   ├── entity_postings.jsonl
│   │   ├── entity_scope_cards.jsonl
│   │   ├── search_plans.jsonl
│   │   ├── candidate_hits.jsonl
│   │   ├── review_jobs.jsonl
│   │   └── reviewed_relations.jsonl
│   │
│   └── derived/                              # higher-order products
│       ├── knowledge/
│       ├── skills/
│       ├── settings/
│       └── protocols/
│
└── runtime/
    ├── recall_traces.jsonl                   # V8RecallTrace[]
    ├── feedback_records.jsonl                # V8FeedbackRecord[]
    ├── feedback_overrides.jsonl              # V8FeedbackOverride[]
    ├── build_report.json                     # 最近一次 build 统计
    ├── build_report.md                       # human-readable build report
    └── review/
        ├── pipeline_review.md                # 总览：一次 build 的阶段摘要 + reviewer checklist
        ├── source_narrative_review.md        # raw -> narrative 审阅附录
        ├── unit_review.md                    # narrative -> compatibility unit 审阅附录
        ├── ir_review.md                      # narrative/compat shell -> IR 审阅附录
        ├── graph_review.md                   # IR -> graph / serving views 审阅附录
        └── pack_review.md                    # selected evidence -> packs 审阅附录
```

所有 `.jsonl` 文件 append-only（rebuild 时整文件重写）。`serving/` 下的 `.json` 文件每次 build 完整重写。

`runtime/review/*.md` 是开发与调优期的临时审阅产物，不是 canonical machine artifacts。它们只承载抽样、统计、代表性样本和 reviewer questions，不镜像全量 JSONL。

**JSONL concurrency contract**:
- 同一次 build 内，canonical `.jsonl/.json` 只允许单个 orchestrator 顺序写入
- build 运行期间不接受第二个 build 并发写同一 `.memory/graph/` 或 `.memory/runtime/` 路径
- 若检测到已有 build lock，新的 build 必须退出或等待
- build 期间到达的新 raw source 留待下一次 build 处理，不回头重开已关闭的 stage outputs

### 3.1 Development Review Markdown Artifacts

开发期默认允许额外生成一个总览 markdown 和若干阶段附录 markdown，供人工审阅。

**总览文件**:
- `runtime/review/pipeline_review.md`

固定结构:
- `Run Context`
- `Executed Loops`
- `Stage Summary`
- `Key Stats`
- `Failure Classification`
- `Reviewer Checklist`
- `Links To Appendices`

**阶段附录文件**:
- `source_narrative_review.md`
- `unit_review.md`
- `ir_review.md`
- `graph_review.md`
- `pack_review.md`

固定结构:
- `Run Context`
- `What This Stage Consumed`
- `What This Stage Produced`
- `Key Stats`
- `Representative Samples`
- `Failures / Warnings`
- `Reviewer Questions`

**各附录的最小展示内容**:

1. `source_narrative_review.md`
- raw source ref
- cleaned narrative excerpt
- removed wrapper summary
- traceability fields
- failure classes:
  - `source_loss`
  - `normalization_noise`
  - `traceability_loss`
  - `narrative_distortion`

2. `unit_review.md`
- narrative doc id / sourceRef
- turn count
- `micro / meso / macro` counts
- parent linkage samples
- representative unit excerpts
- split reasons:
  - discourse block split
  - time-gap split
  - new user episode split
  - overflow split

3. `ir_review.md`
- source unit excerpt
- extracted IR items
- evidence span offsets
- summary IR item when present
- failure classes:
  - `bad_unit_boundaries`
  - `poor_prompt_guidance`
  - `schema_mismatch`
  - `weak_evidence_anchoring`

4. `graph_review.md`
- node / edge totals
- alias merge samples
- rejected noisy nodes
- trigger lexicon samples
- node summary samples
- failure classes:
  - `consolidation_loss`
  - `graph_shape_issue`
  - `serving_view_issue`
  - `pack_materialization_issue`

5. `pack_review.md`
- selected evidence span ids
- chosen pack type
- direct / compiled content excerpt
- evidence refs
- pack-type decision reason
- duplication / trimming notes

**生成原则**:
- markdown review 文件默认只展示抽样和摘要，不转储全量 JSONL
- 每个阶段的样本数量由配置控制
- 附录优先服务人工审阅，不承担 machine-replay 责任
- machine-replay 仍以 `.jsonl/.json` 为准

**writer module contract**:
- review markdown 全部由 `src/v8/review/markdown-writer.ts` 负责
- orchestrator 只传阶段输入、阶段输出、build context 和 sample policy
- writer 负责抽样、裁切 excerpt、生成 markdown、写入固定路径
- writer 不参与 canonical JSONL 生成，不修改 stage output

---

## 4. Type Contracts

### 4.1 Common Types

```ts
// ── scale ──
export type V8Scale = "micro" | "meso" | "macro";
export type V8EdgeScale = V8Scale | "cross";

// ── source ──
export type V8SourceClass = "raw" | "curated" | "legacy";
export type V8Speaker = "user" | "assistant" | "system" | "tool" | "unknown";
export type V8Language = "zh" | "en" | "mixed" | "unknown";

// ── semantic state ──
export type V8Scope = "global" | "topic" | "session";
export type V8Validity = "active" | "tentative" | "superseded" | "session_only";
export type V8OriginType = "asserted" | "aggregated" | "inferred";
export type V8Polarity = "positive" | "negative" | "neutral";
export type V8Certainty = "certain" | "probable" | "possible" | "uncertain";
```

### 4.2 Node & Edge Type Vocabularies

本节先给 `meaning contract`，再给 union type 定义。实现按 `meaning` 对齐；union types 只负责编译期约束。

### 4.2.1 Meaning Contract

这里的 type name 是语义位，不是表面词名，不是自由标签。

- `node type` 定义对象在记忆图中的语义角色
- `edge predicate` 定义对象之间的语义关系
- 同一个英文词跨 scale 出现时，按各自 scale 的专用 meaning 解释，不做同义扩展

### 4.2.2 Three-Layer Recall Geometry Contract

这一节承接架构文档中的总表，给出实现层需要使用的细表。

这里的 contract 同时服务两层：

- IR production
  - 抽取阶段的 LLM 根据这张表决定当前窗口产出哪些 type 与 relation；
- recall consumption
  - ignition、propagation、bundle resolution 根据这张表决定如何点火、如何扩散、如何把过去片段带回前台。

当前实现只保留纯三层基底：

- micro
- meso
- macro

memory-control、state-overlay、scope-change 和其它 cross-layer state taxonomy 不属于这份主表。

#### 4.2.2.1 Layer Boundary Rules

| Layer | Semantic Scale | Extraction Boundary | Recall Use |
|---|---|---|---|
| micro | 单个对象、单个事件、单个属性、单个命题、单个局部支撑点 | 当前窗口里可以直接引用、直接判断、直接比较的最小语义单位 | 作为点火锚点和局部传播起点，把 recall 带到直接相关的过去片段 |
| meso | 一个局部完整块，由多个 micro 围绕同一局部目标、问题、步骤、互动或结果组织而成 | 当前窗口里已经形成一个局部闭合块，但还没有上升成长期线索或阶段结构 | 作为局部片段组织单位，帮助 bundle 把多个相关片段拼成一个可交付块 |
| macro | 一条跨多个局部块的长程线索、阶段结构、主题结构或演化结构 | 当前窗口里已经明确支持跨块、跨阶段、跨时间的持续结构，而不是单一局部块 | 作为长程召回骨架，把 recall 从当前线索带到更远的阶段、线程、主题或演化片段 |

判定规则：

- micro 关注当前文本里最小且直接成立的对象、事实、事件、命题和支撑点；
- meso 关注多个 micro 如何在一个局部块里共同成立；
- macro 关注多个 meso 或多个局部块如何形成一条持续结构；
- 同一内容优先落在最低且足够表达它的层级，只有文本明确支持更高层结构时才上升到更高层。

#### 4.2.2.2 Shared Contract Shape

每个 type 都同时带两类说明：

- formation entry
  - 抽取阶段在什么文本条件下产出这个 type；
- recall function
  - 这个 type 在 recall 中主要帮助点亮和组织哪类过去片段。

每个 relation 都同时带三类说明：

- formation entry
  - 抽取阶段在什么文本条件下产出这条 relation；
- recall role
  - 这条 relation 在 recall 中承担什么作用；
- propagation shape
  - 这条 relation 在传播中主要把激活往哪类方向带。

propagation shape 使用统一的运行时描述：

- horizontal
  - 同层局部扩散；
- vertical-up
  - 向更高层结构抬升；
- vertical-down
  - 向更具体局部回落；
- temporal-forward
  - 顺时间向后推进；
- temporal-backward
  - 逆时间回溯；
- oblique
  - 跨线索、跨块、跨解释链的斜向带起。

type 的 family 只承担阅读和编排作用，不构成独立运行语义。
relation 的 family 同时承担阅读作用和运行时归组作用。

#### 4.2.2.3 Micro Types

| Family | Type | Formation Entry | Recall Function |
|---|---|---|---|
| object | entity | 文本里出现稳定对象，如人、地点、组织、系统、文件、物件 | 作为稳定点火锚点，带起与该对象直接相关的事实片段 |
| object | concept | 文本表达抽象概念、术语、主题、范畴 | 作为概念锚点，带起围绕同一概念的解释与事实 |
| object | method | 文本表达做事方法、操作方式、策略步骤 | 作为方法锚点，带起相关流程、工具使用和结果 |
| event | event | 文本表达一个发生了的动作、变化或情节节点 | 作为事件锚点，带起前因后果和相邻事件 |
| event | attribute | 文本表达性质、状态、配置、描述性特征 | 作为对象状态补充，帮助筛选当前场景匹配的片段 |
| event | metric | 文本表达数值、计量、评分、统计量 | 作为可比或可验证锚点，带起相关比较和变化 |
| proposition | claim | 文本表达命题、判断、结论、评价 | 作为可被支持、反驳或解释的命题核心 |
| support | evidence | 文本表达证据、依据、引用、材料、示例 | 作为支撑线索，帮助回到支持某命题的过去片段 |
| support | context | 文本表达条件、背景、环境、范围、前提 | 作为场景限定，帮助 recall 在正确条件下扩散 |
| discourse | discourse_unit | 文本表达定义、解释、总结、推荐等局部 discourse 作用 | 作为局部组织点，帮助补全解释链和说明链 |

#### 4.2.2.4 Meso Types

| Family | Type | Formation Entry | Recall Function |
|---|---|---|---|
| scene | scene_block | 文本构成一个局部完整场景或局部叙事块 | 把相邻事实组织成可交付的局部片段 |
| scene | situation_frame | 文本构成一个局部局势、处境、问题场景 | 把相关对象、条件、动作放进同一局部框架 |
| objective | objective_block | 文本围绕一个局部目标展开 | 把相关目标推进片段聚成一块 |
| objective | problem_block | 文本围绕一个局部问题、冲突、障碍展开 | 把问题线、阻碍线相关片段聚成一块 |
| method | strategy_block | 文本围绕一个局部策略、应对思路展开 | 把应对方式、替代方案、行动选择聚成一块 |
| method | procedure_block | 文本围绕一组有序步骤或流程展开 | 把步骤化片段组织成可回忆的流程块 |
| interaction | interaction_block | 文本围绕一段互动、协作、对抗展开 | 把多方互动片段组织成局部互动块 |
| interaction | decision_block | 文本围绕一个局部决策、取舍、结论展开 | 把前提、选择、决定和结果组织到一起 |
| support | evidence_frame | 文本围绕一组证据或支撑材料展开 | 把支撑同一判断的材料聚成可回忆局部证据框 |
| transition | shift_block | 文本出现局部转折、切换、重定向、立场变化 | 作为局部转折点，帮助 recall 从旧方向切到新方向 |
| transition | outcome_block | 文本围绕局部结果、响应、后果展开 | 把行动结果和对应反馈组织成局部结果块 |
| transition | block_function | 文本表达一个块在更大结构里的作用，如 setup、pivot、recovery | 作为局部结构角色，帮助 bundle 组装更完整的片段 |

#### 4.2.2.5 Macro Types

| Family | Type | Formation Entry | Recall Function |
|---|---|---|---|
| structure | arc | 文本明确支持一条较完整的发展弧线 | 支撑长程召回和阶段串联 |
| structure | thread | 文本明确支持一条持续反复出现的问题线、对象线、主题线 | 支撑跨片段、跨时间的持续主题召回 |
| structure | phase | 文本明确支持一个较大的阶段边界 | 支撑按阶段组织 recall |
| structure | global_scene_type | 文本支持较高层的场景模式，如恢复、升级、冲突扩张 | 支撑按高层模式带起相关片段 |
| structure | regime | 文本支持一个全局运行环境、制度、版本范式 | 支撑按环境或范式切换 recall |
| line | objective_line | 文本支持一条长期目标线 | 支撑围绕长期目标的长程召回 |
| line | conflict_line | 文本支持一条长期冲突或张力线 | 支撑围绕冲突推进和解决的长程召回 |
| line | relationship_arc | 文本支持一条关系演化线 | 支撑关系变化相关的长程召回 |
| line | method_line | 文本支持一条方法、能力、策略演化线 | 支撑流程和能力演进相关的长程召回 |
| theme | theme | 文本支持一个长期反复出现的主题或母题 | 支撑高层主题下的片段聚合 |
| theme | pattern | 文本支持一个反复出现的结构或行为模式 | 支撑模式性召回 |
| theme | turning_point | 文本支持一个重大转折点或不可逆拐点 | 作为强点火点，带起前后关键片段 |
| theme | global_state | 文本支持一个较大范围内持续成立的总体状态 | 支撑围绕总体状态的跨片段召回 |

### 4.2.3 Relation Meaning

#### 4.2.3.1 Micro Relations

| Family | Relations | Formation Entry | Recall Role | Propagation Shape |
|---|---|---|---|---|
| identity | is_a, instance_of, part_of, has_part, belongs_to, equivalent_to | 文本明确表达归属、组成、同一性、类别关系 | 稳定对象锚点和对象簇 | horizontal, vertical-up, vertical-down |
| participation | performs, acts_on, uses, produces, targets | 文本明确表达谁做什么、作用到什么、使用什么、产出什么、目标是什么 | 形成默认的行动主路径，把对象、动作、目标、结果串起来 | horizontal, oblique |
| event | initiates, involves, occurs_at, results_in_event | 文本明确表达事件起点、参与者、发生位置、事件后续 | 把当前线索带到相邻事件和事件支撑片段 | horizontal, temporal-forward, temporal-backward |
| causality | causes, caused_by, enables, prevents, requires, conditioned_on | 文本明确表达因果、条件、依赖、阻碍 | 把 recall 沿原因、前提、约束、后果方向推进 | horizontal, temporal-forward, temporal-backward, oblique |
| temporal | before, after, simultaneous_with, evolves_to | 文本明确表达时间顺序、并发、演化 | 支撑历史回溯、后续推进和变化跟踪 | temporal-forward, temporal-backward |
| comparison | better_than, worse_than, similar_to, differs_from | 文本明确表达比较、相似、差异 | 把当前对象带到可比项和替代项 | horizontal, oblique |
| support | supports, contradicts, cites | 文本明确表达支撑、反驳、引用 | 把命题带到证据、反证和相关材料 | horizontal, oblique, vertical-down |
| discourse | elaborates, summarizes, contrasts, explains, concludes, recommends | 文本明确表达解释、总结、对比、结论、建议 | 作为 bridge，把主事实和补充说明、总结、建议链连接起来 | horizontal, oblique, vertical-up |

#### 4.2.3.2 Meso Relations

| Family | Relations | Formation Entry | Recall Role | Propagation Shape |
|---|---|---|---|---|
| anchoring | grounded_in, oriented_to, focuses_on, realized_by, evidenced_by_block, functions_as | 文本明确表达一个局部块建立在哪个局势、目标、证据或功能上 | 把局部块锚定到其局部中心与支撑结构 | horizontal, vertical-down |
| dynamics | triggered_by, responds_to, constrained_by, attempts_to_resolve, escalates, mitigates, reframes, revises | 文本明确表达局部块如何回应、收束、加剧、缓和或改写局部问题 | 形成局部问题推进链和局部应对链 | horizontal, oblique |
| transformation | culminates_in, leads_to, produces_shift, stabilizes, destabilizes, opens, closes | 文本明确表达一个局部块的结果、转折、开启、闭合 | 标记局部闭合点和转折点，帮助 bundle 形成完整局部片段 | horizontal, temporal-forward, vertical-up |
| organization | precedes_block, branches_to, merges_into, parallels, contrasts_with_block, echoes, sets_up, mirrors_locally | 文本明确表达块与块之间的局部组织关系 | 把相邻局部块串成更完整的局部结构 | horizontal, oblique, temporal-forward |

#### 4.2.3.3 Macro Relations

| Family | Relations | Formation Entry | Recall Role | Propagation Shape |
|---|---|---|---|---|
| structure | unfolds_through, spans_phase, organized_as, governed_by, centered_on_line, dominated_by | 文本明确表达一条长线或弧线如何分阶段展开，受什么高层结构支配 | 组织长程召回的主骨架 | vertical-up, vertical-down, temporal-forward |
| evolution | transitions_to_phase, evolves_to, branches_into, converges_with, interrupted_by, resumes_after, culminates_at, resolved_by | 文本明确表达阶段切换、分支、汇合、中断、恢复、高潮、解决 | 支撑长程历史追踪和阶段跳转 | temporal-forward, temporal-backward, oblique |
| global_condition | produces_state, shifts_regime, stabilizes_state, destabilizes_state, constrains, enables | 文本明确表达长线结构如何重塑总体条件、总体环境和全局约束 | 支撑按全局条件筛选和推进 recall | vertical-down, oblique, temporal-forward |
| interaction | competes_with, reinforces, undermines, mirrors, recurs_as, foreshadows, pays_off, recontextualizes, opens_arc, closes_arc | 文本明确表达长线之间的相互作用、伏笔、回响、兑现与开闭 | 支撑跨长线、跨主题、跨阶段的 oblique recall | oblique, temporal-forward, temporal-backward |

### 4.2.4 Minimal Inter-Layer Relations

这一节只补最小层间边，用来让 vertical propagation 有明确落点和回落点。

这些边名保持中性。传播方向由 runtime 决定，而不是写死在边名里。

| Relation | Connected Layers | Meaning | Runtime Use |
|---|---|---|---|
| micro_meso_membership | micro <-> meso | 一个 micro 属于一个局部 meso 块，或一个 meso 块由若干 micro 构成 | 给 vertical propagation 提供稳定的成员跳转骨架 |
| meso_macro_membership | meso <-> macro | 一个 meso 块属于一个 macro 结构，或一个 macro 结构由若干 meso 构成 | 给更高层结构提供稳定的上下层跳转骨架 |
| micro_meso_abstraction | micro <-> meso | 一个 micro 被局部块吸收、概括、组织或功能化 | 给 soft vertical propagation 提供局部抽象路径 |
| meso_macro_abstraction | meso <-> macro | 一个 meso 被长程结构吸收、概括、组织或主题化 | 给 soft vertical propagation 提供长程抽象路径 |

使用规则：

- membership 表示硬结构归属；
- abstraction 表示软结构提升；
- 同一关系可被 runtime 解释为 vertical-up 或 vertical-down；
- 这四条边足以支撑当前版本的 vertical propagation 主路径。

### 4.2.5 Temporal and Vertical Coordination

temporal-forward 和 temporal-backward 不是另一套独立 ontology，而是 relation 在传播时的运行方向。

它和三层表的联动规则是：

1. 同层 temporal
- micro relation 先在 micro 层做时间推进或回溯；
- meso relation 先在 meso 层做局部块顺序推进或回溯；
- macro relation 先在 macro 层做长程阶段推进或回溯。

2. temporal + vertical-up
- 当同层 temporal 命中了一串连续局部结构时，runtime 可以通过 membership 或 abstraction 抬升到更高层；
- 这让系统从“局部连续事实”上升到“局部块”或“长程线索”。

3. temporal + vertical-down
- 当高层 temporal 命中了 thread、phase、arc 等长程结构时，runtime 可以通过 membership 或 abstraction 回落到更具体的 meso 或 micro；
- 这让系统从“长程线索”回到真正可交付的过去片段。

4. temporal + oblique
- 当 temporal 路径已经建立一条主线时，oblique relation 允许系统从当前时间线切到相关但不完全同线的结构；
- 这通常用于带起补充解释、相邻问题线、相关主题线或回响片段。

运行时优先级：

- 同层 temporal 是第一步；
- vertical 用于在层级之间升降；
- oblique 用于补充跨线索连接；
- bundle resolution 最终只消费被共同点亮、且能回到 narrative 片段的结构。

### 4.2.6 Contract Usage

抽取阶段：

- 当前窗口的 LLM 使用这份三层 contract 选择 type 与 relation；
- micro、meso、macro 决定当前窗口允许形成的语义尺度；
- formation entry 定义何时应该产出，而不是让模型自由发明新类别。

recall 阶段：

- ignition 先沿 type 找到可点亮对象；
- propagation 主要消费 relation 的 recall role 与 propagation shape；
- vertical propagation 通过最小层间边完成升降；
- temporal-forward 和 temporal-backward 在当前层先运行，再和 vertical 或 oblique 联动；
- bundle resolution 依赖这些被共同点亮的结构，把过去真正相关的 narrative 片段带到前台；
- front-end 交付给 LLM 的始终是原文片段或由这些片段压出的 pack，而不是 taxonomy 本身。

### 4.3 Source & Narrative

```ts
export interface V8NarrativeRecord {
  id: string;                   // "narr_{date}_{seq}"
  sourceClass: V8SourceClass;
  sourceRef: string;            // 原始文件路径或 session trace ref
  sessionId: string;
  sourceType: "session_narrative" | "session_trace" | "daily_log" | "knowledge_md" | "skill_md";
  speaker: V8Speaker | null;    // per-doc narrative 允许为空；turn speaker 在 unitization 时重建
  timestamp: string | null;     // narrative doc 级别可为空；具体 turn timestamp 在 turn span / unit 层恢复
  rawText: string;              // 原始文本（保留用于回退校验）
  cleanText: string;            // 清洗后文本（canonical evidence surface）
  cleanMap: V8OffsetMapping[];  // raw ↔ clean 偏移映射
  language: V8Language;
  metadata: {
    timelineStart?: string;
    turnId?: string;            // 仅当 record 本身就是单 turn source 时可选填写
    messageId?: string;         // 仅当 source-stage 直接对应单条 message 时可选填写
    toolName?: string;
    toolCallId?: string;
    [key: string]: unknown;
  };
}

export interface V8OffsetMapping {
  rawStart: number;
  rawEnd: number;
  cleanStart: number;
  cleanEnd: number;
}
```

### 4.4 Units

```ts
export interface V8Unit {
  id: string;                   // "unit_{date}_{seq}"
  narrativeRecordId: string;
  scale: V8Scale;
  ordinal: number;              // 同层同 narrative record 内的顺序
  charStart: number;            // 相对于 cleanText 的起始 offset
  charEnd: number;
  text: string;                 // 从 cleanText[charStart:charEnd] 切出（冗余存储，方便调试）
  speaker: V8Speaker | null;
  timestamp: string | null;
  parentUnitId: string | null;  // meso → macro, micro → meso
  language: V8Language;
}
```

### 4.5 Memory IR & Evidence Spans

```ts
export interface V8EvidenceSpan {
  id: string;                   // "es_{date}_{seq}"
  narrativeRecordId: string;
  compatibilityUnitId?: string | null;
  charStart: number;            // 相对于 narrative cleanText
  charEnd: number;
  // 不存 text 副本。运行时通过 narrativeRecordId + offsets 解析。
}

export interface V8MemoryIRItem {
  id: string;                   // "ir_{date}_{seq}"
  narrativeRecordId: string;
  compatibilityUnitIds?: string[]; // 可选 legacy handles，不是 canonical evidence source
  nodeType: V8NodeType;
  originType: V8OriginType;
  scale: V8Scale;
  subject: string;
  predicate: string;
  object: string;
  label: string;                // 归一化标签（用于 graph dedup）
  qualifiers: V8Qualifiers;
  evidenceSpans: V8EvidenceSpan[]; // 作为 IR item 的内嵌属性持久化
  confidence: number;           // 0–1
  scope: V8Scope;
  validity: V8Validity;
}

export interface V8Qualifiers {
  aspect?: string;
  time?: string;
  context?: string;
  polarity?: V8Polarity;
  certainty?: V8Certainty;
}
```

### 4.6 Graph

```ts
export interface V8GraphNode {
  id: string;                   // "node_{hash8}"
  nodeType: V8NodeType;
  canonicalLabel: string;
  aliases: string[];
  scale: V8Scale;
  sourceIRItemIds: string[];    // 哪些 IR items 被合并进了这个 node
  state: {
    scope: V8Scope;
    validity: V8Validity;
    confidence: number;
    supportCount: number;       // 多少条独立 IR items 支撑
  };
}

export interface V8GraphEdge {
  id: string;                   // "edge_{hash8}"
  type: V8EdgePredicate;
  src: string;                  // source node id
  dst: string;                  // target node id
  scale: V8EdgeScale;
  originType: V8OriginType;
  sourceIRItemIds: string[];
  forwardDimension: V8PropagationDimension; // src -> dst
  reverseDimension: V8PropagationDimension; // dst -> src
  qualifiers: V8Qualifiers;
  confidence: number;
  state: {
    scope: V8Scope;
    validity: V8Validity;
  };
}

export type V8PropagationDimension =
  | "H"
  | "V_up"
  | "V_down"
  | "T_forward"
  | "T_backward"
  | "O_up"
  | "O_down"
  | "gate"
  | "none";
```

### 4.7 Serving Views (Trigger Vocabulary)

```ts
// ── trigger lexicon ──
// 倒排索引：term → 它能触发的 node 列表
export interface V8TriggerLexicon {
  terms: Record<string, V8TriggerHit[]>;
  nodeCount: number;
  updatedAt: string;
}

export interface V8TriggerHit {
  nodeId: string;
  weight: number;               // 触发强度
  source: "canonical" | "alias" | "keyword" | "summary";
}

// ── day index (episodic gating) ──
export interface V8DayIndex {
  entries: Record<string, string[]>;  // dayKey "2026-03-20" → nodeIds
}

// ── source index ──
export interface V8SourceIndex {
  entries: Record<string, string[]>;  // sourceRef → nodeIds
}

// ── node summary map (for scene overlap scoring) ──
// 仅给 meso/macro 节点准备，micro 节点用 canonical label 即可
export interface V8NodeSummaryMap {
  entries: Record<string, string>;    // nodeId → short summary text
}
```

### 4.8 Runtime Recall

```ts
// ── L0 control plane ──
// 由前台 LLM 自行维护（相当于 LLM 的 todo list）
export interface V8L0ControlAnchors {
  goal: string;
  activeTask: string;
  latestUserRequest: string;
  handoff?: string;
}

// ── active text signal ──
export interface V8ActiveTextSignal {
  source: "user" | "assistant" | "tool" | "subagent"
        | "feedback" | "working_state" | "observation";
  text: string;
  weight: number;
  timestamp: string;
}

export interface V8AnchorCandidate {
  nodeId: string;
  score: number;
  source: "lexical" | "scene" | "control" | "mixed";
}

export interface V8StateInquiry {
  anchorNodeId: string;
  aspectKey: string | null;
  regimeHint: string | null;
  validityMismatch: boolean;
  competingStateNodeIds: string[];
  mode: "none" | "state_line" | "retrospective";
}

// ── scanner state (runtime-only, 不落盘) ──
export interface V8ScannerState {
  roundIndex: number;
  windowStart: number;          // 当前 scan window 在文本流中的起始位置
  windowEnd: number;
  nodeEnergies: Map<string, number>;     // nodeId → residual energy
  nodeCooldowns: Map<string, number>;    // nodeId → last activation timestamp (ms)
  bundleCooldowns: Map<string, number>;  // unitId → last delivery timestamp (ms)
  recentTrajectory: V8PropagationDimension[]; // 最近 2-3 步维度序列
}

// ── bundle = narrative/evidence-first recall candidate (runtime-only) ──
export interface V8Bundle {
  primaryNarrativeRecordId: string;
  evidenceSpanIds: string[];    // 被选中的 canonical evidence
  compatibilityUnitIds: string[]; // 可选 legacy handles
  energy: number;               // 聚合后的 bundle_energy
  supportingNodeIds: string[];  // 贡献能量的 graph nodes
  tier: "critical" | "decision" | "background";
}

// ── recall assembly = 一轮 recall 的完整输出 ──
export interface V8RecallAssembly {
  roundIndex: number;
  bundles: V8Bundle[];          // 入选的 bundles
  packs: V8Pack[];              // 组装好的 packs
  controlAnchors: V8L0ControlAnchors;
  timestamp: string;
}

export interface V8StateSnapshot {
  anchorNodeId: string;
  aspectKey: string;
  stateLabel: string;
  regimeHint?: string | null;
  validity: "active" | "superseded" | "uncertain";
  supportEvidenceSpanIds: string[];
}
```

### 4.9 Packs

```ts
// ── pack = selected narrative evidence 的最合适表达 ──
export interface V8Pack {
  id: string;
  type: "direct" | "compiled";
  sourceEvidenceSpanIds: string[]; // canonical evidence refs
  compatibilityUnitIds?: string[]; // 可选 legacy handles
  content: string;              // 实际注入文本
  evidenceSpanIds: string[];    // evidence chain
}

// ── pre-compiled pack (后台产出, 缓存于 graph/packs/) ──
export interface V8PreCompiledPack {
  id: string;                   // "pack_{hash8}"
  sourceEvidenceSpanIds: string[]; // 被总结的 canonical evidence refs
  compatibilityUnitIds?: string[]; // 可选 legacy handles
  variant: "summary" | "state";
  content: string;              // LLM 编译的 summary
  evidenceSpanIds: string[];
  fingerprint: string;          // sha256(sorted sourceEvidenceSpanIds + evidence text hash)
  compiledAt: string;
  ttlSec?: number | null;       // default null = 不失效
}
```

### 4.10 Feedback

```ts
export interface V8RecallTrace {
  id: string;
  sessionId: string;
  roundIndex: number;
  deliveredPackIds: string[];
  deliveredUnitIds: string[];   // 实际交付的 units
  deliveredNodeIds: string[];   // 贡献能量的 nodes
  controlAnchors: V8L0ControlAnchors;
  timestamp: string;
}

export type V8FeedbackLabel =
  | "memory_content_error"
  | "memory_scope_selection_error"
  | "task_stack_drift"
  | "memory_induced_execution_error"
  | "memory_helped"
  | "memory_ignored_neutral"
  | "memory_missed_relevant";

export interface V8FeedbackRecord {
  id: string;
  sessionId: string;
  recallTraceId: string;
  source: "user" | "tool" | "model";
  label: V8FeedbackLabel;
  polarity: V8Polarity;
  targets: string[];            // nodeIds 或 unitIds
  layer: "flash" | "scene" | "durable";
  reason?: string;
  timestamp: string;
}

export interface V8FeedbackOverride {
  id: string;
  feedbackId: string;
  targetId: string;             // nodeId 或 unitId
  layer: "flash" | "scene" | "durable";
  operation: "reinforce" | "suppress" | "clear";
  delta: number;                // -1.0 ～ +1.0
  ttlSec: number | null;       // null = 永久，等待下次 consolidation 消费
  createdAt: string;
}
```

### 4.11 Relation Mining

```ts
export interface V8EntityPosting {
  anchorId: string;             // graph node id
  canonicalLabel: string;
  narrativeRecordIds: string[];
  unitIds: string[];
  evidenceSpanIds: string[];
}

export interface V8EntityScopeCard {
  anchorId: string;
  shardHints: string[];         // 相关 narrative record ids
  coanchorHints: string[];      // 相关 entity node ids
  edgeFamilyHints: string[];    // 已有 edge types
  stateHints: string[];         // 已有 state-related edges
}

export interface V8RelationSearchPlan {
  id: string;
  anchorIds: string[];
  lane: "focused" | "broadened" | "exploratory";
  queryTerms: string[];
  timeConstraints?: { after?: string; before?: string };
}

export interface V8ReviewedRelation {
  id: string;
  reviewJobId: string;
  anchorIds: string[];
  relationType: V8EdgePredicate;
  supportEvidenceSpanIds: string[];
  confidence: number;
  verdict: "accepted" | "rejected" | "shelved";
}
```

### 4.12 Configuration

```ts
export interface V8PipelineConfig {
  // ── build ──
  startAt?: "source" | "narrative"; // default "source"
  compilePhase?: "stream" | "final"; // default "final"
  rebuildMode: "full" | "incremental";
  maxNarrativeDocs?: number;    // dev: 限制处理文档数
  emitReviewMarkdown?: boolean; // dev: 生成总览 md + 阶段附录 md
  reviewSampleCount?: number;   // default 5, 每阶段抽样数量
  reviewExcerptChars?: number;  // default 600, 每条样本展示最大字符数

  // ── unitization 粒度 guardrails ──
  microMaxChars: number;        // default 420
  mesoMaxChars: number;         // default 3200
  macroTargetChars: number;     // default 12000
  macroMaxChars: number;        // default 28000
  mesoMaxSentences: number;     // default 8
  mesoMinSentences: number;     // default 2
  macroTargetMesoUnits: number; // default 4
  macroMaxMesoUnits: number;    // default 8

  // ── IR extraction ──
  irLlmCommand: string;         // LLM binary 或 API endpoint
  irLlmTimeout: number;         // ms
  irMaxItemsPerUnit: number;    // default 8, 数量 guardrail
  irMinConfidence: number;      // default 0.3, 低于此过滤

  // ── pack compilation ──
  packLlmCommand: string;
  packLlmTimeout: number;
  packCompileThresholdChars: number;  // unit text 超过此长度才编译 summary; default 500
  compiledPackTtlSec?: number | null; // default null = 不失效

  // ── scan window ──
  scanIntervalChars: number;    // default 24
  scanBoundaryPatterns: string[]; // default: ["[。？！.!?]+", "```\\s*$", "\\n\\s*\\n"]

  // ── ignition ──
  ignitionWeights: {
    a: number;                  // g_lex 权重, default 0.45
    b: number;                  // max(g_scene, g_ctrl) 权重, default 0.35
    c: number;                  // g_time 权重, default 0.20
  };
  baseGainInitial: number;      // 首轮/预热, default 1.4
  baseGainNormal: number;       // 普通 scan, default 1.0

  // ── propagation ──
  decayLambda: number;          // 跨轮衰减, default 0.95
  forwardGain: number;          // 正向传播增益, default 0.30
  reverseGain: number;          // 反向传播增益, default 0.15
  hubPenaltyPower: number;      // 1/√degree 的指数, default 0.50
  topKEdges: number;            // 每个方向最多传播几条边, default 6
  stopThreshold: number;        // 低于此清零, default 0.05
  dimensionWeights: {
    H: number;                  // default 1.0
    V_up: number;               // default 0.45
    V_down: number;             // default 0.25
    T_forward: number;          // default 1.1
    T_backward: number;         // default 0.5
    O_up: number;               // default 0.7
    O_down: number;             // default 0.55
  };
  scopeGateFloor: number;       // default 0.15

  // ── bundle selection ──
  criticalThreshold: number;    // default 0.82
  decisionThreshold: number;    // default 0.74
  backgroundThreshold: number;  // default 0.68
  maxInjectedBundles: number;   // default 3
  nodeCooldownMs: number;       // default 180_000
  bundleCooldownMs: number;     // default 300_000

  // ── scene ──
  sceneDecayLambda: number;     // default 0.985
  sceneBiasGain: number;        // default 0.50

  // ── search escalation ──
  searchMaxExpansionSteps: number;  // default 3

  // ── trigger tokenization ──
  triggerTokenMinCharsEn: number;   // default 3
  triggerTokenMinCharsCjk: number;  // default 2
  triggerTokenMaxNgramCjk: number;  // default 3

  // ── direct pack ──
  directPackMaxChars: number;       // default 1200
  directPackTrimWindowChars: number; // default 400

  // ── search ranking ──
  searchBm25TopK: number;           // default 20
  searchReturnTopK: number;         // default 5
}
```

### 4.13 Review Markdown Contracts

```ts
export interface V8ReviewRunContext {
  buildId: string;
  rebuildMode: "full" | "incremental";
  compilePhase?: "stream" | "final";
  startedAt: string;
  finishedAt?: string;
  workspace: string;
  sourceDocCount: number;
  activeSessionIds?: string[];
}

export interface V8ReviewSamplePolicy {
  sampleCount: number;
  excerptChars: number;
}

export interface V8SourceNarrativeReviewInput {
  run: V8ReviewRunContext;
  policy: V8ReviewSamplePolicy;
  narrativeRecords: V8NarrativeRecord[];
}

export interface V8UnitReviewInput {
  run: V8ReviewRunContext;
  policy: V8ReviewSamplePolicy;
  narrativeRecords: V8NarrativeRecord[];
  units: V8Unit[];
}

export interface V8IrReviewInput {
  run: V8ReviewRunContext;
  policy: V8ReviewSamplePolicy;
  units: V8Unit[];
  irItems: V8MemoryIRItem[];
}

export interface V8GraphReviewInput {
  run: V8ReviewRunContext;
  policy: V8ReviewSamplePolicy;
  nodes: V8GraphNode[];
  edges: V8GraphEdge[];
  triggerLexicon: V8TriggerLexicon;
  nodeSummaryMap: V8NodeSummaryMap;
}

export interface V8PackReviewInput {
  run: V8ReviewRunContext;
  policy: V8ReviewSamplePolicy;
  bundles?: V8Bundle[];
  packs: V8Pack[];
  units: V8Unit[];
}

export interface V8PipelineReviewInput {
  run: V8ReviewRunContext;
  stageStats: Record<string, number | string>;
  executedLoops: string[];
  failures: Array<{ stage: string; type: string; message: string }>;
  appendixPaths: string[];
}
```

**writer interfaces**:

```ts
function writeSourceNarrativeReviewMarkdown(input: V8SourceNarrativeReviewInput): string
function writeUnitReviewMarkdown(input: V8UnitReviewInput): string
function writeIrReviewMarkdown(input: V8IrReviewInput): string
function writeGraphReviewMarkdown(input: V8GraphReviewInput): string
function writePackReviewMarkdown(input: V8PackReviewInput): string
function writePipelineReviewMarkdown(input: V8PipelineReviewInput): string
```

返回值为写入后的绝对路径。发生写入错误时抛异常，由 orchestrator 捕获并记录到 `build_report.md`。

**sampling rules**:
- `sampleCount` 默认取 `config.reviewSampleCount ?? 5`
- `excerptChars` 默认取 `config.reviewExcerptChars ?? 600`
- source / unit / IR / graph / pack 五类附录都必须按同一采样策略执行
- 若总量小于 `sampleCount`，全部写入
- 抽样优先级默认采用：
  - high-signal failures
  - longest / densest artifacts
  - newest narrative docs
  - 其余按 sourceRef 稳定排序

### 4.14 Manifest

```ts
export interface V8BuildManifest {
  schemaVersion: number;        // 当前 = 1
  pipelineVersion: string;      // e.g. "0.1.0"
  storageFormat: "jsonl";
  createdAt: string;
  updatedAt: string;
  lastFullRebuildAt: string | null;
  narrativeRecordCount: number;
  unitCount: number;
  irItemCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  compiledPackCount: number;
}
```

---

## 5. Background Pipeline

### 5.1 Trigger & Lifecycle

```
orchestrator.run(config: V8PipelineConfig): Promise<V8BuildManifest>
```

一次 tool call（或定时触发）调用 `orchestrator.run`。orchestrator 顺序执行 step 1–5，每步输出直接传给下一步。中间产物顺序写入 `.memory/graph/` 下对应的 JSONL 文件。

若 `emitReviewMarkdown = true`，orchestrator 在每个关键阶段完成后额外刷新 `runtime/review/` 下的 markdown 审阅文件。markdown 审阅文件不阻塞 canonical JSONL 写入；即使 markdown 生成失败，主 build 仍应继续，但必须在 `build_report.md` 中记录该失败。

`incremental` 模式：只处理上次 build 后新增的 narrative records。通过 manifest 中的 `updatedAt` 与 raw 文件的修改时间比较确定增量范围。graph 层做 merge（新 nodes/edges 与已有合并），不做全量重写。

`full` 模式：全量重跑。先清空 `graph/` 目录，再从头写入。

**review markdown emission order**:
1. source-stage 完成后刷新 `source_narrative_review.md`
2. unitization 完成后刷新 `unit_review.md`
3. IR 提取完成后刷新 `ir_review.md`
4. graph / serving views 完成后刷新 `graph_review.md`
5. pack compilation 或 pack assembly 完成后刷新 `pack_review.md`
6. 最后汇总刷新 `pipeline_review.md`

**orchestrator writer calls**:

```ts
if (config.emitReviewMarkdown) {
  const reviewRun = buildReviewRunContext(...)
  const reviewPolicy = buildReviewSamplePolicy(config)

  writeSourceNarrativeReviewMarkdown(...)
  writeUnitReviewMarkdown(...)
  writeIrReviewMarkdown(...)
  writeGraphReviewMarkdown(...)
  writePackReviewMarkdown(...)
  writePipelineReviewMarkdown(...)
}
```

实现约束：
- writer 调用必须放在对应 stage 的 canonical JSONL 写入之后
- writer 输入使用 stage 的稳定输出，不读取未落盘的临时局部变量快照
- writer 失败只记入 report，不使主 build 失败

### 5.2 Step 1: Raw → Narrative

```ts
function normalizeSessionMessages(
  messages: RawSessionMessage[],
  options: NarrativeNormalizationOptions
): V8NarrativeRecord[]

function loadNarrativeRecords(rawDir: string): V8NarrativeRecord[]
```

**实现边界**: `raw -> narrative` 由两个连续子边界组成：

1. **source-stage normalization**
   - 读取 session traces
   - 归一化 conversation records
   - 归一化 operation/tool records
   - 持久化到 `raw/assembled/session_{id}_narrative.md`

2. **compile-stage narrative loading**
   - 从 `raw/assembled/` 目录加载 `*_narrative.md`
   - 每个 markdown 文件加载为一个 `V8NarrativeRecord`
   - 后续 unitization 直接消费这些 narrative docs

当前实现的 canonical compile input 是 assembled narrative markdown 文档，而不是即时内存里的 raw session trace。

**编排边界**:
- `startAt = "source"` 时，orchestrator 会先跑 source-stage normalization，再持久化 assembled markdown
- 随后统一从 `raw/assembled/*_narrative.md` 读取 compile input
- `startAt = "narrative"` 时，直接跳过 source-stage，复用现有 assembled markdown
- 所以 compile boundary 落在 `assembled markdown docs`，不是 raw transcript objects

**source-stage 输入**:
- OpenClaw session JSONL messages
- tool call / tool result fragments
- source sync cursor（增量模式）

**source-stage 处理**:
1. 解析原始消息并识别 role / speaker / timestamp
2. 从 assistant 消息中抽取 `toolCall`
3. 从 `toolResult` 消息中抽取 operation result
4. 对 conversation text 做结构性清洗
5. 对 operation/tool records 按 cleaning profile 组装 narrative records
6. 将所有 narrative records 以 append-only 方式持久化到 `raw/assembled/*.md`
7. compile 阶段再通过 `loadNarrativeRecords(rawDir)` 把每个 `*_narrative.md` 加载成一个 `V8NarrativeRecord`

**source-stage 代码边界**:
- session message normalization:
  - [narrative-normalizer.ts](d:/E/memory_sys_design/memory-enhanced/src/v8/architecture/narrative-normalizer.ts)
- assembled narrative loading:
  - [narrative-source.ts](d:/E/memory_sys_design/memory-enhanced/src/v8/architecture/narrative-source.ts)
- build orchestration:
  - [compiler_clean_slate.ts](d:/E/memory_sys_design/memory-enhanced/src/v8/compiler_clean_slate.ts)

**实现约束**:
- narrative normalization 是 **source-aware assembly**，不是单纯 strip text
- tool/operation records 会被重建为 narrative records，而不是简单丢弃或平铺成普通 assistant text
- compile 阶段默认从 `assembled narrative markdown` 读取，而不是再次重放 raw traces
- narrative doc 的排序由 `timelineStart` 和 `sourceRef` 决定，因此 compile 时是“按 narrative docs”而不是“按原始 message 数组”推进

### 5.2.1 Session Message Normalization

source-stage normalizer 是 source-aware normalizer，不是普通 transcript cleaner：

1. 遍历 raw session messages
2. 识别普通 conversation message、assistant tool call、tool result
3. conversation message 直接转成 `session_trace` narrative record
4. tool call / tool result 先进入临时收集结构，再合成为 operation-style narrative record
5. 所有 text 字段经过 `cleanTextWithMap(...)`
6. 结果写成 conversation records + operation records

**合成路径**:
- assistant `toolCall` 会先进 `toolCallMap`
- `toolResult` 会先进 `pendingResults`
- 最后用 `buildOperationNarrativeRecordsFromCollected(...)` 合成 operation narratives

`raw -> narrative` 的实现重点：
- 先识别 source kind
- 再决定 record synthesis path
- 最后才做 text cleaning 和 markdown assembly

### 5.2.2 Cleaning And Preservation Rules

cleaning contract 是带 provenance 的 deterministic cleaning：

- 通过 `cleanTextWithMap(...)` 生成：
  - `cleanText`
  - `cleanMap`
- `cleanMap` 记录 raw offset 到 clean offset 的映射
- 被 strip 的内容不进入 canonical narrative text，但其删除范围仍可回查

当前 deterministic clean patterns 至少包括：
- injected memory blocks
- task ledger blocks
- transport metadata blocks
- `Current time: ...`
- 其他已知 wrapper / scaffold text

实现要求：
- 保留 visible user text
- 保留 visible assistant text
- 保留 high-signal tool result content
- wrapper text 必须被剥离，而不是与正文混流
- operation narrative 需要依赖 tool cleaning profiles 提取高信号内容，而不是盲目拼接全部 payload

### 5.2.3 Assembled Narrative Persistence

source-stage 输出是 session-level assembled markdown docs，而不是零散 narrative record JSON。

当前 compile 代码依赖这个边界：
- assembled narratives 落盘到 `raw/assembled/`
- `loadNarrativeRecords(...)` 只读取 `*_narrative.md`
- 每个 narrative markdown 文件会被包装成一个 `V8NarrativeRecord`
- `metadata.timelineStart` 用于后续排序和并行切分

**持久化约束**:
- source-stage append-only 持久化 assembled markdown
- compile-stage 能独立从 markdown docs 重启
- unitizer 不依赖 source-stage 的瞬时内存对象

**Normalization 必须保留的信息**:
- source path / source id
- session id, turn id, message id
- speaker
- timestamp
- char offsets (cleanMap)
- original raw text (rawText 字段)

**当前清洗 contract**:

| 清洗对象 | 处理方式 |
|---|---|
| prompt scaffolding | strip，记录到 cleanMap |
| tool call JSON wrapper | strip |
| tool result wrapper | strip wrapper, 保留 result content |
| 注入的 memory block | strip（这是上一轮 V8 自己注入的） |
| task ledger / approval / retry | strip |
| 原始 user text | 保留 |
| assistant 正文输出 | 保留 |
| tool result 正文 | 保留，超长做受控裁剪但保留回指 |
| code blocks | 保留 |
| operation details | 按 tool cleaning profile 提取高信号内容 |

**Deterministic strip targets**:

- `<!-- Memory Context (Live) --> ... <!-- End Memory Context -->`
- `<!-- Memory Recall ... -->`
- `<memory-context> ... </memory-context>`
- `<task-ledger> ... </task-ledger>`
- `<!-- Task Ledger ... -->`
- `Conversation info (untrusted metadata): ...`
- `Current time: ...`

V8 recall / memory injection templates must not introduce heartbeat text.

**Raw input precedence**:

1. runtime observation / transcript content
2. visible assistant text
3. visible tool result text
4. wrapper / scaffold / control text

清洗时只剥离第 4 类；前 1-3 类默认保留。

### 5.3 Step 2: Narrative → Compatibility Units

```ts
function unitizeNarrativeRecords(
  records: V8NarrativeRecord[],
  config?: UnitizerConfig
): V8Unit[]

function unitizeNarrativeRecordsParallel(
  records: V8NarrativeRecord[],
  config?: UnitizerConfig,
  workerCount?: number
): Promise<V8Unit[]>
```

**输入**: V8NarrativeRecord[]

**架构定位**:
- 这一步不是 canonical evidence 生成边界，而是可选 compatibility shell。
- `narrative` 仍是 source of truth；真正的 evidence spans 在 Step 3 的 IR extraction 阶段产生。
- unitizer 的职责是为 legacy review、cache key、debug view 和过渡期 API 提供稳定切片。

**实现边界**:
- unitizer 消费的是 compile-stage 加载出来的 narrative docs
- 每个 doc 对应一个 narrative markdown 文件
- `workerCount > 1` 时，按 narrative docs 分片并行，而不是把单篇 narrative 内部分给多个 worker

**实现 contract**: unitizer 是一个 **turn-aware + discourse-aware + source-category-aware + time-gap-aware** 的多阶段 compatibility segmenter。

**实现入口**:
- 主入口：
  - [unitizer.ts](d:/E/memory_sys_design/memory-enhanced/src/v8/architecture/unitizer.ts)
- 并行入口：
  - `unitizeNarrativeRecordsParallel(...)`
- worker：
  - [unitizer-worker.ts](d:/E/memory_sys_design/memory-enhanced/src/v8/architecture/unitizer-worker.ts)

**算法顺序**:
1. 对每条 narrative record 先按行切分并保留 offsets
2. 从 markdown 头部重建 `turn spans`
3. 在每个 turn 内构造 discourse blocks
4. 基于 discourse blocks 构造 `micro descriptors`
5. 基于 turn spans + micro descriptors 构造 `meso descriptors`
6. 基于 meso descriptors 构造 `macro descriptors`
7. 最后 materialize 为 `V8Unit[]`

### 5.3.0 Parallelization Boundary

当前并行边界：
- orchestrator 先通过 `loadNarrativeRecords(...)` 拿到 narrative docs
- `unitizeNarrativeRecordsParallel(...)` 把 docs 分 shard
- 每个 worker 独立 unitize 自己那批 narrative docs
- 汇总后得到最终 `V8Unit[]`

实现要求：
- 并行单元是 narrative doc，不是 text chunk
- unit ids 必须在单 doc 内稳定生成
- worker 失败时要能回退到单线程 unitization，而不是让 build 直接失去 narrative->unit 输出

### 5.3.1 Turn Reconstruction

unitizer 首先识别 narrative markdown 中的 turn header，例如：

- `### [#12 | 2026-03-11 04:30] user`
- `### [op-3 | 2026-03-11 04:34] assistant (tool)`
- `### user (2026-03-11 04:30)`

每个 turn span 至少携带：
- `ordinal`
- `speaker`
- `timestamp`
- `sourceCategory`

其中 `sourceCategory` 当前至少区分：
- `conversation`
- `operation`
- `unknown`

这一步把后续 unitization 固定为带 turn 语义的结构切分。

### 5.3.2 Micro Construction

`micro` 构造不是固定窗口切分。当前实现会：

1. 先从 turn 内构造 discourse blocks，block 至少区分：
   - `paragraph`
   - `list`
   - `code`
   - `label`
   - `quote`
2. 再把 block 拆成 atomic pieces
3. 再用 lexical similarity、block kind、sourceCategory、长度上限做 merge/smoothing

当前默认配置：
- `microMaxChars = 420`
- `operation` 类 turn 的 micro 上限可放宽到 `microMaxChars * 2`

**micro 构造特征**:
- code block 不按普通句子切
- list block 会按 item 结构切
- 很短的碎片会在 post-pass smoothing 中并回邻接 micro
- operation 类 turn 会优先保持更高密度片段，而不是过度切碎
- `turn` 本身足够短时会直接成为一个 micro，而不是强制继续切

### 5.3.3 Meso Construction

`meso` 基于 `turn spans + micro descriptors` 做局部结构聚合，不是按段落累计。

当前默认配置：
- `mesoMaxChars = 3200`
- `mesoMinSentences = 2`
- `mesoMaxSentences = 8`

当前 meso 断开条件包括：
- 新 user episode 开始
- hard overflow / exceeds meso limit
- turn count limit
- time boundary（大时间间隔）

**meso 聚合细节**:
- `minStableMesoChars = max(1100, floor(mesoMaxChars * 0.34))`
- 只有在当前 meso 已经足够稳定时，新一轮 user episode 或 time gap 才会强制切断
- `operation` 类 turn 的 turn-count limit 更宽（当前代码是 `10`，普通 conversation 是 `12`）
- flush 后还会经过 `smoothMesoDescriptors(...)`，把过短 meso 向前或向后并回

该实现显式利用：
- turn 边界
- speaker 变化
- interaction episode
- timestamp gap

这一定义应作为编码基线，不要回退成单纯的段落/heading/code block 切分。

### 5.3.4 Macro Construction

`macro` 基于 meso descriptors 做更高层 grouping，不是主题词或大时间跳跃的单一规则切分。

当前默认配置：
- `macroTargetMesoUnits = 4`
- `macroMaxMesoUnits = 8`
- `macroTargetChars = 12000`
- `macroMaxChars = 28000`

**macro flush 条件**:
- `nextChars > macroMaxChars`
- 已达到 target chars，且：
  - 已有足够 meso 数量
  - 或下一个 meso 以 macro-shift cue 开头
  - 或遇到大时间间隔

该实现同时利用：
- meso-count aware
- target-chars aware
- cue-aware
- time-gap-aware

flush 之后还会经过 `smoothMacroDescriptors(...)`：
- 过短 macro 会尝试并回相邻 macro
- 合并上限不是严格 `macroMaxChars`，而是 `softMaxChars = floor(macroMaxChars * 1.35)`

### 5.3.5 Materialization

descriptor 构造完成后，unitizer 才 materialize 出真正的 `V8Unit[]`：
- 先 materialize macro units
- 再 materialize meso units，并挂 parent macro
- 最后 materialize micro units，并挂 parent meso

当前 `unit` 不是“边切边写”的流式对象，而是 descriptor pass 完成后的稳定产物。

### 5.3.6 Implementation Constraints

后续修改 `raw -> unit` 代码时，优先级应为：

1. 先尊重 narrative markdown 这个 compile boundary
2. 再尊重 turn-aware / discourse-aware / source-aware 的 unitizer 结构
3. 不要把 unitizer 退化回纯长度切分器
4. 不要把 source-stage normalizer 退化回普通 transcript cleaner

能直接复用当前代码的部分应直接复用：
- `normalizeSessionMessages(...)`
- `loadNarrativeRecords(...)`
- `unitizeNarrativeRecords(...)`
- `unitizeNarrativeRecordsParallel(...)`

### 5.4 Step 3: Narrative / Compatibility Shell → IR + Evidence Spans

```ts
function extractIR(
  units: V8Unit[],
  narrativeRecords: V8NarrativeRecord[],
  config: V8PipelineConfig
): { items: V8MemoryIRItem[]; spans: V8EvidenceSpan[] }
```

**输入**: V8Unit[]（可选 compatibility shell） + 对应的 V8NarrativeRecord[]（canonical evidence source）

**处理**:

1. **LLM 提取**（primary）:
   - canonical 上按 narrative-aligned spans / windows 提交给 LLM；当前实现可以继续借用 unit batching，但那只是兼容性执行形状
   - prompt 中包含 bounded vocabulary tables（架构 §9）作为约束
   - micro compatibility units: 用 micro-scope 的 node types + edge predicates
   - meso compatibility units: 用 meso-scope 的 node types + edge predicates
   - macro compatibility units: 用 macro-scope 的 node types + edge predicates
   - LLM 返回 JSON 格式的 IR items

**LLM batching contract**:
- 默认 batch 单位是 `unit`
- 默认 batch size:
  - micro: 8 units
  - meso: 4 units
  - macro: 2 units
- 默认并发：`min(4, workerCount || 1)`
- timeout: 每个 batch 使用 `irLlmTimeout`
- retry:
  - 最多 2 次
  - 第 1 次失败后原 batch 原样重试
  - 第 2 次失败后将 batch 二分为更小 batch 再试
- partial failure:
  - 单 batch 最终失败时不终止整轮 build
  - 失败信息写入 `build_report.md` 与 `ir_review.md`
  - 对应 units 本轮不产出 IR items，等待后续重跑

2. **后置过滤**（rules, lightweight）:
   - 数量 guardrail: 如果一个 micro unit 返回 > `irMaxItemsPerUnit` 个 items，截断到最高 confidence 的 N 个
   - 强行抽取筛除: 如果 unit text 很短（< 20 chars）但 LLM 仍然产出了多个 items，检查 confidence；低于 `irMinConfidence` 的丢弃
   - 格式校验: subject/predicate/object 非空，nodeType 在 bounded vocabulary 内

3. **Evidence span 产生**:
   - evidence span 在 IR extraction 阶段直接生成，不从 unit 预继承
   - `evidenceSpan.narrativeRecordId` 来自被抽取的 narrative record
   - `evidenceSpan.charStart` / `charEnd` 指向 canonical narrative offsets
   - 如果当前 batch 借用了 compatibility unit，则可附带 `compatibilityUnitId`
   - 如果 LLM 返回了更精确的 sub-span offset（指向当前 narrative window 内部更窄的位置），使用更窄的 span

4. **Summary 产生**:
   - 当 meso/macro unit 的 text 长度 > `packCompileThresholdChars` 时
   - 生成一个 summary IR item（nodeType = "discourse_unit", predicate = "summarizes"）
   - 该 summary 的 label 用于后续 trigger vocabulary，使长 unit 能被语义匹配

   summary IR item 统一写成：
   - `nodeType = "discourse_unit"`
   - `subject = compatibility unit id 或 narrative window fingerprint`
   - `predicate = "summarizes"`
   - `object = summary_text`
   - `label = summary_text`
   - `evidenceSpans = [primary span of source unit]`

**输出**:
- `memory_items.jsonl`

`V8EvidenceSpan` 作为 `V8MemoryIRItem` 的内嵌属性写入 `memory_items.jsonl`。graph、review markdown 和运行时 backtrace 如需 span 信息，应从 source IR items 解析，不再单独维护 `evidence_spans.jsonl`。如果下游仍需要 unit 维度追踪，应通过 `compatibilityUnitId(s)` 读取，而不是把 unit 写回 canonical source contract。

**LLM prompt contract**:

当前抽取契约已经从 `subject / predicate / object / item_type / qualifiers`
收成更轻的前台字段：

```md
### Completed Item
point_a:
relation:
relation_family:
point_b:
origin_type:
evidence_start_turn:
evidence_end_turn:
evidence_start_anchor:
evidence_end_anchor:

### Pending Item
tension_role:
point_a:
relation:
relation_family:
point_b:
evidence_start_turn:
evidence_end_turn:
evidence_start_anchor:
evidence_end_anchor:
status: pending
```

说明：
- `Types` 只作为 `point_a / point_b` 的解释边界，不再要求模型输出 `item_type`
- `qualifiers` 不再属于 LLM 产出契约
- 是否需要门控、价值判断或下游限定信息，由消费层决定，不由抽取阶段先验裁剪

### 5.5 Step 4: IR → Graph + Serving Views

```ts
function materializeGraph(
  irItems: V8MemoryIRItem[],
  existingNodes?: V8GraphNode[],     // incremental mode
  existingEdges?: V8GraphEdge[],     // incremental mode
  config: V8PipelineConfig
): {
  nodes: V8GraphNode[];
  edges: V8GraphEdge[];
  triggerLexicon: V8TriggerLexicon;
  dayIndex: V8DayIndex;
  sourceIndex: V8SourceIndex;
  nodeSummaryMap: V8NodeSummaryMap;
}
```

**输入**: V8MemoryIRItem[] (+ incremental 模式下已有的 nodes/edges)

**处理分为四个子步骤，但在同一个函数内顺序执行**:

#### 4a. Normalization / Consolidation → Nodes

1. 按 `(nodeType, label)` 分组 IR items
2. 同一 label 的不同 alias 做 merge（canonical label 选最频繁的，其余入 aliases）
3. 合并 source IR items；evidence spans 继续留在 source IR items 内嵌持久化
4. 计算 state:
   - scope: 如果所有 source units 来自同一 session → "session"，跨 session → "topic" 或 "global"
   - validity: 默认 "active"；如果有 supersedes/state_supersedes_state edge 指向它 → "superseded"
   - confidence: 所有 source IR items 的 max confidence
   - supportCount: source IR items 数量
5. **Dedup**: 如果 incremental 模式下已有同 label + nodeType 的 node，merge 而非新建
6. **Reject**: supportCount == 1 且 confidence < 0.4 的 node 不写入 graph（弱支撑噪声）

**incremental node merge contract**:
- `aliases`: normalized union
- `sourceIRItemIds`: stable union
- `supportCount`: 累加新增独立 IR items 数量
- `confidence`: 取 `max(existing, incomingMax)`
- `state.scope`: 取覆盖范围更宽者（`session < topic < global`）
- `state.validity`: 若任一输入明确为 `superseded`，保留 `superseded`；否则优先保留现有非默认值

#### 4b. Consolidation → Edges

1. 从 IR items 中提取关系:
   - 每个 IR item 的 (subject → predicate → object) 映射到 (src node → edge type → dst node)
   - src/dst 通过 label → nodeId 查找
2. 相同 (src, type, dst) 的 edges 合并为一条
3. Qualifiers 合并（取最具体的值）
4. 为每条 edge 标注 `forwardDimension` / `reverseDimension`
4. **Dedup**: incremental 模式下与已有 edges 合并

**incremental edge merge contract**:
- `(src, type, dst)` 相同即视为同一 edge
- `sourceIRItemIds`: stable union
- `qualifiers`: 非空字段优先；冲突时保留更具体值；无法判断具体性时保留现有值并记录 warning
- `confidence`: 取 `max(existing, incomingMax)`
- `forwardDimension` / `reverseDimension`: 由 `edge type + traversal direction` 决定；同 type 必须稳定
- `state.scope`: 取覆盖范围更宽者
- `state.validity`: 采用与 node 相同的 validity merge 规则

**default dimension mapping**:

| Edge family | forwardDimension | reverseDimension |
|---|---|---|
| micro/meso/macro 同层 semantic edges | `H` | `H` |
| containment / child -> parent | `V_up` | `V_down` |
| abstraction / source -> summary | `V_up` | `V_down` |
| `state_supersedes_state` | `T_forward` | `T_backward` |
| `state_refines_state` | `T_forward` | `T_backward` |
| `state_changed_by_event` | `T_forward` | `T_backward` |
| `state_opened_by_block` / `state_closed_by_block` | `T_forward` | `T_backward` |
| `state_invalidated_under_regime` / `state_reactivated_under_regime` | `T_forward` | `T_backward` |
| `correction_propagates_to_line` | `T_forward` | `T_backward` |
| `local_*_in_*line` / `local_event_in_thread` / `local_shift_to_turning_point` | `O_up` | `O_down` |
| scope anchor edges | `gate` | `gate` |
| evidence anchor edges | `none` | `none` |

#### 4c. Trigger Vocabulary 生成

从所有 graph nodes 生成倒排索引:

```ts
for each node:
  // canonical label → term
  addTriggerTerm(node.canonicalLabel, node.id, 1.0, "canonical")
  // aliases → terms
  for (alias of node.aliases):
    addTriggerTerm(alias, node.id, 0.8, "alias")
  // tokenize label/aliases → keyword terms
  for (token of tokenize(node.canonicalLabel + " " + node.aliases.join(" "))):
    if (token.length >= triggerTokenMinCharsCjk for CJK, >= triggerTokenMinCharsEn for EN):
      addTriggerTerm(token, node.id, 0.5, "keyword")
  // meso/macro nodes: summary keywords
  if (node.scale !== "micro" && nodeSummaryMap[node.id]):
    for (token of tokenize(nodeSummaryMap[node.id])):
      addTriggerTerm(token, node.id, 0.3, "summary")
```

Tokenize 规则:
- English: split on whitespace/punctuation, lowercase, filter stopwords, min 3 chars
- CJK: bigram + trigram sliding window

Canonical label normalization:
- trim
- collapse internal whitespace
- lowercase ASCII letters
- preserve CJK and path punctuation
- normalize path separators to `/`

Alias merge rule:
- same normalized label => same alias bucket
- if one label is strict substring of another and both share same nodeType, shorter one stays alias unless supportCount is strictly higher

#### 4d. Index 生成

**Day index**: 从每个 node 的 source IR items → units → narrative records → timestamp 提取 dayKey。一个 node 可出现在多天。

**Source index**: 从每个 node 的 source IR items → narrativeRecordId → sourceRef。

**Node summary map**: 只给 meso/macro nodes 生成。取该 node 所有 source units 中最长的 meso/macro unit 的前 200 chars 作为 summary。如果 IR 提取阶段产出了 summary IR item，优先用其 label。

**输出**: 写入 `graph_nodes.jsonl`, `graph_edges.jsonl`, `serving/trigger_lexicon.json`, `serving/day_index.json`, `serving/source_index.json`, `serving/node_summary_map.json`。

### 5.6 Step 5: Graph → Pre-compiled Packs

```ts
function compilePacks(
  nodes: V8GraphNode[],
  edges: V8GraphEdge[],
  units: V8Unit[],
  irItems: V8MemoryIRItem[],
  config: V8PipelineConfig
): V8PreCompiledPack[]
```

**输入**: graph + units + IR items

**处理**:

1. 找出所有 meso/macro units 的 text 长度 > `packCompileThresholdChars` 的 unit neighborhoods
2. 对每个这样的 neighborhood:
   a. 收集该 unit 及其子 units 的所有 IR items
   b. 收集相关 graph nodes 的 summary 信息
   c. 将 IR items + summaries 发送给 LLM，生成一段 L0-agnostic summary
   d. 计算 fingerprint = sha256(sorted unit ids + unit text hashes)
   e. 如果已有相同 fingerprint 的 cached pack → 跳过

3. **LLM compiled-pack prompt contract**:

```
将以下记忆片段总结为一段紧凑的背景概述。
保留关键事实、决策和状态变化。去掉重复和冗余。
不要添加推断。保留可追溯的细节。

记忆片段:
---
{ir_items_formatted}
---
```

4. **Compiled variant selection**:
- `summary` variant:
  - 用于稳定背景、长距离脉络、主题摘要
  - 按事实、决策、背景组织
- `state` variant:
  - 用于状态、变化、分支控制相关 neighborhood
  - 按当前状态、状态变化、约束、未决项组织

5. **State-oriented compiled prompt contract**:

```
将以下记忆片段整理为面向状态与分支控制的紧凑表达。
优先保留：
- 当前有效状态
- 已发生的状态变化
- 约束、冲突、未决项
- 与后续行动直接相关的条件

不要添加推断。不要改写事实方向。保留可追溯细节。

记忆片段:
---
{ir_items_formatted}
---
```

**输出**: 写入 `packs/compiled_packs.jsonl`。同一组 source units 可同时存在 `summary` 和 `state` 两种 compiled variant；运行时按当前 bundle / control context 选用。

---

## 6. Foreground Recall

### 6.1 Scan Window Lifecycle

前台 recall 嵌入在 LLM 生成过程中。scanner 作为一个 stateful 组件，持有 `V8ScannerState`。

```
生成开始
  ↓
[pre-excitation pass] baseGain = baseGainInitial
  ↓
[生成循环]
  每输出 scanIntervalChars 个字符 OR 命中 scanBoundaryPatterns:
    → 执行一次 recall round (§6.2–§6.6)
  ↓
生成结束
  ↓
清除 scanner state
```

**Pre-excitation pass**: 生成开始前执行一次特殊 ignition。此时没有生成文本，只有 user prompt + L0 control anchors。`baseGain = baseGainInitial`（更高增益）。目的：预热 graph 激活状态，确保任务开始时关键记忆已被点亮。

`scanBoundaryPatterns` 的默认值以 `V8PipelineConfig` 为准。

### 6.2 Ignition

```ts
function ignite(
  signals: V8ActiveTextSignal[],
  controlAnchors: V8L0ControlAnchors,
  triggerLexicon: V8TriggerLexicon,
  dayIndex: V8DayIndex,
  nodeSummaryMap: V8NodeSummaryMap,
  scannerState: V8ScannerState,
  config: V8PipelineConfig
): Map<string, number>  // nodeId → u_i
```

**输入**: 当前 scan window 内的 text signals + L0 + serving views

**处理**:

1. **Tokenize** 当前 signals 的 text
2. **Trigger matching**: 在 trigger lexicon 中查找命中的 terms，得到 provisional node hits
3. **Anchor extraction**:
   - 从 provisional node hits、scene overlap、control overlap 中找出当前最可能的 anchor neighborhood
   - anchor 可以是 entity / method / decision line / relationship line / topic-state / state-overlay object
4. **Aspect / state-slot detection**:
   - 在已命中的 anchor neighborhood 内，检测当前 query/scene 正在追问哪个可变方面
   - aspect 可以来自：
     - 当前 control anchors
     - 已激活 state-overlay nodes
     - 已激活的 constraint / decision / validity 关系
5. **State competition / validity mismatch detection**:
   - 检查同一 `anchor + aspect` 下是否同时出现多个互斥状态候选
   - 检查当前 regime / scope / validity 是否与已激活状态不一致
   - 仅当存在 state competition、validity mismatch 或明确状态追问时，进入状态几何主路径

**default anchor extraction algorithm**:

```ts
function extractAnchorCandidates(
  provisionalHits: Map<string, number>,
  controlAnchors: V8L0ControlAnchors,
  nodeSummaryMap: V8NodeSummaryMap
): V8AnchorCandidate[] {
  for each hit node:
    lexical = normalizedTriggerWeight(node)
    scene = sceneOverlap(node, signals, nodeSummaryMap)
    control = controlOverlap(node, controlAnchors)
    structural = isAnchorLikeNode(node) ? 0.15 : 0

    anchorScore = 0.40 * lexical
                + 0.30 * scene
                + 0.20 * control
                + 0.10 * structural

  keep top 5 candidates
  return candidates sorted by anchorScore desc
}
```

`isAnchorLikeNode(node)` 默认对下列 node type 返回真：
- `entity`
- `concept`
- `method`
- `goal`
- `decision`
- `constraint`
- `topic_state`
- 各类 `state-overlay` nodes

**dominant anchor selection**:
- 若 top1 比 top2 高至少 `0.15`，直接选 top1
- 否则保留 top2 共同形成一个 small anchor neighborhood
- 若 top candidates 全部低于 `0.25`，本轮不进入状态几何主路径

**default aspect / state-slot detection algorithm**:

```ts
function detectStateSlot(
  anchorNodeId: string,
  activeNodes: string[],
  activeEdges: V8GraphEdge[],
  controlAnchors: V8L0ControlAnchors
): { aspectKey: string | null; regimeHint: string | null } {
  candidateAspectKeys =
    collect from:
      edge.qualifiers.aspect
      connected state-overlay node labels
      connected constraint / decision / validity relations
      short phrases inside controlAnchors.activeTask / latestUserRequest

  score each aspectKey by:
    qualifier frequency
    connected state-node count
    overlap with control text
    overlap with currently active neighboring blocks

  return top aspectKey if score >= 0.35 else null
}
```

默认优先读取 aspect 的位置：
1. `edge.qualifiers.aspect`
2. state-overlay node 的 canonical label
3. constraint / decision / validity relation 的 object / label
4. control text 中与 anchor 紧邻的短语

**default state competition detection**:
- 在同一 `anchor + aspectKey` 下收集 state candidates
- 若同时存在：
  - 不同 canonical label 的 state nodes
  - 或 mutually exclusive validity states
  - 或不同 regime/phase 下的 conflicting active states
  则标记为 `state competition`

**default validity mismatch detection**:
- 当前 regimeHint / phaseHint / topicHint 与 state path 上的 scope/validity edges 不一致
- 或工具结果 / 当前 scene 明显否定了当前 active state
- 任一命中即标记 `validityMismatch = true`

6. 对每个命中的 node 计算注入分数:

```
u_i = baseGain * (a * g_lex + b * max(g_scene, g_ctrl) + c * g_time)
     + g_anchor + g_state_inquiry
```

其中:
- `g_lex` = sum of matched trigger weights for this node (capped at 1.0)
- `g_scene` = weighted Jaccard overlap between current signal tokens and node summary tokens
- `g_ctrl` = weighted Jaccard overlap between L0 text tokens and node label/alias tokens
- `g_time` = temporal / locality gating score:
  - 如果 node 在 dayIndex 中有当前 dayKey → 1.0
  - 如果有近期 dayKey (±3 days) → 0.5
  - 否则 → 0.1（全局可用的稳定节点保底）
- `g_anchor` = node 是否处在 dominant anchor neighborhood 内的附加增益
  - 与当前 anchor 强绑定的 node 获得更高注入
  - 默认取值范围 `0.0 ~ 0.35`
- `g_state_inquiry` = dominant anchor + active aspect 对状态线邻域的附加注入
  - 仅当检测到 state competition、validity mismatch 或明确状态追问时才激活
  - 默认取值范围 `0.0 ~ 0.45`

7. **Episodic gating** (架构 §6.4):
   - 稳定事实/可复用方法相关 nodes: 默认保持较高全局可用性
   - 带明确 day/episode binding 的 nodes: 只有局部时间线索或 dayKey overlap 时才 eligible
   - episodic binding 与 stable availability 的判定策略当前不在本 spec 中写死，具体 heuristic 留给实现层

8. 返回 nodeId → u_i map（只包含 u_i > 0 的节点）

geometry 访问不改写 `node/edge` ontology。Ignition 只负责确定 dominant anchor 与 active aspect；时间/结构/oblique 几何统一交给 propagation 处理。

**ignition contract**:
- lexical hit 只负责打开候选入口
- dominant anchor 决定 recall 从哪个局部对象或状态对象开始展开
- aspect detection 决定当前追问的是哪个可变槽位
- 最终是否形成可交付 recall，仍取决于 propagation 后的 local consistency 和 supporting-unit convergence

`weighted Jaccard` 实现:

```
score(A, B) = sum(min(wA[t], wB[t])) / sum(max(wA[t], wB[t]))
```

权重来源:
- canonical hit = 1.0
- alias hit = 0.8
- keyword hit = 0.5
- summary keyword hit = 0.3

### 6.3 Propagation

```ts
function propagate(
  ignitionScores: Map<string, number>,
  edges: V8GraphEdge[],
  scannerState: V8ScannerState,
  config: V8PipelineConfig
): void  // mutates scannerState.nodeEnergies
```

**输入**: 本轮 ignition scores + graph edges + scanner state

**处理**:

```
// Step 1: 衰减上轮残余
for each nodeId in scannerState.nodeEnergies:
  Energy_i = decayLambda * Energy_i

// Step 2: 叠加本轮注入
for each (nodeId, u_i) in ignitionScores:
  Energy_i = Energy_i + u_i

// Step 3: 正向传播 (一次)
for each node with Energy > stopThreshold:
  取 top-K 条 outgoing edges (by edge.confidence * SynapseWeight)
  for each target:
    ΔE = Energy_source × SynapseWeight(edge, "forward") × forwardGain
        × (1 / degree_target^hubPenaltyPower) × CooldownFactor
    Energy_target += ΔE
    push edge.forwardDimension into scannerState.recentTrajectory

// Step 4: 反向传播 (一次, 较弱)
for each node with Energy > stopThreshold:
  取 top-K 条 incoming edges
  for each source:
    ΔE = Energy_target × SynapseWeight(edge, "reverse") × reverseGain
        × (1 / degree_source^hubPenaltyPower) × CooldownFactor
    Energy_source += ΔE
    push edge.reverseDimension into scannerState.recentTrajectory

// Step 5: 清零低于阈值的
for each nodeId in scannerState.nodeEnergies:
  if Energy_i < stopThreshold:
    delete scannerState.nodeEnergies[nodeId]
```

**SynapseWeight**:

`base_confidence(edge) × dimensionWeight × familyWeight × scopeGate × trajectoryAffinity`

**geometry propagation contract**:
- temporal / oblique geometry 通过 `forwardDimension` / `reverseDimension` 进入传播
- `H / V / T / O / gate` 是统一传播维度，不是附加 ontology object
- `scope anchor` 不传播能量，只做 through-pass 判断
- `evidence anchor` 不参与传播，只做 backtrace

**three-axis + oblique path contract**:
- `H`: 同层语义传播
- `V_up / V_down`: 跨层抽象与具化
- `T_forward / T_backward`: 状态演化与时间回溯
- `O_up / O_down`: 穿过 `H / V / T` 的 oblique path，不单列为第四个轴
- `gate`: scope/validity 判断

**anchor-centered propagation rule**:
- propagation 先在 dominant anchor neighborhood 内展开，而不是先做全局时间词扩散
- 若某条路径不再属于当前 anchor neighborhood，默认降权

**state-line traversal rule**:
- 当 dominant anchor + aspect 已成立时，优先沿 `T_forward / T_backward` 维度展开
- `state_supersedes_state`、`state_refines_state`、`state_changed_by_event`、`state_opened_by_block`、`state_closed_by_block` 构成默认 state-line 主路径
- `T_forward` 偏向找到当前有效状态；`T_backward` 保留直接前驱与历史解释路径

**scope/validity gating rule**:
- `state_valid_in_phase`、`state_valid_in_timewindow`、`block_scoped_to_regime`、`block_scoped_to_topicstate` 全部按 `gate` 处理
- `gate` 先做 through-pass 判断，再给出降权系数
- 当前不在 scope 内的路径默认不屏蔽，按 `scopeGateFloor` 降权

**oblique path rule**:
- `local_*_in_*line`、`local_event_in_thread`、`local_shift_to_turning_point` 默认走 `O_up / O_down`
- oblique path 不作为首跳主路径
- 仅当 anchor neighborhood 已经稳定，且当前 line 对 active aspect 有解释价值时，才放大 oblique expansion

**trajectory affinity rule**:
- 传播维度切换有方向偏好；奖励有意义的维度切换，惩罚单维度过深
- 默认 bonus:
  - `H -> T_*` = `1.3`
  - `V_up -> O_up` = `1.3`
  - `O_down -> H` = `1.2`
  - `T_forward -> gate` = `1.2`
  - `H -> V_up` = `1.1`
- 默认 penalty:
  - `H -> H -> H` = `0.7`
  - `V_up -> V_up -> V_up` = `0.4`
  - `T_* -> T_* -> T_*` = `0.6`

**retrospective reconstruction trigger**:
- 若已检测到 state inquiry，但当前 graph 中找不到可遍历的 state line：
  - 不继续盲目 semantic expansion
  - 标记该 anchor + aspect 为 retrospective reconstruction candidate
  - 后续交给 search escalation 或 archive retrieval 做 anchor-centered historical reconstruction

**default state-line traversal policy**:
- 从 dominant anchor 开始，只保留同一 `anchor + aspectKey` 下的状态链
- traversal 顺序：
  1. 当前最匹配 active state
  2. `state_supersedes_state` 的前驱与后继
  3. `state_changed_by_event` 对应的 event / block
  4. `state_invalidated_under_regime` / `state_reactivated_under_regime`
- stop 条件：
  - 已找到一个当前状态 + 一个直接前驱状态
- 或累计命中的 supporting evidence slices 已达到 `maxInjectedBundles * 3`
  - 或继续扩展只会离开当前 anchor neighborhood

**CooldownFactor**: 如果 node 在 nodeCooldowns 中且距离上次激活 < nodeCooldownMs → 0.3，否则 → 1.0。

**default familyWeight**:

- `H` 维内:
  - causality / local transformation: `1.3`
  - local dynamics / long-range evolution: `1.2`
  - participation: `1.0`
  - ontology: `0.7`
  - discourse / block organization: `0.5 ~ 0.6`
  - long-range interaction: `1.1`
- `T` 维内:
  - `state_supersedes_state`: `1.0`
  - `state_changed_by_event`: `1.2`
  - `state_invalidated_under_regime` / `state_reactivated_under_regime`: `1.1`
  - `correction_propagates_to_line`: `1.3`
- `gate`: 不进入 familyWeight，直接走 `scopeGate`
- `none`: `0.0`
### 6.4 Bundle Resolution Onto Supporting Evidence

```ts
function resolveBundles(
  scannerState: V8ScannerState,
  irItems: V8MemoryIRItem[],
  units: V8Unit[],
  nodeSummaryMap: V8NodeSummaryMap,
  controlAnchors: V8L0ControlAnchors,
  config: V8PipelineConfig
): V8Bundle[]
```

**输入**: propagation 后的 scanner state (nodeEnergies) + IR items + optional compatibility units

**处理**:

1. **Activated IR Neighborhood → Supporting Evidence 解析**:
   ```
   构建 nodeId → IR item ids 的映射 (从 graph nodes 的 sourceIRItemIds)
   构建 IR item id → evidence spans 的映射 (从 IR items 的 evidenceSpans)
   构建 evidence span → compatibility unit ids 的可选映射

   for each (nodeId, energy) in scannerState.nodeEnergies:
     for each irItemId in nodeToIR[nodeId]:
       for each evidenceSpan in irToEvidenceSpans[irItemId]:
         bundleKey = resolveNarrativeBundleKey(evidenceSpan)
         evidenceSupportScores[bundleKey] += energy
         bundleEvidenceSpans[bundleKey].add(evidenceSpan.id)
         bundleSupportingNodes[bundleKey].add(nodeId)
         if evidenceSpan.compatibilityUnitId:
           bundleCompatibilityUnits[bundleKey].add(evidenceSpan.compatibilityUnitId)
   ```

   该步骤不把 unit 变成第二套储能载体。它只负责把已激活的 IR / graph neighborhood 解析到其 supporting narrative evidence，并对 evidence candidate 聚合 support score。compatibility units 如果存在，只作为附加句柄。

2. **Bundle energy 计算**:
   ```
    for each bundleKey with evidenceSupportScores[bundleKey] > 0:
      scene_bias = computeSceneBias(bundleKey, signals, nodeSummaryMap) * sceneBiasGain
      state_bias = computeStateTimeBias(bundleKey, bundleSupportingNodes[bundleKey], scannerState)
      cooldown_penalty = bundleCooldowns[bundleKey] ? 0.5 : 0

     bundle_energy = evidenceSupportScores[bundleKey] + scene_bias + state_bias - cooldown_penalty
   ```

   `computeStateTimeBias(...)` contract:
   - 输入：supporting nodes、当前已激活的 edge families、scope/validity 命中结果
   - 输出：该 evidence candidate 是否被 state inquiry 额外支持
   - 作用：提高“与当前 anchor + aspect 的状态线更一致”的 narrative evidence 收敛优先级
   - 若当前为 retrospective reconstruction candidate，则优先提升那些更可能代表前驱状态或失效状态的 evidence slice
   - 边界：不改变 canonical evidence 定义；兼容 unit 只影响 legacy traceability

3. **Tier 分配**:
   ```
   if bundle_energy >= criticalThreshold → "critical"
   else if bundle_energy >= decisionThreshold → "decision"
   else if bundle_energy >= backgroundThreshold → "background"
   else → 不入选
   ```

4. **Top-k 选择**: 按 bundle_energy 降序，取前 `maxInjectedBundles` 个

5. 返回 V8Bundle[]

`computeSceneBias()` 默认实现：
- 取该 evidence bundle 的 supporting nodes
- 对每个 supporting node 取其 `canonicalLabel + aliases + nodeSummaryMap[nodeId]`
- 与当前 signals 做 weighted Jaccard overlap
- 取最大值作为该 evidence bundle 的 `scene_bias` 基数

### 6.5 Pack Formation

```ts
function assemblePacks(
  bundles: V8Bundle[],
  units: V8Unit[],
  compiledPacks: V8PreCompiledPack[],
  controlAnchors: V8L0ControlAnchors,
  config: V8PipelineConfig
): V8Pack[]
```

**输入**: selected bundles + optional compatibility units + pre-compiled pack cache

**处理**:

对每个 bundle:

1. **查找 canonical evidence / compatibility shell**:
   ```
   evidenceSpans = resolveEvidenceSpans(bundle.evidenceSpanIds)
   compatibilityUnits = units.filter(u => bundle.compatibilityUnitIds.includes(u.id))
   ```

2. **选择 pack type**:
   ```
   if 当前任务强依赖原文措辞:
     → direct pack
   else if evidence spans 覆盖的 narrative region 过长或与下层兼容切片重叠严重:
     → 优先 compiled pack
   else if 已存在 IR-backed compressed representation 或 compiled cache:
     → compiled pack
    else:
      → direct pack
   ```

   compatibility `unit.scale` 只作为强提示，不直接决定 pack type。`micro` 更容易走 direct；`meso / macro` 更容易走 compiled；这不是硬映射。

   具体判定顺序：
   1. 若 `wordingCritical(evidenceSpans, controlAnchors)` 为真 -> direct
   2. 若 `resolvedNarrativeText.length > directPackMaxChars` -> compiled
   3. 若 `hasHighParentOverlap(compatibilityUnits)` 为真 -> compiled
   4. 若存在 `compiledPack` 或 `summary IR item` -> compiled
   5. 其余 -> direct

3. **Direct pack 组装**:
   ```ts
     {
       id: generateId("pack"),
       type: "direct",
       sourceEvidenceSpanIds: bundle.evidenceSpanIds,
       compatibilityUnitIds: bundle.compatibilityUnitIds,
      content: buildDirectExpression(evidenceSpans, controlAnchors),  // narrative 原文片段、近原文组织或轻量裁切去重
      evidenceSpanIds: bundle.evidenceSpanIds
    }
   ```

`buildDirectExpression()` 默认实现：
- 若 `resolvedNarrativeText.length <= directPackMaxChars`，直接返回原文
- 若包含 code fence，优先保留命中的 code block 与其前后各 `directPackTrimWindowChars` 的自然语言上下文
- 否则按 controlAnchors/query tokens 在 resolved narrative text 内找最高重叠 span，截取该 span 前后各 `directPackTrimWindowChars`
- 去重重复空行和重复列表项

4. **Compiled pack 组装**:
   ```ts
   {
     id: generateId("pack"),
     type: "compiled",
     sourceEvidenceSpanIds: compiledPack.sourceEvidenceSpanIds,
     compatibilityUnitIds: compiledPack.compatibilityUnitIds,
     content: compiledPack.content,
     evidenceSpanIds: compiledPack.evidenceSpanIds
   }
   ```

### 6.6 Context Injection

```ts
function injectContext(
  packs: V8Pack[],
  controlAnchors: V8L0ControlAnchors
): string
```

**输入**: 组装好的 packs + L0

**处理**: 用模板把 packs 组织成可注入 LLM context 的文本块。

```markdown
<memory_recall round="{roundIndex}">
{for each pack, ordered by bundle tier then energy:}

[{pack.type === "direct" ? "direct" : "compiled"} | tier: {bundle.tier}]
{pack.content}

{end for}
</memory_recall>
```

L0 的 structural binding：不写进 pack 内容，而是通过 pack 的选择和排序隐式对齐。L0 本身已经在 LLM 的 context 中（作为 task ledger / system prompt 的一部分）。

**注入位置**: 紧接在当前生成位置之前，作为 context window 的一部分。具体注入方式取决于宿主系统（OpenClaw）的 prompt 组装逻辑。

### 6.7 Search Escalation

```ts
function escalateSearch(
  currentBundles: V8Bundle[],
  units: V8Unit[],
  narrativeRecords: V8NarrativeRecord[],
  controlAnchors: V8L0ControlAnchors,
  config: V8PipelineConfig
): V8Pack[]
```

**触发条件**: 当前轮 bundles 全部低于 backgroundThreshold，或前台 LLM 显式请求更多记忆。

**逐级扩圈**:

```
Step 1: 在当前 activated bundles 对应的 narrative spans 附近搜索
  → 取 bundle.primaryNarrativeRecordId 与 bundle.evidenceSpanIds
  → 在对应 record 的已命中 span 附近 ±2000 chars 范围内做 keyword search
  → 如果找到相关内容 → 先解析 supporting evidence，再按 pack formation policy 决定 direct / compiled

Step 2: 扩大到同 day 的全量 narrative
  → 取 dayKey → 该日所有 narrative records
  → BM25 keyword search (query = L0.activeTask + current signals)
  → top-k results → 先解析 supporting evidence，再按 pack formation policy 组装返回

Step 3: 扩大到全量 narrative
  → 全量 BM25 search
  → top-k results → 先解析 supporting evidence，再按 pack formation policy 组装返回

Step 4: raw archive fallback (最后手段)
  → 搜索 raw/ 目录下的原始文件
  → 返回原文片段
```

每级只有在上一级结果不足时才继续。search escalation 由前台 LLM 发起（通过在 output 中产生搜索请求），系统提供受控搜索边界。

**retrospective reconstruction default flow**:

当 `retrospective reconstruction candidate` 被标记后，search escalation 默认按以下顺序执行：

1. **anchor-scoped retrieval**
   - 先只检索与 dominant anchor 直接相关的 narrative docs / units
   - 不做全局主题扩散

2. **aspect-bucket grouping**
   - 将检索到的 evidence 按 `aspectKey` 分桶
   - 无法显式落到 `aspectKey` 的 evidence，不进入当前 reconstruction lane

3. **time/regime bucketing**
   - 在同一 aspect bucket 内，再按：
     - `dayKey`
     - `phase`
     - `regime`
     - `topic-state`
     做分桶

4. **state snapshot synthesis**
   - 每个桶只合成一个短 state snapshot：
     - anchor
     - aspect
     - candidate state expression
     - validity / regime
     - support unit ids

5. **snapshot comparison**
   - 比较相邻桶的 snapshot
   - 识别：
     - 前驱状态
     - 当前状态
     - 失效状态
     - regime-specific state

6. **reconstruction landing**
   - 若比较结果足够稳定：
     - 作为临时 reconstruction result 进入当前 recall
     - 并可在后续 build 中沉淀成正式 state-line edges
   - 若不稳定：
     - 只作为 search result 返回，不写回 graph

`V8StateSnapshot` 定义见 §4 Type Contracts。

**Search ranking**:
- `rank = 0.60 * bm25 + 0.25 * anchor_overlap + 0.15 * recency`
- 每级先取 `searchBm25TopK`
- rerank 后返回前 `searchReturnTopK`

---

## 7. Feedback Side Path

### 7.1 Recall Trace Recording

每次 recall round 执行后立即记录:

```ts
function recordTrace(
  assembly: V8RecallAssembly,
  sessionId: string
): V8RecallTrace
```

写入 `runtime/recall_traces.jsonl`。append-only。

### 7.2 Feedback Observation & Attribution

```ts
function processFeedback(
  observation: {
    source: "user" | "tool" | "model";
    text: string;
    traceId: string;
  }
): V8FeedbackRecord | null
```

**处理**:

1. **对齐**: 通过 traceId 找到对应的 recall trace，确认本轮投递过哪些 packs/nodes
2. **检测 feedback 类型**:
   - 用户显式纠正 ("不对"、"错了"、"应该是...") → memory_content_error
   - 用户确认 ("对的"、"没错") → memory_helped
   - tool 结果与 recall 内容矛盾 → memory_content_error
   - model 忽略了注入内容 → memory_ignored_neutral
   - model 表示信息不够 → memory_missed_relevant
3. **Attribution**: 将 feedback 对齐到具体 targets (node ids 或 unit ids)

### 7.3 Override Application

```ts
function applyOverrides(
  feedback: V8FeedbackRecord
): V8FeedbackOverride[]
```

**层级规则**:

| 层级 | 触发条件 | 作用范围 | 持续时间 |
|---|---|---|---|
| flash | 任何单次 feedback | 当前回答 / 当前 tool 周期 | 立即消失 |
| scene | 同一 session 内重复出现 | 后续几轮 scan window | session 内 |
| durable | 跨 session 反复对齐的 feedback 或强事实确认 | 长期 recall 调整 | 永久，直到下次 consolidation 消费 |

**Override 对 runtime 的影响**:
- `suppress`: bundle_energy -= |delta|
- `reinforce`: bundle_energy += |delta|
- `clear`: 清除之前的 override

**Durable override → graph 修改** (在下次 build 时):
- durable suppress 意味着 recall 中的内容与当前事实矛盾
- 下次 build 时，orchestrator 将 durable overrides 传给 IR extractor
- IR extractor 在处理对应 units 时，将冲突信息一并提供给 LLM
- LLM / consolidation 可据此调整 validity、support/confidence，或在有足够证据时产出状态变化相关关系

**durable landing contract**:
- temporal relation landing 只是可能结果
- durable feedback 不绑定单一路径
- consolidation 可落到 validity、support、confidence 或状态变化关系

---

## 8. Relation Mining

### 8.1 Trigger & Lifecycle

独立于主 pipeline，**周期性**执行（例如每 N 次 build 后，或手动触发）。

```ts
function runRelationMining(
  nodes: V8GraphNode[],
  edges: V8GraphEdge[],
  narrativeRecords: V8NarrativeRecord[],
  units: V8Unit[],
  config: V8PipelineConfig
): V8ReviewedRelation[]
```

### 8.2 Anchor Selection

从 graph 中选定稳定 anchors:
- 高 supportCount 的 entity/concept/method nodes
- 有 control overlay 的 preference/goal/constraint/decision nodes
- 有 state overlay 的 state nodes

### 8.3 Search Planning

对每个 anchor 生成三条 lane 的 search plans:

| Lane | 搜索范围 | 置信度要求 |
|---|---|---|
| focused | anchor 的直接 neighborhood ±1 hop | 高 |
| broadened | anchor 的 2-hop neighborhood + 同 topic | 中 |
| exploratory | 全量 archive, 低先验 | 低（需 LLM review 确认） |

### 8.4 Candidate Retrieval

```
BM25 + vector search on narrative/unit corpus
  → rerank with anchor class hints + graph-guided hints
  → top-k candidates per plan
```

### 8.5 Relation Review

LLM 对 candidates 做 relation review:
- 输入: anchor context + candidate evidence spans
- 输出: relationType, confidence, verdict (accepted/rejected/shelved)

### 8.6 Graph Landing

accepted relations 交回 `materializeGraph` 做 normalization/consolidation 后写入 graph。这是 append-only 的——新 edges 加入，不删旧的。

---

## 9. Open Design Spaces

以下问题在架构层已定义问题空间和约束边界，但具体实现方案未定。Pipeline 在这些位置预留了扩展点。

### 9.1 Temporal And Oblique Recall Geometry

**架构要求**: graph 内部存在可被前台访问的持久化 geometry，用来承载状态变化、时间变化和跨线索牵动。

**本体边界**:
- `node = object/state-object`
- `edge = relation`
- temporal / oblique geometry 优先落在 `edge taxonomy + edge qualifiers + edge-aware propagation`

**Pipeline 预留**:
- `V8GraphEdge.qualifiers` 可承载 time/context/polarity 等限定信息
- `propagation()` 中 `SynapseWeight` 可扩展为 edge-family-aware / qualifier-aware 权重函数
- `V8PipelineConfig` 预留 `edgePropagationPolicy` 字段（当前未定义）
- `ignite()` 中 `g_time` 当前只做 day-level locality，后续可扩展为 state-aware gating

**待决设计**:
- 状态变化如何影响传播路径
- state_supersedes_state edge 是否降低被 superseded node 的传播权重
- 跨线索耦合 edge (line_binding) 如何在传播中起作用
- 时间窗口 edge (scope_anchor) 是否在 ignition 阶段做 gating

### 9.2 Propagation Scope

**当前**: 全图传播，受 topKEdges + stopThreshold + cooldown 约束。

**待决**: 是否需要在某些条件下限制传播到 subgraph（例如只在 activated neighborhood 内传播）。与 §9.1 相关。

### 9.3 Bundle Energy Aggregation

**当前**: 同一 unit 的多个 supporting node 的 energy 做简单 sum。

**待决**: 是否需要 max/weighted-average/diminishing-returns 等替代策略。

### 9.4 Higher-Order Product Distillation

**架构要求**: knowledge/skill/setting/agent coordination protocol 从反复激活的稳定 graph neighborhoods 中蒸馏。

**distillation trigger framework**:
- 候选 neighborhood 需要同时满足：
  - activation count `>= 5`
  - 至少跨 `2` 个 session 持续出现，或单 session 内高支持度重复出现
  - evidence spans 覆盖不少于 `3` 个独立 units
- 分类规则：
  - `knowledge`: 稳定背景、概念、事实、项目常识
  - `skill`: 稳定 procedure / workflow / failure-recovery 模式
  - `setting`: 长期约束、背景设定、世界规则、项目前提
  - `protocol`: agent coordination / interaction style / search style

**output format**:
- 每个产物写入 `graph/derived/{kind}/<slug>.md`
- 文件最小结构：
  - `Title`
  - `Why This Exists`
  - `Canonical Expression`
  - `Evidence Basis`
  - `Reactivation Triggers`
  - `Last Updated`

**System prompt seeds**: 蒸馏出的产物以简短摘要形式写入 agent.md / system prompt。只需包含少量关键 trigger terms，确保 scan window 能命中，从而触发完整 recall。

**system-prompt seed contract**:
- 不把 derived markdown 全文注入 system prompt
- 只提取：
  - canonical label
  - 1–3 个 trigger terms
  - 1 段极短 summary
- 运行时通过这些 seeds 触发完整 recall


