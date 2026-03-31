# V8 Architecture Rewrite Design

Status: draft for review
Audience: maintainers, future contributors, agent-memory researchers

## 1. Core Problem

V8 解决的是上下文受限条件下的长期记忆形成与召回问题。

当前长期任务里有三个核心问题：

1. 某些事情明明发生过，也被记录过，但当前上下文里没有那段信息时，模型不会主动意识到“这里应该去找记忆”。
2. 即使历史中存在关键线索、深层关系或状态变化，模型仍然倾向于只依赖当前上下文硬解，而不是沿记忆继续找证据。
3. 如果记忆系统只能在自定义样本上 work，而不能在权威 benchmark 上取得强结果，就很难证明这套设计真的成立。

V8 的目标是让模型在需要时知道：

- 过去发生过什么；
- 哪些过去的事和当前任务有关；
- 下一步该沿着哪条线继续找；
- 在理想情况下，直接拿到足够继续工作的记忆表达。

一句话压缩版：

> V8 不是一个“存历史”的系统，而是一个让模型在需要时知道“过去发生过什么、哪里可能有证据、如何继续把它找回来”的系统。

## 2. System Definition

V8 是一个双系统耦合的记忆系统：

- 后台系统负责把经历加工成可检索、可点火、可追溯的记忆结构；
- 前台系统负责在生成过程中主动召回这些记忆，并在信息不足时继续向下搜索证据。

这两条主线并列存在。

V8 同时包含一条附着在前台 recall 上的 `feedback learning side path`。它不构成第三条独立主线，负责把 recall delivery 与后续 user/model/tool outcomes 对齐为 recall 调整信号。

V8 共享的核心记忆产物是：

- `narrative`
- `memory IR`
- `graph`
- `bundle`
- `pack`
- `unit`

总结构纲可以压缩成一句：

> `narrative` 是 canonical source surface 与默认证据面，`memory IR` 在抽取阶段产出带 offset anchors 的结构化 claim，`graph` 提供激活与路由，`bundle` 聚合 runtime 选中的 narrative-grounded evidence neighborhood，`pack` 提供 narrative/evidence-first 的交付表达，`unit` 仅保留为兼容旧接口与旧缓存边界的 compatibility shell。

## 3. Core Principles

### 3.1 Evidence-Backed Source Policy

V8 的高层记忆对象都必须 evidence-backed，并主要围绕规范化后的 `narrative` 工作。V8 不允许把推断结果伪装成原文事实。

高层对象的证据链落在：

`graph node/edge -> memory IR item + evidence span -> narrative span / turn slice -> narrative record -> raw archive`

- `memory IR item`
  - 一条带证据锚点的 IR 抽取结果。
- `evidence span`
  - `memory IR item` 的定位属性，在 IR extraction 阶段产生，用来把 IR 精确回指到 `narrative` offsets。
- `narrative record`
  - `narrative` 中可被存储、回放和追溯的一条规范化叙述记录。

在 source policy 上：

- `raw archive`
  - 保留 append-only 原始记录；
  - 作为回退、校验、追底与失效恢复的低层面。
- `narrative`
  - 从 raw archive 结构性清洗、时序组装而来；
  - 是默认权威证据面、canonical source surface，也是 IR 提取、recall 和 search 的起点。

## 4. Shared Memory Products

### 4.1 Narrative

`narrative` 是由 raw archive 经过结构性清洗和时序组装后形成的连续叙述体证据面。它是完整的 cleaned usage log，包含 user、assistant、tool 和其它运行时观察材料在可叙述边界内的规范化记录。`narrative` 是 canonical source surface：IR extraction 直接在它的 turn/span surface 上工作，runtime recall 与 search 也默认沿 narrative evidence 展开。

### 4.2 Unit

`unit` 不再是记忆系统的 canonical source boundary，而是覆盖旧接口、旧缓存与旧调试视图的 compatibility shell。它可以把一段 narrative span、turn window 或其它已抽取证据边界包装成稳定 ID 与分层切片，方便 legacy consumers 继续工作，但它不再定义“真正的证据来自哪里”。

