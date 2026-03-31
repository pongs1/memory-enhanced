import type { V8NarrativeRecord } from "../types_v8.js";
import {
    getToolCleaningProfile,
    loadResolvedToolCleaningProfiles,
    type OperationKind,
    type OperationPromotion,
    type ToolCleaningProfile,
} from "./tool-cleaning-profiles.js";

export interface RawSessionMessage {
    type?: string;
    id?: string | number;
    parentId?: string | number;
    role?: string;
    speaker?: string;
    content?: string | Array<{ text?: string }>;
    text?: string;
    body?: string;
    message?: {
        role?: string;
        tool_calls?: unknown;
        toolCalls?: unknown;
        function_call?: unknown;
        functionCall?: unknown;
        toolCallId?: string;
        tool_call_id?: string;
        toolName?: string;
        tool_name?: string;
        name?: string;
        tool?: string;
        content?: Array<{
            type?: string;
            text?: string;
            id?: string;
            name?: string;
            arguments?: unknown;
            description?: string;
            toolCallId?: string;
            tool_call_id?: string;
            toolName?: string;
            tool_name?: string;
            tool?: string;
            function?: {
                name?: string;
                arguments?: unknown;
                description?: string;
            };
        }> | string;
        details?: Record<string, unknown>;
        isError?: boolean;
        timestamp?: string | number;
    };
    timestamp?: string | number;
    createdAt?: string | number;
    created_at?: string | number;
    [key: string]: unknown;
}

export interface NarrativeNormalizationOptions {
    sourceRefPrefix: string;
    sessionId?: string;
    cleanPatterns?: RegExp[];
    includeOperations?: boolean;
    minSourceIndexExclusive?: number;
    workspace?: string;
    toolCleaningProfiles?: Map<string, ToolCleaningProfile>;
}

interface CompiledCleanPatterns {
    patterns: RegExp[];
    unionPattern: RegExp | null;
}

const DEFAULT_CLEAN_PATTERNS: RegExp[] = [
    /<!-- Memory Context \(Live\) -->[\s\S]*?<!-- End Memory Context -->/g,
    /<!-- Memory Recall[\s\S]*?<!-- End Memory Recall -->/g,
    /<memory-context[\s\S]*?<\/memory-context>/gi,
    /<task-ledger[\s\S]*?<\/task-ledger>/gi,
    /<!--\s*Task Ledger[\s\S]*?-->/gi,
    /Conversation info \(untrusted metadata\):[\s\S]*?```[\s\S]*?```/gi,
    /^Current time:[^\n]*$/gim,
    /^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/gim,
    /^.*Read HEARTBEAT\.md.*$/gim,
    /^.*HEARTBEAT_OK.*$/gim,
];

