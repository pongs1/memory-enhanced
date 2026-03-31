import { Worker } from "node:worker_threads";
import type { V8NarrativeRecord, V8NarrativeSourceCategory, V8Unit } from "../types_v8.js";
import {
    type NarrativeLine,
    parseNarrativeTurnSpans,
    splitNarrativeLinesWithOffsets,
} from "./narrative-turns.js";

export interface UnitizerConfig {
    microMaxChars?: number;
    mesoMaxSentences?: number;
    mesoMinSentences?: number;
    mesoMaxChars?: number;
    macroTargetMesoUnits?: number;
    macroMaxMesoUnits?: number;
    macroTargetChars?: number;
    macroMaxChars?: number;
}

const DEFAULT_CONFIG: Required<UnitizerConfig> = {
    microMaxChars: 420,
    mesoMaxSentences: 8,
    mesoMinSentences: 2,
    mesoMaxChars: 3200,
    macroTargetMesoUnits: 4,
    macroMaxMesoUnits: 8,
    macroTargetChars: 12000,
    macroMaxChars: 28000,
};

interface TurnSpan {
    ordinal: number;
    headerStart: number;
    headerEnd: number;
    bodyStart: number;
    bodyEnd: number;
    role: V8Unit["role"];
    timestamp: string | null;
    sourceCategory: V8NarrativeSourceCategory;
}

type DiscourseBlockKind =
    | "paragraph"
    | "list"
    | "code"
    | "label"
    | "quote";

interface DiscourseBlock {
    start: number;
    end: number;
    kind: DiscourseBlockKind;
}

interface MicroDescriptor {
    start: number;
    end: number;
    turnOrdinal: number;
    role: V8Unit["role"];
    timestamp: string | null;
    sourceCategory: V8NarrativeSourceCategory;
}

interface AtomicPiece extends DiscourseBlock {
    start: number;
    end: number;
}

interface MesoDescriptor {
    start: number;
    end: number;
    turnStartOrdinal: number;
    turnEndOrdinal: number;
    role: V8Unit["role"];
    timestamp: string | null;
    sourceCategory: V8NarrativeSourceCategory;
}

interface MacroDescriptor {
    start: number;
    end: number;
    role: V8Unit["role"];
    timestamp: string | null;
    sourceCategory: V8NarrativeSourceCategory;
}

interface WorkerNarrativeInput {
    id: string;
    sourceRef: string;
    language: V8NarrativeRecord["language"];
    metadata: V8NarrativeRecord["metadata"];
}

export function unitizeNarrativeRecords(
    records: V8NarrativeRecord[],
    config?: UnitizerConfig
): V8Unit[] {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const units: V8Unit[] = [];

    for (const record of records) {
        const text = record.cleanText ?? record.rawText;
        if (!text.trim()) continue;

        const lines = splitNarrativeLinesWithOffsets(text);
        const turns = buildTurnSpans(lines, text.length);
        const micro = buildMicroDescriptors(text, lines, turns, cfg);
        const meso = buildMesoDescriptors(text, turns, micro, cfg);
        const macro = buildMacroDescriptors(text, meso, cfg);

        const macroUnits = materializeMacroUnits(record, text, macro);
        const mesoUnits = materializeMesoUnits(record, text, meso, macroUnits);
        const microUnits = materializeMicroUnits(record, text, micro, mesoUnits);

        units.push(...macroUnits, ...mesoUnits, ...microUnits);
    }

    return units;
}

export async function unitizeNarrativeRecordsParallel(
    records: V8NarrativeRecord[],
    config?: UnitizerConfig,
    workerCount = 1
): Promise<V8Unit[]> {
    if (workerCount <= 1 || records.length <= 1) {
        return unitizeNarrativeRecords(records, config);
    }

    const inputs: WorkerNarrativeInput[] = [];
    for (const record of records) {
        if (!record.sourceRef) continue;
        inputs.push({
            id: record.id,
            sourceRef: record.sourceRef,
            language: record.language ?? "unknown",
            metadata: record.metadata ?? {},
        });
    }

    if (inputs.length <= 1) {
        return unitizeNarrativeRecords(records, config);
    }

    const shardCount = Math.min(workerCount, inputs.length);
    const shards = chunkArray(inputs, shardCount);
    const results = await Promise.all(
        shards.map((shard) => runUnitizerWorker(shard, config))
    );
    return results.flat();
}

