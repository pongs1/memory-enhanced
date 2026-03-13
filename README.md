# 🧠 memory-enhanced — Evidence-Backed Cognitive Layer (V8)

[**English**](./README.md) | [**中文简体**](./README_zh.md)

> **"Why does your AI always forget the coding style you just explained yesterday? Why do solved bugs repeat themselves 3 weeks later? Why does your Agent lose its way after a dozen tool calls?"**

The `memory-enhanced` plugin transforms OpenClaw from a "goldfish memory" chat box into a **long-term intelligent agent** governed by a strict **evidence-backed** memory architecture and biomimetic associative recall.

---

## 🏗️ Architecture Overview: The Layers of V8

V8 eliminates the old event-centric RAG models and instead guarantees that every memory traces back to raw session evidence (Clean-Slate Default). The pipeline is split into distinct layers:

| Layer | Responsibility | Storage Location / Artifact |
|---|---|---|
| **L0: Control** | Active tasks, prioritization, and focus stack | `.memory/active/focus_stack.json` |
| **L1: Raw Store** | Immutable, append-only raw session logs and runtime tool observations | OpenClaw session traces, observations |
| **L2-L5: The Pipeline** | Normalization, Unitization (`micro/meso/macro`), Evidence Span Extraction, and bounded IR formulation | `.memory/graph/units.jsonl`, `evidence_spans.jsonl`, etc. |
| **L6: Memory Graph & Packs** | The 3-layer recall graph (`micro`, `meso`, `macro`), summary packs, and state packs | `.memory/graph/graph_nodes.jsonl`, `summary_packs.jsonl` |
| **L7: Context Assembly** | Dynamic injection of graph bundles, state, and evidence back into the runtime | *In-Memory Runtime* |

*(For full architecture details, schema definitions, and migration plans, see [V8_ARCHITECTURE.md](./V8_ARCHITECTURE.md) and [V8_SCHEMA_AND_PIPELINE.md](./V8_SCHEMA_AND_PIPELINE.md))*

---

## 🧬 V8 Tech: The Soul of the Machine

We no longer ask the AI to "search" through thousands of files. Instead, V8 relies on **Online Ignition** and sparse graph propagation.

### 1. Biomimetic Spreading Activation
Scanning the live stream and control anchors triggers "ignition" on relevant graph nodes. Energy then propagates sparsely across the network:
*   **Forward & Reverse Spread**: Energy moves forward to model likely continuations and backward for causal backtracking.
*   **Hub Penalization**: Generic high-degree nodes (e.g., "API") are suppressed to prevent noisy memory storms.
*   **Episodic Locality**: Day and episode windows gate episodic memory, preventing historical noise from flooding the active context.

### 2. The 3-Layer Graph Topology
Unlike flat knowledge graphs, V8 categorizes memory relationally across three distinct semantics:
*   **Micro**: Objects, facts, and exact evidence anchors.
*   **Meso**: Scene blocks, local strategies, and workflow steps.
*   **Macro**: Long-range phases, global states, and structural turning points.

### 3. Immediate Correction Loop (Hot-Patching)
If the user corrects a persistent error ("No, use MySQL, not Redis"), the system doesn't wait for a slow offline graph rebuild. It injects an instant **Shadow Node** (`BeliefState: Revised`) and applies a massive negative penalty to the outdated fact, hot-patching the live Context Assembly instantly.

### 4. Procedural Memory Caching
To avoid redundantly invoking LLM reasoning for settled history, V8 actively limits repetitive generation. Highly-active stable clusters (Activated Bundles) have their outputs cached into a `Memory Summary Pack` or `Structured State Pack`. This acts like human "procedural memory," turning expensive declarative reasoning into a fast structural shortcut.

---

## ⚡ Why avoid the old Instruction Scripts (SKILL.md)?

1.  **Evidence over Scripts**: V8 treats `knowledge` and `skill` as post-hoc artifacts (packs), not raw sources. If they stray from evidence, they decay.
2.  **Zero Command Blindness**: Instruction scripts get drowned out by LLM noise. Plugins use **native code execution**, enforcing rules independent of the LLM's adherence.
3.  **Real-Time Recall**: Millisecond response via ONNX trigger lexicons and efficient memory indexers. The AI no longer pauses because it "can't remember."

---

## 🚦 Quick Start

1.  **Clone**: Clone this repo into the OpenClaw extensions directory.
2.  **Install**: Run `pnpm install`.
3.  **Config**: Update `openclaw.json` to enable plugin mode and "Forced Injection" paths.
4.  **Init**: Create the `memory/` directory structure in your workspace.

**👉 [CLICK HERE: The Hyper-Detailed "Out-of-the-Box" Deployment Guide](./DEPLOYMENT_GUIDE.md)**

---

## 📜 Task Management Philosophy (ADaPT)

This project strictly follows the **ADaPT (Action Development and Project Tracking)** framework:
1.  **Passive Ledger**: Working memory (L0 Control) is always injected as a small task ledger (`Goal / Active / Next / Deferred / Done Recently`). The model does not need to "remember to check it."
2.  **User-First Priority**: The latest user request always outranks the stored ledger. When the ledger is idle, the newest user request is auto-promoted into `Active`.
3.  **Reorder, Don't Drift**: Use `memory_working reprioritize`, `complete`, and `defer` to keep long projects moving without letting stale tasks hijack a new turn.

---

## 🤝 Contributing & Feedback

Join us in building a stronger cognitive layer for agents! Licensed under MIT.