export function normalizeSessionMessages(
    messages: RawSessionMessage[],
    options: NarrativeNormalizationOptions
): V8NarrativeRecord[] {
    const sourceRefPrefix = options.sourceRefPrefix;
    const cleanPatterns = options.cleanPatterns || DEFAULT_CLEAN_PATTERNS;
    const cleaner = compileCleanPatterns(cleanPatterns);
    const sessionId =
        options.sessionId || deriveSessionId(sourceRefPrefix) || "default";
    const minSourceIndexExclusive = Math.max(
        0,
        Number(options.minSourceIndexExclusive || 0)
    );
    const toolCleaningProfiles =
        options.toolCleaningProfiles ||
        loadResolvedToolCleaningProfiles(options.workspace);

    const conversationRecords: V8NarrativeRecord[] = [];
    const toolCallMap = new Map<string, ToolCallInfo>();
    const pendingResults: ToolResultInfo[] = [];

    messages.forEach((msg, index) => {
        const sourceIndex = index + 1;
        const rawRole = resolveMessageRole(msg);
        if (rawRole === "assistant") {
            for (const call of extractToolCalls(msg, index)) {
                if (call.toolCallId) {
                    toolCallMap.set(call.toolCallId, call);
                }
            }
        }
        if (sourceIndex <= minSourceIndexExclusive) {
            return;
        }
        if (rawRole === "tool" || rawRole === "toolResult") {
            const toolResult = extractToolResult(msg, index);
            if (toolResult) {
                pendingResults.push(toolResult);
            }
            return;
        }

        const rawText = extractText(msg);
        if (!rawText) return;
        const { cleanText, cleanMap } = cleanTextWithMap(rawText, cleaner);
        const role = resolveNarrativeRole(msg, rawRole);
        const timestamp = normalizeTimestamp(
            msg.timestamp ?? msg.createdAt ?? msg.created_at
        );
        const sourceRef = `${sourceRefPrefix}#${sourceIndex}`;
        const id = buildNarrativeRecordId(sessionId, sourceIndex);

        conversationRecords.push({
            id,
            sourceClass: "raw",
            sourceType: "session_trace",
            sourceRef,
            role,
            timestamp,
            rawText,
            cleanText,
            cleanMap,
            language: detectLanguage(cleanText || rawText),
            metadata: {
                sessionId,
                sourceRef,
                sourceCategory: "conversation",
                sourceIndex: String(sourceIndex),
            },
        });
    });

    const operationRecords =
        options.includeOperations === false
              ? []
              : buildOperationNarrativeRecordsFromCollected({
                    sourceRefPrefix,
                    sessionId,
                    cleaner,
                    minSourceIndexExclusive,
                    toolCleaningProfiles,
                    toolCallMap,
                    pendingResults,
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

function normalizeRoleLabel(value?: string): string | null {
    if (!value) return null;
    const lower = value.toLowerCase();
    if (lower.includes("tool")) return "tool";
    if (lower.includes("user")) return "user";
    if (lower.includes("assistant") || lower.includes("model")) return "assistant";
    if (lower.includes("system")) return "system";
    return "unknown";
}

function resolveNarrativeRole(
    msg: RawSessionMessage,
    rawRole?: string
): V8NarrativeRecord["role"] {
    const explicitRole = String(rawRole || "").trim();
    if (explicitRole) return explicitRole;
    const candidates = [
        msg.speaker,
        (msg.message as { speaker?: string } | undefined)?.speaker,
    ];
    for (const candidate of candidates) {
        const normalized = String(candidate || "").trim();
        if (!normalized) continue;
        return normalized;
    }
    const normalizedRole = normalizeRoleLabel(rawRole);
    return normalizedRole;
}

function resolveMessageRole(msg: RawSessionMessage): string {
    return (
        (msg.message as { role?: string } | undefined)?.role ||
        msg.role ||
        msg.speaker ||
        ""
    );
}

function normalizeTimestamp(value?: string | number): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") {
        const ts = value > 1e12 ? value : value * 1000;
        return new Date(ts).toISOString();
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
    }
    return null;
}

function buildNarrativeRecordId(sessionId: string, index: number): string {
    return `narr_${sessionId}_${index}`;
}

function buildOperationRecordId(sessionId: string, index: number): string {
    return `narr_${sessionId}_op_${index}`;
}

function deriveSessionId(sourceRefPrefix: string): string | null {
    if (!sourceRefPrefix) return null;
    const last = sourceRefPrefix.split(/[\\/]/).pop();
    if (!last) return null;
    return last.replace(/\.[^.]+$/, "") || null;
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

function cleanTextWithMap(
    rawText: string,
    patternsOrCleaner: RegExp[] | CompiledCleanPatterns
): { cleanText: string; cleanMap: V8NarrativeRecord["cleanMap"] } {
    const cleaner = Array.isArray(patternsOrCleaner)
        ? compileCleanPatterns(patternsOrCleaner)
        : patternsOrCleaner;
    const ranges = collectRemovalRanges(rawText, cleaner);
    const merged = mergeRanges(ranges);
    const cleanMap: NonNullable<V8NarrativeRecord["cleanMap"]> = [];
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

interface OperationProfile {
    kind: OperationKind;
    promotion: OperationPromotion;
    rule?: ToolCleaningProfile;
}

function buildOperationNarrativeRecordsFromCollected(input: {
    sourceRefPrefix: string;
    sessionId: string;
    cleaner: CompiledCleanPatterns;
    minSourceIndexExclusive: number;
    toolCleaningProfiles?: Map<string, ToolCleaningProfile>;
    toolCallMap: Map<string, ToolCallInfo>;
    pendingResults: ToolResultInfo[];
}): V8NarrativeRecord[] {
    const {
        sourceRefPrefix,
        sessionId,
        cleaner,
        minSourceIndexExclusive,
        toolCleaningProfiles,
        toolCallMap,
        pendingResults,
    } = input;
    const records: V8NarrativeRecord[] = [];

    let opIndex = 0;
    for (const result of pendingResults) {
        if (isIgnoredLegacyOperation(toolCallMap.get(result.toolCallId), result)) {
            if (result.toolCallId) {
                toolCallMap.delete(result.toolCallId);
            }
            continue;
        }
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
            cleaner,
            toolCleaningProfiles
        );
        records.push(record);
        if (result.toolCallId) {
            toolCallMap.delete(result.toolCallId);
        }
    }

    for (const call of toolCallMap.values()) {
        if (call.sourceIndex <= minSourceIndexExclusive) continue;
        if (isIgnoredLegacyOperation(call, null)) continue;
        opIndex += 1;
        const record = buildOperationRecord(
            call,
            null,
            opIndex,
            sourceRefPrefix,
            sessionId,
            cleaner,
            toolCleaningProfiles
        );
        records.push(record);
    }

    return records;
}

function isIgnoredLegacyOperation(
    call: ToolCallInfo | undefined,
    result: ToolResultInfo | null
): boolean {
    const toolName = (call?.toolName || result?.toolName || "").toLowerCase();
    return toolName === "memory_record";
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
    const calls: ToolCallInfo[] = [];
    const seen = new Set<string>();

    const pushCall = (call: ToolCallInfo) => {
        const key = `${call.toolCallId || ""}:${call.toolName || ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        calls.push(call);
    };

    const content = extractContentArray(msg);
    for (const item of content) {
        const type = item?.type || "";
        if (!type) continue;
        if (
            type !== "toolCall" &&
            type !== "tool_call" &&
            type !== "tool_use"
        ) {
            continue;
        }
        const toolName =
            item.name ||
            item.toolName ||
            item.tool_name ||
            item.tool ||
            item.function?.name ||
            "tool";
        pushCall({
            toolCallId:
                item.id || item.toolCallId || item.tool_call_id || "",
            toolName,
            description: extractToolDescription(item),
            arguments: item.arguments ?? item.function?.arguments,
            messageId: msg.id,
            parentId: msg.parentId,
            timestamp:
                msg.timestamp ??
                msg.createdAt ??
                msg.created_at ??
                msg.message?.timestamp,
            sourceIndex,
        });
    }

    const rawToolCalls =
        msg.message?.tool_calls ??
        msg.message?.toolCalls ??
        msg.message?.function_call ??
        msg.message?.functionCall;
    const toolCalls = Array.isArray(rawToolCalls)
        ? rawToolCalls
        : rawToolCalls
          ? [rawToolCalls]
          : [];
    for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        const callObj = call as Record<string, unknown>;
        const fn = callObj.function as Record<string, unknown> | undefined;
        const toolName =
            (typeof callObj.name === "string" && callObj.name) ||
            (typeof callObj.toolName === "string" && callObj.toolName) ||
            (typeof callObj.tool_name === "string" && callObj.tool_name) ||
            (typeof callObj.tool === "string" && callObj.tool) ||
            (typeof fn?.name === "string" && fn?.name) ||
            "tool";
        pushCall({
            toolCallId:
                (typeof callObj.id === "string" && callObj.id) ||
                (typeof callObj.toolCallId === "string" && callObj.toolCallId) ||
                (typeof callObj.tool_call_id === "string" && callObj.tool_call_id) ||
                "",
            toolName,
            description: extractToolDescription(callObj),
            arguments: callObj.arguments ?? fn?.arguments,
            messageId: msg.id,
            parentId: msg.parentId,
            timestamp:
                msg.timestamp ??
                msg.createdAt ??
                msg.created_at ??
                msg.message?.timestamp,
            sourceIndex,
        });
    }

    return calls.filter((call) => Boolean(call.toolCallId || call.toolName));
}

function extractToolResult(
    msg: RawSessionMessage,
    sourceIndex: number
): ToolResultInfo | null {
    const role =
        (msg.message as { role?: string } | undefined)?.role ||
        msg.role ||
        msg.speaker;
    if (role !== "toolResult" && role !== "tool") return null;
    const toolCallId =
        msg.message?.toolCallId ||
        msg.message?.tool_call_id ||
        (msg as { toolCallId?: string }).toolCallId;
    const toolName =
        msg.message?.toolName ||
        msg.message?.tool_name ||
        msg.message?.name ||
        msg.message?.tool ||
        (msg as { toolName?: string }).toolName;
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
    toolCallId?: string;
    tool_call_id?: string;
    toolName?: string;
    tool_name?: string;
    tool?: string;
    function?: {
        name?: string;
        arguments?: unknown;
        description?: string;
    };
}> {
    const raw = msg.message?.content ?? msg.content;
    if (Array.isArray(raw)) return raw;
    return [];
}

function extractToolDescription(item: {
    description?: string;
    arguments?: unknown;
    function?: { description?: string; arguments?: unknown };
}): string | undefined {
    if (item.description) return item.description;
    if (item.function?.description) return item.function.description;
    if (item.arguments && typeof item.arguments === "object") {
        const args = item.arguments as Record<string, unknown>;
        if (typeof args.description === "string") return args.description;
    }
    if (item.function?.arguments && typeof item.function.arguments === "object") {
        const args = item.function.arguments as Record<string, unknown>;
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
    const detailText = extractStructuredDetailText(details);
    if (detailText) {
        return detailText;
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
    cleaner: CompiledCleanPatterns,
    toolCleaningProfiles?: Map<string, ToolCleaningProfile>
): V8NarrativeRecord {
    const toolName = call?.toolName || result?.toolName || "tool";
    const profile = classifyOperation(
        toolName,
        call?.arguments,
        result,
        toolCleaningProfiles
    );
    const description = call?.description?.trim();
    const inputSummary = summarizeToolArguments(call?.arguments, profile);
    const resultSummary = summarizeToolResult(result, profile);
    const output = summarizeToolOutput(toolName, call?.arguments, result, profile);

    const lines: string[] = [];
    lines.push("#### Tool operation");
    let firstSentence = buildOperationIntro(toolName, call?.arguments, profile);
    if (description && !sentenceAlreadyContains(firstSentence, description)) {
        firstSentence += ` ${capitalizeSentence(trimTrailingPeriod(description))}.`;
    }
    if (inputSummary) firstSentence += ` Input: ${inputSummary}.`;
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
    const { cleanText, cleanMap } = cleanTextWithMap(rawText, cleaner);
    const timestamp = normalizeTimestamp(result?.timestamp ?? call?.timestamp);
    const sourceRef = `${sourceRefPrefix}#op-${index}`;
    const id = buildOperationRecordId(sessionId, index);

    const metadata: Record<string, string> = {
        sessionId,
        sourceRef,
        sourceCategory: "operation",
        toolName,
        operationKind: profile.kind,
        operationPromotion: profile.promotion,
    };
    const sourceIndex = result?.sourceIndex ?? call?.sourceIndex;
    if (typeof sourceIndex === "number") {
        metadata.sourceIndex = String(sourceIndex + 1);
    }
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
        role: "assistant",
        timestamp,
        rawText,
        cleanText,
        cleanMap,
        language: detectLanguage(cleanText || rawText),
        metadata,
    };
}

function classifyOperation(
    toolName: string,
    args: unknown,
    result: ToolResultInfo | null,
    toolCleaningProfiles?: Map<string, ToolCleaningProfile>
): OperationProfile {
    const rule = getToolCleaningProfile(toolCleaningProfiles, toolName);
    const heuristic = classifyOperationHeuristically(toolName, args, result, rule);
    return {
        kind: rule?.kind ?? heuristic.kind,
        promotion: rule?.promotion ?? heuristic.promotion,
        rule,
    };
}

function classifyOperationHeuristically(
    toolName: string,
    args: unknown,
    result: ToolResultInfo | null,
    rule?: ToolCleaningProfile
): OperationProfile {
    const name = toolName.toLowerCase();
    const argRecord = toRecord(args);
    const command =
        typeof argRecord?.command === "string"
            ? argRecord.command.toLowerCase()
            : "";
    const resultText = (result?.contentText || "").trim();
    const detailText = extractStructuredDetailText(result?.details, rule);
    const richPayload = extractWritablePayload(args, rule);
    const hasRichText = isHighSignalText(resultText || detailText || richPayload || "");

    if (name === "read") {
        return { kind: "read_artifact", promotion: "llm_ir", rule };
    }
    if (
        name === "web_search" ||
        name.includes("search") ||
        name.includes("browser") ||
        name.includes("fetch") ||
        hasQueryReference(argRecord, rule) ||
        hasUrlReference(argRecord, rule)
    ) {
        return { kind: "web_lookup", promotion: "llm_ir", rule };
    }
    if (name === "memory_record") {
        return { kind: "legacy_memory_write", promotion: "metadata_only", rule };
    }
    if (
        hasArtifactReference(argRecord, rule) &&
        (hasRichText || looksLikeReadCommand(command) || looksLikeContentExtractionCommand(command))
    ) {
        return { kind: "read_artifact", promotion: "llm_ir", rule };
    }
    if (
        name === "write" ||
        name === "edit" ||
        name === "apply_patch" ||
        hasWritablePayload(argRecord, rule)
    ) {
        return { kind: "artifact_write", promotion: "llm_ir", rule };
    }
    if (name === "process") {
        return { kind: "process_control", promotion: "metadata_only", rule };
    }
    if (
        name === "exec" ||
        name === "shell" ||
        name === "bash" ||
        name === "node" ||
        name === "python"
    ) {
        if (looksLikeContentExtractionCommand(command)) {
            return { kind: "content_extraction", promotion: "llm_ir", rule };
        }
        if (looksLikeReadCommand(command)) {
            return { kind: "read_artifact", promotion: "llm_ir", rule };
        }
        if (looksLikeFilesystemProbe(command)) {
            return { kind: "filesystem_probe", promotion: "evidence_only", rule };
        }
        return { kind: "command_execution", promotion: "evidence_only", rule };
    }
    if (hasRichText) {
        return { kind: "tool_operation", promotion: "llm_ir", rule };
    }
    if (result?.contentText?.trim()) {
        return { kind: "tool_operation", promotion: "evidence_only", rule };
    }
    return { kind: "tool_operation", promotion: "metadata_only", rule };
}

function buildOperationIntro(
    toolName: string,
    args: unknown,
    profile: OperationProfile
): string {
    const target = extractOperationTarget(args, profile.rule);
    switch (profile.kind) {
        case "read_artifact":
            return target
                ? `Assistant used \`${toolName}\` to read ${target}.`
                : `Assistant used \`${toolName}\` to read an artifact.`;
        case "web_lookup":
            return `Assistant used \`${toolName}\` to search external sources.`;
        case "artifact_write":
            return target
                ? `Assistant used \`${toolName}\` to write ${target}.`
                : `Assistant used \`${toolName}\` to write an artifact.`;
        case "content_extraction":
            return `Assistant used \`${toolName}\` to extract content from an external artifact.`;
        case "filesystem_probe":
            return `Assistant used \`${toolName}\` to inspect the filesystem or environment.`;
        case "process_control":
            return `Assistant used \`${toolName}\` to manage a background process.`;
        case "legacy_memory_write":
            return `Assistant used \`${toolName}\` to write into the legacy memory store.`;
        default:
            return `Assistant ran \`${toolName}\`.`;
    }
}

function summarizeToolArguments(
    args: unknown,
    profile: OperationProfile
): string | null {
    if (args === null || args === undefined) return null;
    if (typeof args === "string") return wrapInlineCode(trimLongText(args, 180));
    if (typeof args !== "object") return String(args);
    const obj = args as Record<string, unknown>;
    const parts: string[] = [];
    const seenKeys = new Set<string>();
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
    const addKey = (key: string, code = false) => {
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);
        add(key, obj[key], code);
    };
    const inputHints = profile.rule?.inputHints;
    for (const key of inputHints?.commandKeys || []) addKey(key, true);
    for (const key of [
        ...(inputHints?.artifactKeys || []),
        ...(inputHints?.urlKeys || []),
    ]) {
        addKey(key, true);
    }
    for (const key of inputHints?.queryKeys || []) addKey(key);
    for (const key of inputHints?.metadataKeys || []) addKey(key);
    addKey("command", true);
    addKey("path", true);
    addKey("file_path", true);
    addKey("file", true);
    addKey("offset");
    addKey("limit");
    addKey("start");
    addKey("end");
    addKey("query");
    addKey("url", true);
    addKey("action");
    addKey("sessionId");
    addKey("pid");
    if (profile.kind === "artifact_write" && hasWritablePayload(obj, profile.rule)) {
        parts.push("payload present");
    }
    if (parts.length) return parts.join(", ");
    try {
        return trimLongText(JSON.stringify(obj), 200);
    } catch {
        return null;
    }
}

function summarizeToolResult(
    result: ToolResultInfo | null,
    profile?: OperationProfile
): string | null {
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
    for (const key of profile?.rule?.resultHints?.metadataKeys || []) {
        if (["status", "exitCode", "durationMs", "sessionId", "pid"].includes(key)) {
            continue;
        }
        const value = details[key];
        if (typeof value === "string" && value.trim()) {
            parts.push(`${key} ${trimLongText(value.trim(), 80)}`);
        } else if (typeof value === "number" || typeof value === "boolean") {
            parts.push(`${key} ${String(value)}`);
        }
    }
    return `Result: ${parts.join(", ")}.`;
}

function summarizeToolOutput(
    toolName: string,
    args: unknown,
    result: ToolResultInfo | null,
    profile: OperationProfile
): string | null {
    const cleaned = normalizeOutputWhitespace(
        stripUntrustedBlocks(resolveResultText(result, profile))
    );
    switch (profile.kind) {
        case "web_lookup":
            return formatWebLookupOutput(args, cleaned, profile);
        case "artifact_write":
            return formatWrittenPayload(args, cleaned);
        case "read_artifact":
            return formatReadLikeOutput(args, cleaned, 2600, 90, profile);
        case "content_extraction":
            return formatReadLikeOutput(args, cleaned, 2200, 80, profile);
        case "filesystem_probe":
            return cleaned
                ? limitTextByLines(
                      cleaned,
                      resolveMaxChars(700, profile),
                      resolveMaxLines(18, profile)
                  )
                : null;
        case "legacy_memory_write":
            {
                const legacyPayload = formatWrittenPayload(args, cleaned);
                return legacyPayload
                    ? limitTextByLines(
                          legacyPayload,
                          resolveMaxChars(600, profile),
                          resolveMaxLines(16, profile)
                      )
                    : null;
            }
        case "process_control":
            return cleaned
                ? limitTextByLines(
                      cleaned,
                      resolveMaxChars(240, profile),
                      resolveMaxLines(6, profile)
                  )
                : null;
        default: {
            if (!cleaned) return null;
            const isCommandLike =
                ["exec", "process", "shell", "bash", "node", "python"].includes(
                    toolName
                ) ||
                (typeof args === "object" &&
                    args !== null &&
                    typeof (args as Record<string, unknown>).command === "string");
            const maxChars = resolveMaxChars(
                isCommandLike ? 900 : 1600,
                profile
            );
            const maxLines = resolveMaxLines(
                isCommandLike ? 24 : 40,
                profile
            );
            return limitTextByLines(cleaned, maxChars, maxLines);
        }
    }
}

function extractStructuredDetailText(
    details?: Record<string, unknown>,
    rule?: ToolCleaningProfile
): string {
    if (!details) return "";
    const preferredKeys = uniqueKeys([
        ...(rule?.resultHints?.textKeys || []),
        "excerpt",
        "summary",
        "output",
        "stdout",
        "stderr",
        "text",
        "result",
        "body",
        "content",
    ]);
    for (const key of preferredKeys) {
        const value = details[key];
        const text = stringifyStructuredValue(value);
        if (text) return text;
    }
    return "";
}

function formatWebLookupOutput(
    args: unknown,
    text: string,
    profile: OperationProfile
): string | null {
    const parsed = tryParseJson(text);
    if (!parsed || typeof parsed !== "object") {
        return text
            ? limitTextByLines(
                  text,
                  resolveMaxChars(1500, profile),
                  resolveMaxLines(32, profile)
              )
            : null;
    }
    const record = parsed as Record<string, unknown>;
    if (
        String(record.status || "").toLowerCase() === "error" ||
        String(record.type || "").toLowerCase() === "errorresponse" ||
        Boolean(toRecord(record.error))
    ) {
        const summary = summarizeOperationError(record);
        return summary ? `Search error: ${summary}` : "Search error.";
    }
    const results = Array.isArray(record.results) ? record.results : [];
    if (results.length === 0) {
        return text
            ? limitTextByLines(
                  text,
                  resolveMaxChars(1200, profile),
                  resolveMaxLines(28, profile)
              )
            : null;
    }
    const lines: string[] = [];
    const query = readNamedString(
        args,
        uniqueKeys([...(profile.rule?.inputHints?.queryKeys || []), "query", "q"])
    );
    const provider =
        typeof record.provider === "string" ? record.provider : "unknown";
    const count =
        typeof record.count === "number" ? record.count : results.length;
    lines.push(
        `Search summary: provider=${provider}, results=${count}${
            query ? `, query=${query}` : ""
        }.`
    );
    for (const result of results.slice(0, 8)) {
        if (!result || typeof result !== "object") continue;
        const item = result as Record<string, unknown>;
        const title = sanitizeSearchLabel(
            typeof item.title === "string" ? item.title : ""
        );
        const site = sanitizeSearchLabel(
            typeof item.siteName === "string" ? item.siteName : ""
        );
        const published =
            typeof item.published === "string" ? item.published : "";
        const url = typeof item.url === "string" ? item.url : "";
        const description = sanitizeSearchLabel(
            typeof item.description === "string" ? item.description : ""
        );
        const parts = [title || site || url || "result"];
        if (site && site !== title) parts.push(site);
        if (published) parts.push(published);
        if (url) parts.push(url);
        lines.push(`- ${parts.join(" | ")}`);
        if (description) lines.push(description);
    }
    return limitTextByLines(
        lines.join("\n"),
        resolveMaxChars(2200, profile),
        resolveMaxLines(50, profile)
    );
}

function formatWrittenPayload(args: unknown, text: string): string | null {
    const payload = extractWritablePayload(args);
    if (payload) {
        return limitTextByLines(payload, 2600, 100);
    }
    return text ? limitTextByLines(text, 1000, 24) : null;
}

function formatReadLikeOutput(
    args: unknown,
    text: string,
    maxChars: number,
    maxLines: number,
    profile: OperationProfile
): string | null {
    if (!text) {
        const payload = extractWritablePayload(args, profile.rule);
        if (!payload) return null;
        return limitTextByLines(
            payload,
            resolveMaxChars(maxChars, profile),
            resolveMaxLines(maxLines, profile)
        );
    }
    return limitTextByLines(
        text,
        resolveMaxChars(maxChars, profile),
        resolveMaxLines(maxLines, profile)
    );
}

function summarizeOperationError(record: Record<string, unknown>): string {
    const errorString =
        typeof record.error === "string" ? record.error.trim() : "";
    if (errorString) {
        const nested = tryParseJson(errorString);
        const nestedRecord = toRecord(nested);
        if (nestedRecord) {
            return summarizeOperationError(nestedRecord);
        }
        return trimLongText(errorString.replace(/\s+/g, " "), 280);
    }
    const errorRecord = toRecord(record.error) || record;
    const meta = toRecord(errorRecord.meta);
    const detail =
        readNamedString(errorRecord, ["detail", "message", "code"]) ||
        stringifyStructuredValue(errorRecord.error) ||
        stringifyStructuredValue(errorRecord);
    const metaErrors = Array.isArray(meta?.errors)
        ? (meta.errors as Array<unknown>)
        : [];
    const firstMeta = toRecord(metaErrors[0]);
    const field =
        Array.isArray(firstMeta?.loc) && firstMeta.loc.length
            ? String(firstMeta.loc[firstMeta.loc.length - 1])
            : "";
    const fieldMsg =
        typeof firstMeta?.msg === "string" ? firstMeta.msg.trim() : "";
    const parts = [detail.replace(/\s+/g, " ").trim()];
    if (field && fieldMsg) {
        parts.push(`Field ${field}: ${fieldMsg}`);
    }
    return trimLongText(parts.filter(Boolean).join(" "), 280);
}

function sanitizeSearchLabel(value: string): string {
    const compact = value
        .replace(/\[external content omitted\]/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    return compact;
}

function tryParseJson(text: string): unknown {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        const firstBrace = text.indexOf("{");
        const firstBracket = text.indexOf("[");
        const candidates = [firstBrace, firstBracket]
            .filter((index) => index >= 0)
            .sort((a, b) => a - b);
        for (const index of candidates) {
            const sliced = text.slice(index).trim();
            try {
                return JSON.parse(sliced);
            } catch {
                // keep trying
            }
        }
        return null;
    }
}

function hasWritablePayload(
    value: Record<string, unknown> | null,
    rule?: ToolCleaningProfile
): boolean {
    if (!value) return false;
    for (const key of uniqueKeys([
        ...(rule?.inputHints?.payloadKeys || []),
        "content",
        "text",
        "body",
        "data",
        "payload",
        "patch",
        "new_string",
        "old_string",
    ])) {
        if (stringifyStructuredValue(value[key])) {
            return true;
        }
    }
    return false;
}

function extractWritablePayload(
    args: unknown,
    rule?: ToolCleaningProfile
): string | null {
    const record = toRecord(args);
    if (!record) return null;
    for (const key of uniqueKeys([
        ...(rule?.inputHints?.payloadKeys || []),
        "content",
        "text",
        "body",
        "data",
        "payload",
        "patch",
        "new_string",
        "old_string",
    ])) {
        const payload = stringifyStructuredValue(record[key]);
        if (payload) return normalizeOutputWhitespace(payload);
    }
    return null;
}

function stringifyStructuredValue(value: unknown): string {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length ? prettyPrintJsonString(trimmed) : "";
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (!value || typeof value !== "object") return "";
    try {
        return JSON.stringify(value, null, 2).trim();
    } catch {
        return "";
    }
}

function prettyPrintJsonString(text: string): string {
    if (
        (text.startsWith("{") && text.endsWith("}")) ||
        (text.startsWith("[") && text.endsWith("]"))
    ) {
        const parsed = tryParseJson(text);
        if (parsed !== null) {
            try {
                return JSON.stringify(parsed, null, 2);
            } catch {
                return text;
            }
        }
    }
    return text;
}

function readNamedString(
    input: unknown,
    keys: string[]
): string | null {
    const record = toRecord(input);
    if (!record) return null;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function extractOperationTarget(
    args: unknown,
    rule?: ToolCleaningProfile
): string | null {
    const record = toRecord(args);
    if (!record) return null;
    const direct = readNamedString(
        record,
        uniqueKeys([
            ...(rule?.inputHints?.artifactKeys || []),
            ...(rule?.inputHints?.urlKeys || []),
            "path",
            "file_path",
            "file",
            "url",
            "target",
            "pdf_path",
            "document_path",
        ])
    );
    if (direct) return wrapInlineCode(trimLongText(direct, 220));
    return null;
}

function hasArtifactReference(
    value: Record<string, unknown> | null,
    rule?: ToolCleaningProfile
): boolean {
    if (!value) return false;
    return Boolean(
        readNamedString(
            value,
            uniqueKeys([
                ...(rule?.inputHints?.artifactKeys || []),
                ...(rule?.inputHints?.urlKeys || []),
            "path",
            "file_path",
            "file",
            "url",
            "target",
            "pdf_path",
            "document_path",
            ])
        )
    );
}

function hasQueryReference(
    value: Record<string, unknown> | null,
    rule?: ToolCleaningProfile
): boolean {
    if (!value) return false;
    return Boolean(
        readNamedString(
            value,
            uniqueKeys([...(rule?.inputHints?.queryKeys || []), "query", "q"])
        )
    );
}

function hasUrlReference(
    value: Record<string, unknown> | null,
    rule?: ToolCleaningProfile
): boolean {
    if (!value) return false;
    return Boolean(
        readNamedString(
            value,
            uniqueKeys([...(rule?.inputHints?.urlKeys || []), "url"])
        )
    );
}

function isHighSignalText(text: string): boolean {
    const normalized = normalizeOutputWhitespace(text);
    if (!normalized) return false;
    if (looksLikeTrivialStatus(normalized)) return false;
    if (normalized.length >= 160) return true;
    if (tryParseJson(normalized) && normalized.length >= 100) return true;
    return false;
}

function looksLikeTrivialStatus(text: string): boolean {
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) return true;
    if (normalized === "(no output)") return true;
    if (normalized.includes("process still running")) return true;
    if (normalized.includes("termination requested")) return true;
    if (/^successfully wrote \d+ bytes to /.test(normalized)) return true;
    return false;
}

function looksLikeFilesystemProbe(command: string): boolean {
    return /\b(ls|find|pwd|which|stat|df|du|env|printenv|ps)\b/.test(command);
}

function looksLikeReadCommand(command: string): boolean {
    return /\b(cat|sed|awk|head|tail|rg|grep|bat|less|more)\b/.test(command);
}

function looksLikeContentExtractionCommand(command: string): boolean {
    return /\b(pdftotext|pdfinfo|python|python3|tesseract|ocr|pymupdf|fitz|mutool|pandoc|textract)\b/.test(
        command
    ) || /\.pdf\b/.test(command);
}

function sentenceAlreadyContains(sentence: string, fragment: string): boolean {
    const left = sentence.replace(/\s+/g, " ").trim().toLowerCase();
    const right = fragment.replace(/\s+/g, " ").trim().toLowerCase();
    return !!right && left.includes(right);
}

function capitalizeSentence(value: string): string {
    if (!value) return value;
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeOutputWhitespace(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const cleaned = removeBinaryLikeLines(
        normalized.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    );
    return cleaned.trim();
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

function removeBinaryLikeLines(text: string): string {
    if (!text) return text;
    const lines = text.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
        if (!line) {
            kept.push(line);
            continue;
        }
        if (isBinaryLikeLine(line)) continue;
        kept.push(line);
    }
    return kept.join("\n");
}

function isBinaryLikeLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.includes("\uFFFD")) return true;
    if (/^%PDF-\d\.\d/.test(trimmed)) return true;
    if (trimmed === "xref" || trimmed === "trailer" || trimmed === "startxref") return true;
    if (/^\d+\s+\d+\s+obj$/.test(trimmed) || trimmed === "endobj") return true;

    const total = trimmed.length;
    let replacement = 0;
    let suspicious = 0;
    for (const ch of trimmed) {
        const cp = ch.codePointAt(0) || 0;
        if (ch === "\uFFFD") replacement += 1;
        const isPrintableAscii = cp >= 0x20 && cp <= 0x7e;
        const isCjk = cp >= 0x4e00 && cp <= 0x9fff;
        const isCommonPunct = "，。！？；：（）【】《》“”‘’、…—·".includes(ch);
        const isWhitespace = ch === " " || ch === "\t";
        if (!isPrintableAscii && !isCjk && !isCommonPunct && !isWhitespace) {
            suspicious += 1;
        }
    }
    if (replacement >= 3 && replacement / total >= 0.08) return true;
    if (suspicious / total >= 0.35) return true;
    return false;
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

function resolveResultText(
    result: ToolResultInfo | null,
    profile: OperationProfile
): string {
    if (!result) return "";
    const detailText = extractStructuredDetailText(result.details, profile.rule);
    return detailText || result.contentText || "";
}

function resolveMaxChars(
    fallback: number,
    profile: OperationProfile
): number {
    return profile.rule?.maxChars ?? fallback;
}

function resolveMaxLines(
    fallback: number,
    profile: OperationProfile
): number {
    return profile.rule?.maxLines ?? fallback;
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

function uniqueKeys(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compileCleanPatterns(patterns: RegExp[]): CompiledCleanPatterns {
    return {
        patterns,
        unionPattern: buildUnionPattern(patterns),
    };
}

function buildUnionPattern(patterns: RegExp[]): RegExp | null {
    if (patterns.length === 0) return null;
    const sources = patterns
        .map((pattern) => pattern.source)
        .filter(Boolean)
        .map((source) => `(?:${source})`);
    if (sources.length === 0) return null;
    const flags = collectUnionFlags(patterns);
    try {
        return new RegExp(sources.join("|"), flags);
    } catch {
        return null;
    }
}

function collectUnionFlags(patterns: RegExp[]): string {
    const flags = new Set<string>(["g"]);
    for (const pattern of patterns) {
        for (const flag of pattern.flags) {
            if (flag === "g" || flag === "i" || flag === "m" || flag === "s" || flag === "u") {
                flags.add(flag);
            }
        }
    }
    return [...flags].join("");
}

function collectRemovalRanges(
    text: string,
    cleaner: CompiledCleanPatterns
): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    if (cleaner.unionPattern) {
        collectRangesFromPattern(text, cleaner.unionPattern, ranges);
        return ranges;
    }
    for (const pattern of cleaner.patterns) {
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
