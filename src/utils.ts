import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve the agent workspace path.
 * Plugin tools receive the working directory from OpenClaw context;
 * this helper provides a fallback.
 */
export function resolveWorkspace(cwd?: string): string {
    return cwd || process.env.OPENCLAW_WORKSPACE || process.cwd();
}

/** Ensure a directory exists (recursive). */
export function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/** Read a JSON file; return fallback if missing or invalid. */
export function readJson<T>(filePath: string, fallback: T): T {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return fallback;
    }
}

/** Write a JSON file atomically-ish (write-then-rename). */
export function writeJson(filePath: string, data: unknown): void {
    ensureDir(path.dirname(filePath));
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
}

/** Append a line to a file, creating it if needed. */
export function appendLine(filePath: string, line: string): void {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, line + "\n", "utf-8");
}

/** Read a file as string; return empty string if missing. */
export function readFileOr(filePath: string, fallback = ""): string {
    try {
        return fs.readFileSync(filePath, "utf-8");
    } catch {
        return fallback;
    }
}

/** Get today's date as YYYY-MM-DD. */
export function today(): string {
    return new Date().toISOString().slice(0, 10);
}

/** Get current time as HH:MM. */
export function nowTime(): string {
    return new Date().toTimeString().slice(0, 5);
}

/** Get current ISO timestamp. */
export function nowISO(): string {
    return new Date().toISOString();
}

export const DEFAULT_ACTIVE_TASK = "Awaiting next user request";
const LEGACY_IDLE_TASKS = new Set([
    DEFAULT_ACTIVE_TASK.toLowerCase(),
    "等待用户新指令",
    "done (pending new goal)",
    "none",
    "initializing",
    "refilling...",
]);
const WORKING_MEMORY_SCHEMA_VERSION = 2;
const CONTINUATION_REQUESTS = new Set([
    "continue",
    "continue.",
    "go on",
    "keep going",
    "继续",
    "继续。",
    "接着",
    "继续做",
    "往下",
]);

/** Standard workspace paths. */
export function paths(workspace: string) {
    return {
        // Searchable by memory_search + memory_get
        memoryDir: path.join(workspace, "memory"),
        knowledgeDir: path.join(workspace, "memory", "knowledge"),
        skillsVerified: path.join(workspace, "memory", "skills", "verified"),
        skillsDrafts: path.join(workspace, "memory", "skills", "drafts"),
        skillsRegistry: path.join(workspace, "memory", "skills", "_registry.json"),
        memoryIndex: path.join(workspace, "MEMORY_INDEX.md"),
        // Metadata (read tool only, not memory_get)
        dotMemory: path.join(workspace, ".memory"),
        associativeGraph: path.join(workspace, ".memory", "_associative_graph.json"),
        semanticCorpus: path.join(workspace, ".memory", "_semantic_corpus.json"),
        activeDir: path.join(workspace, ".memory", "active"),
        scratchpad: path.join(workspace, ".memory", "active", "scratchpad.md"),
        focusStack: path.join(workspace, ".memory", "active", "focus_stack.json"),
        focusStackMd: path.join(workspace, ".memory", "active", "focus_stack.md"),
        eventsDir: path.join(workspace, ".memory", "events"),
        eventsSchema: path.join(workspace, ".memory", "events", "_schema.json"),
        scriptsDir: path.join(workspace, ".memory", "scripts"),
        archiveDir: path.join(workspace, ".memory", "archive"),
        // Daily files (parameterized)
        dailyLog: (date: string) => path.join(workspace, "memory", `${date}.md`),
        dailyJsonl: (date: string) =>
            path.join(workspace, ".memory", "events", `${date}.jsonl`),
    };
}

/**
 * Count the next event sequence number for a given date's JSONL file.
 */
export function nextEventSeq(jsonlPath: string): number {
    try {
        const content = fs.readFileSync(jsonlPath, "utf-8").trim();
        if (!content) return 1;
        return content.split("\n").length + 1;
    } catch {
        return 1;
    }
}

