# V8 Architecture Draft

Status: draft  
Audience: maintainers, future contributors, agent-memory researchers

This document defines the current design target for `memory-enhanced` V8.
It is not a promise that the current code already satisfies this design.
It is the architecture we want to converge toward before large-scale rewrites.

The implementable companion spec is:

- [V8_SCHEMA_AND_PIPELINE.md](./V8_SCHEMA_AND_PIPELINE.md)

## 1. Design Goal

V8 is not "just a graph".

The target is a double-speed cognitive system for long-running agents:

- a control plane that preserves task continuity, priority, and handoff state
- a raw memory substrate that remains human-auditable
- a fast associative layer that can react during generation
- a slow consolidation layer that rewrites memory structure during "sleep"

The user-facing outcome should be:

- after `/new`, the agent can recover the correct task state
- in a large task, the agent can stay on-track instead of drifting
- previously validated workflows, constraints, bugfixes, and checkpoints can be recalled fast enough to save rediscovery cost
- another LLM can take over through the same memory substrate without needing to rediscover the whole project

## 2. Layered Model

V8 keeps the existing layered storage model and adds the graph as a new compiled layer instead of replacing the older ones.

| Layer | Role | Canonical store | Mutation speed |
|---|---|---|---|
| `L0 Control` | goal, active task, resume, handoff, priority | `.memory/active/focus_stack.json` | fast |
| `L1 Raw Stream` | daily logs and raw traces | `memory/YYYY-MM-DD.md`, session traces | append-only |
| `L2 Episodic` | concrete events, failures, discoveries, checkpoints | `.memory/events/*.jsonl` | fast |
| `L3 Semantic / Procedural` | stable long-term knowledge and workflows | `memory/knowledge/*.md` | slow |
| `L4 Graph Index` | machine-readable associative compilation | `.memory/graph/*.jsonl`, indexes | mixed |

Why keep all five:

- `L0` should not be mixed into long-term memory. It is execution control, not just another memory.
- `L1` and `L2` are the audit trail. If the graph learns the wrong thing, we need a factual base to recover from.
- `L3` remains the human-readable canonical store for durable knowledge and handoff.
- `L4` exists to make online triggering and cross-memory integration fast.

The graph is therefore a compiled index and online reasoning substrate, not the only source of truth.

## 3. Scientific Basis

This design is grounded in four ideas.

### 3.1 Complementary Learning Systems

Fast episodic learning and slow semantic consolidation should not share one storage rate.
This follows Complementary Learning Systems: hippocampal-like fast event indexing plus neocortical slow structural integration.

Source:
- McClelland, McNaughton, O'Reilly (1995), "Why there are complementary learning systems in the hippocampus and neocortex"  
  https://pubmed.ncbi.nlm.nih.gov/7624455/

### 3.2 Working Memory Gating

Task state should be explicitly gated and kept separate from long-term memory.
This follows the prefrontal-cortex / basal-ganglia view of working-memory control.

Source:
- O'Reilly, Frank (2006), "Making working memory work"  
  https://pubmed.ncbi.nlm.nih.gov/16378516/

### 3.3 Locality in Human Language

Human language tends to organize around local dependencies and recurring short multiword units.
That supports short online trigger windows instead of paragraph-scale matching.

Sources:
- Futrell, Mahowald, Gibson (2015), "Large-scale evidence of dependency length minimization in 37 languages"  
  https://pubmed.ncbi.nlm.nih.gov/26240370/
- Biber, Conrad, Cortes (2004), "Lexical Bundles in University Teaching and Textbooks"  
  https://academic.oup.com/applij/article-pdf/25/3/371/431268/250371.pdf
- Hyland (2012), "Bundles in Academic Discourse"  
  https://doi.org/10.1017/S0267190512000037

### 3.4 Time-Aware Graph Memory

Agent memory graphs work better when time, history, and supersession are modeled explicitly.

Sources:
- Rasmussen et al. (2025), "Zep: A Temporal Knowledge Graph Architecture for Agent Memory"  
  https://arxiv.org/abs/2501.13956
- Chhikara et al. (2025), "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory"  
  https://arxiv.org/abs/2504.19413

## 4. Memory Unit: One Memory -> A Small Node Bundle

V8 should not store an entire memory as one monolithic graph node.

Default compilation target:

- one memory item becomes `3-6` graph nodes
- each node carries one locally reusable semantic role
- edges reconstruct the larger memory

Default node roles:

