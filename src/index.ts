/**
 * memory-enhanced — OpenClaw plugin entry point.
 *
 * Registers 2 agent tools:
 *   - memory_consolidate: Build V8 clean-slate graph from session traces
 *   - memory_working:     Passive working-memory ledger & scratchpad
 *
 * These complement (not replace) the built-in memory_search and memory_get tools.
 */

import {
    MemoryConsolidateParams,
    executeMemoryConsolidate,
} from "./tools/memory_consolidate.js";
import {
    executeMemoryWorking,
    MemoryWorkingParams,
} from "./tools/memory_working.js";

import {
    isSyntheticControlRequest,
    isIdleTask,
    loadWorkingMemoryState,
    normalizeUserRequest,
    renderInjectedWorkingMemory,
    summarizeUserRequestForTask,
    shouldSwitchToLatestUserRequest,
    syncLatestUserRequest,
    writeWorkingMemoryState,
} from "./utils.js";
import { registerStreamWrapper } from "./hooks/wrap-stream-fn.js";
import {
    findMatchingNodes,
    isExplicitMemoryAffirmation,
    isExplicitMemoryCorrection,
    recordFeedback,
    refreshFeedbackStore,
} from "./v8/feedback-store.js";
import { takeRecentRecallTraces } from "./v8/feedback-runtime.js";
import type { V8ScannerConfig } from "./v8/types_v8.js";

