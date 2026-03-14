import type {
    V8MemoryItem,
    V8MemoryItemType,
    V8MemoryOriginType,
    V8EvidenceSpan,
    V8Unit,
    V8NarrativeRecord,
} from "../types_v8.js";

export interface IrExtractionConfig {
    defaultConfidence?: number;
}

const DEFAULT_CONFIDENCE = 0.62;

const PREFERENCE_PATTERNS = [
    /prefer|preference|更喜欢|偏好|尽量|希望/gi,
    /简短|详细|中文|英文/gi,
];
const CONSTRAINT_PATTERNS = [
    /必须|不要|不需要|禁止|不可|不得|不能|仅|只要/gi,
];
const GOAL_PATTERNS = [/目标|要做|需要做|希望实现|计划/gi];
const DECISION_PATTERNS = [/决定|改为|改成|采用|弃用|切换|选择/gi];
const CONVERSATION_ACT_PATTERNS = [/更正|纠正|不是|不对|澄清|确认/gi];

export function extractMemoryItems(
    sources: V8NarrativeRecord[],
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[],
    config?: IrExtractionConfig
): V8MemoryItem[] {
    const confidence = config?.defaultConfidence ?? DEFAULT_CONFIDENCE;
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const sourceById = new Map(sources.map((s) => [s.id, s]));

    const items: V8MemoryItem[] = [];

    for (const span of evidenceSpans) {
        const unit = unitsById.get(span.unitId);
        if (!unit) continue;
        const source = sourceById.get(unit.narrativeRecordId);
        const text = span.text || unit.text;
        const speaker = source?.speaker ?? "unknown";
        const sourceCategory = source?.metadata?.sourceCategory;
        const allowControl = sourceCategory !== "operation";

        const controlType = allowControl ? detectControlType(text) : null;
        if (controlType) {
            items.push(
                buildItem({
                    itemType: controlType,
                    originType: "asserted",
                    layer: "micro",
                    subject: speaker,
                    predicate: controlPredicate(controlType),
                    object: normalizeObject(text),
                    label: truncateLabel(text),
                    narrativeRecordId: unit.narrativeRecordId,
                    sourceRef: source?.sourceRef ?? "",
                    evidenceSpanIds: [span.id],
                    unitIds: [unit.id],
                    confidence,
                })
            );
        }

        items.push(
            buildItem({
                itemType: "discourse_unit",
                originType: "asserted",
                layer: "micro",
                subject: speaker,
                predicate: "summarizes",
                object: truncateLabel(text),
                label: truncateLabel(text),
                narrativeRecordId: unit.narrativeRecordId,
                sourceRef: source?.sourceRef ?? "",
                evidenceSpanIds: [span.id],
                unitIds: [unit.id],
                confidence: confidence - 0.08,
            })
        );
    }

    return items;
}

function buildItem(input: {
    itemType: V8MemoryItemType;
    originType: V8MemoryOriginType;
    layer: V8MemoryItem["layer"];
    subject: string;
    predicate: string;
    object: string;
    label: string;
    narrativeRecordId: string;
    sourceRef: string;
    evidenceSpanIds: string[];
    unitIds: string[];
    confidence: number;
}): V8MemoryItem {
    const now = new Date().toISOString();
    return {
        id: `mi_${now}_${Math.random().toString(36).slice(2, 8)}`,
        narrativeRecordId: input.narrativeRecordId,
        sourceRef: input.sourceRef,
        itemType: input.itemType,
        originType: input.originType,
        layer: input.layer,
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        label: input.label,
        qualifiers: {},
        evidenceSpanIds: input.evidenceSpanIds,
        unitIds: input.unitIds,
        confidence: input.confidence,
        scope: "session",
        validity: "active",
        createdAt: now,
        updatedAt: now,
    };
}

function detectControlType(text: string): V8MemoryItemType | null {
    if (matchesAny(text, DECISION_PATTERNS)) return "decision";
    if (matchesAny(text, GOAL_PATTERNS)) return "goal";
    if (matchesAny(text, CONSTRAINT_PATTERNS)) return "constraint";
    if (matchesAny(text, PREFERENCE_PATTERNS)) return "preference";
    if (matchesAny(text, CONVERSATION_ACT_PATTERNS)) return "conversation_act";
    return null;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
}

function controlPredicate(type: V8MemoryItemType): string {
    switch (type) {
        case "preference":
            return "prefers";
        case "constraint":
            return "requires";
        case "goal":
            return "targets";
        case "decision":
            return "decides";
        case "conversation_act":
            return "acts";
        default:
            return "states";
    }
}

function normalizeObject(text: string): string {
    return truncateLabel(text);
}

function truncateLabel(text: string, maxLen = 120): string {
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
}
