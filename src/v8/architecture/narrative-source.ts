import * as fs from "node:fs";
import * as path from "node:path";
import type { V8NarrativeRecord } from "../types_v8.js";

interface NarrativeEntry {
    label?: string | null;
    speakerRaw: string;
    text: string;
    timestampRaw?: string | null;
}

export function loadNarrativeRecords(rawDir: string): V8NarrativeRecord[] {
    const assembledDir = path.join(rawDir, "observations", "assembled");
    if (!fs.existsSync(assembledDir)) return [];
    const files = fs
        .readdirSync(assembledDir)
        .filter((name) => name.endsWith("_narrative.md"));
    const records: V8NarrativeRecord[] = [];
    for (const file of files) {
        const fullPath = path.join(assembledDir, file);
        const content = fs.readFileSync(fullPath, "utf-8");
        const sessionId = parseSessionId(content, file);
        const entries = parseNarrativeEntries(content);
        entries.forEach((entry, idx) => {
            const id = `narr_${sessionId}_${idx + 1}`;
            const sourceRef = `${fullPath}#entry-${idx + 1}`;
            const rawText = entry.text.trim();
            if (!rawText) return;
            const parsedLabel = parseLabel(entry.label);
            const sourceCategory = detectSourceCategory(
                entry.speakerRaw,
                parsedLabel?.sourceCategory
            );
            const metadata: Record<string, string> = {
                sessionId,
                sourceRef,
                sourceCategory,
                narrativeLabel: entry.label || "",
                narrativeSpeaker: entry.speakerRaw,
            };
            if (parsedLabel?.sourceIndex) {
                metadata.sourceIndex = String(parsedLabel.sourceIndex);
            }
            records.push({
                id,
                sourceClass: "curated",
                sourceType: "session_narrative",
                sourceRef,
                speaker: normalizeSpeaker(entry.speakerRaw),
                timestamp: normalizeTimestamp(entry.timestampRaw),
                rawText,
                cleanText: rawText,
                cleanMap: [],
                language: detectLanguage(rawText),
                metadata,
            });
        });
    }
    return records;
}

function parseSessionId(content: string, fileName: string): string {
    const match = content.match(/Session:\s*`([^`]+)`/);
    if (match && match[1]) return match[1].trim();
    const fileMatch = fileName.match(/^session_(.+)_narrative\.md$/);
    return fileMatch && fileMatch[1] ? fileMatch[1] : "default";
}

function parseNarrativeEntries(content: string): NarrativeEntry[] {
    const lines = content.split(/\r?\n/);
    const entries: NarrativeEntry[] = [];
    let current: NarrativeEntry | null = null;
    let buffer: string[] = [];

    const flush = () => {
        if (!current) return;
        const text = buffer.join("\n").trim();
        if (text) {
            entries.push({ ...current, text });
        }
        current = null;
        buffer = [];
    };

    for (const line of lines) {
        const header = line.match(/^###\s+(.*)$/);
        if (header) {
            flush();
            const { label, speaker, timestamp } = parseHeader(header[1]);
            current = {
                label,
                speakerRaw: speaker || "unknown",
                timestampRaw: timestamp,
                text: "",
            };
            continue;
        }
        if (current) {
            buffer.push(line);
        }
    }
    flush();
    return entries;
}

function parseHeader(value: string): {
    label?: string | null;
    speaker: string;
    timestamp?: string | null;
} {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
        const closing = trimmed.indexOf("]");
        if (closing > 0) {
            const label = trimmed.slice(1, closing).trim();
            const speaker = trimmed.slice(closing + 1).trim();
            return {
                label,
                speaker: speaker || "unknown",
                timestamp: extractTimestamp(label),
            };
        }
    }
    const parenIndex = trimmed.indexOf("(");
    if (parenIndex > 0 && trimmed.endsWith(")")) {
        const speaker = trimmed.slice(0, parenIndex).trim();
        const meta = trimmed.slice(parenIndex + 1, -1).trim();
        return {
            label: meta || null,
            speaker: speaker || "unknown",
            timestamp: extractTimestamp(meta),
        };
    }
    return { speaker: trimmed || "unknown" };
}

function extractTimestamp(label: string): string | null {
    const match = label.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
    return match ? match[1] : null;
}

function parseLabel(label?: string | null): {
    sourceIndex?: number;
    sourceCategory?: "conversation" | "operation";
} | null {
    if (!label) return null;
    const opMatch = label.match(/op-(\d+)/i);
    if (opMatch) {
        return { sourceIndex: Number(opMatch[1]), sourceCategory: "operation" };
    }
    const msgMatch = label.match(/#(\d+)/);
    if (msgMatch) {
        return { sourceIndex: Number(msgMatch[1]), sourceCategory: "conversation" };
    }
    return null;
}

function detectSourceCategory(
    speakerRaw: string,
    labelCategory?: "conversation" | "operation"
): "conversation" | "operation" {
    if (labelCategory) return labelCategory;
    const lower = (speakerRaw || "").toLowerCase();
    if (lower.includes("tool") || lower.includes("operation")) {
        return "operation";
    }
    return "conversation";
}

function normalizeSpeaker(raw?: string): V8NarrativeRecord["speaker"] {
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower.includes("user")) return "user";
    if (lower.includes("assistant") || lower.includes("model")) return "assistant";
    if (lower.includes("system")) return "system";
    return "unknown";
}

function normalizeTimestamp(value?: string | null): string | null {
    if (!value) return null;
    const parsed = new Date(value.replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function detectLanguage(text: string): V8NarrativeRecord["language"] {
    if (!text) return "unknown";
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;
    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > enCount * 2) return "zh";
    if (enCount > zhCount * 2) return "en";
    return "mixed";
}