- `topic/entity`
- `workflow/action`
- `constraint/decision`
- `condition/context`
- `evidence/artifact`
- `checkpoint/handoff`

Not every memory needs all roles. Most should compile to a sparse subset.

### Why `3-6` nodes

This is a default prior, not a theorem.
The final bundle size should depend on memory length and structural complexity.

The justification is:

- English discourse frequently reuses short formulaic spans, with `4-word bundles` being a common practical unit in corpus studies.
- Chinese lexical units are usually short. Different corpora report average word lengths around `1.15` to `1.61` Chinese characters per word depending on genre.
- If a memory stays too large, one stale subcondition can poison the whole item.
- If a memory is split too aggressively, the graph becomes dense and black-box-like.

Sources:
- HNZ corpus statistics: average word length `1.15` chars/word  
  https://faculty.washington.edu/fxia/hnz/v1/v1-stat.html
- Chinese clinical segmentation corpus: average word length `1.5` chars/word  
  https://bmcmedinformdecismak.biomedcentral.com/articles/10.1186/s12911-019-0770-7
- CGW news corpus overview: average word length around `1.51-1.58` chars/word  
  https://ckip.iis.sinica.edu.tw/data/paper/journal/2015-JCLMS-huang-corpus.pdf

Inference:

- local recall should target short spans first
- memory compilation should preserve local substructure
- stale conditions should be isolated to specific nodes or edges instead of collapsing the whole memory

Practical rule:

- short, structurally simple memories may compile to `2-3` nodes
- medium memories should usually compile to `3-6` nodes
- long or highly structured memories may compile to more nodes if the split preserves clear local roles

So the real design target is not a fixed count.
It is adaptive node bundling with a sparse upper bound.

## 5. Trigger Windows

The current V8 prototype uses whitespace-driven buffering in `associative-scanner.ts`.
That is not acceptable for Chinese-heavy workloads.

V8 should switch to char- and boundary-aware windows.

### Proposed online windows

| Window | English heuristic | Chinese heuristic | Purpose |
|---|---|---|---|
| `micro` | `24-48` chars | `12-24` chars | lexical ignition, local phrase cue |
| `meso` | `96-192` chars | `64-128` chars | sentence / clause semantics |
| `macro` | `256-512` chars | `192-384` chars | rolling thought state |

These numbers are heuristics derived from:

- English tokenization rule-of-thumb: `1 token ~= 4 chars`, `1 token ~= 0.75 word`
- Chinese short-word distributions and sentence-length statistics
- the need to sample often enough for online recall without exploding compute

Source for the English token heuristic:
- OpenAI Help Center, "What are tokens and how to count them?"  
  https://help.openai.com/en/articles/4936856-understanding-tokens

These windows are intentionally in chars, not model tokens:

- they are easier to compute inside the stream hook
- they are tokenizer-agnostic
- later versions can keep a parallel token counter if needed

### Boundary policy

Checks should run at:

- punctuation boundaries
- code fence boundaries
- paragraph boundaries
- hard char thresholds

Not every delta should trigger a full scan.

## 6. Graph Storage

The graph should not live in a single JSON file.

Proposed layout:

```text
.memory/graph/
  nodes_episodic.jsonl
  nodes_semantic.jsonl
  nodes_procedural.jsonl
  edges_associative.jsonl
  edges_structural.jsonl
  edges_supersession.jsonl
  trigger_lexicon.json
  embedding_index/
```

Why JSONL:

- append-friendly
- easy to diff and inspect
- easy to stream into small indexes
- compatible with offline LLM output cleaning pipelines

Why MD still matters:

- the graph is optimized for fast computation
- the MD files remain optimized for human review, audit, and handoff
- recalled node bundles should resolve back to the relevant MD source when constructing the injected recall block

## 6.1 Event Graph Window

Events should be compiled into graph nodes by default.

Reason:

- event memory has already been filtered once compared with the raw log
- many useful recalls start from concrete discoveries, failures, restart points, and recent project turns
- keeping events out of the graph would weaken the "A + B -> sudden recall" behavior

But episodic activation should stay local.

Proposed rule:

- maintain a rolling episodic subgraph over a bounded date window
- if the current task and stream cues do not activate a day or episode cluster, that day's event nodes stay silent
- semantic/procedural nodes remain globally available, while episodic nodes are selectively activated

This keeps the event graph small enough for fast online use without throwing away recent concrete memory.

## 7. Node Schema