`micro / meso / macro` 仍可作为兼容性切片粒度存在，但它们主要服务于 review、cache key、legacy pack materialization 和过渡期 API。前台真正交给 LLM 的内容应由 narrative-grounded evidence selection 决定；若某个 pack 仍携带 unit id，那只是为了兼容追踪与缓存，而不是为了把 unit 重新抬回 canonical delivery primitive。

### 4.3 Memory IR

`memory IR` 是从 `narrative` 中提取出的、带证据锚点的中间结构层。它的作用是把文本中的实体、关系、状态、变化和局部摘要，转换成可归并、可验证、可物化的中间记忆表示。单个 IR 抽取产物可称为 `memory IR item`。IR extraction 本身负责产出 evidence spans；也就是说，证据锚点不是先由 unitization 决定、再被 IR 继承，而是由 IR 对 narrative offsets 的抽取结果直接写出。

### 4.4 Graph

`graph` 是从 `memory IR` 经过 `normalization / consolidation` 后形成的长期关系组织层，维护实体、关系、状态以及 recall 所需的可传播结构。`graph` 的职责是 activation、routing 和长期组织，不是直接作为最终交付内容。

真正的“生命”从 `IR -> graph` 这一段开始长出来：

- `narrative` 有文本，但还没有生命；
- `memory IR` 有结构，但还没有真正的生命周期；
- 到 `graph` 才开始出现持续的关系、演化、替代和跨时间联动。

只有到了 `graph`，同一对象与关系才能跨局部上下文被保留、被点火进入局部激活域，并沿关系继续移动。前台 recall 不是把 graph 直接交付给 LLM，而是从 activated IR / graph neighborhood 中解析 supporting evidence spans 与 narrative regions，并在需要时附带兼容性 unit shell，随后形成 `bundle` 与 `pack`。

`graph` 内部还包含为 recall 准备的持久化 `serving views`。

### 4.5 Temporal And Oblique Recall Geometry

这一层定义一份同时服务于 IR 生产与 recall 消费的共享 contract。

它回答两类问题：

- 抽取阶段的 LLM 在当前窗口里应该产出哪些 type 与 relation；
- ignition、propagation、bundle resolution 在运行时应该如何消费这些 type 与 relation。

当前架构只保留纯三层基底：

- micro
- meso
- macro

control、state-overlay、scope-change 和其它 cross-layer state taxonomy 不进入这张架构总表。它们属于后续实现扩展，而不是当前主骨架。

| Layer | Semantic Scale | Formation Focus | Recall Focus | Main Propagation |
|---|---|---|---|---|
| micro | 单个对象、单个事件、单个属性、单个命题、单个局部支撑点 | 当前窗口里最小且直接成立的对象、事实、事件、命题与支撑点 | 作为点火锚点和局部传播起点，把 recall 带到直接相关的过去片段 | horizontal + temporal |
| meso | 一个局部完整块，由多个 micro 围绕同一局部目标、问题、步骤、互动或结果组织而成 | 当前窗口里已经形成局部闭合块，但还没有上升成长期线索或阶段结构 | 作为局部片段组织单位，帮助 bundle 把多个相关片段拼成一个可交付块 | horizontal + vertical |
| macro | 一条跨多个局部块的长程线索、阶段结构、主题结构或演化结构 | 当前窗口里已经明确支持跨块、跨阶段、跨时间的持续结构，而不是单一局部块 | 作为长程召回骨架，把 recall 从当前线索带到更远的阶段、线程、主题或演化片段 | temporal + oblique + vertical |

这张总表只定义层级边界和使用方向。

- 细粒度 type / relation 表进入实现文档；
- 最小层间边进入实现文档；
- temporal-forward 和 temporal-backward 的运行联动也进入实现文档。

### 4.6 Bundle

`bundle` 是运行时的 narrative/evidence-first recall candidate。它不是预先定义的一组 graph objects，也不是某个 IR 或 entity 的全部历史支撑片段。`bundle` 表示：在当前回合中，一组被共同激活的 IR / graph neighborhood 共同支持了哪些 narrative-grounded evidence slices，这些 evidence slices 因而成为 recall 选择候选。

