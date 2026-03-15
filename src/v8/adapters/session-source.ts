import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonl } from "../architecture/io.js";
import type { RawSessionMessage } from "../architecture/narrative-normalizer.js";

export interface SessionSourceOptions {
    sessionTraceDir?: string;
    maxFiles?: number;
}

export function resolveSessionTraceDir(
    workspaceDir?: string,
    override?: string
): string | null {
    if (override) return override;
    if (process.env.OPENCLAW_SESSION_TRACE_DIR) {
        return process.env.OPENCLAW_SESSION_TRACE_DIR;
    }
    const stateDir =
        process.env.OPENCLAW_STATE_DIR ||
        process.env.CLAWDBOT_STATE_DIR ||
        resolveDefaultStateDir();
    if (stateDir) {
        const candidate = path.join(stateDir, "agents", "main", "sessions");
        if (fs.existsSync(candidate)) return candidate;
    }
    if (workspaceDir) {
        const candidate = path.join(workspaceDir, ".memory", "sessions");
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function loadSessionTraces(
    workspaceDir?: string,
    options?: SessionSourceOptions
): { sourceRefPrefix: string; messages: RawSessionMessage[] }[] {
    const dir = resolveSessionTraceDir(workspaceDir, options?.sessionTraceDir);
    if (!dir || !fs.existsSync(dir)) return [];

    const files = fs
        .readdirSync(dir)
        .filter((file) => {
            if (!(file.endsWith(".jsonl") || file.endsWith(".json"))) return false;
            if (file.includes(".reset.") || file.includes(".deleted.")) return false;
            if (file === "sessions.json") return false;
            return true;
        })
        .map((file) => path.join(dir, file));

    const decorated = files.map((filePath) => ({
        filePath,
        mtimeMs: safeReadMtimeMs(filePath),
    }));
    decorated.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const sortedFiles = decorated.map((entry) => entry.filePath);

    const limited =
        typeof options?.maxFiles === "number"
            ? sortedFiles.slice(0, options.maxFiles)
            : sortedFiles;

    return limited
        .map((filePath) => {
            const messages = readSessionFile(filePath).filter(isMessageRecord);
            return {
                sourceRefPrefix: filePath,
                messages,
            };
        })
        .filter((entry) => entry.messages.length > 0);
}

function safeReadMtimeMs(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function readSessionFile(filePath: string): RawSessionMessage[] {
    if (filePath.endsWith(".jsonl")) {
        return readJsonl<RawSessionMessage>(filePath);
    }
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as RawSessionMessage[];
        if (Array.isArray(parsed?.messages)) return parsed.messages as RawSessionMessage[];
        return [];
    } catch {
        return [];
    }
}

function isMessageRecord(record: RawSessionMessage): boolean {
    if (!record) return false;
    if ((record as { type?: string }).type === "message") return true;
    return Boolean(record.message || record.content || record.text);
}

function resolveDefaultStateDir(): string | null {
    const home = os.homedir();
    const candidates = [
        path.join(home, ".openclaw"),
        path.join(home, ".clawdbot"),
        path.join(home, ".moldbot"),
        path.join(home, ".moltbot"),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // ignore
        }
    }
    return candidates[0] ?? null;
}