Minimal node shape:

```json
{
  "id": "mn_...",
  "kind": "episodic|semantic|procedural",
  "role": "topic|workflow|constraint|condition|evidence|checkpoint",
  "text": "short normalized content",
  "source_ref": "evt_... or memory/knowledge/foo.md#node_...",
  "confidence": 0.0,
  "importance": 0.0,
  "last_used_at": "ISO-8601",
  "last_verified_at": "ISO-8601",
  "hit_count": 0,
  "adopt_count": 0
}
```

Notes:

- `text` must be short enough for fast matching, not a paragraph dump
- `source_ref` is mandatory so the graph can rehydrate back to MD or event content
- `confidence` and `importance` are not the same
- `adopt_count` tracks whether the agent actually used the recalled memory

## 8. Edge Schema

Edges should not carry a single undifferentiated weight.

Minimal edge shape:

```json
{
  "id": "me_...",
  "type": "associative|causal|constraint|workflow_next|same_topic|supersedes|valid_when|invalid_when",
  "src": "mn_...",
  "dst": "mn_...",
  "assoc_strength": 0.0,
  "utility": 0.0,
  "trust": 0.0,
  "freshness": 0.0,
  "context_fit": 0.0,
  "last_updated_at": "ISO-8601"
}
```

Why split edge scores:

- "not used" does not mean "false"
- "worked before but not here" should mostly hurt `context_fit` or `freshness`
- "user says never do this again" should hurt `trust` and maybe create a superseding edge
- "old condition changed" should often create `valid_when` / `invalid_when` links instead of deleting memory

## 9. Online Activation Model

V8 online recall should use a sparse damped propagation model.

Suggested form:

```text
h(t+1) = lambda * h(t) + U(t) + P * h(t) - I * h(t) + C(t)
```

Where:

- `h(t)` = node energy state
- `lambda` = decay / retention term
- `U(t)` = current stream injection
- `P` = typed forward propagation
- `I` = inhibition term
- `C(t)` = coincidence bonus for multi-cue convergence

### Injection gates

For each candidate node:

```text
u_i = a * g_lex + b * g_emb + c * g_ctrl + d * g_time
```

Where:

- `g_lex` = lexical / phrase trigger
- `g_emb` = local embedding similarity
- `g_ctrl` = alignment with current `goal / active task / latest user request`
- `g_time` = recency / resumption bonus

This keeps the graph from becoming a pure semantic nearest-neighbor system.

### Stability constraints

To prevent activation storms:

- top-k propagation per node
- hub penalty
- cooldown / refractory period for recently fired nodes
- typed edge multipliers
- bounded reverse propagation

### Recall selection policy

When multiple memories cross threshold:

- first emit only the top few highest-energy candidates
- if lower-ranked candidates remain high across later checkpoints, they may be injected afterward
- do not dump every threshold-crossing memory at once

This preserves the possibility of delayed "second-wave" recall without overwhelming the model.

Reverse propagation is useful, but it is not backpropagation in the gradient-descent sense.
It is local credit / blame propagation used for "multi-clue convergence" and retrospective association.

Its exact strength should remain configurable and be tuned by smoke tests rather than fixed by theory alone.

## 10. Recall Output Strategy

Graph trigger classification and graph storage are not the same thing.

After activation, recalled content should be inserted using three delivery tiers:

- `critical recall`
  - proven bugfix
  - verified workflow
  - hard user constraint
  - checkpoint / handoff / restart state
- `decision recall`
  - prior decision
  - stable preference
  - durable priority policy
- `background recall`
  - optional supporting context

Current rule:

- `critical` may interrupt and redirect
- `decision` may interrupt but should not automatically reprioritize
- `background` should behave as a candidate context block

This delivery tier is not the graph ontology.
It is the final insertion policy.

## 11. Hardening: Memory That Stops Softening

Some memories should eventually stop behaving like weak recall candidates.

V8 should support hardening into two cores:

- `agent identity core`
- `inter-agent protocol core`

Examples:

- stable operating habits that define the agent's long-term working style
- durable protocol language that multiple agents can share without renegotiation every session

Hardening condition should not be semantic similarity alone.

Minimum criteria:

- hit count over threshold
- adoption rate over threshold
- low harm rate
- stable across multiple sessions
- still aligned with the agent's declared identity or protocol role

Hardening output:

- higher recall priority
- stronger resistance to decay
- stricter change policy

## 12. Feedback Learning