`bundle` 不直接面向 LLM。它的语义身份落在被支持的 evidence neighborhood 与其对应 narrative spans 上，而不是落在 graph-side grouping 上。若运行时仍附带 unit ids，它们只作为 compatibility handles。

### 4.7 Pack

`pack` 是对 selected narrative evidence 的最合适表达。它面向 LLM，但它的内容本体始终来自 `narrative` 与其对应的 IR-backed evidence spans，不来自独立的 graph-side 交付物，也不以 unit 作为权威来源。

`pack` 有两种基本形成方式：

- `direct pack`
  - 直接对 selected narrative spans 做重组、裁切、去重或硬组织后形成，尽量保留原有表达。
- `compiled pack`
  - 由 LLM 对 selected narrative evidence 做压缩、改写、总结或结构重组后形成。

`pack` 的 evidence binding 继承自所选 IR items 与 evidence spans，并在后续 evidence expansion 与 search 中继续使用。`pack` 不要求与 narrative 原文等长同形；它交付的是 selected evidence 在当前上下文下的最合适表达，可能是 narrative 片段、近原文组织，或由 IR 支撑的压缩表达。若 pack 落盘时继续携带 unit 引用，这些引用只用于兼容追踪。

### 4.8 Compiled Pack Variants

不同的 `compiled pack` 可以在表达侧重点上有所不同，但它们仍然都是对 selected narrative evidence 的组织，而不是独立于 evidence 之外的新原料桶。对于过长的 narrative regions，前台通常交付的是它们在 `IR` 中沉淀出的压缩表达，或由这些 `IR-backed` 内容进一步整理后的表达，而不是整段原文。兼容性 units 可以继续参与缓存与审阅，但不应被写成 pack 的语义本体。

`summary pack` 与 `state pack` 不是另一套平行产品体系，而是 `compiled pack` 的两种常见表达倾向。

- `summary pack`
  - 强调对稳定背景、阶段脉络和长期上下文的压缩表达。
- `state pack`
  - 强调从 selected evidence 中抽出与当前状态、变化和分支控制最相关的表达。

这两类 pack 都必须继续绑定 narrative evidence。

### 4.9 Graph-Derived Products

`knowledge`、`skill`、`setting` 和 `agent coordination protocol` 都属于 graph 的下游产物。

- `knowledge`
  - graph 邻域被反复激活、持续 evidence-backed，并被总结成可复用语义结果后形成的产物。
- `skill`
  - 同一机制的 procedural 分支；
  - 当一个稳定邻域描述的是可复用 workflow、约束、检查点或恢复路径时，可以沉淀为 skill 产品。
- `setting`
  - 当一个稳定邻域描述的是长期成立的设定、角色约束、世界规则、项目固定背景或跨回合不应漂移的前提时，可以进一步提炼成更高阶的 setting 产品。
- `agent coordination protocol`
  - 当一个稳定邻域描述的是 agent 之间反复复用的约定表达、交互协议、搜索方式、思考方式或协作信号时，可以进一步提炼成 agent coordination protocol 产品。

`knowledge` 和 `skill` 已经是当前架构里的直接 graph product 方向；`setting` 和 `agent coordination protocol` 更接近在多次激活中持续保持高热、随后被蒸馏出来的更高阶基础能力。它们继续上升时，不是把整段记忆直接硬写进 `system prompt`，而是在 `system prompt` 中种下稳定索引或种子；对应的是可被快速点亮的高能 recall region。运行时只要命中少量关键 cue，这个区域就会被快速带起，并进一步触发相应 `pack`，形成接近条件反射的 recall shortcut。

这些产品都必须继续绑定：

- 产生它们的 node cluster；
- 支撑它们的 evidence spans；
- 能重新点亮它们的 graph neighborhood。

## 5. Background Memory-Formation Spine

后台主线在高层上应当写成：

1. `raw archive -> narrative`
2. `narrative -> memory IR (+ evidence spans)`
3. `memory IR --(normalization / consolidation)--> graph`
4. `graph -> serving views + pre-compiled packs`
5. `narrative / IR -> optional compatibility units`