function chunkArray<T>(items: T[], shardCount: number): T[][] {
    const buckets: T[][] = Array.from({ length: shardCount }, () => []);
    items.forEach((item, idx) => {
        buckets[idx % shardCount]?.push(item);
    });
    return buckets.filter((bucket) => bucket.length > 0);
}

function runUnitizerWorker(
    records: WorkerNarrativeInput[],
    config?: UnitizerConfig
): Promise<V8Unit[]> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./unitizer-worker.js", import.meta.url), {
            workerData: { records, config },
        });
        let settled = false;
        worker.once("message", (message: { units?: V8Unit[] }) => {
            settled = true;
            resolve(message.units ?? []);
        });
        worker.once("error", (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
        worker.once("exit", (code) => {
            if (settled) return;
            if (code === 0) {
                resolve([]);
            } else {
                reject(new Error(`unitizer worker exited with code ${code}`));
            }
        });
    });
}

function buildTurnSpans(lines: NarrativeLine[], textLength: number): TurnSpan[] {
    return parseNarrativeTurnSpans(lines.map((line) => line.text).join("")).map((turn) => ({
        ordinal: turn.ordinal,
        headerStart: turn.headerStart,
        headerEnd: turn.headerEnd,
        bodyStart: turn.bodyStart,
        bodyEnd: turn.bodyEnd,
        role: turn.role || null,
        timestamp: turn.timestamp,
        sourceCategory: detectSourceCategory({ role: turn.role || "" }, turn.role || null),
    }));
}

function buildMicroDescriptors(
    text: string,
    lines: NarrativeLine[],
    turns: TurnSpan[],
    cfg: Required<UnitizerConfig>
): MicroDescriptor[] {
    const micros: MicroDescriptor[] = [];

    for (const turn of turns) {
        const fullTurn = trimRange(text, turn.bodyStart, turn.bodyEnd);
        const fullTurnLength = fullTurn.end - fullTurn.start;
        const turnDirectLimit =
            turn.sourceCategory === "operation"
                ? cfg.microMaxChars * 2
                : Math.floor(cfg.microMaxChars * 1.15);
        if (fullTurnLength > 0 && fullTurnLength <= turnDirectLimit) {
            micros.push(describeMicro(fullTurn.start, fullTurn.end, turn));
            continue;
        }

        const blocks = buildDiscourseBlocks(lines, turn);
        if (blocks.length === 0) {
            if (fullTurn.end > fullTurn.start) {
                micros.push(describeMicro(fullTurn.start, fullTurn.end, turn));
            }
            continue;
        }

        const atomic: AtomicPiece[] = blocks.flatMap((block) =>
            splitBlockToAtomicPieces(text, block, cfg.microMaxChars)
        );
        if (atomic.length === 0) continue;

        if (
            turn.sourceCategory === "operation" &&
            atomic.length <= 4 &&
            sumLength(atomic) <= cfg.microMaxChars * 2
        ) {
            micros.push(
                describeMicro(atomic[0]!.start, atomic[atomic.length - 1]!.end, turn)
            );
            continue;
        }

        let groupStartIndex: number | null = null;
        let groupEndIndex = 0;
        let lastKind: DiscourseBlockKind | null = null;

        const flush = () => {
            if (groupStartIndex === null || groupEndIndex < groupStartIndex) return;
            const start = atomic[groupStartIndex]!.start;
            const end = atomic[groupEndIndex]!.end;
            micros.push(describeMicro(start, end, turn));
            groupStartIndex = null;
            groupEndIndex = 0;
            lastKind = null;
        };

        for (let idx = 0; idx < atomic.length; idx += 1) {
            const piece = atomic[idx]!;
            const pieceLength = piece.end - piece.start;
            if (groupStartIndex === null) {
                groupStartIndex = idx;
                groupEndIndex = idx;
                lastKind = piece.kind;
                continue;
            }

            const currentStart = atomic[groupStartIndex]!.start;
            const currentEnd = atomic[groupEndIndex]!.end;
            const currentLength = currentEnd - currentStart;
            const nextLength = piece.end - currentStart;
            const semanticScore = lexicalSimilarity(
                text,
                atomic[groupEndIndex]!.start,
                atomic[groupEndIndex]!.end,
                piece.start,
                piece.end
            );
            const mergeable = canMergeAtomicIntoMicro(
                lastKind,
                piece.kind,
                currentLength,
                pieceLength,
                nextLength,
                semanticScore,
                turn,
                cfg
            );

            if (!mergeable) {
                flush();
                groupStartIndex = idx;
                groupEndIndex = idx;
                lastKind = piece.kind;
                continue;
            }

            groupEndIndex = idx;
            lastKind = piece.kind;
        }

        flush();

        // Post-pass smoothing avoids tiny shards created by punctuation or list wrapping.
        const turnMicros = micros.filter((item) => item.turnOrdinal === turn.ordinal);
        const smoothed = smoothMicroDescriptorsForTurn(text, turnMicros, turn, cfg);
        micros.splice(micros.length - turnMicros.length, turnMicros.length, ...smoothed);
    }

    return micros;
}