V8 should distinguish at least these outcomes after recall:

- `accepted`
- `ignored`
- `not_reached`
- `misapplied`
- `contradicted`
- `superseded`
- `harmful`

Why this matters:

- an ignored memory may simply be irrelevant in this context
- a superseded memory may still be historically correct
- a harmful memory should be penalized strongly
- a contradicted memory may indicate source conflict and require review

This means feedback should do one of three things:

- local edge update
- queue-for-review
- create a new superseding or condition edge

Do not blindly slash a whole workflow because one invocation failed under one condition.

## 13. Sleep and Decay

Sleep should stay in the system.
It should not be replaced by graph-only updates.

But decay should not be uniform.

### Decay policy by substrate

- `raw events`
  - strongest decay
  - goal: remove low-value noise
- `episodic graph edges`
  - medium decay
  - goal: reduce stale local situation bindings
- `episodic node availability`
  - bounded by rolling date window and activation silence rules
  - old event nodes do not need to fire unless the current stream reactivates that episode cluster
- `semantic/procedural graph core`
  - no blind global half-life
  - instead update by:
    - repeated success
    - contradiction
    - supersession
    - long-term non-use
    - context mismatch

### Staleness suspicion

A memory should enter the update queue when multiple signals align, for example:

- its trigger distribution shifts significantly
- it is frequently recalled but rarely adopted
- adopted recalls increasingly fail
- newer evidence repeatedly conflicts with it
- neighboring nodes begin to capture most of its former activations

This should create a review candidate, not immediate deletion.

## 14. Offline Consolidation

Offline LLM consolidation should write structured output that is easy to sanitize and compile.

Preferred flow:

1. read raw event / MD source
2. emit structured MD blocks or JSONL candidates
3. sanitize
4. compile into nodes and edges
5. update indexes

Preferred storage target:

- graph indexes in JSONL / JSON
- long-form human-readable explanations still in MD

The compiler, not the LLM, should own final acceptance.

## 15. Benchmark Plan

First benchmark target:

- new session
- no prior conversational context
- only the memory system is allowed to recover project knowledge
- long document / PDF / book / database setting
- model must progressively read and memorize via tools instead of seeing the answer all at once

This benchmark is designed to answer the real product question:

"Can a fresh session recover the right detailed knowledge fast enough to work like a continuing agent?"

### Initial benchmark shape

- corpus source:
  - long scientific papers, books, or long QA corpora with answer keys
  - good candidates include LongBench single-document QA tasks, Qasper paper QA, and later PeerQA-style evidence retrieval
- ingestion rule:
  - the model may only read chunks incrementally
  - it may store findings through memory tools
  - later sessions must answer through memory recovery first
- scoring:
  - factual accuracy
  - recall latency
  - number of retrieval steps
  - drift rate
  - memory pollution rate

Reference benchmark source:
- LongBench (ACL 2024)  
  https://aclanthology.org/2024.acl-long.172/
- Qasper (NAACL 2021)  
  https://aclanthology.org/2021.naacl-main.365/

## 16. Gap Between Current Code and Target V8

Current repo status:

- `focus` has been redesigned into a passive ledger and checkpoint steering exists
- `critical / decision / background` insertion policy now exists in the stream wrapper
- the graph is still a single-file prototype with scalar edge weights
- the current scanner is still whitespace-biased and therefore not ready for Chinese-heavy streams
- offline compilation into multi-node bundles does not exist yet
- hardening into agent identity / inter-agent protocol cores does not exist yet

This means the current code is V8-inspired, not the final V8 architecture.

## 17. Proposed Implementation Order

1. replace the current scanner's whitespace windowing with char- and boundary-aware windows
2. define the JSONL graph schema and migration path from the single-file graph
3. add node-bundle compilation from events and knowledge MD
4. split scalar edge weight into multi-factor edge scores
5. add staleness suspicion queue and offline review pipeline
6. add hardening logic for identity and inter-agent protocol cores
7. build the first no-context long-document benchmark

## 18. Open Questions

- what is the best adaptive node-bundle rule for different memory lengths and structures?
- should procedural memories be compiled from MD only, or may high-confidence events become procedural nodes directly?
- should episodic nodes ever be directly injected, or only after graph-mediated summarization?
- how should the episodic date window expand or contract under different workloads?
- how much reverse propagation is useful before it becomes noise in practice?
- when should a memory become "hard core" versus merely "high confidence"?

These are the key design questions still open.
