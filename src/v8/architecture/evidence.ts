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
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const spans: V8EvidenceSpan[] = [];
    let ordinal = 0;
    for (const unit of units) {
        if (unit.layer !== "micro") continue;
        ordinal += 1;
        const source = sourceById.get(unit.narrativeRecordId);
        spans.push({
            id: `es_${unit.id}_${ordinal}`,
            narrativeRecordId: unit.narrativeRecordId,
            narrativeRef: unit.narrativeRef,
            unitId: unit.id,
            charStart: unit.charStart,
            charEnd: unit.charEnd,
            text: unit.text,
            speaker: unit.speaker ?? null,
            timestamp: unit.timestamp ?? null,
            sourceClass: source?.sourceClass ?? "raw",
            sourceType: source?.sourceType ?? "session_narrative",
            score,
        });
    }
    return spans;
}
