# 🧠 memory-enhanced — Biomorphic 4-Layer Cognitive Layer (V8)

[**English**](./README.md) | [**中文简体**](./README_zh.md)

> **"Why does your AI always forget the coding style you just explained yesterday? Why do solved bugs repeat themselves 3 weeks later? Why does your Agent lose its way after a dozen tool calls?"**

The `memory-enhanced` plugin transforms OpenClaw from a "goldfish memory" chat box into a **long-term intelligent agent** with active consolidation, automatic forgetting, and associative recall.

---

## 🏗️ Architecture Overview: 4 Bio-Inspired Layers

| Layer | Responsibility | Storage Location | What does the AI feel? |
|---|---|---|---|
| **L1: Working Memory** | Active tasks & rough notes | `.memory/active/` | On wake, it is **forced** to see the 7 priority tasks and logic drafts—no search required. |
| **L2: Episodic Memory** | Events, decisions & "Aha!" moments | `.memory/events/` | Recorded like a personalized diary; fragments are recalled based on the "thinking direction." |
| **L3: Semantic Memory** | Distilled knowledge & preferences | `memory/knowledge/` | The "essence" of past events, no longer cluttered with raw messages. |
| **L4: Procedural Memory** | Verified "How-To" SOPs | `memory/skills/` | When facing the same problem, it checks the manual instead of reinventing the wheel. |

---

## 🧬 V8 Tech: Subconscious Associative Recall (SAR)

We no longer ask the AI to "search" through thousands of files. Instead, we mimic human **"subconscious association."**

### 1. Thought Inertia Tracking (Formally "Momentum")
The system captures the AI's "thinking inertia." We don't just look at the last word; we calculate the **Vector Moving Average** of the recent context:
$$Thought Center = 0.7 \cdot Current Input + 0.3 \cdot Past Context$$
Just as thinking of "Microservices" warms up "K8s" and "Docker" in your brain before you even say them.

### 2. Deep Symbolic Axons
We use offline LLMs (e.g., DeepSeek R1) to label and link memories in the background. These are not keyword matches, but **logical dependencies** and **metaphorical links**.
*   **Energy Spread**: When a thought hits a point, energy flows through "axons" (bidirectional) to pull deep-seated knowledge into the light.
*   **Hub Penalization**: To prevent generic terms (e.g., "Code") from triggering everything, the system automatically suppresses "Super-Hubs" using degree-centrality dampening.

### 3. Forced Context Injection
The ultimate solution for low LLM initiative. We bypass the LLM's "tool-calling preference." Using OpenClaw core Hooks, we **force highly relevant memories into the mind-model** before generation even starts. The AI doesn't think "Should I search?"; it just "knows" the background.

---

## ⚡ Why avoid the old Instruction Scripts (SKILL.md)?

1.  **Saving Money**: Saves about 2000 tokens per turn. Over time, this cuts 80% of API costs.
2.  **Zero Command Blindness**: Instruction scripts get drowned out by noise. Plugins use **native code execution**, independent of the LLM's obedience.
3.  **Real-Time Recall**: Millisecond response via ONNX CPU execution. The AI no longer pauses because it "can't remember."

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
1.  **Passive Ledger**: Working memory is always injected as a small task ledger (`Goal / Active / Next / Deferred / Done Recently`). The model does not need to "remember to check it."
2.  **User-First Priority**: The latest user request always outranks the stored ledger. Old tasks are resumable backlog, not marching orders.
3.  **Reorder, Don't Drift**: Use `memory_working reprioritize`, `complete`, and `defer` to keep long projects moving without letting stale tasks hijack a new turn.

---

## 🤝 Contributing & Feedback

Join us in building a stronger cognitive layer for agents! Licensed under MIT.
