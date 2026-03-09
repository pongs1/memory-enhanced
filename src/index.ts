/**
 * memory-enhanced — OpenClaw plugin entry point.
 *
 * Registers 4 agent tools:
 *   - memory_record:      Write structured events (dual-format JSONL + MD)
 *   - memory_explore:     Traverse association chains
 *   - memory_consolidate: Decay, archive, MEMORY_INDEX.md regeneration
 *   - memory_working:     Passive working-memory ledger & scratchpad
 *
 * These complement (not replace) the built-in memory_search and memory_get tools.
 */

import {
    MemoryRecordParams,
    executeMemoryRecord,
} from "./tools/memory_record.js";
import {
    MemoryExploreParams,
    executeMemoryExplore,
} from "./tools/memory_explore.js";
import {
    MemoryConsolidateParams,
    executeMemoryConsolidate,
} from "./tools/memory_consolidate.js";
import {
    executeMemoryWorking,
    MemoryWorkingParams,
} from "./tools/memory_working.js";

import {
    countWorkingMemoryTasks,
    loadWorkingMemoryState,
    paths,
    renderWorkingMemory,
    touchWorkingMemoryState,
} from "./utils.js";
import { registerStreamWrapper } from "./hooks/wrap-stream-fn.js";

// @ts-ignore
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default function register(api: OpenClawPluginApi) {
    const pluginConfig = api.config as
        | {
            halfLifeDays?: number;
            archiveThreshold?: number;
            memoryMdMaxChars?: number;
        }
        | undefined;

    const extractText = (msg: any) => {
        if (!msg) return "";
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
            return msg.content.map((c: any) => c.text || "").join("\n");
        }
        return "";
    };

    // --- memory_record ---
    api.registerTool({
        name: "memory_record",
        description:
            "Record an important event in dual format (structured JSONL + searchable Markdown). " +
            "Use this for decisions, preferences, insights, errors, and corrections that are " +
            "worth preserving. Returns the generated event ID for association linking. " +
            "Note: casual chat and raw tool outputs should NOT be recorded (session JSONL " +
            "already captures those).",
        parameters: MemoryRecordParams,
        execute: executeMemoryRecord,
    });

    // --- memory_explore ---
    api.registerTool({
        name: "memory_explore",
        description:
            "Traverse association chains starting from an event ID (evt_*) or knowledge " +
            "entry ID (ke_*). Follows linked entries up to the specified depth, calculates " +
            "relevance scores (importance + association density), and reinforces accessed " +
            "entries (resets their decay score). Use this when a retrieved memory has " +
            "associations you want to investigate.",
        parameters: MemoryExploreParams,
        execute: executeMemoryExplore,
    });

    // --- memory_consolidate ---
    api.registerTool({
        name: "memory_consolidate",
        description:
            "Run structural consolidation: apply decay to old events, archive low-score " +
            "entries, and regenerate MEMORY_INDEX.md from knowledge files. This handles " +
            "mechanical tasks at zero token cost. NOTE: knowledge *distillation* " +
            "(extracting knowledge from events) still requires you to read the events " +
            "and write to memory/knowledge/*.md before calling this tool.",
        parameters: MemoryConsolidateParams,
        execute: (id: string, params: any, ctx: any) =>
            executeMemoryConsolidate(id, params, { ...ctx, config: pluginConfig }),
    });

    // --- memory_working ---
    api.registerTool({
        name: "memory_working",
        description:
            "Manage the passive working-memory ledger and scratchpad. " +
            "The ledger tracks goal, active task, queued next tasks, deferred tasks, and recently completed work. " +
            "Use 'plan' to reset the ledger, 'reprioritize' to move a new task to the top, " +
            "'complete' to finish the active task, 'defer' to park a task, and 'push' to queue more work. " +
            "Use 'scratchpad_append' for rough notes and 'scratchpad_refill' to recover parked tasks.",
        parameters: MemoryWorkingParams,
        execute: executeMemoryWorking,
    });

    // --- HOOKS ---
    registerStreamWrapper(api, pluginConfig);

    // Cognitive Pulse Ticker to track continuous tool executions without memory updates
    const sessionTickers = new Map<string, number>();

    api.on("after_tool_call", async (event: any, ctx: any) => {
        const toolName = event.toolName || "";
        const sid = ctx?.sessionId || "default";

        // If the agent uses a memory tool, it resets its cognitive pressure
        if (toolName.startsWith("memory_")) {
            sessionTickers.set(sid, 0);
            return;
        }

        // Otherwise, cognitive pressure increases
        const ticks = (sessionTickers.get(sid) || 0) + 1;
        sessionTickers.set(sid, ticks);
    });

    api.on("before_prompt_build", async (event: any, ctx: any) => {
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const p = paths(workspace);
        const sections: string[] = [];
        const sid = ctx?.sessionId || "default";

        // L1: Passive working-memory ledger, always injected from source-of-truth JSON.
        try {
            const workingState = loadWorkingMemoryState(workspace);
            const ledgerMd = renderWorkingMemory(workingState).trim();
            if (ledgerMd) {
                sections.push(`## Task Ledger\n${ledgerMd}`);
            }
        } catch (e) { }

        // --- Telemetry Calculation (Zero LLM Token Cost) ---
        let unconsolidatedCount = 0;
        let trackedTasks = 0;
        let deferredTasks = 0;
        try {
            const fs = await import("node:fs");
            const path = await import("node:path");

            // Unconsolidated events
            const eventsDir = path.join(workspace, ".memory", "events");
            if (fs.existsSync(eventsDir)) {
                const files = fs.readdirSync(eventsDir).filter((f: string) => f.endsWith(".jsonl"));
                for (const f of files) {
                    const content = fs.readFileSync(path.join(eventsDir, f), "utf-8").trim();
                    if (content) {
                        const lines = content.split("\n").filter((l: string) => l.trim());
                        for (const line of lines) {
                            try {
                                const ev = JSON.parse(line);
                                if (!ev.consolidated) unconsolidatedCount++;
                            } catch (e) { }
                        }
                    }
                }
            }

            const workingState = loadWorkingMemoryState(workspace);
            trackedTasks = countWorkingMemoryTasks(workingState);
            deferredTasks = workingState.deferred_tasks.length;
        } catch (e) { }

        const messages = event.messages || [];
        const isNewSession = messages.filter((m: any) => m.role === "user").length <= 1 && messages.filter((m: any) => m.role === "assistant").length === 0;
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
        const lastUserText = extractText(lastUserMsg).replace(/\s+/g, " ").trim();
        const latestUserLine = lastUserText
            ? `> - Latest User Request: ${lastUserText.slice(0, 220)}${lastUserText.length > 220 ? "..." : ""}`
            : `> - Latest User Request: (none captured)`;

        const memoryIndexStr = `> 📁 **Available Memory Index (Partial):**\n> - \`memory/knowledge/user-prefs.md\` (User preferences & coding style)\n> - \`memory/knowledge/architecture.md\` (System design decisions)\n> - \`memory/YYYY-MM-DD.md\` (Recent historical events)`;
        const telemetryStr = `> 📊 **System Health Telemetry:**\n> - Unconsolidated Events: ${unconsolidatedCount} (If > 3, consider calling \`memory_consolidate\`)\n> - Working Ledger: ${trackedTasks} active/next task(s), ${deferredTasks} deferred`;
        const workingRuleStr = `> 🧭 **Working Memory Rule:**\n> - The latest user message is authoritative for this turn.\n${latestUserLine}\n> - Treat the task ledger as resumable backlog only. If it conflicts with the latest user request, serve the user request first and update the ledger afterward.`;

        sections.push(workingRuleStr);

        if (isNewSession) {
            sections.push(`> [SYSTEM NOTIFICATION: COGNITIVE WAKE-UP]\n> You are waking up to a new session or beginning a complex task. Before proceeding, perform an explicit Context Check:\n> \n> 1. Are you aware of the user's specific definitions, rules, or long-term preferences?\n> 2. Do you have the historical architecture or constraints for the current project?\n>\n${telemetryStr}\n>\n${memoryIndexStr}\n>\n> ⚡ **MANDATORY DIRECTIVE**:\n> IF you lack the necessary context to fulfill the user's request flawlessly, you MUST use the \`read\` or \`memory_explore\` tool to fetch the exact file contents from the index above. IF you already have the context, proceed without reading.`);
        } else {
            // Cognitive Pulse Injection
            const ticks = sessionTickers.get(sid) || 0;
            if (ticks >= 5) {
                sections.push(`> ⚠️ **[SYSTEM INTERRUPT: COGNITIVE OVERLOAD DETECTED]**\n> You have executed ${ticks} consecutive steps. Your operating context may be saturated, or you may be suffering from task tunnel vision.\n>\n${telemetryStr}\n>\n${memoryIndexStr}\n>\n> ⚡ **REQUIRED ACTION**: \n> 1. Does your current blocker match anything in the long-term index? If so, evaluate if you need to call \`read\` or \`memory_explore\`.\n> 2. You MUST update your \`memory_working\` ledger to reflect your current stage.\n> 3. You MUST save your intermediate findings via \`memory_record\` before resuming the task.`);
                sessionTickers.set(sid, 0);
            }
        }

        if (sections.length > 0) {
            return {
                prependContext: `<!-- Memory Context (Live) -->\n${sections.join("\n\n")}\n<!-- End Memory Context -->`
            };
        }
        return {};
    });

    api.on("agent_end", async (event: any, ctx: { workspaceDir: string }) => {
        // L2: Auto-record user intent & assistant reply
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const msgs = event?.messages || [];

        // Find last user message
        const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
        const lastAssistant = [...msgs].reverse().find((m: any) => m.role === "assistant");

        if (!lastUser && !lastAssistant) return;

        const userText = extractText(lastUser);
        const asstText = extractText(lastAssistant);
        const combined = `${userText}\n${asstText}`.toLowerCase();

        if (userText.trim()) {
            touchWorkingMemoryState(workspace, {
                last_user_request: userText.replace(/\s+/g, " ").trim().slice(0, 240),
            });
        }

        // Heuristics for auto-recording
        const triggerKeywords = [
            "decided", "preference", "remember", "prefer",
            "决定", "偏好", "记住", "以后都", "不要", "喜欢"
        ];

        const shouldRecord = triggerKeywords.some(kw => combined.includes(kw));

        if (shouldRecord) {
            const recordContent = `User: ${userText.substring(0, 500)}\nAsst: ${asstText.substring(0, 500)}`;
            try {
                // Pass a mocked toolCallId and input
                await executeMemoryRecord("auto_hook", {
                    content: recordContent,
                    type: "insight",
                    importance: 0.6,
                    tags: ["auto-recorded"],
                    associations: []
                }, ctx);
            } catch (e) {
                // ignore errors in background hook
            }
        }
    });
}
