import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../../utils.js";
import { readJsonl, writeJsonl } from "./io.js";
import type {
    V8EvidenceSpan,
    V8GraphLayer,
    V8MemoryItem,
    V8MemoryItemType,
    V8SourceRecord,
    V8Unit,
} from "../types_v8.js";

export interface V8IrLlmJob {
    jobId: string;
    unitId: string;
    layer: V8GraphLayer;
    sourceRecordId: string;
    sourceRef: string;
    speaker: string | null;
    language: string;
    text: string;
    evidenceSpanIds: string[];
    prompt: string;
}

interface EdgeCatalogFile {
    edges?: Array<{
        type?: string;
        layer?: string;
        status?: string;
    }>;
}

const CONTROL_ITEM_TYPES = new Set<V8MemoryItemType>([
    "preference",
    "goal",
    "constraint",
    "decision",
    "open_question",
    "conversation_act",
    "session_state",
    "topic_state",
]);

function edgeCatalogPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../schema/v8-edge-catalog.json");
}

function loadAllowedPredicates(): Record<V8GraphLayer, Set<string>> {
    const data = readJson<EdgeCatalogFile>(edgeCatalogPath(), { edges: [] });
    const allowed: Record<V8GraphLayer, Set<string>> = {
        micro: new Set(),
        meso: new Set(),
        macro: new Set(),
    };
    const edges = Array.isArray(data.edges) ? data.edges : [];
    for (const entry of edges) {
        if (!entry?.type || !entry.layer) continue;
        if (entry.status && entry.status !== "canonical") continue;
        if (entry.layer === "micro" || entry.layer === "meso" || entry.layer === "macro") {
            allowed[entry.layer].add(entry.type);
        }
    }
    return allowed;
}

const ALLOWED_PREDICATES = loadAllowedPredicates();

export function buildLlmIrJobs(
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[],
    sources: V8SourceRecord[]
): V8IrLlmJob[] {
    const spansByUnit = new Map<string, V8EvidenceSpan[]>();
    for (const span of evidenceSpans) {
        const list = spansByUnit.get(span.unitId) || [];
        list.push(span);
        spansByUnit.set(span.unitId, list);
    }
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const jobs: V8IrLlmJob[] = [];

    for (const unit of units) {
        const spans = (spansByUnit.get(unit.id) || []).slice().sort((a, b) => b.score - a.score);
        const spanIds = spans.slice(0, 6).map((span) => span.id);
        const source = sourceById.get(unit.sourceRecordId);
        if (source?.metadata?.sourceCategory === "operation") {
            continue;
        }
        const prompt = buildPrompt({
            unit,
            spans: spans.slice(0, 6),
            source,
        });
        jobs.push({
            jobId: `job_${unit.id}`,
            unitId: unit.id,
            layer: unit.layer,
            sourceRecordId: unit.sourceRecordId,
            sourceRef: source?.sourceRef ?? "",
            speaker: source?.speaker ?? null,
            language: unit.language,
            text: unit.text,
            evidenceSpanIds: spanIds,
            prompt,
        });
    }

    return jobs;
}

export function writeIrLlmJobs(filePath: string, jobs: V8IrLlmJob[]): void {
    writeJsonl(filePath, jobs);
}

export function loadLlmIrItems(
    filePath: string,
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[],
    sources: V8SourceRecord[]
): V8MemoryItem[] {
    const raw = readJsonl<any>(filePath);
    if (raw.length === 0) return [];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const sourcesById = new Map(sources.map((s) => [s.id, s]));
    const spansByUnit = new Map<string, V8EvidenceSpan[]>();
    for (const span of evidenceSpans) {
        const list = spansByUnit.get(span.unitId) || [];
        list.push(span);
        spansByUnit.set(span.unitId, list);
    }
    const items: V8MemoryItem[] = [];
    for (const entry of raw) {
        const item = normalizeLlmItem(entry, unitsById, sourcesById, spansByUnit);
        if (item) {
            items.push(item);
        }
    }
    return items;
}

