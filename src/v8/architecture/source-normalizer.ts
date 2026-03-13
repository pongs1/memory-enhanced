import type { V8SourceRecord } from "../types_v8.js";

export interface RawSessionMessage {
    id?: string | number;
    parentId?: string | number;
    role?: string;
    speaker?: string;
    content?: string | Array<{ text?: string }>;
    text?: string;
    body?: string;
    message?: {
        role?: string;
        content?: Array<{
            type?: string;
            text?: string;
            id?: string;
            name?: string;
            arguments?: unknown;
            description?: string;
        }> | string;
        toolCallId?: string;
        toolName?: string;
        details?: Record<string, unknown>;
        isError?: boolean;
        timestamp?: string | number;
    };
    timestamp?: string | number;
    createdAt?: string | number;
    created_at?: string | number;
    [key: string]: unknown;
}

export interface SourceNormalizationOptions {
    sourceRefPrefix: string;
    sessionId?: string;
    cleanPatterns?: RegExp[];
    includeOperations?: boolean;
}

const DEFAULT_CLEAN_PATTERNS: RegExp[] = [
    /<!-- Memory Context \(Live\) -->[\s\S]*?<!-- End Memory Context -->/g,
    /<memory-context[\s\S]*?<\/memory-context>/gi,
    /<task-ledger[\s\S]*?<\/task-ledger>/gi,
    /<!--\s*Task Ledger[\s\S]*?-->/gi,
];

export function normalizeSessionMessages(
    messages: RawSessionMessage[],
    options: SourceNormalizationOptions
): V8SourceRecord[] {
    const sourceRefPrefix = options.sourceRefPrefix;
    const cleanPatterns = options.cleanPatterns || DEFAULT_CLEAN_PATTERNS;
    const sessionId =
        options.sessionId || deriveSessionId(sourceRefPrefix) || "default";

    const conversationRecords = messages
        .map((msg, index) => {
            const rawText = extractText(msg);
            if (!rawText) return null;
            const { cleanText, cleanMap } = cleanTextWithMap(
                rawText,
                cleanPatterns
            );
            const rawRole =
                (msg.message as { role?: string } | undefined)?.role ||
                msg.role ||
                msg.speaker;
            if (rawRole === "tool" || rawRole === "toolResult") {
                return null;
            }
            const speaker = normalizeSpeaker(rawRole);
            const timestamp = normalizeTimestamp(
                msg.timestamp ?? msg.createdAt ?? msg.created_at
            );
            const sourceRef = `${sourceRefPrefix}#${index + 1}`;
            const id = buildSourceRecordId(sessionId, index + 1);

            return {
                id,
                sourceClass: "raw",
                sourceType: "session_trace",
                sourceRef,
                speaker,
                timestamp,
                rawText,
                cleanText,
                cleanMap,
                language: detectLanguage(cleanText || rawText),
                metadata: {
                    sessionId,
                    sourceRef,
                    sourceCategory: "conversation",
                },
            } satisfies V8SourceRecord;
        })
        .filter(Boolean) as V8SourceRecord[];

    const operationRecords =
        options.includeOperations === false
            ? []
            : buildOperationSourceRecords(messages, {
                  sourceRefPrefix,
                  sessionId,
                  cleanPatterns,
              });

    return [...conversationRecords, ...operationRecords];
}

function extractText(msg: RawSessionMessage): string {
    if (!msg) return "";
    const candidates: Array<string | Array<{ text?: string }> | undefined> = [
        msg.text,
        msg.body as string | undefined,
        msg.content as string | Array<{ text?: string }> | undefined,
        msg.message?.content as string | Array<{ text?: string }> | undefined,
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (typeof candidate === "string") {
            return candidate.trim().length ? candidate : "";
        }
        if (Array.isArray(candidate)) {
            const text = candidate.map((c) => c.text || "").join("\n");
            return text.trim().length ? text : "";
        }
    }
    return "";
}

function normalizeSpeaker(value?: string): V8SourceRecord["speaker"] {
    if (!value) return null;
    const lower = value.toLowerCase();
    if (lower.includes("user")) return "user";
    if (lower.includes("assistant") || lower.includes("model")) return "assistant";
    if (lower.includes("system")) return "system";
    return "unknown";
}

function normalizeTimestamp(value?: string | number): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
        const ts = value > 1e12 ? value : value * 1000;
        return new Date(ts).toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildSourceRecordId(sessionId: string, index: number): string {
    return `src_${sessionId}_${index}`;
}

function buildOperationRecordId(sessionId: string, index: number): string {
    return `src_${sessionId}_op_${index}`;
}