/**
 * Parse all events from a JSONL file.
 */
export function readEvents(jsonlPath: string): MemoryEvent[] {
    try {
        const content = fs.readFileSync(jsonlPath, "utf-8").trim();
        if (!content) return [];
        return content
            .split("\n")
            .filter((l: string) => l.trim())
            .map((l: string) => JSON.parse(l) as MemoryEvent);
    } catch {
        return [];
    }
}

/**
 * Write events back to a JSONL file.
 */
export function writeEvents(jsonlPath: string, events: MemoryEvent[]): void {
    ensureDir(path.dirname(jsonlPath));
    const content = events.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(jsonlPath, content ? content + "\n" : "", "utf-8");
}

/**
 * Find a knowledge entry by ID across all knowledge files.
 */
export function findKnowledgeEntry(
    knowledgeDir: string,
    entryId: string
): { file: string; content: string } | null {
    if (!fs.existsSync(knowledgeDir)) return null;
    const files = fs
        .readdirSync(knowledgeDir)
        .filter((f: string) => f.endsWith(".md"));
    for (const file of files) {
        const content = fs.readFileSync(
            path.join(knowledgeDir, file),
            "utf-8"
        );
        const marker = `<!-- knowledge_entry: ${entryId} -->`;
        const endMarker = `<!-- /knowledge_entry -->`;
        const startIdx = content.indexOf(marker);
        if (startIdx === -1) continue;
        const endIdx = content.indexOf(endMarker, startIdx);
        if (endIdx === -1) continue;
        return {
            file,
            content: content.slice(startIdx, endIdx + endMarker.length),
        };
    }
    return null;
}

/** Memory event type definition. */
export interface MemoryEvent {
    id: string;
    timestamp: string;
    type: string;
    content: string;
    tags: string[];
    importance: number;
    associations: string[];
    consolidated: boolean;
    decay_score: number;
}

/** Focus stack structure. */
export interface WorkingMemoryState {
    schema_version: number;
    project_goal: string;
    context_path: string[];
    active_task: string;
    next_tasks: string[];
    deferred_tasks: string[];
    done_recent: string[];
    last_user_request: string;
    last_updated: string;
}

interface LegacyFocusStack {
    project_goal?: string;
    current_path?: unknown;
    current_focus?: unknown;
    pending_siblings?: unknown;
    last_updated?: unknown;
    context_path?: unknown;
    active_task?: unknown;
    next_tasks?: unknown;
    deferred_tasks?: unknown;
    done_recent?: unknown;
    last_user_request?: unknown;
    schema_version?: unknown;
}

function normalizeString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeUserRequest(value: string, maxChars = 240): string {
    return value
        .replace(/<!-- Memory Context \(Live\) -->[\s\S]*?<!-- End Memory Context -->/g, " ")
        .replace(/^\[[^\]]{1,80}\]\s*/, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxChars);
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const seen = new Set<string>();
    const items: string[] = [];

    for (const entry of value) {
        const text = normalizeString(entry);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push(text);
    }

    return items;
}

function normalizeTaskList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const seen = new Set<string>();
    const items: string[] = [];

    for (const entry of value) {
        const text = typeof entry === "string" ? normalizeUserRequest(entry) : "";
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push(text);
    }

    return items;
}

export function createDefaultWorkingMemoryState(): WorkingMemoryState {
    return {
        schema_version: WORKING_MEMORY_SCHEMA_VERSION,
        project_goal: "Not set",
        context_path: [],
        active_task: DEFAULT_ACTIVE_TASK,
        next_tasks: [],
        deferred_tasks: [],
        done_recent: [],
        last_user_request: "",
        last_updated: nowISO(),
    };
}

export function isIdleTask(task: string): boolean {
    const normalized = normalizeString(task).toLowerCase();
    return normalized === "" || LEGACY_IDLE_TASKS.has(normalized);
}

