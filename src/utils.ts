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

/** Standard workspace paths. */
export function paths(workspace: string) {
    return {
        // Searchable by memory_search + memory_get
        memoryDir: path.join(workspace, "memory"),
        knowledgeDir: path.join(workspace, "memory", "knowledge"),
        skillsVerified: path.join(workspace, "memory", "skills", "verified"),
        skillsDrafts: path.join(workspace, "memory", "skills", "drafts"),
        skillsRegistry: path.join(workspace, "memory", "skills", "_registry.json"),
        memoryMd: path.join(workspace, "MEMORY.md"),
        // Metadata (read tool only, not memory_get)
        dotMemory: path.join(workspace, ".memory"),
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
export interface FocusStack {
    project_goal: string;
    current_path: string[];
    current_focus: string;
    pending_siblings: string[];
    last_updated: string;
}

/** Append a note to a specific section in scratchpad.md. */
export function appendScratchpad(workspace: string, section: string, content: string): void {
    const p = paths(workspace);
    const existing = readFileOr(p.scratchpad, "# Scratchpad\n");
    const sectionHeader = `## ${section}`;

    let newContent = "";
    if (existing.includes(sectionHeader)) {
        newContent = existing.replace(sectionHeader, `${sectionHeader}\n- [${nowTime()}] ${content}`);
    } else {
        newContent = existing.trim() + `\n\n${sectionHeader}\n- [${nowTime()}] ${content}\n`;
    }

    fs.writeFileSync(p.scratchpad, newContent.trim() + "\n", "utf-8");
}