function buildDiscourseBlocks(lines: NarrativeLine[], turn: TurnSpan): DiscourseBlock[] {
    const turnLines = lines.filter(
        (line) => line.start >= turn.bodyStart && line.end <= turn.bodyEnd
    );
    const blocks: DiscourseBlock[] = [];
    let idx = 0;

    while (idx < turnLines.length) {
        const line = turnLines[idx]!;
        const trimmed = line.text.trim();

        if (!trimmed) {
            idx += 1;
            continue;
        }
        if (/^---+$/.test(trimmed)) {
            idx += 1;
            continue;
        }
        if (/^```/.test(trimmed)) {
            const start = line.start;
            let end = line.end;
            idx += 1;
            while (idx < turnLines.length) {
                end = turnLines[idx]!.end;
                if (/^```/.test(turnLines[idx]!.text.trim())) {
                    idx += 1;
                    break;
                }
                idx += 1;
            }
            blocks.push({ start, end, kind: "code" });
            continue;
        }
        if (isLabelLine(trimmed)) {
            const start = line.start;
            let end = line.end;
            idx += 1;
            while (idx < turnLines.length) {
                const nextTrimmed = turnLines[idx]!.text.trim();
                if (!nextTrimmed || isBoundaryLine(nextTrimmed)) break;
                end = turnLines[idx]!.end;
                idx += 1;
            }
            blocks.push({ start, end, kind: "label" });
            continue;
        }
        if (isListLine(trimmed)) {
            const start = line.start;
            let end = line.end;
            idx += 1;
            while (idx < turnLines.length) {
                const next = turnLines[idx]!;
                const nextTrimmed = next.text.trim();
                if (!nextTrimmed) break;
                if (isLabelLine(nextTrimmed) || /^```/.test(nextTrimmed)) break;
                if (!isListLine(nextTrimmed) && !isIndentedContinuation(next.text)) break;
                end = next.end;
                idx += 1;
            }
            blocks.push({ start, end, kind: "list" });
            continue;
        }
        if (/^>/.test(trimmed)) {
            const start = line.start;
            let end = line.end;
            idx += 1;
            while (idx < turnLines.length) {
                const nextTrimmed = turnLines[idx]!.text.trim();
                if (!nextTrimmed || !/^>/.test(nextTrimmed)) break;
                end = turnLines[idx]!.end;
                idx += 1;
            }
            blocks.push({ start, end, kind: "quote" });
            continue;
        }

        const start = line.start;
        let end = line.end;
        idx += 1;
        while (idx < turnLines.length) {
            const nextTrimmed = turnLines[idx]!.text.trim();
            if (!nextTrimmed || isBoundaryLine(nextTrimmed)) break;
            end = turnLines[idx]!.end;
            idx += 1;
        }
        blocks.push({ start, end, kind: "paragraph" });
    }

    return blocks;
}

function isBoundaryLine(trimmed: string): boolean {
    return isLabelLine(trimmed) || isListLine(trimmed) || /^```/.test(trimmed) || /^>/.test(trimmed);
}

function isLabelLine(trimmed: string): boolean {
    return /^(Input|Result|Output|Summary|Search summary|包含|回退方法|结果|输出|说明|步骤)[:：]/i.test(
        trimmed
    );
}

function isListLine(trimmed: string): boolean {
    return /^([-*+]\s+|\d+\.\s+)/.test(trimmed);
}

function isIndentedContinuation(line: string): boolean {
    return /^\s{2,}\S/.test(line);
}

function splitBlockToAtomicPieces(
    text: string,
    block: DiscourseBlock,
    maxChars: number
): DiscourseBlock[] {
    const trimmed = trimRange(text, block.start, block.end);
    if (trimmed.end <= trimmed.start) return [];
    if (trimmed.end - trimmed.start <= maxChars) {
        return [{ start: trimmed.start, end: trimmed.end, kind: block.kind }];
    }
    if (block.kind === "list") {
        return splitListBlockByItems(text, trimmed.start, trimmed.end, maxChars).map((slice) => ({
            start: slice.start,
            end: slice.end,
            kind: block.kind,
        }));
    }
    if (block.kind === "code" || block.kind === "label" || block.kind === "quote") {
        return sliceRangeByLength(text, trimmed.start, trimmed.end, maxChars).map((slice) => ({
            start: slice.start,
            end: slice.end,
            kind: block.kind,
        }));
    }
    return splitBySentenceBoundaries(text, trimmed.start, trimmed.end, maxChars).map((slice) => ({
        start: slice.start,
        end: slice.end,
        kind: block.kind,
    }));
}

function splitListBlockByItems(
    text: string,
    start: number,
    end: number,
    maxChars: number
): Array<{ start: number; end: number }> {
    const lineRegex = /[^\n]*\n?|[^\n]+$/g;
    lineRegex.lastIndex = start;
    const lines: Array<{ start: number; end: number; text: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(text))) {
        if (match.index >= end) break;
        const lineStart = match.index;
        const lineEnd = Math.min(end, lineStart + match[0].length);
        lines.push({
            start: lineStart,
            end: lineEnd,
            text: text.slice(lineStart, lineEnd),
        });
        if (lineEnd >= end) break;
    }

    const items: Array<{ start: number; end: number }> = [];
    let itemStart: number | null = null;
    let itemEnd = 0;

    const flushItem = () => {
        if (itemStart === null || itemEnd <= itemStart) return;
        items.push({ start: itemStart, end: itemEnd });
        itemStart = null;
        itemEnd = 0;
    };

    for (const line of lines) {
        const trimmed = line.text.trim();
        if (!trimmed) {
            flushItem();
            continue;
        }
        const isNewItem = /^([-*+]\s+|\d+\.\s+)/.test(trimmed);
        if (isNewItem) {
            flushItem();
            itemStart = line.start;
            itemEnd = line.end;
            continue;
        }
        if (itemStart === null) {
            itemStart = line.start;
        }
        itemEnd = line.end;
    }
    flushItem();

    const slices: Array<{ start: number; end: number }> = [];
    for (const item of items) {
        const trimmed = trimRange(text, item.start, item.end);
        if (trimmed.end <= trimmed.start) continue;
        if (trimmed.end - trimmed.start <= maxChars) {
            slices.push(trimmed);
            continue;
        }
        slices.push(...sliceRangeByLength(text, trimmed.start, trimmed.end, maxChars));
    }
    return slices;
}

function splitBySentenceBoundaries(
    text: string,
    start: number,
    end: number,
    maxChars: number
): Array<{ start: number; end: number }> {
    const slices: Array<{ start: number; end: number }> = [];
    let cursor = start;
    while (cursor < end) {
        let hardEnd = Math.min(end, cursor + maxChars);
        if (hardEnd < end) {
            const softEnd = findSentenceBreak(text, cursor, hardEnd, end);
            if (softEnd > cursor) {
                hardEnd = softEnd;
            }
        }
        const trimmed = trimRange(text, cursor, hardEnd);
        if (trimmed.end > trimmed.start) {
            slices.push(trimmed);
        }
        cursor = hardEnd;
    }
    return slices;
}

function findSentenceBreak(text: string, start: number, preferredEnd: number, hardEnd: number): number {
    for (let idx = preferredEnd; idx > start; idx -= 1) {
        const ch = text[idx - 1];
        if (ch === "\n" || ch === "。" || ch === "！" || ch === "？" || ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === "；") {
            return idx;
        }
    }
    return Math.min(preferredEnd, hardEnd);
}

function sliceRangeByLength(
    text: string,
    start: number,
    end: number,
    maxChars: number
): Array<{ start: number; end: number }> {
    const slices: Array<{ start: number; end: number }> = [];
    let cursor = start;
    while (cursor < end) {
        let nextEnd = Math.min(end, cursor + maxChars);
        if (nextEnd < end) {
            const softBreak = findSoftBreak(text, cursor, nextEnd);
            if (softBreak > cursor) nextEnd = softBreak;
        }
        const trimmed = trimRange(text, cursor, nextEnd);
        if (trimmed.end > trimmed.start) {
            slices.push(trimmed);
        }
        cursor = nextEnd;
    }
    return slices;
}

function findSoftBreak(text: string, start: number, end: number): number {
    for (let idx = end; idx > start; idx -= 1) {
        const ch = text[idx - 1];
        if (ch === "\n" || ch === " " || ch === "\t" || ch === "," || ch === "，" || ch === ";" || ch === "；") {
            return idx;
        }
    }
    return end;
}

function canMergeAtomicIntoMicro(
    previousKind: DiscourseBlockKind | null,
    nextKind: DiscourseBlockKind,
    currentLength: number,
    nextPieceLength: number,
    mergedLength: number,
    semanticScore: number,
    turn: TurnSpan,
    cfg: Required<UnitizerConfig>
): boolean {
    const limit = turn.sourceCategory === "operation" ? cfg.microMaxChars * 2 : cfg.microMaxChars;
    if (mergedLength > limit) return false;
    if (previousKind === "code" || nextKind === "code") return false;
    if (nextKind === "label") return false;
    if (previousKind === "label") return true;
    if (turn.sourceCategory === "operation" && (previousKind === "list" || nextKind === "list")) {
        return semanticScore >= 0.15 || nextPieceLength < Math.floor(cfg.microMaxChars * 0.35);
    }
    if (semanticScore >= 0.2) return true;
    if (currentLength >= cfg.microMaxChars && nextPieceLength > cfg.microMaxChars * 0.3) {
        return false;
    }
    return nextPieceLength <= Math.floor(cfg.microMaxChars * 0.35);
}

function sumLength(blocks: Array<{ start: number; end: number }>): number {
    return blocks.reduce((sum, block) => sum + (block.end - block.start), 0);
}

function smoothMicroDescriptorsForTurn(
    text: string,
    input: MicroDescriptor[],
    turn: TurnSpan,
    cfg: Required<UnitizerConfig>
): MicroDescriptor[] {
    if (input.length <= 1) return input;
    const output = input.slice();
    const minUsefulLength = turn.sourceCategory === "operation" ? 64 : 28;
    const limit = turn.sourceCategory === "operation" ? cfg.microMaxChars * 2 : cfg.microMaxChars;
    const hardTinyLength = turn.sourceCategory === "operation" ? 20 : 12;

    let idx = 0;
    while (idx < output.length) {
        const current = output[idx]!;
        const currentLength = current.end - current.start;
        if (currentLength >= minUsefulLength) {
            idx += 1;
            continue;
        }

        const prev = idx > 0 ? output[idx - 1] : null;
        const next = idx + 1 < output.length ? output[idx + 1] : null;

        const prevMergedLength = prev ? current.end - prev.start : Number.MAX_SAFE_INTEGER;
        const nextMergedLength = next ? next.end - current.start : Number.MAX_SAFE_INTEGER;

        const prevScore = prev
            ? lexicalSimilarity(text, prev.start, prev.end, current.start, current.end)
            : -1;
        const nextScore = next
            ? lexicalSimilarity(text, current.start, current.end, next.start, next.end)
            : -1;

        const relaxedLimit = currentLength <= hardTinyLength ? limit + 120 : limit;
        const canMergePrev = prev && prevMergedLength <= relaxedLimit;
        const canMergeNext = next && nextMergedLength <= relaxedLimit;

        if (canMergePrev && (!canMergeNext || prevScore >= nextScore)) {
            prev!.end = current.end;
            output.splice(idx, 1);
            continue;
        }
        if (canMergeNext) {
            next!.start = current.start;
            output.splice(idx, 1);
            continue;
        }
        // If still tiny and cannot satisfy strict limits, force semantic continuity
        // by attaching to the better neighboring chunk.
        if (currentLength <= hardTinyLength) {
            if (prev && (!next || prevScore >= nextScore)) {
                prev.end = current.end;
                output.splice(idx, 1);
                continue;
            }
            if (next) {
                next.start = current.start;
                output.splice(idx, 1);
                continue;
            }
        }
        idx += 1;
    }

    return output;
}

function lexicalSimilarity(
    text: string,
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number
): number {
    const aTokens = extractLexicalTokens(text.slice(aStart, aEnd));
    const bTokens = extractLexicalTokens(text.slice(bStart, bEnd));
    if (aTokens.size === 0 || bTokens.size === 0) return 0;
    let overlap = 0;
    for (const token of aTokens) {
        if (bTokens.has(token)) overlap += 1;
    }
    return overlap / Math.min(aTokens.size, bTokens.size);
}

function extractLexicalTokens(value: string): Set<string> {
    const tokens = new Set<string>();
    const english = value.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    for (const token of english) {
        tokens.add(token);
    }
    const cjk = value.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const token of cjk) {
        tokens.add(token);
    }
    return tokens;
}