function deriveSessionId(sourceRefPrefix: string): string | null {
    if (!sourceRefPrefix) return null;
    const last = sourceRefPrefix.split(/[\\/]/).pop();
    if (!last) return null;
    return last.replace(/\.[^.]+$/, "") || null;
}

function detectLanguage(text: string): V8SourceRecord["language"] {
    if (!text) return "unknown";
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;
    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > enCount * 2) return "zh";
    if (enCount > zhCount * 2) return "en";
    return "mixed";
}

function cleanTextWithMap(
    rawText: string,
    patterns: RegExp[]
): { cleanText: string; cleanMap: V8SourceRecord["cleanMap"] } {
    const ranges = collectRemovalRanges(rawText, patterns);
    const merged = mergeRanges(ranges);
    const cleanMap: NonNullable<V8SourceRecord["cleanMap"]> = [];
    let cleanText = "";
    let cleanCursor = 0;
    let rawCursor = 0;

    for (const [start, end] of merged) {
        if (start > rawCursor) {
            const segment = rawText.slice(rawCursor, start);
            cleanText += segment;
            cleanMap.push({
                cleanStart: cleanCursor,
                cleanEnd: cleanCursor + segment.length,
                rawStart: rawCursor,
                rawEnd: start,
            });
            cleanCursor += segment.length;
        }
        rawCursor = Math.max(rawCursor, end);
    }

    if (rawCursor < rawText.length) {
        const segment = rawText.slice(rawCursor);
        cleanText += segment;
        cleanMap.push({
            cleanStart: cleanCursor,
            cleanEnd: cleanCursor + segment.length,
            rawStart: rawCursor,
            rawEnd: rawText.length,
        });
    }

    return { cleanText, cleanMap };
}

interface ToolCallInfo {
    toolCallId: string;
    toolName: string;
    description?: string;
    arguments?: unknown;
    messageId?: string | number;
    parentId?: string | number;
    timestamp?: string | number;
    sourceIndex: number;
}

interface ToolResultInfo {
    toolCallId: string;
    toolName?: string;
    messageId?: string | number;
    parentId?: string | number;
    timestamp?: string | number;
    contentText?: string;
    details?: Record<string, unknown>;
    isError?: boolean;
    sourceIndex: number;
}

function buildOperationSourceRecords(
    messages: RawSessionMessage[],
    options: { sourceRefPrefix: string; sessionId: string; cleanPatterns: RegExp[] }
): V8SourceRecord[] {
    const { sourceRefPrefix, sessionId, cleanPatterns } = options;
    const toolCallMap = new Map<string, ToolCallInfo>();
    const pendingResults: ToolResultInfo[] = [];
    const records: V8SourceRecord[] = [];

    messages.forEach((msg, index) => {
        const toolCalls = extractToolCalls(msg, index);
        for (const call of toolCalls) {
            if (call.toolCallId) {
                toolCallMap.set(call.toolCallId, call);
            }
        }
        const toolResult = extractToolResult(msg, index);
        if (toolResult) {
            pendingResults.push(toolResult);
        }
    });

    let opIndex = 0;
    for (const result of pendingResults) {
        opIndex += 1;
        const call = result.toolCallId
            ? toolCallMap.get(result.toolCallId)
            : undefined;
        const record = buildOperationRecord(
            call,
            result,
            opIndex,
            sourceRefPrefix,
            sessionId,
            cleanPatterns
        );
        records.push(record);
        if (result.toolCallId) {
            toolCallMap.delete(result.toolCallId);
        }
    }

    for (const call of toolCallMap.values()) {
        opIndex += 1;
        const record = buildOperationRecord(
            call,
            null,
            opIndex,
            sourceRefPrefix,
            sessionId,
            cleanPatterns
        );
        records.push(record);
    }

    return records;
}

function extractToolCalls(
    msg: RawSessionMessage,
    sourceIndex: number
): ToolCallInfo[] {
    const role =
        (msg.message as { role?: string } | undefined)?.role ||
        msg.role ||
        msg.speaker;
    if (role !== "assistant") return [];
    const content = extractContentArray(msg);
    if (!content.length) return [];
    return content
        .filter((item) =>
            item?.type ? item.type === "toolCall" || item.type === "tool_call" : false
        )
        .map((item) => ({
            toolCallId: item.id || "",
            toolName: item.name || "tool",
            description: extractToolDescription(item),
            arguments: item.arguments,
            messageId: msg.id,
            parentId: msg.parentId,
            timestamp:
                msg.timestamp ??
                msg.createdAt ??
                msg.created_at ??
                msg.message?.timestamp,
            sourceIndex,
        }))
        .filter((call) => Boolean(call.toolCallId || call.toolName));
}

