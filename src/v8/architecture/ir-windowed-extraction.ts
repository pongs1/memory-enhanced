import type { V8PendingIr } from "../types_v8.js";
import { parseNarrativeTurnSpans } from "./narrative-turns.js";

interface NarrativeTurn {
    idx: number;
    charStart: number;
    charEnd: number;
    role: string;
    turnType: "user_message" | "assistant_text" | "tool_call_result" | "other";
    text: string;
    timestamp: string | null;
}
export interface V8IrWindow {
    idx: number;
    turnIdxStart: number;
    turnIdxEnd: number;
    turns: NarrativeTurn[];
}

export interface V8NextWindowInput {
    pending: V8PendingIr[];
    turns: NarrativeTurn[];
}

export interface V8ParsedExtractionResponse {
    completedBlocks: string[];
    pending: V8PendingIr[];
}

export function parseNarrativeTurns(markdown: string): NarrativeTurn[] {
    const text = String(markdown || "").replace(/\r\n/g, "\n");
    return parseNarrativeTurnSpans(text).map((turn) => {
        const rawBody = text.slice(turn.bodyStart, turn.bodyEnd);
        const body = rawBody.replace(/^\n+/, "").replace(/\n+$/, "");
        const leadingTrimmed = rawBody.length - rawBody.replace(/^\n+/, "").length;
        const charStart = body.length > 0 ? turn.bodyStart + leadingTrimmed : turn.bodyStart;
        const charEnd = charStart + body.length;
        return {
            idx: turn.ordinal,
            charStart,
            charEnd,
            role: turn.role || "",
            turnType: classifyTurnType(turn.role || ""),
            text: body,
            timestamp: turn.timestamp,
        };
    });
}

export function buildSerialIrWindows(
    turns: NarrativeTurn[],
    options?: { windowSize?: number; overlapTurns?: number }
): V8IrWindow[] {
    if (turns.length === 0) return [];
    const windowSize = Math.max(1, options?.windowSize ?? 6);
    const overlapTurns = Math.max(0, Math.min(windowSize - 1, options?.overlapTurns ?? 2));
    const stride = Math.max(1, windowSize - overlapTurns);
    const windows: V8IrWindow[] = [];

    for (let start = 0; start < turns.length; start += stride) {
        const slice = turns.slice(start, start + windowSize);
        if (slice.length === 0) break;
        windows.push({
            idx: windows.length + 1,
            turnIdxStart: slice[0]!.idx,
            turnIdxEnd: slice[slice.length - 1]!.idx,
            turns: slice,
        });
        if (start + windowSize >= turns.length) break;
    }

    return windows;
}

export function buildNextWindowInput(input: {
    pending: V8PendingIr[];
    overlapTurns: NarrativeTurn[];
    newTurns: NarrativeTurn[];
}): V8NextWindowInput {
    return {
        pending: input.pending.slice(),
        turns: [...input.overlapTurns, ...input.newTurns],
    };
}

export function parseExtractionMarkdownResponse(markdown: string): V8ParsedExtractionResponse {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const completedBlocks: string[] = [];
    const pending: V8PendingIr[] = [];

    let mode: "completed" | "pending" | null = null;
    let buffer: string[] = [];
    let pendingIndex = 0;

    const flush = () => {
        const body = buffer.join("\n").trim();
        if (!body) {
            buffer = [];
            return;
        }
        if (mode === "completed") {
            completedBlocks.push(`### Item\n${body}`.trim());
        } else if (mode === "pending") {
            const item = parsePendingBlock(body, pendingIndex);
            if (item) {
                pending.push(item);
                pendingIndex += 1;
            }
        }
        buffer = [];
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (/^###\s+Completed Item\s*$/i.test(trimmed)) {
            flush();
            mode = "completed";
            continue;
        }
        if (/^###\s+Pending Item\s*$/i.test(trimmed)) {
            flush();
            mode = "pending";
            continue;
        }
        if (mode) {
            buffer.push(line);
        }
    }
    flush();

    return { completedBlocks, pending };
}

