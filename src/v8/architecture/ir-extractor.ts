import type {
    V8MemoryItem,
    V8MemoryItemType,
    V8MemoryOriginType,
    V8EvidenceSpan,
    V8Unit,
} from "../types_v8.js";

export interface IrExtractionConfig {
    defaultConfidence?: number;
}

const DEFAULT_CONFIDENCE = 0.62;

const ANCHOR_STOPWORDS = new Set([
    "the",
    "a",
    "an",
    "at",
    "by",
    "after",
    "before",
    "during",
    "from",
    "into",
    "with",
    "without",
    "and",
    "or",
    "but",
    "we",
    "they",
    "he",
    "she",
    "it",
    "this",
    "that",
    "these",
    "those",
    "session",
    "assistant",
    "user",
    "system",
]);

export function extractMemoryItems(
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[],
    config?: IrExtractionConfig
): V8MemoryItem[] {
    const confidence = config?.defaultConfidence ?? DEFAULT_CONFIDENCE;
    const unitsById = new Map(units.map((u) => [u.id, u]));

    const items: V8MemoryItem[] = [];
    const seen = new Set<string>();

    for (const span of evidenceSpans) {
        const unit = unitsById.get(span.unitId);
        if (!unit) continue;
        const text = span.text || unit.text;
        const speaker = unit.role ?? "unknown";
        const anchors = extractSurfaceAnchors(text);
        const semanticItems = buildSemanticItems({
            text,
            speaker,
            unit,
            span,
            anchors,
            confidence,
        });
        for (const item of semanticItems) {
            const key = [
                item.narrativeRecordId,
                item.unitIds.join(","),
                item.itemType,
                item.subject,
                item.predicate,
                item.object,
                String(item.qualifiers?.status || ""),
            ].join("|");
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(item);
        }

        const fallbackObject = truncateLabel(text);
        if (fallbackObject) {
            const fallbackKey = `${unit.narrativeRecordId}|${unit.id}|discourse|${fallbackObject}`;
            if (!seen.has(fallbackKey)) {
                seen.add(fallbackKey);
                items.push(
                    buildItem({
                        itemType: "discourse_unit",
                        originType: "asserted",
                        layer: "micro",
                        subject: speaker,
                        predicate: "summarizes",
                        object: fallbackObject,
                        label: fallbackObject,
                        narrativeRecordId: unit.narrativeRecordId,
                        sourceRef: unit.narrativeRef,
                        evidenceSpanIds: [span.id],
                        unitIds: [unit.id],
                        confidence: Math.max(0.35, confidence - 0.16),
                    })
                );
            }
        }
    }

    return items;
}

function buildSemanticItems(input: {
    text: string;
    speaker: string;
    unit: V8Unit;
    span: V8EvidenceSpan;
    anchors: string[];
    confidence: number;
}): V8MemoryItem[] {
    const items: V8MemoryItem[] = [];
    const label = truncateLabel(input.text);
    const primaryAnchor = input.anchors[0] || truncateLabel(input.text, 32);
    const secondaryAnchor = input.anchors[1] || "";

    if (input.anchors.length >= 2) {
        const claim = buildItem({
            itemType: "claim",
            originType: "asserted",
            layer: "micro",
            subject: primaryAnchor,
            predicate: "involves",
            object: secondaryAnchor,
            label,
            narrativeRecordId: input.unit.narrativeRecordId,
            sourceRef: input.unit.narrativeRef,
            evidenceSpanIds: [input.span.id],
            unitIds: [input.unit.id],
            confidence: Math.min(0.82, input.confidence + 0.04),
        });
        items.push(claim);
    } else if (input.anchors.length >= 1) {
        const claim = buildItem({
            itemType: "claim",
            originType: "asserted",
            layer: "micro",
            subject: primaryAnchor,
            predicate: "states",
            object: truncateLabel(input.text, 72),
            label,
            narrativeRecordId: input.unit.narrativeRecordId,
            sourceRef: input.unit.narrativeRef,
            evidenceSpanIds: [input.span.id],
            unitIds: [input.unit.id],
            confidence: Math.min(0.78, input.confidence + 0.02),
        });
        items.push(claim);
    }

    if (input.anchors.length >= 1 && input.text.trim().length >= 24) {
        items.push(
            buildItem({
                itemType: "event",
                originType: "asserted",
                layer: "micro",
                subject: primaryAnchor,
                predicate: "results_in_event",
                object: secondaryAnchor || truncateLabel(input.text, 72),
                label,
                narrativeRecordId: input.unit.narrativeRecordId,
                sourceRef: input.unit.narrativeRef,
                evidenceSpanIds: [input.span.id],
                unitIds: [input.unit.id],
                confidence: Math.min(0.74, input.confidence),
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

function extractSurfaceAnchors(text: string): string[] {
    const tokens = String(text || "")
        .split(/[^A-Za-z0-9_\u4e00-\u9fff]+/)
        .map((token) => token.trim())
        .filter(Boolean);
    const anchors: string[] = [];
    let titleRun: string[] = [];

    const flushRun = () => {
        if (titleRun.length >= 1) {
            const phrase = titleRun.join(" ").trim();
            if (isAnchorPhrase(phrase)) anchors.push(phrase);
        }
        titleRun = [];
    };

    for (const token of tokens) {
        if (looksLikeTitleAnchor(token)) {
            titleRun.push(token);
            continue;
        }
        flushRun();
        if (looksLikeCodeAnchor(token) || looksLikeCjkAnchor(token)) {
            anchors.push(token);
        }
    }
    flushRun();
    return Array.from(new Set(anchors)).slice(0, 6);
}

function isAnchorPhrase(phrase: string): boolean {
    const lower = phrase.toLowerCase();
    if (ANCHOR_STOPWORDS.has(lower)) return false;
    if (phrase.length < 2) return false;
    return true;
}

function looksLikeTitleAnchor(token: string): boolean {
    const first = token[0];
    const lower = token.toLowerCase();
    return Boolean(
        first &&
            first >= "A" &&
            first <= "Z" &&
            token.length >= 2 &&
            !ANCHOR_STOPWORDS.has(lower)
    );
}

function looksLikeCodeAnchor(token: string): boolean {
    if (token.length < 3) return false;
    const lower = token.toLowerCase();
    if (ANCHOR_STOPWORDS.has(lower)) return false;
    let hasUpper = false;
    let hasAlpha = false;
    for (const ch of token) {
        if (ch >= "A" && ch <= "Z") hasUpper = true;
        if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) hasAlpha = true;
        if (!isSafeAnchorChar(ch)) return false;
    }
    return hasUpper && hasAlpha;
}

function isSafeAnchorChar(ch: string): boolean {
    return (
        (ch >= "A" && ch <= "Z") ||
        (ch >= "a" && ch <= "z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "_"
    );
}

function looksLikeCjkAnchor(token: string): boolean {
    const lower = token.toLowerCase();
    if (ANCHOR_STOPWORDS.has(lower)) return false;
    for (const ch of token) {
        if (ch >= "\u4e00" && ch <= "\u9fff") {
            return token.length >= 2;
        }
    }
    return false;
}

function truncateLabel(text: string, maxLen = 120): string {
    const trimmed = text.trim().replace(/\s+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
}