function extractToolResult(
    msg: RawSessionMessage,
    sourceIndex: number
): ToolResultInfo | null {
    const role =
        (msg.message as { role?: string } | undefined)?.role ||
        msg.role ||
        msg.speaker;
    if (role !== "toolResult") return null;
    const toolCallId = msg.message?.toolCallId;
    const toolName = msg.message?.toolName;
    const details =
        (msg.message?.details as Record<string, unknown> | undefined) ||
        (msg as { details?: Record<string, unknown> }).details;
    const contentText = extractToolResultText(msg, details);
    return {
        toolCallId: toolCallId || "",
        toolName,
        messageId: msg.id,
        parentId: msg.parentId,
        timestamp:
            msg.timestamp ??
            msg.createdAt ??
            msg.created_at ??
            msg.message?.timestamp,
        contentText,
        details,
        isError: Boolean(msg.message?.isError),
        sourceIndex,
    };
}

function extractContentArray(
    msg: RawSessionMessage
): Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
    description?: string;
}> {
    const raw = msg.message?.content ?? msg.content;
    if (Array.isArray(raw)) return raw;
    return [];
}

function extractToolDescription(item: {
    description?: string;
    arguments?: unknown;
}): string | undefined {
    if (item.description) return item.description;
    if (item.arguments && typeof item.arguments === "object") {
        const args = item.arguments as Record<string, unknown>;
        if (typeof args.description === "string") return args.description;
    }
    return undefined;
}

function extractToolResultText(
    msg: RawSessionMessage,
    details?: Record<string, unknown>
): string {
    const aggregated = details?.aggregated;
    if (typeof aggregated === "string" && aggregated.trim().length) {
        return aggregated;
    }
    const content = msg.message?.content ?? msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const text = content.map((item) => item.text || "").join("\n");
        return text.trim().length ? text : "";
    }
    return "";
}

function buildOperationRecord(
    call: ToolCallInfo | undefined,
    result: ToolResultInfo | null,
    index: number,
    sourceRefPrefix: string,
    sessionId: string,
    cleanPatterns: RegExp[]
): V8SourceRecord {
    const toolName = call?.toolName || result?.toolName || "tool";
    const description = call?.description?.trim();
    const inputSummary = summarizeToolArguments(call?.arguments);
    const resultSummary = summarizeToolResult(result);
    const output = summarizeToolOutput(toolName, call?.arguments, result);

    const lines: string[] = [];
    lines.push("#### Tool operation");
    let firstSentence = `Assistant ran \`${toolName}\``;
    if (description) {
        firstSentence += ` to ${trimTrailingPeriod(description)}.`;
    } else {
        firstSentence += ".";
    }
    if (inputSummary) {
        firstSentence += ` Input: ${inputSummary}.`;
    }
    lines.push(firstSentence);
    if (resultSummary) {
        lines.push(resultSummary);
    } else {
        lines.push("Result: pending.");
    }
    if (output) {
        lines.push("Output:");
        lines.push(output);
    }

    const rawText = lines.join("\n");
    const { cleanText, cleanMap } = cleanTextWithMap(rawText, cleanPatterns);
    const timestamp = normalizeTimestamp(result?.timestamp ?? call?.timestamp);
    const sourceRef = `${sourceRefPrefix}#op-${index}`;
    const id = buildOperationRecordId(sessionId, index);

    const metadata: Record<string, string> = {
        sessionId,
        sourceRef,
        sourceCategory: "operation",
        toolName,
    };
    if (call?.toolCallId) metadata.toolCallId = call.toolCallId;
    if (call?.messageId !== undefined) {
        metadata.toolCallMessageId = String(call.messageId);
    }
    if (result?.messageId !== undefined) {
        metadata.toolResultMessageId = String(result.messageId);
    }
    if (result?.details?.status) {
        metadata.toolStatus = String(result.details.status);
    }
    if (typeof result?.details?.exitCode === "number") {
        metadata.toolExitCode = String(result.details.exitCode);
    }
    if (result?.isError) {
        metadata.toolIsError = "true";
    }

    return {
        id,
        sourceClass: "curated",
        sourceType: "session_trace",
        sourceRef,
        speaker: "assistant",
        timestamp,
        rawText,
        cleanText,
        cleanMap,
        language: detectLanguage(cleanText || rawText),
        metadata,
    };
}

