import * as fs from "node:fs";
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
        group?: string;
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

const ITEM_TYPES_BY_LAYER: Record<V8GraphLayer, string[]> = {
    micro: [
        "entity",
        "concept",
        "method",
        "event",
        "attribute",
        "metric",
        "claim",
        "evidence",
        "context",
        "discourse_unit",
    ],
    meso: [
        "scene_block",
        "situation_frame",
        "objective_block",
        "problem_block",
        "strategy_block",
        "procedure_block",
        "interaction_block",
        "decision_block",
        "evidence_frame",
        "shift_block",
        "outcome_block",
        "block_function",
    ],
    macro: [
        "arc",
        "thread",
        "phase",
        "global_scene_type",
        "regime",
        "objective_line",
        "conflict_line",
        "relationship_arc",
        "method_line",
        "theme",
        "pattern",
        "turning_point",
        "global_state",
    ],
};

function edgeCatalogPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../schema/v8-edge-catalog.json");
}

function loadAllowedPredicates(): {
    allowed: Record<V8GraphLayer, Set<string>>;
    grouped: Record<V8GraphLayer, Map<string, string[]>>;
} {
    const data = readJson<EdgeCatalogFile>(edgeCatalogPath(), { edges: [] });
    const allowed: Record<V8GraphLayer, Set<string>> = {
        micro: new Set(),
        meso: new Set(),
        macro: new Set(),
    };
    const grouped: Record<V8GraphLayer, Map<string, string[]>> = {
        micro: new Map(),
        meso: new Map(),
        macro: new Map(),
    };
    const edges = Array.isArray(data.edges) ? data.edges : [];
    for (const entry of edges) {
        if (!entry?.type || !entry.layer) continue;
        if (entry.status && entry.status !== "canonical") continue;
        if (entry.layer === "micro" || entry.layer === "meso" || entry.layer === "macro") {
            allowed[entry.layer].add(entry.type);
            const group = entry.group || "other";
            const list = grouped[entry.layer].get(group) || [];
            list.push(entry.type);
            grouped[entry.layer].set(group, list);
        }
    }
    return { allowed, grouped };
}