### 5.1 Raw Archive To Narrative

`raw archive -> narrative` 主要做结构性清洗和时序组装，而不是语义改写。它的目标是把异构原始材料转成稳定、可回放、可切分、可搜索的叙述体证据面。

### 5.2 Narrative Normalization

Normalization 把异构 source 转成稳定 source contract，并保留证据价值。

必须保留或重建的信息包括：

- source path 或 source id；
- session id、turn id、message id；
- speaker；
- timestamp；
- char offsets 或 line offsets；
- original raw text。

Normalization 的核心规则：

- 清掉 prompt scaffolding、tool wrapper、注入的 memory block、控制噪声；
- 保留 span map，使 evidence span 仍能回溯到 narrative offsets；
- `narrative` 是 canonical cleaned surface；
- 大多数 runtime observation 都应进入 `narrative`；只有内容极长、极噪、极碎，直接完整保留反而会让叙述体失真时，才允许做受控裁剪，但必须保留足以回指原始信息的记录。

### 5.3 Compatibility Segmentation Shell

`unit` 不再是后台主线开始形成记忆结构的 canonical 切分层。后台的 canonical source 已经是 `narrative`，而 evidence 由 IR extraction 直接写出。`unitization` 现在更准确地说，是一个可选的 compatibility segmentation shell。

`micro / meso / macro` 仍可作为兼容性分层，用于 legacy review、cache keys、debug views 与某些 pack materialization 辅助，但它们不再定义 narrative 到 IR 的唯一竖向边界。

定义：

- `micro`
  - 最小但仍然完整的存储级语义证据单位，通常承载一个局部 cue、条件、比较或关系片段；
  - 通常是一个分句、句子级或短 span 级的局部语义片段。
- `meso`
  - 一个稳定的局部语义块，通常足以支撑一个推理步骤、命题簇或 discourse function。
- `macro`
  - 更长的主题、阶段或时间窗口上下文。

Compatibility shell 规则：

- offsets 是第一等公民；
- compatibility unit text 来自 `narrative`；
- 切分依据语义与 discourse closure；
- char/token 长度作为 guardrail；
- 任何 compatibility 切片都不得改写 canonical evidence source，真正 evidence 仍以 IR extraction 写出的 narrative offsets 为准。

### 5.4 Narrative To Memory IR

`narrative -> memory IR` 负责从 narrative turn/span surface 里提取 bounded、evidence-backed 的结构项。compatibility units 如果存在，只作为 batching、cache 或 review 的辅助视图，不构成 evidence 的上游真源。

IR 至少要能表达：

- 实体与对象；
- 关系与命题；
- 状态与变化；
- 局部摘要与 discourse role；
- 支撑这些项的 evidence anchors。

`evidence span` 在这一层产生。它不是独立于 IR 之前的另一层文本产物，而是 IR item 对 narrative offsets 的定位锚点；前台 recall 也通过这些锚点把 activated IR neighborhood 解析到 supporting narrative evidence，并在需要时映射到 compatibility units。

### 5.5 Normalization And Consolidation

`normalization / consolidation` 负责把 IR 归并成稳定 graph。

它的职责是：

- deduplicate 与 normalize extraction instances；
- merge aliases 与重复出现的 evidence-backed relations；
- reject noisy or weakly supported outputs；
- consolidate durable memory objects；
- 保持语义层次分离。

- `raw-text instantiation`
  - 原文在这里实际表达了什么。
- `stable-memory consolidation`
  - V8 如何把这些表达归并成长期稳定记忆。

### 5.6 Compiler Boundary

后台编译边界可以稳定描述成：

1. `source adapters` 把原始记录转成 `narrative records`
2. `IR extractors` 直接在 narrative windows / spans 上提取 `memory IR items`，并为其中的 claim 附上 `evidence spans`
3. `compatibility segmenters` 在需要时把 narrative evidence 投影成 `units`，供旧缓存、旧 review 或旧接口继续消费
4. `graph materializers` 把 IR 归并成 graph nodes / edges，并写出 recall 所需的 `serving views`
5. `compiled-pack materializers` 产出可在运行时复用的 `compiled packs`