function normalizeLlmItem(
    raw: any,
    unitsById: Map<string, V8Unit>,
    sourcesById: Map<string, V8SourceRecord>,
    spansByUnit: Map<string, V8EvidenceSpan[]>
): V8MemoryItem | null {
    if (!raw || typeof raw !== "object") return null;
    const unitId =
        typeof raw.unitId === "string"
            ? raw.unitId
            : typeof raw.unit_id === "string"
              ? raw.unit_id
              : "";
    if (!unitId) return null;
    const unit = unitsById.get(unitId);
    if (!unit) return null;
    const source = sourcesById.get(unit.sourceRecordId);
    const itemType =
        (typeof raw.itemType === "string" && raw.itemType) ||
        (typeof raw.item_type === "string" && raw.item_type) ||
        "";
    if (!itemType) return null;

    const predicate =
        (typeof raw.predicate === "string" && raw.predicate) ||
        (typeof raw.relation === "string" && raw.relation) ||
        "";
    if (!predicate) return null;

    if (!CONTROL_ITEM_TYPES.has(itemType as V8MemoryItemType)) {
        const allowed = ALLOWED_PREDICATES[unit.layer] || new Set();
        if (!allowed.has(predicate)) return null;
    }

    const subject =
        (typeof raw.subject === "string" && raw.subject) ||
        (typeof raw.actor === "string" && raw.actor) ||
        "";
    const object =
        (typeof raw.object === "string" && raw.object) ||
        (typeof raw.target === "string" && raw.target) ||
        "";
    if (!subject || !object) return null;

    const rawEvidence =
        raw.evidenceSpanIds ||
        raw.evidence_span_ids ||
        raw.evidence_refs ||
        raw.evidenceRefs;
    const evidenceSpanIds = Array.isArray(rawEvidence)
        ? rawEvidence.filter((id: any) => typeof id === "string" && id)
        : [];
    if (evidenceSpanIds.length === 0) {
        const spans = (spansByUnit.get(unitId) || []).slice(0, 3);
        if (spans.length === 0) return null;
        for (const span of spans) {
            evidenceSpanIds.push(span.id);
        }
    }

    const now = new Date().toISOString();
    return {
        id:
            (typeof raw.id === "string" && raw.id) ||
            (typeof raw.memory_item_id === "string" && raw.memory_item_id) ||
            `mi_llm_${now}_${Math.random().toString(36).slice(2, 8)}`,
        sourceRecordId: unit.sourceRecordId,
        sourceRef: source?.sourceRef ?? "",
        itemType: itemType as V8MemoryItemType,
        originType:
            (typeof raw.originType === "string" && raw.originType) ||
            (typeof raw.origin_type === "string" && raw.origin_type) ||
            "asserted",
        layer: unit.layer,
        subject,
        predicate,
        object,
        label:
            (typeof raw.label === "string" && raw.label) ||
            truncateLabel(`${subject} ${predicate} ${object}`),
        qualifiers: typeof raw.qualifiers === "object" && raw.qualifiers ? raw.qualifiers : {},
        evidenceSpanIds,
        unitIds: [unitId],
        confidence: typeof raw.confidence === "number" ? raw.confidence : 0.7,
        scope: raw.scope || "session",
        validity: raw.validity || "active",
        createdAt: raw.createdAt || now,
        updatedAt: raw.updatedAt || now,
    };
}

function buildPrompt(input: {
    unit: V8Unit;
    spans: V8EvidenceSpan[];
    source?: V8SourceRecord;
}): string {
    const unit = input.unit;
    const evidenceLines = input.spans.map(
        (span) => `- (${span.id}) ${sanitizeLine(span.text)}`
    );
    const allowed = Array.from(ALLOWED_PREDICATES[unit.layer] || []).sort();
    const allowedLine = allowed.length
        ? `Allowed relations (${unit.layer}): ${allowed.join(", ")}`
        : "";
    return [
        "## 结构化关系抽取任务",
        "",
        "你没有任何项目背景信息，只有下面这段清洗后的文本和证据片段。",
        "任务：从该文本中抽取关系，输出 JSON 数组；若没有可抽取关系，输出 []。",
        "",
        "硬性规则：",
        "- 只能使用 Allowed relations 列表内的关系类型",
        "- 只输出文本中明确支持的关系，不要做超出文本的推断",
        "- `evidence_span_ids` 必须来自提供的 span id 列表",
        "- `unit_id` 必须是当前 Unit ID",
        "- 输出必须是 JSON 数组，不要任何解释或额外文本",
        "",
        "每个 item 必须包含字段：",
        "`item_type`, `subject`, `predicate`, `object`, `qualifiers`, `origin_type`, `evidence_span_ids`, `unit_id`, `confidence`",
        "",
        allowedLine,
        "",
        "### Unit",
        `Unit ID: ${unit.id}`,
        `Layer: ${unit.layer}`,
        `Speaker: ${input.source?.speaker ?? "unknown"}`,
        "",
        unit.text.trim(),
        "",
        "### Evidence spans",
        ...evidenceLines,
    ]
        .filter(Boolean)
        .join("\n");
}

function truncateLabel(text: string, maxLen = 120): string {
    const trimmed = (text || "").trim().replace(/\s+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
}

function sanitizeLine(text: string, maxLen = 200): string {
    return truncateLabel(text, maxLen);
}