function describeMicro(start: number, end: number, turn: TurnSpan): MicroDescriptor {
    return {
        start,
        end,
        turnOrdinal: turn.ordinal,
        role: turn.role,
        timestamp: turn.timestamp,
        sourceCategory: turn.sourceCategory,
    };
}

function buildMesoDescriptors(
    text: string,
    turns: TurnSpan[],
    micro: MicroDescriptor[],
    cfg: Required<UnitizerConfig>
): MesoDescriptor[] {
    const microByTurn = new Map<number, MicroDescriptor[]>();
    for (const item of micro) {
        const bucket = microByTurn.get(item.turnOrdinal) || [];
        bucket.push(item);
        microByTurn.set(item.turnOrdinal, bucket);
    }

    const meso: MesoDescriptor[] = [];
    let currentTurns: TurnSpan[] = [];
    let currentChars = 0;
    let hasUser = false;
    let hasResponseAfterUser = false;
    const minStableMesoChars = Math.max(1100, Math.floor(cfg.mesoMaxChars * 0.34));

    const flush = () => {
        if (currentTurns.length === 0) return;
        const first = currentTurns[0]!;
        const last = currentTurns[currentTurns.length - 1]!;
        meso.push({
            start: first.headerStart,
            end: last.bodyEnd,
            turnStartOrdinal: first.ordinal,
            turnEndOrdinal: last.ordinal,
            role: first.role,
            timestamp: first.timestamp,
            sourceCategory: resolveAggregateCategory(currentTurns.map((turn) => turn.sourceCategory)),
        });
        currentTurns = [];
        currentChars = 0;
        hasUser = false;
        hasResponseAfterUser = false;
    };

    for (const turn of turns) {
        const turnMicros = microByTurn.get(turn.ordinal) || [];
        if (turnMicros.length === 0) continue;
        const turnChars = turn.bodyEnd - turn.headerStart;
        const shouldStartNewUserEpisode =
            isUserLikeRole(turn.role) &&
            currentTurns.length > 0 &&
            hasUser &&
            hasResponseAfterUser &&
            currentTurns.length >= 4 &&
            currentChars >= minStableMesoChars;
        const hardOverflow =
            currentTurns.length > 0 &&
            currentChars + turnChars > Math.floor(cfg.mesoMaxChars * 1.35);
        const exceedsMesoLimit =
            currentTurns.length > 0 &&
            currentChars >= Math.max(280, cfg.mesoMaxChars * 0.65) &&
            currentChars + turnChars > cfg.mesoMaxChars;
        const turnCountLimit = turn.sourceCategory === "operation" ? 10 : 12;
        const hitsTurnCountLimit =
            currentTurns.length > 0 &&
            currentTurns.length >= turnCountLimit &&
            currentChars >= Math.floor(minStableMesoChars * 0.55);
        if (
            shouldStartNewUserEpisode ||
            hardOverflow ||
            exceedsMesoLimit ||
            hitsTurnCountLimit
        ) {
            flush();
        }

        currentTurns.push(turn);
        currentChars = currentTurns[currentTurns.length - 1]!.bodyEnd - currentTurns[0]!.headerStart;
        if (isUserLikeRole(turn.role)) {
            hasUser = true;
        } else if (hasUser) {
            hasResponseAfterUser = true;
        }
    }

    flush();
    return smoothMesoDescriptors(meso, cfg);
}