function classifyTurnType(role: string): NarrativeTurn["turnType"] {
    const normalized = role.toLowerCase();
    if (normalized.includes("tool")) return "tool_call_result";
    if (normalized.includes("assistant")) return "assistant_text";
    if (normalized.includes("user")) return "user_message";
    return "other";
}

function parsePendingBlock(block: string, index: number): V8PendingIr | null {
    const lines = String(block || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return null;
    const values: Record<string, string> = {};
    for (const line of lines) {
        const match = line.match(/^(?:-\s*)?([a-zA-Z_]+)\s*:\s*(.*)$/);
        if (!match) continue;
        values[match[1]!.toLowerCase()] = String(match[2] || "").trim();
    }
    const evidence = parsePendingEvidence(values);
    const unitNumbers = evidence?.turnStart
        ? buildTurnRange(evidence.turnStart, evidence.turnEnd ?? evidence.turnStart)
        : String(values.unit_numbers || "")
              .split(/[,，\s]+/)
              .map((value) => Number.parseInt(value, 10))
              .filter((value) => Number.isFinite(value));
    const rawRole = String(values.tension_role || "none").trim().toLowerCase();
    const tensionRole: V8PendingIr["tensionRole"] =
        rawRole === "open" || rawRole === "advance" || rawRole === "state" ? rawRole : "none";
    return {
        id: values.id || `pending_${index + 1}`,
        narrativeRecordId: evidence?.narrativeRecordId,
        tensionRole,
        subject: values.point_a || values.subject || undefined,
        predicate: values.relation || values.predicate || undefined,
        relationFamily: values.relation_family || undefined,
        object: values.point_b || values.object || undefined,
        startTurn: evidence?.turnStart,
        endTurn: evidence?.turnEnd,
        startAnchor: values.evidence_start_anchor || values.anchor_start || undefined,
        endAnchor: values.evidence_end_anchor || values.anchor_end || undefined,
        hasExplicitEndEvidence: Boolean(
            values.evidence_end_turn || values.evidence_end_anchor || values.anchor_end
        ),
        turnRefs: unitNumbers,
        charStart: Number.parseInt(values.char_start || "0", 10) || 0,
        charEnd: Number.parseInt(values.char_end || "0", 10) || 0,
        status: "pending",
    } as V8PendingIr;
}

function parsePendingEvidence(values: Record<string, string>): { narrativeRecordId?: string; turnStart: number; turnEnd?: number } | null {
    const start = Number.parseInt(String(values.evidence_start_turn || '').trim(), 10);
    const end = Number.parseInt(String(values.evidence_end_turn || '').trim(), 10);
    if (Number.isFinite(start) && Number.isFinite(end)) {
        return {
            turnStart: Math.min(start, end),
            turnEnd: Math.max(start, end),
        };
    }
    if (Number.isFinite(start)) {
        return {
            turnStart: start,
        };
    }
    return parseEvidenceDescriptor(String(values.evidence || ''));
}

function parseEvidenceDescriptor(value: string): { narrativeRecordId?: string; turnStart: number; turnEnd?: number } | null {
    const trimmed = String(value || "").trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(?:(.*?)\s+)?turns?\s+(\d+)(?:\s*-\s*(\d+))?$/i);
    if (!match) return null;
    const turnStart = Number.parseInt(match[2] || "", 10);
    const turnEnd = match[3] ? Number.parseInt(match[3] || "", 10) : undefined;
    if (!Number.isFinite(turnStart)) return null;
    return {
        narrativeRecordId: String(match[1] || "").trim() || undefined,
        turnStart: turnEnd && Number.isFinite(turnEnd) ? Math.min(turnStart, turnEnd) : turnStart,
        turnEnd: turnEnd && Number.isFinite(turnEnd) ? Math.max(turnStart, turnEnd) : undefined,
    };
}

function buildTurnRange(start: number, end: number): number[] {
    const output: number[] = [];
    for (let current = start; current <= end; current += 1) {
        output.push(current);
    }
    return output;
}

