import type { V8EvidenceSpan, V8SourceRecord, V8Unit } from "../types_v8.js";

export interface EvidenceExtractionConfig {
    defaultScore?: number;
}

const DEFAULT_SCORE = 0.6;

export function extractEvidenceSpans(
    units: V8Unit[],
    sources: V8SourceRecord[] = [],
    config?: EvidenceExtractionConfig
): V8EvidenceSpan[] {
    const score = config?.defaultScore ?? DEFAULT_SCORE;
    const speakerBySource = new Map(
        sources.map((source) => [source.id, source.speaker])
    );
    return units
        .filter((unit) => unit.layer === "micro")
        .map((unit, idx) => ({
            id: `es_${unit.id}_${idx + 1}`,
            sourceRecordId: unit.sourceRecordId,
            unitId: unit.id,
            charStart: unit.charStart,
            charEnd: unit.charEnd,
            text: unit.text,
            speaker: speakerBySource.get(unit.sourceRecordId) ?? null,
            score,
        }));
}
