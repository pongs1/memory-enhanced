/**
 * memory-enhanced — OpenClaw plugin entry point.
 *
 * Registers 4 agent tools:
 *   - memory_record:      Write structured events (dual-format JSONL + MD)
 *   - memory_explore:     Traverse association chains
 *   - memory_consolidate: Decay, archive, MEMORY.md regeneration
 *   - memory_status:      Health check and statistics
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
import { executeMemoryStatus } from "./tools/memory_status.js";
import {
    MemoryFocusParams,
    executeMemoryFocus,
} from "./tools/memory_focus.js";
import {
    MemoryScratchpadParams,
    executeMemoryScratchpad,
} from "./tools/memory_scratchpad.js";

import { paths, readJson, readFileOr } from "./utils.js";

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
            "entries, and regenerate MEMORY.md from knowledge files. This handles " +
            "mechanical tasks at zero token cost. NOTE: knowledge *distillation* " +
            "(extracting knowledge from events) still requires you to read the events " +
            "and write to memory/knowledge/*.md before calling this tool.",
        parameters: MemoryConsolidateParams,
        execute: (id: string, params: any, ctx: any) =>
            executeMemoryConsolidate(id, params, { ...ctx, config: pluginConfig }),
    });

    // --- memory_status ---
    api.registerTool({
        name: "memory_status",
        description:
            "Show memory system health: directory structure, file counts, " +
            "MEMORY.md size, event/knowledge/skill statistics, and warnings. " +
            "No parameters needed.",
        parameters: { type: "object", properties: {}, required: [] },
        execute: executeMemoryStatus,
    });

    // --- memory_focus ---
    api.registerTool({
        name: "memory_focus",
        description:
            "Manage the ADaPT focus stack (working memory queue). " +
            "Use 'status' at session start to recall state. " +
            "Use 'plan' to set goal/path/focus/siblings. " +
            "Use 'complete' to finish a task and auto-record insights. " +
            "Use 'push' to add pending tasks. " +
            "Automatically enforces a 7-chunk limit and prompts for 'overflow' to scratchpad.md.",
        parameters: MemoryFocusParams,
        execute: executeMemoryFocus,
    });

    // --- memory_scratchpad ---
    api.registerTool({
        name: "memory_scratchpad",
        description:
            "Manage Reasoning and Verification notes in scratchpad.md. " +
            "Use 'append' to log notes without overwriting. " +
            "Use 'refill' to bring overflow tasks from scratchpad back into the focus stack JSON.",
        parameters: MemoryScratchpadParams,
        execute: executeMemoryScratchpad,
    });

    // --- HOOKS ---
    api.on("before_agent_start", async (event: any, ctx: { workspaceDir: string }) => {
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const p = paths(workspace);
        const sections: string[] = [];

        // L1: Active Focus (MD Frontend)
        const focusMd = readFileOr(p.focusStackMd, "").trim();
        if (focusMd) {
            sections.push(`## 🎯 Active Focus\n${focusMd}`);
        }

        if (sections.length > 0) {
            return {
                prependSystemContext: `<!-- Memory Context (auto-injected) -->\n${sections.join("\n\n")}\n<!-- End Memory Context -->`
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

        const extractText = (msg: any) => {
            if (!msg) return "";
            if (typeof msg.content === "string") return msg.content;
            if (Array.isArray(msg.content)) {
                return msg.content.map((c: any) => c.text || "").join("\n");
            }
            return "";
        };

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