function buildMacroDescriptors(
    text: string,
    meso: MesoDescriptor[],
    cfg: Required<UnitizerConfig>
): MacroDescriptor[] {
    const macro: MacroDescriptor[] = [];
    let current: MesoDescriptor[] = [];

    const flush = () => {
        if (current.length === 0) return;
        const first = current[0]!;
        const last = current[current.length - 1]!;
        macro.push({
            start: first.start,
            end: last.end,
            role: first.role,
            timestamp: first.timestamp,
            sourceCategory: resolveAggregateCategory(current.map((item) => item.sourceCategory)),
        });
        current = [];
    };

    for (const item of meso) {
        if (current.length === 0) {
            current.push(item);
            continue;
        }
        const first = current[0]!;
        const currentChars = current[current.length - 1]!.end - first.start;
        const nextChars = item.end - first.start;
        const hitsHardLimit = nextChars > cfg.macroMaxChars;
        const reachesTargetChars = currentChars >= cfg.macroTargetChars;
        const hitsTargetWithCue =
            currentChars >= cfg.macroTargetChars &&
            beginsWithMacroShiftCue(text.slice(item.start, Math.min(item.end, item.start + 120)));
        const hasEnoughMeso = current.length >= Math.max(3, cfg.macroTargetMesoUnits);

        if (
            hitsHardLimit ||
            (hasEnoughMeso && (reachesTargetChars || hitsTargetWithCue))
        ) {
            flush();
        }
        current.push(item);
    }

    flush();
    return smoothMacroDescriptors(macro, cfg);
}