function summarizeToolArguments(args: unknown): string | null {
    if (args === null || args === undefined) return null;
    if (typeof args === "string") return wrapInlineCode(trimLongText(args, 180));
    if (typeof args !== "object") return String(args);
    const obj = args as Record<string, unknown>;
    const parts: string[] = [];
    const add = (label: string, value: unknown, code = false) => {
        if (value === null || value === undefined) return;
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) return;
            parts.push(
                `${label} ${code ? wrapInlineCode(trimLongText(trimmed, 180)) : trimLongText(trimmed, 180)}`
            );
        } else if (typeof value === "number" || typeof value === "boolean") {
            parts.push(`${label} ${String(value)}`);
        }
    };
    add("command", obj.command, true);
    add("path", obj.path, true);
    add("file", obj.file, true);
    add("query", obj.query);
    add("url", obj.url, true);
    add("action", obj.action);
    add("session", obj.sessionId);
    add("pid", obj.pid);
    if (parts.length) return parts.join(", ");
    try {
        return trimLongText(JSON.stringify(obj), 200);
    } catch {
        return null;
    }
}

function summarizeToolResult(result: ToolResultInfo | null): string | null {
    if (!result) return null;
    const details = result.details || {};
    const status =
        typeof details.status === "string"
            ? details.status
            : result.isError
              ? "error"
              : "completed";
    const parts: string[] = [status];
    if (typeof details.exitCode === "number") {
        parts.push(`exit ${details.exitCode}`);
    }
    if (typeof details.durationMs === "number") {
        parts.push(`${details.durationMs} ms`);
    }
    if (typeof details.sessionId === "string") {
        parts.push(`session ${details.sessionId}`);
    }
    if (typeof details.pid === "number") {
        parts.push(`pid ${details.pid}`);
    }
    return `Result: ${parts.join(", ")}.`;
}

function summarizeToolOutput(
    toolName: string,
    args: unknown,
    result: ToolResultInfo | null
): string | null {
    if (!result?.contentText) return null;
    const isCommandLike =
        ["exec", "process", "shell", "bash", "node", "python"].includes(
            toolName
        ) ||
        (typeof args === "object" &&
            args !== null &&
            typeof (args as Record<string, unknown>).command === "string");
    const maxChars = isCommandLike ? 800 : 1600;
    const maxLines = isCommandLike ? 20 : 40;
    const cleaned = normalizeOutputWhitespace(
        stripUntrustedBlocks(result.contentText)
    );
    return limitTextByLines(cleaned, maxChars, maxLines);
}

function normalizeOutputWhitespace(text: string): string {
    return text.replace(/\r\n/g, "\n").trim();
}

function stripUntrustedBlocks(text: string): string {
    if (!text) return text;
    const stripped = text
        .replace(
            /SECURITY NOTICE:[\s\S]*?(?=<<<EXTERNAL_UNTRUSTED_CONTENT|$)/g,
            ""
        )
        .replace(
            /<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?>>>/g,
            "[external content omitted]"
        );
    return stripped.trim();
}

function limitTextByLines(text: string, maxChars: number, maxLines: number): string {
    if (!text) return "";
    const lines = text.split("\n");
    const limitedLines = lines.slice(0, maxLines);
    let output = limitedLines.join("\n");
    if (output.length > maxChars) {
        output = output.slice(0, maxChars) + "…";
    }
    return output;
}

function trimLongText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "…";
}

function wrapInlineCode(text: string): string {
    return `\`${text.replace(/`/g, "'")}\``;
}

function trimTrailingPeriod(text: string): string {
    return text.replace(/[。．.]\s*$/, "");
}

function collectRemovalRanges(text: string, patterns: RegExp[]): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const pattern of patterns) {
        if (!pattern.global) {
            const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
            collectRangesFromPattern(text, globalPattern, ranges);
        } else {
            collectRangesFromPattern(text, pattern, ranges);
        }
    }
    return ranges;
}

function collectRangesFromPattern(
    text: string,
    pattern: RegExp,
    ranges: Array<[number, number]>
): void {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text))) {
        const start = match.index;
        const end = start + match[0].length;
        ranges.push([start, end]);
    }
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
    if (!ranges.length) return [];
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    let [currentStart, currentEnd] = sorted[0];
    for (let i = 1; i < sorted.length; i += 1) {
        const [start, end] = sorted[i];
        if (start <= currentEnd) {
            currentEnd = Math.max(currentEnd, end);
        } else {
            merged.push([currentStart, currentEnd]);
            currentStart = start;
            currentEnd = end;
        }
    }
    merged.push([currentStart, currentEnd]);
    return merged;
}
