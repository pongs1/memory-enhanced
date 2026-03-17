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

const CONTROL_PHRASE_HINTS = {
    preference: ["prefer", "preference", "更喜欢", "偏好", "尽量", "希望", "简短", "详细", "中文", "英文"],
    constraint: ["必须", "不要", "不需要", "禁止", "不可", "不得", "不能", "仅", "只要", "仅限"],
    goal: ["目标", "要做", "需要做", "希望实现", "计划", "goal", "build", "implement"],
    decision: ["决定", "改为", "改成", "采用", "弃用", "切换", "选择", "decided", "switched", "replace"],
    conversation_act: ["更正", "纠正", "不是", "不对", "澄清", "确认", "记住", "记下", "记着", "remember"],
} as const;

const EARLIER_STATE_HINTS = [
    "earlier",
    "previous",
    "original",
    "initial",
    "former",
    "originally",
    "at the start",
    "at first",
    "first",
    "之前",
    "以前",
    "原来",
    "最初",
    "一开始",
    "前面",
] as const;

const CURRENT_STATE_HINTS = [
    "current",
    "currently",
    "latest",
    "now",
    "present",
    "final",
    "by finals week",
    "现在",
    "当前",
    "目前",
    "最新",
    "最后",
] as const;

const CHANGE_EVENT_HINTS = [
    "reversed",
    "changed",
    "switch",
    "switched",
    "replace",
    "replaced",
    "removed",
    "remove",
    "drop",
    "dropped",
    "rollback",
    "resolved",
    "fix",
    "fixed",
    "取代",
    "改成",
    "改为",
    "变成",
    "反转",
    "撤回",
    "恢复",
    "修复",
] as const;

const RELATIONSHIP_HINTS = [
    "partner",
    "partners",
    "friend",
    "friends",
    "enemy",
    "enemies",
    "rival",
    "rivals",
    "allies",
    "ally",
    "lab partner",
    "夫妻",
    "恋人",
    "朋友",
    "敌人",
    "对手",
    "搭档",
    "盟友",
    "同事",
    "伙伴",
] as const;

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
        const speaker = unit.speaker ?? "unknown";
        const sourceCategory = unit.sourceCategory;
        const allowControl = sourceCategory !== "operation";

        const controlType = allowControl ? detectControlType(text) : null;
        if (controlType) {
            const object = normalizeObject(text);
            const predicate = controlPredicate(controlType);
            pushUniqueItem(
                items,
                seen,
                buildItem({
                    itemType: controlType,
                    originType: "asserted",
                    layer: "micro",
                    subject: speaker,
                    predicate,
                    object,
                    label: truncateLabel(text),
                    narrativeRecordId: unit.narrativeRecordId,
                    sourceRef: unit.narrativeRef,
                    evidenceSpanIds: [span.id],
                    unitIds: [unit.id],
                    confidence,
                }),
                `${unit.narrativeRecordId}|${speaker}|${predicate}|${object}`
            );
        }

        const anchors = extractSurfaceAnchors(text);
        const stateStatus = detectStateStatus(text);
        for (const item of buildStructuredMicroItems({
            text,
            speaker,
            unit,
            span,
            anchors,
            stateStatus,
            confidence,
        })) {
            const key = `${item.narrativeRecordId}|${item.itemType}|${item.subject}|${item.predicate}|${item.object}|${String(item.qualifiers?.status || "")}`;
            pushUniqueItem(items, seen, item, key);
        }

        const fallbackObject = truncateLabel(text);
        if (fallbackObject) {
            const fallbackKey = `${unit.narrativeRecordId}|${unit.id}|discourse|${fallbackObject}`;
            pushUniqueItem(
                items,
                seen,
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
                }),
                fallbackKey
            );
        }
    }

    return items;
}

function pushUniqueItem(
    items: V8MemoryItem[],
    seen: Set<string>,
    item: V8MemoryItem,
    key: string
): void {
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
}