function tokenizeWorkingMemoryText(text: string): string[] {
    const englishWords = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    return [...englishWords, ...cjkChunks.map((chunk) => chunk.trim())];
}

export function hasMeaningfulTaskOverlap(activeTask: string, lastUserRequest: string): boolean {
    const activeTokens = new Set(tokenizeWorkingMemoryText(activeTask));
    const requestTokens = tokenizeWorkingMemoryText(lastUserRequest);

    if (activeTokens.size === 0 || requestTokens.length === 0) {
        return false;
    }

    return requestTokens.some((token) => activeTokens.has(token));
}

function dedupeWorkingTasks(tasks: string[], activeTask?: string): string[] {
    const seen = new Set<string>();
    const cleaned: string[] = [];

    for (const task of tasks) {
        const normalized = normalizeUserRequest(task, 240);
        if (!normalized || normalized === activeTask || seen.has(normalized)) continue;
        seen.add(normalized);
        cleaned.push(normalized);
    }

    return cleaned;
}

function isContinuationRequest(request: string): boolean {
    const normalized = normalizeUserRequest(request).toLowerCase();
    return CONTINUATION_REQUESTS.has(normalized);
}

export function normalizeWorkingMemoryState(raw: unknown): WorkingMemoryState {
    const source = (raw ?? {}) as LegacyFocusStack;
    const fallback = createDefaultWorkingMemoryState();
    const projectGoal = normalizeUserRequest(normalizeString(source.project_goal) || fallback.project_goal, 400);
    const contextPath = normalizeStringList(source.context_path ?? source.current_path);
    const activeTask = normalizeUserRequest(
        normalizeString(source.active_task ?? source.current_focus) || DEFAULT_ACTIVE_TASK
    ) || DEFAULT_ACTIVE_TASK;
    const nextTasks = normalizeTaskList(source.next_tasks ?? source.pending_siblings).filter(
        (task) => task !== activeTask
    );
    const deferredTasks = normalizeTaskList(source.deferred_tasks).filter(
        (task) => task !== activeTask && !nextTasks.includes(task)
    );
    const doneRecent = normalizeTaskList(source.done_recent)
        .filter((task) => task !== activeTask && !nextTasks.includes(task))
        .slice(-5);
    const lastUserRequest = normalizeUserRequest(normalizeString(source.last_user_request));
    const lastUpdated = normalizeString(source.last_updated) || fallback.last_updated;

    return {
        schema_version: WORKING_MEMORY_SCHEMA_VERSION,
        project_goal: projectGoal,
        context_path: contextPath,
        active_task: activeTask,
        next_tasks: nextTasks,
        deferred_tasks: deferredTasks,
        done_recent: doneRecent,
        last_user_request: lastUserRequest,
        last_updated: lastUpdated,
    };
}

export function loadWorkingMemoryState(workspace: string): WorkingMemoryState {
    const p = paths(workspace);
    return normalizeWorkingMemoryState(readJson(p.focusStack, createDefaultWorkingMemoryState()));
}

export function renderWorkingMemory(state: WorkingMemoryState): string {
    const lines = [
        `**Goal:** ${state.project_goal}`,
        `**Updated:** ${state.last_updated}`,
    ];

    if (state.context_path.length > 0) {
        lines.push(`**Context:** ${state.context_path.join(" / ")}`);
    }

    lines.push(`**Active:** ${state.active_task}`);

    if (state.next_tasks.length > 0) {
        lines.push("", "**Next:**");
        state.next_tasks.slice(0, 5).forEach((task) => lines.push(`- ${task}`));
        if (state.next_tasks.length > 5) {
            lines.push(`- ... (${state.next_tasks.length - 5} more queued)`);
        }
    }

    if (state.deferred_tasks.length > 0) {
        lines.push("", `**Deferred:** ${state.deferred_tasks.length} task(s) parked`);
    }

    if (state.done_recent.length > 0) {
        lines.push("", "**Done Recently:**");
        state.done_recent
            .slice(-3)
            .reverse()
            .forEach((task) => lines.push(`- ${task}`));
    }

    if (state.last_user_request) {
        lines.push("", `**Last User Request:** ${state.last_user_request}`);
    }

    return lines.join("\n");
}