### 5.7 Cross-Archive Relation Mining

后台除了主线编译，还需要一条面向 graph 建立的 `graph-guided relation mining` lane。它由后台 LLM 围绕实体、对象、方法、目标、决策、约束、状态对象等稳定 anchors 发起，用来补齐单次上下文无法同时容纳的远距离关系脉络。

这条 lane 的目标是：

- 在全历史中为 anchor 补齐远距离关系证据；
- 发现跨时间、跨切片、跨主题但仍与当前 anchor 稳定相关的关系；
- 为 graph 提供新的长期关系候选。

它与当前 graph 的结合方式是：

- graph 提供 anchors、已有 neighborhood 和当前可用的结构提示；
- archive search 在全历史 `span / narrative` indexes 上提供候选证据，并可选附带 compatibility unit projection；
- 后台 LLM 在 compact evidence pack 上完成 relation review，并给出关系是否成立、落在哪组 anchors 之间、由哪些 evidence 支撑；
- `normalization / consolidation` 负责把这份 relation review 结果整理为可落图的 graph relation，包括 anchor 对齐、去重、合并和冲突处理；语义判断本身不在这一步重做；
- 经整理后的关系结果直接写入 graph。

标准路径：

1. 从 graph 中选定 anchor entity / object / method / goal / decision / constraint / state object；
2. 基于当前 neighborhood 与结构提示生成 graph-guided search plan；
3. 对全量 archive span corpus 做 `BM25 + vector` 搜索；
4. 用 graph-guided hints 与 anchor class hints 做 rerank；
5. 组装 compact evidence packs 交给后台 LLM 做 relation review，形成可落图的关系结论；
6. 将这份关系结论交回 normalization / consolidation 做 graph landing。

搜索规划仍保留三条 lane：

- `focused`
- `broadened`
- `exploratory`

这三条 lane 对应 anchor 附近的高置信关系、放宽先验后的次环关系，以及低先验但可能有价值的远距离关系。

## 6. Online Recall Spine

前台主线在高层上应当写成：

1. `active text signals + L0 -> ignition`
2. `ignition -> IR / graph activation`
3. `activated IR neighborhood -> evidence resolution`
4. `evidence bundle -> pack injection`
5. `insufficient evidence pack -> search escalation`

`ignition` 指前台 recall 的入口步骤：系统根据当前正在处理的输入和当前控制态，在 graph 中找出哪些记忆区域应先被点亮。`L0` 指当前任务控制面，负责承载 goal、active task、latest request、handoff 等控制锚点。

### 6.1 Runtime Inputs

Ignition 输入包括：

- `active text signals`
  - 当前正在处理的 user / assistant / tool / subagent / feedback / working-state 输入碎片。
- `control anchors`
  - 当前显式控制条件，例如 goal、active task、latest user request、handoff 等。
- `serving views`
  - 只服务当前点火的 trigger vocabulary surface，例如 names、aliases、trigger terms 和短摘要文本。


### 6.2 Key Runtime Formulas

Ignition 先做候选匹配，再做注入评分。候选匹配通过 `serving views` 完成。点火视图提供 names、aliases、触发词、短摘要文本和必要的轻量限定信息。扫描窗口的大小与边界策略属于实现层。

点火后的结果是在 graph 中打开一个由当前输入约束的局部激活域。后续传播继续发生在 activated IR / graph neighborhood 中；`bundle` 的形成则来自这些被激活结构对 supporting narrative evidence 的共同支持，而不是来自预先写好的 node grouping。

这里的 geometry 访问不要求改写 `node = 对象 / 状态对象`、`edge = 关系` 的本体边界。点火先命中 nodes 与其 serving surface，再由 edge family、edge qualifier 和当前已激活关系共同重排下一跳优先级。

候选 node 的直接注入分数保持为：

`u_i = baseGain * (a * g_lex + b * max(g_scene, g_ctrl) + c * g_time)`

其中：

- `u_i`
  - 候选节点 `i` 的直接注入分数。