function isLikelyControlCandidate(text: string): boolean {
    const cleaned = text.trim().replace(/\s+/g, " ");
    if (!cleaned) return false;
    const lower = cleaned.toLowerCase();
    if (["hi", "hello", "hey", "ok", "好的", "收到", "嗯", "啊", "哈喽"].includes(lower)) {
        return false;
    }
    if (cleaned.length >= 4) return true;
    return ["改", "换", "记", "禁", "要", "别"].some((cue) => cleaned.includes(cue));
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
    if (!isLikelyControlCandidate(text)) return null;
    const normalized = normalizeForHints(text);
    const ranked = (Object.keys(CONTROL_PHRASE_HINTS) as Array<keyof typeof CONTROL_PHRASE_HINTS>)
        .map((key) => ({
            key,
            score: hintCoverageScore(normalized, CONTROL_PHRASE_HINTS[key]),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    if (!best) return null;
    if (best.key === "decision") return "decision";
    if (best.key === "goal") return "goal";
    if (best.key === "constraint") return "constraint";
    if (best.key === "preference") return "preference";
    if (best.key === "conversation_act") return "conversation_act";
    return null;
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

function buildStructuredMicroItems(input: {
    text: string;
    speaker: string;
    unit: V8Unit;
    span: V8EvidenceSpan;
    anchors: string[];
    stateStatus: "earlier" | "current" | null;
    confidence: number;
}): V8MemoryItem[] {
    const items: V8MemoryItem[] = [];
    const normalized = normalizeForHints(input.text);
    const qualifiers = input.stateStatus ? { status: input.stateStatus } : {};

    if (input.anchors.length >= 2 && hintCoverageScore(normalized, RELATIONSHIP_HINTS) > 0) {
        const item = buildItem({
            itemType: "relationship_state",
            originType: "asserted",
            layer: "micro",
            subject: input.anchors[0]!,
            predicate: "involves",
            object: input.anchors[1]!,
            label: truncateLabel(input.text),
            narrativeRecordId: input.unit.narrativeRecordId,
            sourceRef: input.unit.narrativeRef,
            evidenceSpanIds: [input.span.id],
            unitIds: [input.unit.id],
            confidence: Math.min(0.86, input.confidence + 0.08),
        });
        item.qualifiers = qualifiers;
        items.push(item);
    }

    if (input.anchors.length >= 1 && input.stateStatus) {
        const item = buildItem({
            itemType: "topic_state",
            originType: "asserted",
            layer: "micro",
            subject: input.speaker,
            predicate: "valid_during",
            object: input.anchors[0]!,
            label: truncateLabel(input.text),
            narrativeRecordId: input.unit.narrativeRecordId,
            sourceRef: input.unit.narrativeRef,
            evidenceSpanIds: [input.span.id],
            unitIds: [input.unit.id],
            confidence: Math.min(0.84, input.confidence + 0.05),
        });
        item.qualifiers = qualifiers;
        items.push(item);
    }

    if (hintCoverageScore(normalized, CHANGE_EVENT_HINTS) > 0) {
        items.push(
            buildItem({
                itemType: "event",
                originType: "asserted",
                layer: "micro",
                subject: input.anchors[0] || input.speaker,
                predicate: "produces_shift",
                object: input.anchors[1] || truncateLabel(input.text, 72),
                label: truncateLabel(input.text),
                narrativeRecordId: input.unit.narrativeRecordId,
                sourceRef: input.unit.narrativeRef,
                evidenceSpanIds: [input.span.id],
                unitIds: [input.unit.id],
                confidence: Math.min(0.82, input.confidence + 0.04),
            })
        );
    }

    return items;
}

function detectStateStatus(text: string): "earlier" | "current" | null {
    const normalized = normalizeForHints(text);
    if (hintCoverageScore(normalized, CURRENT_STATE_HINTS) > 0) return "current";
    if (hintCoverageScore(normalized, EARLIER_STATE_HINTS) > 0) return "earlier";
    return null;
}

function normalizeForHints(text: string): string {
    return String(text || "").trim().toLowerCase();
}

function hintCoverageScore(text: string, hints: readonly string[]): number {
    let score = 0;
    for (const hint of hints) {
        const normalizedHint = normalizeForHints(hint);
        if (!normalizedHint) continue;
        if (text.includes(normalizedHint)) {
            score += normalizedHint.length >= 6 ? 1.2 : 1;
        }
    }
    return score;
}

function extractSurfaceAnchors(text: string): string[] {
    const tokens = String(text || "")
        .split(/[^A-Za-z0-9_\u4e00-\u9fff]+/)
        .map((token) => token.trim())
        .filter(Boolean);
    const anchors: string[] = [];
    let titleRun: string[] = [];

    const flushRun = () => {
        if (titleRun.length > 0) {
            anchors.push(titleRun.join(" "));
            titleRun = [];
        }
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

function looksLikeTitleAnchor(token: string): boolean {
    const first = token[0];
    return Boolean(first && first >= "A" && first <= "Z" && token.length >= 2);
}

function looksLikeCodeAnchor(token: string): boolean {
    if (token.length < 3) return false;
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