// @ts-ignore
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default function register(api: OpenClawPluginApi) {
    const pluginConfig = api.config as
        | {
            outputCheckpointChars?: number;
            outputCheckpointCooldownChars?: number;
            outputCheckpointBoundarySlackChars?: number;
            outputCheckpointMaxInterrupts?: number;
            outputCheckpointDriftThreshold?: number;
            outputCheckpointTailChars?: number;
            enableV8GraphRecall?: boolean;
            v8CleanSlateMode?: boolean;
            v8SessionTraceDir?: string;
            v8PackCacheTtlDays?: number;
            v8ScannerConfig?: Partial<V8ScannerConfig>;
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
    const extractCurrentPromptUserText = (value: string) => {
        const withoutInjected = value
            .replace(/<!-- Memory Context \(Live\) -->[\s\S]*?<!-- End Memory Context -->\s*/g, "")
            .trim();
        if (!withoutInjected) {
            return "";
        }

        const timestampTail =
            withoutInjected.match(/\[[^\]]+\]\s*([\s\S]+)$/)?.[1]?.trim() ||
            withoutInjected;
        const lastLine =
            timestampTail
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .pop() || timestampTail;

        const normalizedTail = normalizeUserRequest(lastLine);
        if (normalizedTail) {
            return normalizedTail;
        }

        return normalizeUserRequest(timestampTail);
    };
    const resolveIncomingUserRequest = (event: any, fallbackMessages?: any[]) => {
        const candidates = [
            typeof event?.prompt === "string" ? extractCurrentPromptUserText(event.prompt) : "",
            extractText(event?.message),
            typeof event?.text === "string" ? event.text : "",
            typeof event?.body === "string" ? event.body : "",
            typeof event?.content === "string" ? event.content : "",
            extractText(event),
        ];

        for (const candidate of candidates) {
            const normalized = normalizeUserRequest(stripInjectedMemoryContext(candidate));
            if (normalized && !isSyntheticControlRequest(normalized)) {
                return normalized;
            }
        }

        const lastUserMsg = [...(fallbackMessages || [])].reverse().find((m: any) => m.role === "user");
        const lastUserText = normalizeUserRequest(extractText(lastUserMsg));
        if (lastUserText && !isSyntheticControlRequest(lastUserText)) {
            return lastUserText;
        }
        return "";
    };

    // OpenClaw runtime supplies a richer context object than the current plugin-sdk type exposes.
    // Keep runtime behavior intact and bridge the stale type surface here.
    const toolExecute = <T extends Function>(fn: T) => fn as any;

    // --- memory_consolidate ---
    api.registerTool({
        name: "memory_consolidate",
        label: "Consolidate Memory",
        description:
            "Build the memory graph directly from raw session traces. " +
            "This handles structural ingestion and graph materialization with zero token cost.",
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
        const sessionId = ctx?.sessionId || "default";
        const latestUserRequest = resolveIncomingUserRequest(event);
        if (!latestUserRequest) {
            return;
        }
        try {
            syncLatestUserRequest(workspace, latestUserRequest);
        } catch (e) { }

        if (isExplicitMemoryCorrection(latestUserRequest)) {
            refreshFeedbackStore(workspace);
            const recallTraces = takeRecentRecallTraces(sessionId);
            const recalledNodes = new Set<string>();
            for (const trace of recallTraces) {
                const traceNodes = new Set<string>();
                for (const bundle of trace.bundles) {
                    for (const nodeId of bundle.nodeIds) {
                        traceNodes.add(nodeId);
                        recalledNodes.add(nodeId);
                    }
                }
                if (traceNodes.size > 0) {
                    recordFeedback(
                        workspace,
                        Array.from(traceNodes).map((nodeId) => ({
                            nodeId,
                            kind: "suppress" as const,
                            delta: -0.35,
                            reason: "user_correction",
                            ttlDays: 30,
                            sessionId,
                            recallTraceId: trace.traceId,
                            source: "user" as const,
                            label: "memory_content_error",
                        }))
                    );
                }
            }

            const positiveCandidates = findMatchingNodes(
                workspace,
                latestUserRequest,
                2,
                0.22
            ).filter((nodeId) => !recalledNodes.has(nodeId));

            if (positiveCandidates.length > 0) {
                recordFeedback(
                    workspace,
                    positiveCandidates.map((nodeId) => ({
                        nodeId,
                        kind: "reinforce" as const,
                        delta: 0.2,
                        reason: "user_correction_reinforce",
                        ttlDays: 7,
                        sessionId,
                        recallTraceId: recallTraces[recallTraces.length - 1]?.traceId,
                        source: "user" as const,
                        label: "memory_helped",
                    }))
                );
            }
        } else if (isExplicitMemoryAffirmation(latestUserRequest)) {
            refreshFeedbackStore(workspace);
            const recallTraces = takeRecentRecallTraces(sessionId);
            for (const trace of recallTraces) {
                const traceNodes = new Set<string>();
                for (const bundle of trace.bundles) {
                    for (const nodeId of bundle.nodeIds) {
                        traceNodes.add(nodeId);
                    }
                }
                if (traceNodes.size === 0) continue;
                recordFeedback(
                    workspace,
                    Array.from(traceNodes).map((nodeId) => ({
                        nodeId,
                        kind: "reinforce" as const,
                        delta: 0.15,
                        reason: "user_confirmation",
                        ttlDays: 14,
                        sessionId,
                        recallTraceId: trace.traceId,
                        source: "user" as const,
                        label: "memory_helped",
                    }))
                );
            }
        }
    });

    api.on("before_prompt_build", async (event: any, ctx: any) => {
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const sections: string[] = [];
        const sid = ctx?.sessionId || "default";
        const messages = event.messages || [];
        const latestUserRequest = resolveIncomingUserRequest(event, messages);
        const currentState = writeWorkingMemoryState(workspace, loadWorkingMemoryState(workspace));
        const previousActiveTask = currentState.active_task;
        let workingState = currentState;

        try {
            if (latestUserRequest) {
                workingState = syncLatestUserRequest(workspace, latestUserRequest);
            }
        } catch (e) { }

        // L1: Passive working-memory ledger, always injected from source-of-truth JSON.
        try {
            const ledgerMd = renderInjectedWorkingMemory(workingState).trim();
            if (ledgerMd) {
                sections.push(`## Task Ledger\n${ledgerMd}`);
            }
        } catch (e) { }

        const isNewSession = messages.filter((m: any) => m.role === "user").length <= 1 && messages.filter((m: any) => m.role === "assistant").length === 0;
        const authoritativeLatestUserRequest = workingState.last_user_request || latestUserRequest;
        const taskSwitchDetected = authoritativeLatestUserRequest
            ? shouldSwitchToLatestUserRequest(currentState, authoritativeLatestUserRequest)
            : false;
        const latestUserTaskTitle = authoritativeLatestUserRequest
            ? summarizeUserRequestForTask(authoritativeLatestUserRequest, 220) || authoritativeLatestUserRequest
            : "";

        const latestUserLine = latestUserTaskTitle
            ? `> - Latest User Request: ${latestUserTaskTitle.slice(0, 220)}${latestUserTaskTitle.length > 220 ? "..." : ""}`
            : `> - Latest User Request: (none captured)`;

        if (
            taskSwitchDetected &&
            !isIdleTask(previousActiveTask) &&
            previousActiveTask !== workingState.active_task
        ) {
            sections.push(
                [
                    "## Priority Shift",
                    `- NOW: ${workingState.active_task}`,
                    `- PREVIOUS ACTIVE -> backlog: ${previousActiveTask}`,
                    "- Obey NOW first. Do not keep executing the previous active task unless the user explicitly asks for it.",
                ].join("\n")
            );
        }

        if (isNewSession && !isIdleTask(workingState.active_task)) {
            sections.push(
                [
                    "## Session Resume",
                    `- Existing active task: ${workingState.active_task}`,
                    "- If the user's first message means continue/resume, keep this active task.",
                    "- If the user gives a new task, switch immediately and park the old task in backlog.",
                ].join("\n")
            );
        }

        const workingRuleStr = `> 🧭 **Working Memory Rule:**\n> - The latest user message is authoritative for this turn.\n${latestUserLine}\n> - Treat the task ledger as resumable backlog only.\n> - If backlog conflicts with the latest user request, follow the user request first.\n> - Never copy this injected block, timestamps, or markdown labels back into \`memory_working\`. Store only short plain task titles.`;
        const focusProtocolStr = [
            "> **Focus Protocol:**",
            "> - Keep a tiny private replan in this shape: `NOW / NEXT / DEFER`.",
            "> - If the user changed direction, silently re-rank before answering.",
            "> - If you update `memory_working`, use only short plain task titles.",
            "> - If the tool rejects your write, retry once with shorter labels instead of storing paragraphs.",
        ].join("\n");

        sections.push(workingRuleStr);
        sections.push(focusProtocolStr);

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
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const msgs = event?.messages || [];

        // Find last user message
        const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
        const lastAssistant = [...msgs].reverse().find((m: any) => m.role === "assistant");

        if (!lastUser && !lastAssistant) return;

        const userText = lastUser ? extractCurrentPromptUserText(extractText(lastUser)) : "";
        const asstText = extractText(lastAssistant);

        if (userText && !isSyntheticControlRequest(userText)) {
            try {
                syncLatestUserRequest(workspace, userText);
            } catch (e) { }
        }
    });
}