- `g_lex`
  - 词面命中或触发词命中的强度。
- `g_scene`
  - 与当前局部语义窗口的 overlap。这里的 scene 指由最近正在处理的文本和控制信号形成的局部语义场。
- `g_ctrl`
  - 与显式 control anchors 的 overlap。
- `g_time`
  - 时间可用性或 episodic locality 分数。
- `baseGain`
  - 当前输入片段的初始激活增益。首轮 prompt 或显式预热点火更高，普通流式输入更低。
- `a, b, c`
  - 词面、当前信号、时间因子的可调权重。

这条公式描述当前输入对节点的直接点火。跨轮延续由 `node residual energy` 负责；被点亮的 IR / graph neighborhood 随后再通过 evidence spans 解析出 supporting narrative evidence。

`bundle` 排序仍然建立在激活后的 graph 运行时产物之上，但排序对象是 evidence-centered candidate：

`bundle_energy = activated_node_energy + scene_bias + state_bias - cooldown_penalty`

含义：

- `activated_node_energy`
  - 当前高活性节点对某个 supporting unit candidate 的聚合贡献，其中已经包含本轮注入后的 residual energy。
- `scene_bias`
  - 当前局部语义窗口带来的额外提升。
- `state_bias`
  - 当前活跃状态表示或已注入状态记忆带来的提升。
- `cooldown_penalty`
  - 最近刚被投递过的 bundle 所受的短时抑制。

### 6.3 Propagation And Leaky Residual Ignition

Propagation 采用 `leaky residual ignition`。每个 node 都保留自己的 residual energy；每轮开始前先衰减上一轮残余，再叠加本轮文本注入，然后在局部激活域内做一次正向传播和一次较弱反向传播。低于阈值的 residual energy 清零，不再继续参与下一轮传播。

这个传播过程不是沿预设的少数固定方向模板展开，而是在已激活区域内沿强边与当前可用约束做受约束的局部自由移动。运行时可以采用 edge-aware propagation，让已激活 edge 影响下一跳 edge 的可达性与权重；这是一种传播嫁接，不是把 edge 改写成 node。时间、状态与跨线索传播的具体机制在架构层仍保持开放。

节点跨轮更新保持为：

`Energy_i_pre = decayLambda * Energy_i_prev`

`Energy_i_post = Energy_i_pre + u_i`

单步传播新增的能量保持为：

`ΔEnergy_target = Energy_source × SynapseWeight × DirectionGain × (1 / √Degree_target) × CooldownFactor`

当前轮结束后的节点能量保持为：

`Energy_i_next = Energy_i_post + ΔEnergy_i_forward + ΔEnergy_i_reverse`

如果 `Energy_i_next < stopThreshold`，则该节点能量清零。

含义：

- `SynapseWeight`
  - 长期边权或记忆强化权重。
- `DirectionGain`
  - 正向传播增益通常强于反向传播增益。
- `1 / √Degree_target`
  - hub penalty，抑制高连接度泛化节点吸收并再次广播过多能量。
- `CooldownFactor`
  - 短时间抑制因子，防止刚刚触发过的节点重复主导。
- `decayLambda`
  - 全局衰减，去掉陈旧活性；它不属于单条边传递，而是扫描轮次之间的整体衰减。
- `stopThreshold`
  - 节点停止继续保留 residual energy 的阈值。

运行时约束：

- `topKEdges` restriction in both directions，即每个节点在每个方向只沿少量最强边传播；
- 分离的 `node cooldown` 与 `bundle cooldown`；
- 分离的 `scene-bias decay` 与 `activation decay`；
- 每轮只做一次正向传播和一次较弱反向传播，不做无限轮次级联；
- `second-wave recall` 由下一轮新的文本注入再次带起残响。

具体默认参数与调优范围应放在 pipeline 文档中。

### 6.4 Episodic Locality

有些 graph neighborhood 带有更强的 episodic binding，需要局部门控；另一些 graph neighborhood 更接近稳定背景、长期事实或可复用方法，在 recall 时可以保持更高的全局可用性。

episodic locality 属于 graph recall geometry 上的一层 gating。