const { allowed: ALLOWED_PREDICATES, grouped: ALLOWED_GROUPS } = loadAllowedPredicates();

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
        const sourceCategory = source?.metadata?.sourceCategory;
        const operationPromotion = source?.metadata?.operationPromotion;
        if (
            sourceCategory === "operation" &&
            operationPromotion !== "llm_ir"
        ) {
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
    input: { mdPath?: string; jsonlPath?: string },
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[],
    sources: V8SourceRecord[]
): V8MemoryItem[] {
    const mdPath = input.mdPath;
    const jsonlPath = input.jsonlPath;
    const fromMd =
        mdPath && mdPath.trim().length > 0
            ? parseMarkdownFile(mdPath, units, evidenceSpans, sources)
            : [];
    if (fromMd.length > 0) {
        if (jsonlPath) {
            writeJsonl(jsonlPath, fromMd);
        }
        return fromMd;
    }
    if (!jsonlPath) return [];
    const raw = readJsonl<any>(jsonlPath);
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

function parseMarkdownFile(
    filePath: string,
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[],
    sources: V8SourceRecord[]
): V8MemoryItem[] {
    try {
        const raw = readFileTrimmed(filePath);
        if (!raw) return [];
        const blocks = splitMarkdownItems(raw);
        if (blocks.length === 0) return [];
        const unitsById = new Map(units.map((u) => [u.id, u]));
        const sourcesById = new Map(sources.map((s) => [s.id, s]));
        const spansByUnit = new Map<string, V8EvidenceSpan[]>();
        for (const span of evidenceSpans) {
            const list = spansByUnit.get(span.unitId) || [];
            list.push(span);
            spansByUnit.set(span.unitId, list);
        }
        const items: V8MemoryItem[] = [];
        for (const block of blocks) {
            const rawItem = parseMarkdownItemBlock(block);
            if (!rawItem) continue;
            const item = normalizeLlmItem(rawItem, unitsById, sourcesById, spansByUnit);
            if (item) items.push(item);
        }
        return items;
    } catch {
        return [];
    }
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
    const groupMap = ALLOWED_GROUPS[unit.layer];
    const groupedLines =
        groupMap && groupMap.size > 0
            ? Array.from(groupMap.entries())
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([group, relations]) => {
                      const list = relations.slice().sort().join(", ");
                      return `- ${group}: ${list}`;
                  })
            : [];
    const allowedLine = allowed.length
        ? `Allowed relations (${unit.layer}): ${allowed.join(", ")}`
        : "";
    const itemTypeLine = ITEM_TYPES_BY_LAYER[unit.layer]?.length
        ? `Allowed item_type (${unit.layer}): ${ITEM_TYPES_BY_LAYER[unit.layer].join(", ")}`
        : "";
    const sourceCategory = input.source?.metadata?.sourceCategory ?? "conversation";
    const operationKind = input.source?.metadata?.operationKind;
    return [
        "任务：从下方文本中抽取关系，输出 Markdown；若无可抽取关系，输出 `[]`。",
        "",
        "硬性规则：",
        "- 只能使用 Allowed relations 列表内的关系类型（按分组提示）",
        "- 只输出文本中明确支持的关系，不要做超出文本的推断",
        "- `evidence_span_ids` 必须来自提供的 span id 列表",
        "- `unit_id` 必须是当前 Unit ID",
        "- 输出必须是 Markdown，不要输出 JSON，不要任何解释或额外文本",
        "",
        "输出格式（严格遵守）：",
        "",
        "### Item",
        "item_type: <type>",
        "subject: <text>",
        "predicate: <relation>",
        "object: <text>",
        "qualifiers: key=value; key=value (没有则留空)",
        "origin_type: asserted|aggregated|inferred",
        "evidence_span_ids: es_xxx, es_yyy",
        "unit_id: <unit_id>",
        "confidence: 0.0-1.0",
        "",
        "每条关系一个 `### Item`。",
        "若无可抽取关系，输出：`[]`",
        "",
        "可选控制类（若文本明确表达偏好/目标/约束/决定等）：",
        "- item_type 可用：preference, goal, constraint, decision, open_question, conversation_act, session_state, topic_state",
        "- predicate 可用：prefers, requires, targets, decides, acts",
        "",
        allowedLine,
        itemTypeLine,
        ...groupedLines,
        "",
        "### Unit",
        `Unit ID: ${unit.id}`,
        `Layer: ${unit.layer}`,
        `Speaker: ${input.source?.speaker ?? "unknown"}`,
        `Source category: ${sourceCategory}${operationKind ? ` (${operationKind})` : ""}`,
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

function readFileTrimmed(filePath: string): string {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return raw.trim();
    } catch {
        return "";
    }
}

function splitMarkdownItems(markdown: string): string[] {
    if (!markdown) return [];
    if (markdown.trim() === "[]") return [];
    const parts = markdown.split(/^\s*###\s+Item\s*$/m);
    if (parts.length <= 1) return [];
    return parts.slice(1).map((part) => part.trim()).filter(Boolean);
}

function parseMarkdownItemBlock(block: string): Record<string, unknown> | null {
    if (!block) return null;
    const lines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return null;
    const item: Record<string, unknown> = {};
    for (const line of lines) {
        const match = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
        if (!match) continue;
        const key = match[1];
        const value = match[2] || "";
        switch (key) {
            case "item_type":
            case "subject":
            case "predicate":
            case "object":
            case "origin_type":
            case "unit_id":
            case "label":
                item[key] = value;
                break;
            case "confidence": {
                const parsed = Number.parseFloat(value);
                if (!Number.isNaN(parsed)) {
                    item[key] = parsed;
                }
                break;
            }
            case "evidence_span_ids": {
                item[key] = value
                    .split(/[,，\s]+/)
                    .map((id) => id.trim())
                    .filter(Boolean);
                break;
            }
            case "qualifiers": {
                item[key] = parseQualifiers(value);
                break;
            }
            default:
                item[key] = value;
        }
    }
    if (!item.item_type || !item.subject || !item.predicate || !item.object) {
        return null;
    }
    return item;
}

function parseQualifiers(value: string): Record<string, string> {
    if (!value) return {};
    if (value === "-" || value === "none" || value === "null") return {};
    const entries = value
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    const qualifiers: Record<string, string> = {};
    for (const entry of entries) {
        const [key, ...rest] = entry.split("=").map((part) => part.trim());
        if (!key || rest.length === 0) continue;
        qualifiers[key] = rest.join("=");
    }
    return qualifiers;
}