export function writeWorkingMemoryState(workspace: string, state: WorkingMemoryState): WorkingMemoryState {
    const p = paths(workspace);
    const normalized = normalizeWorkingMemoryState(state);

    ensureDir(p.activeDir);
    writeJson(p.focusStack, normalized);
    fs.writeFileSync(p.focusStackMd, renderWorkingMemory(normalized) + "\n", "utf-8");

    return normalized;
}

export function touchWorkingMemoryState(
    workspace: string,
    patch: Partial<WorkingMemoryState> = {}
): WorkingMemoryState {
    const current = loadWorkingMemoryState(workspace);
    return writeWorkingMemoryState(workspace, {
        ...current,
        ...patch,
        last_updated: patch.last_updated ?? nowISO(),
    });
}

export function syncLatestUserRequest(
    workspace: string,
    latestUserRequest: string
): WorkingMemoryState {
    const normalizedRequest = normalizeUserRequest(latestUserRequest);
    const current = loadWorkingMemoryState(workspace);

    if (!normalizedRequest) {
        return current;
    }

    const continuationOnly = isContinuationRequest(normalizedRequest);
    if (continuationOnly) {
        if (isIdleTask(current.active_task) && current.last_user_request) {
            return writeWorkingMemoryState(workspace, {
                ...current,
                active_task: current.last_user_request,
                last_updated: nowISO(),
            });
        }
        return current;
    }

    const activeIsIdle = isIdleTask(current.active_task);
    const conflictsWithActive =
        !activeIsIdle && !hasMeaningfulTaskOverlap(current.active_task, normalizedRequest);
    const shouldPromote = activeIsIdle || conflictsWithActive;

    if (!shouldPromote) {
        if (current.last_user_request === normalizedRequest) {
            return current;
        }

        return writeWorkingMemoryState(workspace, {
            ...current,
            last_user_request: normalizedRequest,
            last_updated: nowISO(),
        });
    }

    const previousActive = current.active_task;
    const nextTasks = dedupeWorkingTasks(
        [
            ...(!isIdleTask(previousActive) && previousActive !== normalizedRequest
                ? [previousActive]
                : []),
            ...current.next_tasks.filter((task) => task !== normalizedRequest),
        ],
        normalizedRequest
    );

    return writeWorkingMemoryState(workspace, {
        ...current,
        active_task: normalizedRequest,
        next_tasks: nextTasks,
        deferred_tasks: current.deferred_tasks.filter((task) => task !== normalizedRequest),
        last_user_request: normalizedRequest,
        last_updated: nowISO(),
    });
}

export function countWorkingMemoryTasks(state: WorkingMemoryState): number {
    const hasActiveTask = !isIdleTask(state.active_task);
    return (hasActiveTask ? 1 : 0) + state.next_tasks.length;
}

/** Append a note to a specific section in scratchpad.md. */
export function appendScratchpad(workspace: string, section: string, content: string): void {
    const p = paths(workspace);
    const existing = readFileOr(p.scratchpad, "# Scratchpad\n");
    const sectionHeader = `## ${section}`;

    let newContent = "";
    const formattedContent = content
        .split("\n")
        .map((line, index) => (index === 0 ? line : `  ${line}`))
        .join("\n");
    if (existing.includes(sectionHeader)) {
        newContent = existing.replace(sectionHeader, `${sectionHeader}\n- [${nowTime()}] ${formattedContent}`);
    } else {
        newContent = existing.trim() + `\n\n${sectionHeader}\n- [${nowTime()}] ${formattedContent}\n`;
    }

    fs.writeFileSync(p.scratchpad, newContent.trim() + "\n", "utf-8");
}