function smoothMesoDescriptors(
    meso: MesoDescriptor[],
    cfg: Required<UnitizerConfig>
): MesoDescriptor[] {
    if (meso.length <= 1) return meso;
    const output = meso.slice();
    const minChars = Math.max(900, Math.floor(cfg.mesoMaxChars * 0.28));
    const softMaxChars = Math.floor(cfg.mesoMaxChars * 1.35);
    let idx = 0;
    while (idx < output.length) {
        const current = output[idx]!;
        const currentLen = current.end - current.start;
        if (currentLen >= minChars) {
            idx += 1;
            continue;
        }
        const prev = idx > 0 ? output[idx - 1] : null;
        const next = idx + 1 < output.length ? output[idx + 1] : null;
        const canMergePrev = prev && current.end - prev.start <= softMaxChars;
        const canMergeNext = next && next.end - current.start <= softMaxChars;
        if (canMergePrev && (!canMergeNext || prev!.turnEndOrdinal - prev!.turnStartOrdinal >= next!.turnEndOrdinal - next!.turnStartOrdinal)) {
            prev!.end = current.end;
            prev!.turnEndOrdinal = current.turnEndOrdinal;
            prev!.sourceCategory = resolveAggregateCategory([
                prev!.sourceCategory,
                current.sourceCategory,
            ]);
            output.splice(idx, 1);
            continue;
        }
        if (canMergeNext) {
            next!.start = current.start;
            next!.turnStartOrdinal = current.turnStartOrdinal;
            next!.role = next!.role ?? current.role;
            next!.timestamp = next!.timestamp ?? current.timestamp;
            next!.sourceCategory = resolveAggregateCategory([
                next!.sourceCategory,
                current.sourceCategory,
            ]);
            output.splice(idx, 1);
            continue;
        }
        idx += 1;
    }
    return output;
}