规则：

- 稳定事实背景和可复用方法相关的分支全局可用；
- 带明确 day、episode、source 绑定的 graph 分支，只通过这些绑定条件与当前局部语义窗口的 overlap 被局部点亮；
- 如果当前局部语义窗口与某个 episode window 没有 overlap，对应 episodic branch 保持沉默。`episode window` 指同一段经历所属的时间窗口。

day-local activation 是一等规则：当前正在处理的文本片段或当前局部语义信号一旦命中带有 episodic binding 的 node，对应 `dayKey` 在本轮扫描窗口中变为 eligible。`dayKey` 指按天分桶的 episodic 标识。

### 6.5 Narrative / Evidence-First Delivery

delivery 的内容权威落在 `narrative` 与 `IR evidence`，组织动作落在 `bundle / pack`。`unit` 若出现，只承担兼容性标识与缓存句柄。

回忆的投递单位需要携带：

- 最相关的证据引用；
- 被选中的 narrative evidence 内容或其压缩表达；
- tier，即运行时投递优先级；
- 支撑这些 evidence slices 的 provenance 引用。

Bundle / pack 的选择顺序是：

1. 聚合 activated IR / node contribution 和 scene bias 到 bundle energy；
2. 在聚合后确定 bundle tier；
3. 施加对应优先级的阈值；
4. 抑制仍处于 cooldown 的 bundle；
5. 只选择极小 top-k 进入注入。

`bundle tier` 是运行时投递优先级分层。`bundle` 本身不储能，只表达“哪些 narrative-grounded evidence slices 在当前回合成为高优先级 recall candidate”。

### 6.6 Pack Injection Policy

这一节定义 pack 的注入边界。

`direct pack` 代表更直接的 narrative evidence 表达；`compiled pack` 代表更稳定的压缩表达。两者都必须持续对齐 `L0`，避免 recall 抢走主线。具体调度顺序、缓存策略和何时切换，属于实现层。

### 6.7 Context Assembly

Runtime recall 最终从两类 pack 组织上下文：

- `direct pack`
  - 直接组织 selected narrative spans 的原文或近原文表达。
- `compiled pack`
  - 对 selected narrative evidence 做压缩、改写或总结后的表达。

表达原则：

- 原文措辞很重要时优先 direct pack；
- 稳定背景或长距离脉络很重要时优先 compiled pack；
- 当前任务如果更需要状态、变化或决策信息，也仍然通过对 selected evidence 的组织来表达，而不是通过脱离 evidence 的独立材料桶表达。

Graph 负责帮助选择候选，最终注入内容仍然落在具体 narrative evidence 的原文片段或压缩表达上。compatibility units 可以随包附带，但不是主语义面。

### 6.8 Search Escalation

当当前 pack 不足以支撑模型继续工作时，search escalation 沿已点亮的记忆线索逐步下探。

第一原则是优先沿当前 activated bundle 所对应的 supporting narrative evidence 继续搜索；compatibility units 只作为可选 shortcut，不构成 search 的主语义面。

搜索范围的主轴是当前线索。基础收口线索包括：

- 当前激活的实体或对象；
- 当前激活的状态、关系或其它演化线索；
- 当前任务与 control anchors。

时间是辅助排序与过滤条件。

具体扩圈方式取决于检索速度：

1. 先看 activated bundle 所对应的 narrative span；
2. 如果 `bm25 + vector` 足够快，就扩大到这些激活片段所在日期的全量 narrative；
3. 如果检索速度不够快，就先限制在已激活 narrative span 的附近区域，再逐步扩大 narrative 范围；
4. narrative 仍然不够时，最后才落到 raw archive fallback。

Search escalation 由前台 LLM 发起，系统提供受控搜索边界。

### 6.9 Feedback Learning Side Path

V8 的 `feedback learning side path` 为：

`recall delivery + user/model/tool outcomes -> runtime observation ledger -> attribution -> flash / scene / durable updates`

输入来源：

- `user feedback`
  - 用户的显式纠正、确认、否定或补充；
- `model adoption`
  - 模型是否实际采用了被注入的记忆；
