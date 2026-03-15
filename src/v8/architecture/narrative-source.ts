import * as fs from "node:fs";
import * as path from "node:path";
import type { V8NarrativeRecord } from "../types_v8.js";

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
        if (!content.trim()) continue;
        const sessionId = parseSessionId(content, file);
        const timelineStart = extractTimelineStart(content);
        records.push({
            id: `narr_${sessionId}`,
            sourceClass: "raw",
            sourceType: "session_narrative",
            sourceRef: fullPath,
            speaker: null,
            timestamp: null,
            rawText: content,
            cleanText: content,
            cleanMap: [],
            language: detectLanguage(content),
            metadata: {
                sessionId,
                sourceRef: fullPath,
                timelineStart,
            },
        });
    }
    records.sort(compareNarrativeRecords);
    return records;
}

function parseSessionId(content: string, fileName: string): string {
    const match = content.match(/Session:\s*`([^`]+)`/);
    if (match && match[1]) return match[1].trim();
    const fileMatch = fileName.match(/^session_(.+)_narrative\.md$/);
    return fileMatch && fileMatch[1] ? fileMatch[1] : "default";
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

function extractTimelineStart(content: string): string {
    const match = content.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
    return match?.[1]?.trim() || "";
}

function compareNarrativeRecords(a: V8NarrativeRecord, b: V8NarrativeRecord): number {
    const aTime = parseTimelineStart(a.metadata?.timelineStart);
    const bTime = parseTimelineStart(b.metadata?.timelineStart);
    if (aTime !== null && bTime !== null && aTime !== bTime) {
        return aTime - bTime;
    }
    if (aTime !== null && bTime === null) return -1;
    if (aTime === null && bTime !== null) return 1;
    return a.sourceRef.localeCompare(b.sourceRef);
}

function parseTimelineStart(value?: string): number | null {
    if (!value) return null;
    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? null : parsed;
}
