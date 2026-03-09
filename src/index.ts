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
    loadWorkingMemoryState,
    normalizeUserRequest,
    renderWorkingMemory,
    syncLatestUserRequest,
    writeWorkingMemoryState,
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
            outputCheckpointChars?: number;
            outputCheckpointCooldownChars?: number;
            outputCheckpointBoundarySlackChars?: number;
            outputCheckpointMaxInterrupts?: number;
            outputCheckpointDriftThreshold?: number;
            outputCheckpointTailChars?: number;
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

    const stripInjectedMemoryContext = (value: string) => {
        return value
            .replace(/<!-- Memory Context \(Live\) -->[\s\S]*?<!-- End Memory Context -->/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    };

    const resolveIncomingUserRequest = (event: any, fallbackMessages?: any[]) => {
        const lastUserMsg = [...(fallbackMessages || [])].reverse().find((m: any) => m.role === "user");
        const lastUserText = normalizeUserRequest(extractText(lastUserMsg));
        if (lastUserText) {
            return lastUserText;
        }

        const candidates = [
            typeof event?.text === "string" ? event.text : "",
            typeof event?.body === "string" ? event.body : "",
            typeof event?.content === "string" ? event.content : "",
            extractText(event?.message),
            typeof event?.prompt === "string" ? stripInjectedMemoryContext(event.prompt) : "",
            extractText(event),
        ];

        for (const candidate of candidates) {
            const normalized = normalizeUserRequest(stripInjectedMemoryContext(candidate));
            if (normalized) {
                return normalized;
            }
        }
        return "";
    };

    // OpenClaw runtime supplies a richer context object than the current plugin-sdk type exposes.
    // Keep runtime behavior intact and bridge the stale type surface here.
    const toolExecute = <T extends Function>(fn: T) => fn as any;

    // --- memory_record ---
    api.registerTool({
        name: "memory_record",
        label: "Record Memory",
        description:
            "Record an important event in dual format (structured JSONL + searchable Markdown). " +
            "Use this for decisions, preferences, insights, errors, and corrections that are " +
            "worth preserving. Returns the generated event ID for association linking. " +
            "Note: casual chat and raw tool outputs should NOT be recorded (session JSONL " +
            "already captures those).",
        parameters: MemoryRecordParams,
        execute: toolExecute(executeMemoryRecord),
    });

    // --- memory_explore ---
    api.registerTool({
        name: "memory_explore",
        label: "Explore Memory",
        description:
            "Traverse association chains starting from an event ID (evt_*) or knowledge " +
            "entry ID (ke_*). Follows linked entries up to the specified depth, calculates " +
            "relevance scores (importance + association density), and reinforces accessed " +
            "entries (resets their decay score). Use this when a retrieved memory has " +
            "associations you want to investigate.",
        parameters: MemoryExploreParams,
        execute: toolExecute(executeMemoryExplore),
    });

    // --- memory_consolidate ---
    api.registerTool({
        name: "memory_consolidate",
        label: "Consolidate Memory",
        description:
            "Run structural consolidation: apply decay to old events, archive low-score " +
            "entries, and regenerate MEMORY_INDEX.md from knowledge files. This handles " +
            "mechanical tasks at zero token cost. NOTE: knowledge *distillation* " +
            "(extracting knowledge from events) still requires you to read the events " +
            "and write to memory/knowledge/*.md before calling this tool.",
        parameters: MemoryConsolidateParams,
        execute: toolExecute((id: string, params: any, ctx: any) =>
            executeMemoryConsolidate(id, params, { ...ctx, config: pluginConfig })),
    });

    // --- memory_working ---
    api.registerTool({
        name: "memory_working",
        label: "Working Memory",
        description:
            "Manage the passive working-memory ledger and scratchpad. " +
            "The ledger tracks goal, active task, queued next tasks, deferred tasks, and recently completed work. " +
            "Use 'plan' to reset the ledger, 'reprioritize' to move a new task to the top, " +
            "'complete' to finish the active task, 'defer' to park a task, and 'push' to queue more work. " +
            "Use 'scratchpad_append' for rough notes and 'scratchpad_refill' to recover parked tasks.",
        parameters: MemoryWorkingParams,
        execute: toolExecute(executeMemoryWorking),
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

    api.on("message_received", async (event: any, ctx: any) => {
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const latestUserRequest = resolveIncomingUserRequest(event);
        if (!latestUserRequest) {
            return;
        }
        try {
            syncLatestUserRequest(workspace, latestUserRequest);
        } catch (e) { }
    });

    api.on("before_prompt_build", async (event: any, ctx: any) => {
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const sections: string[] = [];
        const sid = ctx?.sessionId || "default";
        const messages = event.messages || [];
        const latestUserRequest = resolveIncomingUserRequest(event, messages);
        let workingState = writeWorkingMemoryState(workspace, loadWorkingMemoryState(workspace));

        try {
            if (latestUserRequest) {
                workingState = syncLatestUserRequest(workspace, latestUserRequest);
            }
        } catch (e) { }

        // L1: Passive working-memory ledger, always injected from source-of-truth JSON.
        try {
            const ledgerMd = renderWorkingMemory(workingState).trim();
            if (ledgerMd) {
                sections.push(`## Task Ledger\n${ledgerMd}`);
            }
        } catch (e) { }

        const isNewSession = messages.filter((m: any) => m.role === "user").length <= 1 && messages.filter((m: any) => m.role === "assistant").length === 0;

        const latestUserLine = latestUserRequest
            ? `> - Latest User Request: ${latestUserRequest.slice(0, 220)}${latestUserRequest.length > 220 ? "..." : ""}`
            : `> - Latest User Request: (none captured)`;

        const workingRuleStr = `> 🧭 **Working Memory Rule:**\n> - The latest user message is authoritative for this turn.\n${latestUserLine}\n> - Treat the task ledger as resumable backlog only.\n> - If backlog conflicts with the latest user request, follow the user request first.\n> - Never copy this injected block, timestamps, or markdown labels back into \`memory_working\`. Store only short plain task titles.`;

        sections.push(workingRuleStr);

        if (!isNewSession) {
            const ticks = sessionTickers.get(sid) || 0;
            if (ticks >= 5) {
                sections.push(`> ⚠️ **Cognitive Check:** You have executed ${ticks} consecutive non-memory steps.\n> - Re-read the latest user request before continuing.\n> - If your active task is stale, update \`memory_working\` after you answer.`);
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

    api.on("agent_end", async (event: any, ctx: { workspaceDir?: string }) => {
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
