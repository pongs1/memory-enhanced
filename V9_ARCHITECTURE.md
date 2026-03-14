# V9 Architecture: The Dual-System Cognitive Engine

Status: proposed  
Audience: maintainers, core agent-memory architects

This document defines the **V9 Memory Architecture**, derived from the rigorous separation of concerns discussed during the V8 evaluation. It explicitly discards the old "V9 Full-Feature Reference."

V9 introduces a fundamental paradigm shift for Agent Memory: **"The Graph is the Guide, the Archive is the Truth."**

It abandons the attempt to inject massive amounts of raw textual evidence directly into the LLM context via Spreading Activation. Instead, it fully implements a **Biomimetic Dual-System Architecture** (aligning with Daniel Kahneman's *Thinking, Fast and Slow*).

## 1. The Core Problem V9 Solves

In V8, the architecture successfully separated the graph from the raw text (Clean-Slate Source Policy). However, at runtime, V8's delivery mechanism required that **all ignited bundles carry their underlying large evidence spans** back into the LLM prompt.

This caused two fatal engineering issues:
1. **Token Bloat & Context Decay**: Injecting 3-4 bundles, each with 1,500 characters of raw evidence, completely destroys the LLM's active working context and eats budget rapidly.
2. **Tools Idiocy**: The LLM became passive. It no longer knew how or when to search for deeper files because the context was forcefully stuffed with text it didn't explicitly ask for.

V9 solves this by introducing **Graph-Augmented Interactive Retrieval**.

---

## 2. The Dual-System Architecture

V9 partitions Agent Memory into two distinct functional halves.

### 2.1 System 1: The Intuition Engine (Graph IR & Spreading Activation)
* **What it is:** The Micro/Meso/Macro memory graph.
* **What it stores:** Highly compressed Information Retrieval (IR) nodes. It stores *coordinates, state labels, and topological relations*, **not** heavy text.
* **How it triggers:** Biomimetic Spreading Activation continuously runs in the background. It is cheap, fast, and driven by the rolling conversational token stream and active `focus_stack.json`.
* **Output to LLM:** A lightweight "Map" or "Topic Context" (similar to *Mori's* topic injection or *Nocturne's* directory tree).
  * *Example output injected into prompt:* 
    `[Hot Context] Graph IR Activated: <Database Pool Refactoring (UUID: 8a4b)> - High relevance to user's 'latency' query. Evidence payload available in Archive.`

### 2.2 System 2: The Conscious Engine (LLM Tool Calling & Raw Archive)
* **What it is:** The full BM25 + Dense Vector Search engine acting over the immutable, raw session logs.
* **What it stores:** The absolute, uncompressed truth. The `Clean-Slate` raw evidence (chat logs, tool logs, terminal errors).
* **How it triggers:** The LLM actively decides to use search tools.
* **Output to LLM:** Precise, deeply verified raw text snippets.

---

## 3. The V9 Execution Pipeline

When the user asks, *"Why did the system crash when I uploaded a huge image?"*

1. **Stream Ignition (System 1):** The user's tokens trigger the graph. The graph activates `IR Node: 'Image Upload Out-Of-Memory (Meso)'` and `IR Node: 'Nginx Body Size Limit (Macro)'`.
2. **Context Assembly:** V9 does **NOT** query the vector database yet. It simply injects these two lightweight IR nodes into the system prompt as "Hot Hints."
3. **LLM Evaluation:** The LLM reads the user prompt, sees the Hot Hints, and realizes: *"I need the exact Nginx error code and the exact container timestamp."*
4. **Tool Execution (System 2):** The LLM autonomously executes `search_memory(query="Nginx Body Size Limit timeout", source="raw_archive")`.
5. **Final Generation:** The BM25+Vector archive returns the pristine, undisturbed raw server blocks. The LLM then generates a perfectly grounded response.

---

## 4. Key Advantages over V8 and SOTA

### 4.1 Curing the "Tool Laziness"
LLMs hate searching blindly in a Vector DB because they don't know what they don't know. V9's System 1 tells the LLM exactly *what* is available and *where* the boundaries of its knowledge lie. The LLM is essentially given an index card; it just needs to decide whether to fetch the book.

### 4.2 Local Context Unification (Inspired by Mori)
Instead of global graph explosions, V9 encourages creating dense local clusters or "Topics." If the user is arguing about a specific React component, the Graph activates the `[Topic: React Component X]` IR. The memory injected is a summary of the *State* of the conversation, keeping the LLM perfectly aligned with the immediate conversational branch.

### 4.3 Precise Version Control (Inspired by Nocturne Memory)
Because the Graph IR acts as a routing table, V9 allows nodes to possess explicit paths or states (e.g., `feature://auth/cookies → state: DEPRECATED`).
When the LLM sees `DEPRECATED` in the IR, it won't even bother searching the Vector DB for that line of reasoning. This completely avoids the fatal flaw of pure Vector RAG, where outdated information dominates the top-K recall.

---

## 5. Architectural Contract for V9

If you implement V9, you must adhere to these absolute rules:

1. **No Raw Text in the Graph:** The Graph must only store IR hooks, Topic Summaries, and relational schemas.
2. **Lazy Evidence Loading:** The `context_assembler` must never fetch raw `Evidence_Span` text automatically. It only injects the IR identifiers.
3. **Actionable Search Tools:** The LLM must be provided with robust `read_archive` and `search_archive(bm25_vector)` tools.
4. **Local Conflict Resolution:** Similar IR nodes must be strictly merged/updated during the consolidation phase to prevent graph node explosion. Do not let contradictory IR nodes coexist without an explicitly typed `supersedes` or `invalidates` edge.

By fully divorcing the **Topology (Mapping)** from the **Text (Archive)**, V9 achieves both lightning-fast context switching and mathematically rigorous evidence verification.
