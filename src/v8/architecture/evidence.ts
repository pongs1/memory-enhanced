import type { V8EvidenceSpan, V8NarrativeRecord, V8Unit } from "../types_v8.js";

export interface EvidenceExtractionConfig {
    defaultScore?: number;
}

const DEFAULT_SCORE = 0.6;

export function extractEvidenceSpans(
    units: V8Unit[],
    sources: V8NarrativeRecord[] = [],
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
            narrativeRecordId: unit.narrativeRecordId,
            unitId: unit.id,
            charStart: unit.charStart,
            charEnd: unit.charEnd,
            text: unit.text,
            speaker: speakerBySource.get(unit.narrativeRecordId) ?? null,
            score,
        }));
}
