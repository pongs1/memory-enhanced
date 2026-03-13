import type { V8SourceRecord, V8Unit } from "../types_v8.js";

export interface UnitizerConfig {
    microMaxChars?: number;
    mesoMaxChars?: number;
    macroTargetChars?: number;
    macroMaxChars?: number;
}

const DEFAULT_CONFIG: Required<UnitizerConfig> = {
    microMaxChars: 320,
    mesoMaxChars: 2000,
    macroTargetChars: 6000,
    macroMaxChars: 12000,
};

export function unitizeSourceRecords(
    records: V8SourceRecord[],
    config?: UnitizerConfig
): V8Unit[] {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const units: V8Unit[] = [];

    for (const record of records) {
        const text = record.cleanText ?? record.rawText;
        if (!text) continue;

        const mesoOffsets = new Map<string, { cleanStart: number; cleanEnd: number }>();
        const mesoUnits: V8Unit[] = splitParagraphs(text, cfg.mesoMaxChars).map(
            (segment, idx): V8Unit => {
                const range = mapCleanRangeToRaw(
                    record.cleanMap,
                    segment.start,
                    segment.end
                );
                const id = `unit_${record.id}_meso_${idx + 1}`;
                mesoOffsets.set(id, {
                    cleanStart: segment.start,
                    cleanEnd: segment.end,
                });
                return {
                    id,
                    sourceRecordId: record.id,
                    layer: "meso",
                    ordinal: idx + 1,
                    charStart: range.rawStart,
                    charEnd: range.rawEnd,
                    text: segment.text,
                    parentUnitId: null,
                    language: record.language,
                };
            }
        );

        const microUnits: V8Unit[] = [];
        for (const meso of mesoUnits) {
            const offsets = mesoOffsets.get(meso.id) || {
                cleanStart: 0,
                cleanEnd: meso.text.length,
            };
            const microSegments = splitSentences(
                meso.text,
                cfg.microMaxChars
            );
            microSegments.forEach((segment, idx) => {
                const cleanStart = segment.start + offsets.cleanStart;
                const cleanEnd = segment.end + offsets.cleanStart;
                const range = mapCleanRangeToRaw(
                    record.cleanMap,
                    cleanStart,
                    cleanEnd
                );
                microUnits.push({
                    id: `unit_${record.id}_micro_${meso.ordinal}_${idx + 1}`,
                    sourceRecordId: record.id,
                    layer: "micro",
                    ordinal: idx + 1,
                    charStart: range.rawStart,
                    charEnd: range.rawEnd,
                    text: segment.text,
                    parentUnitId: meso.id,
                    language: record.language,
                });
            });
        }

        const macroUnits = buildMacroUnits(record, mesoUnits, cfg);

        // attach meso parent to macro
        for (const meso of mesoUnits) {
            const macro = macroUnits.find((m) =>
                m.charStart <= meso.charStart && m.charEnd >= meso.charEnd
            );
            if (macro) {
                meso.parentUnitId = macro.id;
            }
        }

        units.push(...macroUnits, ...mesoUnits, ...microUnits);
    }

    return units;
}

function splitParagraphs(text: string, maxChars: number) {
    const segments: Array<{ text: string; start: number; end: number }> = [];
    const blocks = text.split(/\n{2,}/);
    let cursor = 0;
    for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) {
            cursor += block.length + 2;
            continue;
        }
        const start = text.indexOf(block, cursor);
        const end = start + block.length;
        if (block.length <= maxChars) {
            segments.push({ text: block, start, end });
        } else {
            const slices = sliceByLength(block, maxChars);
            let offset = start;
            for (const slice of slices) {
                segments.push({
                    text: slice,
                    start: offset,
                    end: offset + slice.length,
                });
                offset += slice.length;
            }
        }
        cursor = end;
    }
    return segments;
}

function splitSentences(text: string, maxChars: number) {
    const segments: Array<{ text: string; start: number; end: number }> = [];
    const sentenceRegex = /[^。！？!?]+[。！？!?]?/g;
    let match: RegExpExecArray | null;
    while ((match = sentenceRegex.exec(text))) {
        const segmentText = match[0].trim();
        if (!segmentText) continue;
        if (segmentText.length <= maxChars) {
            segments.push({
                text: segmentText,
                start: match.index,
                end: match.index + match[0].length,
            });
        } else {
            const slices = sliceByLength(segmentText, maxChars);
            let offset = match.index;
            for (const slice of slices) {
                segments.push({
                    text: slice,
                    start: offset,
                    end: offset + slice.length,
                });
                offset += slice.length;
            }
        }
    }
    return segments;
}

function sliceByLength(text: string, maxChars: number): string[] {
    const slices: string[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
        slices.push(text.slice(i, i + maxChars));
    }
    return slices;
}

function buildMacroUnits(
    record: V8SourceRecord,
    mesoUnits: V8Unit[],
    cfg: Required<UnitizerConfig>
): V8Unit[] {
    const macroUnits: V8Unit[] = [];
    if (!mesoUnits.length) return macroUnits;
    let current: V8Unit[] = [];
    let currentStart = mesoUnits[0].charStart;
    let currentEnd = mesoUnits[0].charEnd;

    const flush = () => {
        if (!current.length) return;
        const id = `unit_${record.id}_macro_${macroUnits.length + 1}`;
        const text = current.map((u) => u.text).join("\n\n");
        macroUnits.push({
            id,
            sourceRecordId: record.id,
            layer: "macro",
            ordinal: macroUnits.length + 1,
            charStart: currentStart,
            charEnd: currentEnd,
            text,
            parentUnitId: null,
            language: record.language,
        });
        current = [];
    };

    for (const meso of mesoUnits) {
        if (!current.length) {
            current = [meso];
            currentStart = meso.charStart;
            currentEnd = meso.charEnd;
            continue;
        }

        const projectedLength = currentEnd - currentStart + (meso.charEnd - meso.charStart);
        if (
            projectedLength > cfg.macroMaxChars ||
            currentEnd - currentStart >= cfg.macroTargetChars
        ) {
            flush();
            current = [meso];
            currentStart = meso.charStart;
            currentEnd = meso.charEnd;
            continue;
        }

        current.push(meso);
        currentEnd = meso.charEnd;
    }

    flush();
    return macroUnits;
}

function mapCleanRangeToRaw(
    cleanMap: V8SourceRecord["cleanMap"],
    cleanStart: number,
    cleanEnd: number
): { rawStart: number; rawEnd: number } {
    if (!cleanMap || cleanMap.length === 0) {
        return { rawStart: cleanStart, rawEnd: cleanEnd };
    }
    const startRange = cleanMap.find(
        (range) => cleanStart >= range.cleanStart && cleanStart <= range.cleanEnd
    );
    const endRange = cleanMap.find(
        (range) => cleanEnd >= range.cleanStart && cleanEnd <= range.cleanEnd
    );
    const rawStart = startRange
        ? startRange.rawStart + (cleanStart - startRange.cleanStart)
        : cleanStart;
    const rawEnd = endRange
        ? endRange.rawStart + (cleanEnd - endRange.cleanStart)
        : cleanEnd;
    return { rawStart, rawEnd };
}
