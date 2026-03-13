import type { V8EvidenceSpan, V8Unit } from "../types_v8.js";

export interface EvidenceExtractionConfig {
    defaultScore?: number;
}

const DEFAULT_SCORE = 0.6;

export function extractEvidenceSpans(
    units: V8Unit[],
    config?: EvidenceExtractionConfig
): V8EvidenceSpan[] {
    const score = config?.defaultScore ?? DEFAULT_SCORE;
    return units
        .filter((unit) => unit.layer === "micro")
        .map((unit, idx) => ({
            id: `es_${unit.id}_${idx + 1}`,
            sourceRecordId: unit.sourceRecordId,
            unitId: unit.id,
            charStart: unit.charStart,
            charEnd: unit.charEnd,
            text: unit.text,
            speaker: null,
            score,
        }));
}
