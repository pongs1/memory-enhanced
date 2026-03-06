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

interface PluginApi {
    registerTool(
        toolDef: {
            name: string;
            description: string;
            parameters: unknown;
            execute: (id: string, params: any) => Promise<any>;
        },
        opts?: { optional?: boolean }
    ): void;
    config?: Record<string, unknown>;
}

export default function register(api: PluginApi) {
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
        execute: (id, params) =>
            executeMemoryConsolidate(id, params, pluginConfig),
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
}