- `fact outcome`
  - 工具结果、执行结果和后续事实是否支持当前 recall。

前提：

- 必须存在 `recall trace`；
- 系统必须知道本轮投递过哪些 pack、哪些 node、哪些 evidence；
- 无 recall alignment 的后续评价只构成 execution feedback，不直接构成 memory feedback。

更新层级：

- `flash`
  - 只影响当前回答或当前工具周期；
- `scene`
  - 影响接下来一小段局部 recall 窗口；
- `durable`
  - 只有在重复对齐的反馈或强事实确认下，才进入更长期的 recall 调整。

作用范围：

- node 或 neighborhood 的短期抑制与强化；
- bundle priority；
- pack 选择偏置；
- temporal / state bias；
- search priors；
- 后续 consolidation 时的 graph-side weight 或 state adjustment。

约束：

- 不得把一条模糊 user text 直接改写成 durable graph truth；
- 不得跳过 attribution 直接改图；
- 不得把 execution failure 和 memory failure 混为一谈。

架构定位：

- recall runtime 的调优回路；
- later consolidation 可消费的长期修正来源；
- 同时覆盖内容修正与后续 recall timing 调整。

## 7. L0 Control Plane

`L0 Control Plane` 持续影响 recall 的行为边界。它提供目标、当前任务、handoff、latest request 等控制锚点，并约束：

- ignition 的点火方向；
- selected evidence neighborhoods 升级为 pack 的选择；
- pack 注入时的任务对齐；
- search escalation 的范围边界。

L0 的角色是把“当前到底在做什么”持续施加到 recall 系统上，避免模型因为局部记忆被点亮而偏离主任务。

## 8. Implementation Boundary

实现边界由几条 contract chain 组成。

实现边界应固定在以下几层：

- `source`
  - 语义提取之前的原始记录与 narrative records。
- `segmentation`
  - 保留 canonical narrative offsets，并在需要时派生 compatibility units。
- `semantic extraction`
  - 从 narrative windows / spans 中抽出的、有边界的 memory IR items。
- `graph products`
  - 经 consolidation 后形成的 graph objects，以及其中为 recall 准备的 `serving views`。
- `runtime recall`
  - 点火、残响传播、supporting-evidence 解析、bundle 形成、pack 投递与搜索扩圈。
- `feedback learning`
  - recall trace、attribution、flash/scene/durable updates，以及后续可被 consolidation 消费的长期修正。
- `ordered state`
  - 同一演化 family 内按顺序组织的状态表示，可以落在 graph 侧或 runtime 侧，而不预设具体组织形式。

实现方向保持为：

1. `source adapters` 把原始记录规范化成 `narrative records`
2. `IR extractors` 直接在 narrative windows / spans 上产出有边界的 `memory IR items`，并附上 `evidence spans`
3. `compatibility segmenters` 在需要时把 narrative evidence 投影成 `units`
4. `graph materializers` 把 IR 归并成 graph objects，并写出其中的 `serving views`
5. `recall` 消费 `serving views`、resolved bundles 与 runtime packs，完成点火、传播、解析和投递
6. `feedback learning` 消费 recall traces 与后续 observations，产出 flash/scene/durable updates，并为 later consolidation 提供长期修正输入
7. `scanner ignition` 是前台运行时入口

边界含义：

- 后台负责形成稳定 memory structure；
- 前台负责匹配、激活、解析 supporting narrative evidence、组织 pack 并继续搜索；
- feedback side path 负责把 recall outcome 对齐回被投递记忆，并调节后续 recall；
- 前台 recall 优先消费 `serving views`。

## 9. External Validation Goal

benchmark 与 SOTA 目标是外部验证目标。

V8 的内部主线仍然是：

- 形成高质量记忆；
- 在需要时召回正确记忆；
- 用过去发生过的事准确指导现在的行为。

benchmark / SOTA 用于验证这套主线是否成立：

- 找到；
- 找准；
- 不丢关键深层语义信息；
- 在长期任务和复杂文本条件下维持一致性。

benchmark 作为外部约束和验证目标存在。