function smoothMacroDescriptors(
    macro: MacroDescriptor[],
    cfg: Required<UnitizerConfig>
): MacroDescriptor[] {
    if (macro.length <= 1) return macro;
    const output = macro.slice();
    const minChars = Math.max(5000, Math.floor(cfg.macroTargetChars * 0.42));
    const softMaxChars = Math.floor(cfg.macroMaxChars * 1.35);
    let idx = 0;
    while (idx < output.length) {
        const current = output[idx]!;
        if (current.end - current.start >= minChars) {
            idx += 1;
            continue;
        }
        const prev = idx > 0 ? output[idx - 1] : null;
        const next = idx + 1 < output.length ? output[idx + 1] : null;
        const canMergePrev = prev && current.end - prev.start <= softMaxChars;
        const canMergeNext = next && next.end - current.start <= softMaxChars;
        if (canMergePrev) {
            prev!.end = current.end;
            prev!.sourceCategory = resolveAggregateCategory([
                prev!.sourceCategory,
                current.sourceCategory,
            ]);
            output.splice(idx, 1);
            continue;
        }
        if (canMergeNext) {
            next!.start = current.start;
            next!.role = next!.role ?? current.role;
            next!.timestamp = next!.timestamp ?? current.timestamp;
            next!.sourceCategory = resolveAggregateCategory([
                next!.sourceCategory,
                current.sourceCategory,
            ]);
            output.splice(idx, 1);
            continue;
        }
        idx += 1;
    }
    return output;
}

function materializeMacroUnits(
    record: V8NarrativeRecord,
    text: string,
    macro: MacroDescriptor[]
): V8Unit[] {
    return macro.map((item, idx) => ({
        id: `unit_${record.id}_macro_${idx + 1}`,
        narrativeRecordId: record.id,
        narrativeRef: record.sourceRef,
        layer: "macro",
        ordinal: idx + 1,
        charStart: item.start,
        charEnd: item.end,
        text: text.slice(item.start, item.end),
        parentUnitId: null,
        language: record.language,
        role: item.role,
        timestamp: item.timestamp,
        sourceCategory: item.sourceCategory,
    }));
}

function materializeMesoUnits(
    record: V8NarrativeRecord,
    text: string,
    meso: MesoDescriptor[],
    macroUnits: V8Unit[]
): V8Unit[] {
    return meso.map((item, idx) => ({
        id: `unit_${record.id}_meso_${idx + 1}`,
        narrativeRecordId: record.id,
        narrativeRef: record.sourceRef,
        layer: "meso",
        ordinal: idx + 1,
        charStart: item.start,
        charEnd: item.end,
        text: text.slice(item.start, item.end),
        parentUnitId: findParentUnitId(item.start, item.end, macroUnits),
        language: record.language,
        role: item.role,
        timestamp: item.timestamp,
        sourceCategory: item.sourceCategory,
    }));
}

function materializeMicroUnits(
    record: V8NarrativeRecord,
    text: string,
    micro: MicroDescriptor[],
    mesoUnits: V8Unit[]
): V8Unit[] {
    return micro.map((item, idx) => ({
        id: `unit_${record.id}_micro_${idx + 1}`,
        narrativeRecordId: record.id,
        narrativeRef: record.sourceRef,
        layer: "micro",
        ordinal: idx + 1,
        charStart: item.start,
        charEnd: item.end,
        text: text.slice(item.start, item.end),
        parentUnitId: findParentUnitId(item.start, item.end, mesoUnits),
        language: record.language,
        role: item.role,
        timestamp: item.timestamp,
        sourceCategory: item.sourceCategory,
    }));
}

function findParentUnitId(start: number, end: number, candidates: V8Unit[]): string | null {
    for (const unit of candidates) {
        if (start >= unit.charStart && end <= unit.charEnd) {
            return unit.id;
        }
    }
    return null;
}

function resolveAggregateCategory(
    categories: V8NarrativeSourceCategory[]
): V8NarrativeSourceCategory {
    return categories.includes("conversation")
        ? "conversation"
        : categories.includes("operation")
          ? "operation"
          : "unknown";
}

function beginsWithMacroShiftCue(value: string): boolean {
    const trimmed = value.trim();
    return /^(现在|接下来|另外|然后|回到|重新|改成|改为|换个|转到)/.test(trimmed);
}

function trimRange(text: string, start: number, end: number): { start: number; end: number } {
    let nextStart = start;
    let nextEnd = end;
    while (nextStart < nextEnd && /\s/.test(text[nextStart] || "")) {
        nextStart += 1;
    }
    while (nextEnd > nextStart && /\s/.test(text[nextEnd - 1] || "")) {
        nextEnd -= 1;
    }
    return { start: nextStart, end: nextEnd };
}

function isUserLikeRole(raw?: string | null): boolean {
    const lower = String(raw || "").toLowerCase();
    return lower.includes("user");
}

function detectSourceCategory(
    header: { role: string },
    role: V8Unit["role"]
): V8NarrativeSourceCategory {
    const rawRole = (header.role || "").toLowerCase();
    if (rawRole.includes("tool")) {
        return "operation";
    }
    if (role) return "conversation";
    return "unknown";
}
