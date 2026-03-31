import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../../utils.js";
import { readJsonl, writeJsonl } from "./io.js";
import { buildExtractPrompt, formatPromptUnitBody, validateAnnotatedItem } from "./ir-llm-workflow.js";
import { buildSerialIrWindows, parseNarrativeTurns } from "./ir-windowed-extraction.js";
import type {
    V8EvidenceSpan,
    V8GraphLayer,
    V8MemoryItem,
    V8MemoryItemType,
    V8Unit,
} from "../types_v8.js";
import type { V8IrPromptUnit } from "./ir-llm-workflow.js";

export interface V8IrLlmJob {
    kind: "extract";
    jobId: string;
    unitId: string;
    unitIds: string[];
    targetUnitIds: string[];
    promptUnits: V8IrPromptUnit[];
    layer: V8GraphLayer;
    narrativeRecordId: string;
    narrativeRecordIds: string[];
    sourceRef: string;
    sourceRefs: string[];
    role: string | null;
    language: string;
    text: string;
    evidenceSpanIds: string[];
    prompt: string;
}

export interface V8LoadedLlmArtifacts {
    items: V8MemoryItem[];
    units: V8Unit[];
    evidenceSpans: V8EvidenceSpan[];
}

export interface BuildLlmIrJobOptions {
    layers?: V8GraphLayer[];
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
    "relationship_state",
    "workflow_validity_state",
    "compatibility_state",
    "preference_state",
    "belief_state",
    "risk_state",
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

const DEFAULT_ITEM_TYPE_BY_LAYER: Record<V8GraphLayer, V8MemoryItemType> = {
    micro: "claim",
    meso: "scene_block",
    macro: "thread",
};

interface LlmBatchConfig {
    maxUnits: number;
    maxChars: number;
    maxEvidenceSpans: number;
}

interface NarrativeWindowConfig {
    windowTurns: number;
    overlapTurns: number;
}

interface JobPromptRef {
    layer: V8GraphLayer;
    unitIds: string[];
    narrativeRecordId: string;
    narrativeRef: string;
    ordinal: number;
    charStart: number;
    charEnd: number;
    text: string;
    role: string | null;
    timestamp: string | null;
}

interface IrAnchor {
    layer: V8GraphLayer;
    narrativeRecordId: string;
    narrativeRef: string;
    turnStart: number;
    turnEnd: number;
    charStart: number;
    charEnd: number;
    role: string | null;
    timestamp: string | null;
    text: string;
}

interface LlmItemDraft {
    rawId: string;
    narrativeRecordId: string;
    sourceRef: string;
    itemType: V8MemoryItemType;
    originType: V8MemoryItem["originType"];
    layer: V8GraphLayer;
    subject: string;
    predicate: string;
    object: string;
    label: string;
    qualifiers: Record<string, string>;
    scope: V8MemoryItem["scope"];
    validity: V8MemoryItem["validity"];
    createdAt: string;
    updatedAt: string;
    anchor: IrAnchor | null;
    legacyUnitIds: string[];
    legacyEvidenceSpanIds: string[];
}

const BATCH_CONFIG_BY_LAYER: Record<V8GraphLayer, LlmBatchConfig> = {
    micro: { maxUnits: 8, maxChars: 2600, maxEvidenceSpans: 24 },
    meso: { maxUnits: 4, maxChars: 4200, maxEvidenceSpans: 18 },
    macro: { maxUnits: 2, maxChars: 6000, maxEvidenceSpans: 12 },
};

const NARRATIVE_WINDOW_CONFIG_BY_LAYER: Record<V8GraphLayer, NarrativeWindowConfig> = {
    micro: { windowTurns: 8, overlapTurns: 2 },
    meso: { windowTurns: 24, overlapTurns: 6 },
    macro: { windowTurns: 40, overlapTurns: 10 },
};

const MAX_ITEMS_PER_UNIT: Record<V8GraphLayer, number> = {
    micro: 12,
    meso: 5,
    macro: 3,
};

const MAX_ITEMS_PER_NARRATIVE_LAYER: Record<V8GraphLayer, number> = {
    micro: 180,
    meso: 48,
    macro: 10,
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

const { allowed: ALLOWED_PREDICATES } = loadAllowedPredicates();

export function buildLlmIrJobs(
    units: V8Unit[],
    _evidenceSpans: V8EvidenceSpan[],
    options?: BuildLlmIrJobOptions
): V8IrLlmJob[] {
    const unitIndex = buildLayerUnitIndex(units);
    const requestedLayers =
        options?.layers && options.layers.length > 0
            ? options.layers
            : unitIndex.layerOrder;
    const enabledLayers = requestedLayers.filter((layer) =>
        unitIndex.layerOrder.includes(layer)
    );

    const jobs: V8IrLlmJob[] = [];
    for (const layer of enabledLayers) {
        const batchConfig = BATCH_CONFIG_BY_LAYER[layer];
        const layerUnits = (unitIndex.unitsByLayer.get(layer) || []).filter((unit) =>
            unit.text.trim().length > 0
        );
        jobs.push(...buildNarrativeExtractJobs(layer, layerUnits, batchConfig));
    }

    return jobs;
}

function buildNarrativeExtractJobs(
    layer: V8GraphLayer,
    units: V8Unit[],
    config: LlmBatchConfig
): V8IrLlmJob[] {
    const jobs: V8IrLlmJob[] = [];
    const groups = groupUnitsByNarrative(units);
    const windowConfig = NARRATIVE_WINDOW_CONFIG_BY_LAYER[layer];
    for (const group of groups) {
        if (group.length === 0) continue;
        const narrativePath = group[0]!.narrativeRef;
        const rawNarrative = readRawFile(narrativePath);
        if (!rawNarrative.trim()) continue;
        const turns = parseNarrativeTurns(rawNarrative);
        if (turns.length === 0) continue;
        const windows = buildSerialIrWindows(turns, {
            windowSize: windowConfig.windowTurns,
            overlapTurns: windowConfig.overlapTurns,
        });
        const unitsByTurn = mapUnitsToTurns(group, turns);
        for (const window of windows) {
            const promptUnits = window.turns.map((turn) => ({
                id: `${layer}_turn_${turn.idx}`,
                narrativeRecordId: group[0]!.narrativeRecordId,
                narrativeRef: narrativePath,
                ordinal: turn.idx,
                charStart: turn.charStart,
                charEnd: turn.charEnd,
                text: turn.text,
                role: turn.role || null,
                timestamp: turn.timestamp,
            }) satisfies V8IrPromptUnit);
            const targetUnitIds = promptUnits.map((unit) => unit.id);
            const sourceUnits = window.turns.flatMap((turn) => unitsByTurn.get(turn.idx) || []);
            const dedupedUnits = Array.from(new Map(sourceUnits.map((unit) => [unit.id, unit])).values());
            if (dedupedUnits.length === 0) continue;
            jobs.push({
                kind: "extract",
                jobId: `job_${layer}_turns_${group[0]!.narrativeRecordId}_${window.turnIdxStart}_${window.turnIdxEnd}`,
                unitId: targetUnitIds[0] || dedupedUnits[0]?.id || `${layer}_turn_${window.turnIdxStart}`,
                unitIds: dedupedUnits.map((unit) => unit.id),
                targetUnitIds,
                promptUnits,
                layer,
                narrativeRecordId: group[0]!.narrativeRecordId,
                narrativeRecordIds: [group[0]!.narrativeRecordId],
                sourceRef: narrativePath,
                sourceRefs: [narrativePath],
                role: promptUnits[0]?.role || null,
                language: group[0]!.language,
                text: window.turns.map((turn) => turn.text.trim()).filter(Boolean).join("\n\n"),
                evidenceSpanIds: [],
                prompt: buildExtractPrompt({
                    layer,
                    workingUnits: promptUnits,
                    pendingItems: [],
                    targetUnitIds,
                }),
            });
        }
    }
    return jobs;
}

function groupUnitsByNarrative(units: V8Unit[]): V8Unit[][] {
    const map = new Map<string, V8Unit[]>();
    for (const unit of units) {
        const key = unit.narrativeRecordId;
        const list = map.get(key) || [];
        list.push(unit);
        map.set(key, list);
    }
    return Array.from(map.values()).map((list) =>
        list
            .slice()
            .sort(
                (a, b) =>
                    a.charStart - b.charStart || a.ordinal - b.ordinal || a.id.localeCompare(b.id)
            )
    );
}

function mapUnitsToTurns(units: V8Unit[], turns: ReturnType<typeof parseNarrativeTurns>): Map<number, V8Unit[]> {
    const map = new Map<number, V8Unit[]>();
    for (const turn of turns) {
        const related = units.filter(
            (unit) => unit.charStart < turn.charEnd && unit.charEnd > turn.charStart
        );
        map.set(turn.idx, related);
    }
    return map;
}

function readRawFile(filePath: string): string {
    try {
        return fs.readFileSync(filePath, "utf-8");
    } catch {
        return "";
    }
}

interface LayerUnitIndex {
    unitsByLayer: Map<V8GraphLayer, V8Unit[]>;
    layerOrder: V8GraphLayer[];
}

function buildLayerUnitIndex(units: V8Unit[]): LayerUnitIndex {
    const unitsByLayer = new Map<V8GraphLayer, V8Unit[]>();
    for (const unit of units) {
        const layerBucket = unitsByLayer.get(unit.layer) || [];
        layerBucket.push(unit);
        unitsByLayer.set(unit.layer, layerBucket);
    }
    return {
        unitsByLayer,
        layerOrder: ["macro", "meso", "micro"],
    };
}

export function writeIrLlmJobs(filePath: string, jobs: V8IrLlmJob[]): void {
    writeJsonl(filePath, jobs);
}

export function loadLlmIrItems(
    input: { mdPath?: string; jsonlPath?: string; jobsPath?: string },
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[]
): V8MemoryItem[] {
    return loadLlmIrArtifacts(input, units, evidenceSpans).items;
}

export function loadLlmIrArtifacts(
    input: { mdPath?: string; jsonlPath?: string; jobsPath?: string },
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[]
): V8LoadedLlmArtifacts {
    const mdPath = input.mdPath;
    const jsonlPath = input.jsonlPath;
    const jobsById = loadJobUnitOrderMap(input.jobsPath);
    const fromMd: V8LoadedLlmArtifacts =
        mdPath && mdPath.trim().length > 0
            ? parseMarkdownFile(mdPath, units, evidenceSpans, jobsById)
            : { items: [], units: [], evidenceSpans: [] };
    if (fromMd.items.length > 0) {
        const pruned = pruneLlmItems(fromMd.items);
        if (jsonlPath) {
            writeJsonl(jsonlPath, pruned);
        }
        return {
            items: pruned,
            units: fromMd.units,
            evidenceSpans: fromMd.evidenceSpans,
        };
    }
    if (!jsonlPath) {
        return { items: [], units: [], evidenceSpans: [] };
    }
    const raw = readJsonl<any>(jsonlPath);
    if (raw.length === 0) {
        return { items: [], units: [], evidenceSpans: [] };
    }
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const spansByUnit = new Map<string, V8EvidenceSpan[]>();
    for (const span of evidenceSpans) {
        const list = spansByUnit.get(span.unitId) || [];
        list.push(span);
        spansByUnit.set(span.unitId, list);
    }
    const drafts: LlmItemDraft[] = [];
    for (const entry of raw) {
        const item = normalizeLlmItemDraft(entry, unitsById, spansByUnit, jobsById);
        if (item) drafts.push(item);
    }
    return materializeDerivedArtifacts(drafts, units, evidenceSpans);
}

function parseMarkdownFile(
    filePath: string,
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[],
    jobsById?: Map<string, JobPromptRef[]>
): V8LoadedLlmArtifacts {
    try {
        const raw = readFileTrimmed(filePath);
        if (!raw) return { items: [], units: [], evidenceSpans: [] };
        const blocks = splitMarkdownItems(raw);
        if (blocks.length === 0) return { items: [], units: [], evidenceSpans: [] };
        const unitsById = new Map(units.map((u) => [u.id, u]));
        const spansByUnit = new Map<string, V8EvidenceSpan[]>();
        for (const span of evidenceSpans) {
            const list = spansByUnit.get(span.unitId) || [];
            list.push(span);
            spansByUnit.set(span.unitId, list);
        }
        const drafts: LlmItemDraft[] = [];
        for (const block of blocks) {
            const rawItem = parseMarkdownItemBlock(block);
            if (!rawItem) continue;
            const item = normalizeLlmItemDraft(rawItem, unitsById, spansByUnit, jobsById);
            if (item) drafts.push(item);
        }
        return materializeDerivedArtifacts(drafts, units, evidenceSpans);
    } catch {
        return { items: [], units: [], evidenceSpans: [] };
    }
}

function normalizeLlmItemDraft(
    raw: any,
    unitsById: Map<string, V8Unit>,
    spansByUnit: Map<string, V8EvidenceSpan[]>,
    jobsById?: Map<string, JobPromptRef[]>
): LlmItemDraft | null {
    if (!raw || typeof raw !== "object") return null;
    const mappedPromptRefs = resolvePromptRefsFromRaw(raw, jobsById);
    const anchor = materializeIrAnchorFromPromptRefs(mappedPromptRefs, unitsById, raw);
    const explicitUnitId =
        typeof raw.unitId === "string"
            ? raw.unitId
            : typeof raw.unit_id === "string"
              ? raw.unit_id
              : "";
    const legacyUnitIds: string[] =
        explicitUnitId
            ? [explicitUnitId]
            : Array.isArray(raw.unit_ids)
              ? raw.unit_ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
              : resolveUnitIdsFromPromptRefs(mappedPromptRefs, unitsById);
    const resolvedUnitIds: string[] = Array.from(new Set<string>(legacyUnitIds)).filter((id) => unitsById.has(id));
    const legacyUnit = resolvedUnitIds.length > 0 ? unitsById.get(resolvedUnitIds[0]!) || null : null;
    const inferredLayer = anchor?.layer || legacyUnit?.layer || inferLayerFromRaw(raw);
    if (!inferredLayer) return null;
    const itemType =
        (typeof raw.itemType === "string" && raw.itemType) ||
        (typeof raw.item_type === "string" && raw.item_type) ||
        "";
    const normalizedItemType = itemType
        ? (itemType.trim().toLowerCase() as V8MemoryItemType)
        : DEFAULT_ITEM_TYPE_BY_LAYER[inferredLayer];
    const allowedItemTypes = new Set(ITEM_TYPES_BY_LAYER[inferredLayer] || []);
    if (
        !CONTROL_ITEM_TYPES.has(normalizedItemType) &&
        !allowedItemTypes.has(normalizedItemType)
    ) {
        return null;
    }

    const predicate =
        (typeof raw.predicate === "string" && raw.predicate) ||
        (typeof raw.relation === "string" && raw.relation) ||
        "";
    if (!predicate) return null;
    const normalizedPredicate = predicate.trim();
    if (!normalizedPredicate) return null;

    const subject =
        (typeof raw.point_a === "string" && raw.point_a) ||
        (typeof raw.subject === "string" && raw.subject) ||
        (typeof raw.actor === "string" && raw.actor) ||
        "";
    const object =
        (typeof raw.point_b === "string" && raw.point_b) ||
        (typeof raw.object === "string" && raw.object) ||
        (typeof raw.target === "string" && raw.target) ||
        "";
    if (inferredLayer === "micro") {
        if (!subject || !object) return null;
    } else if (!subject && !object) {
        return null;
    }

    const rawEvidence =
        raw.evidenceSpanIds ||
        raw.evidence_span_ids ||
        raw.evidence_refs ||
        raw.evidenceRefs;
    const candidateSpans = resolvedUnitIds.flatMap((id) => spansByUnit.get(id) || []);
    const unitSpanIds = new Set(candidateSpans.map((span) => span.id));
    const explicitEvidence = Array.isArray(rawEvidence);
    const legacyEvidenceSpanIds: string[] = explicitEvidence
        ? rawEvidence.filter(
              (id: unknown): id is string => typeof id === "string" && id.length > 0 && unitSpanIds.has(id)
          )
        : [];

    const now = new Date().toISOString();
    const qualifiers = normalizeQualifiers(
        typeof raw.qualifiers === "object" && raw.qualifiers ? raw.qualifiers : {}
    );
    const relationFamily =
        (typeof raw.relation_family === "string" && raw.relation_family.trim()) ||
        "";
    if (relationFamily) {
        qualifiers.relation_family = relationFamily.trim().toLowerCase();
    }
    const candidate: LlmItemDraft = {
        rawId:
            (typeof raw.id === "string" && raw.id) ||
            (typeof raw.memory_item_id === "string" && raw.memory_item_id) ||
            `mi_llm_${now}_${Math.random().toString(36).slice(2, 8)}`,
        narrativeRecordId: anchor?.narrativeRecordId || legacyUnit?.narrativeRecordId || "",
        sourceRef: anchor?.narrativeRef || legacyUnit?.narrativeRef || "",
        itemType: normalizedItemType,
        originType:
            (typeof raw.originType === "string" && raw.originType) ||
            (typeof raw.origin_type === "string" && raw.origin_type) ||
            "asserted",
        layer: inferredLayer,
        subject,
        predicate: normalizedPredicate,
        object,
        label:
            (typeof raw.label === "string" && raw.label) ||
            truncateLabel(`${subject} ${normalizedPredicate} ${object}`),
        qualifiers,
        scope: raw.scope || "session",
        validity: raw.validity || "active",
        createdAt: raw.createdAt || now,
        updatedAt: raw.updatedAt || now,
        anchor,
        legacyUnitIds: resolvedUnitIds,
        legacyEvidenceSpanIds,
    };
    if (!candidate.narrativeRecordId || !candidate.sourceRef) return null;
    return candidate;
}

function truncateLabel(text: string, maxLen = 120): string {
    const trimmed = (text || "").trim().replace(/\s+/g, " ");
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen) + "…";
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
        const match = line.match(/^(?:-\s*)?([a-zA-Z_]+)\s*:\s*(.*)$/);
        if (!match) continue;
        const key = match[1];
        const value = match[2] || "";
        switch (key) {
            case "item_type":
            case "point_a":
            case "subject":
            case "relation":
            case "predicate":
            case "relation_family":
            case "point_b":
            case "object":
            case "origin_type":
            case "unit_id":
            case "unit_number":
            case "unit_ref":
            case "label":
            case "evidence":
            case "anchor_start":
            case "anchor_end":
            case "evidence_start_turn":
            case "evidence_end_turn":
            case "evidence_start_anchor":
            case "evidence_end_anchor":
                item[key] = value;
                break;
            case "unit_ids": {
                item[key] = value
                    .split(/[,，\s]+/)
                    .map((id) => id.trim())
                    .filter(Boolean);
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
    const left = item.point_a || item.subject;
    const rel = item.relation || item.predicate;
    const right = item.point_b || item.object;
    const allowOpenSides = item.layer === "meso" || item.layer === "macro";
    if (!rel) {
        return null;
    }
    if (allowOpenSides ? (!left && !right) : (!left || !right)) {
        return null;
    }
    item.subject = left;
    item.predicate = rel;
    item.object = right;
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
    return normalizeQualifiers(qualifiers);
}

function loadJobUnitOrderMap(jobsPath?: string): Map<string, JobPromptRef[]> {
    if (!jobsPath) return new Map();
    try {
        const raw = readJsonl<any>(jobsPath);
        const map = new Map<string, JobPromptRef[]>();
        for (const entry of raw) {
            const jobId = typeof entry?.jobId === "string" ? entry.jobId : "";
            const layer =
                entry?.layer === "micro" || entry?.layer === "meso" || entry?.layer === "macro"
                    ? entry.layer
                    : null;
            const promptUnits = Array.isArray(entry?.promptUnits) ? entry.promptUnits : [];
            if (!jobId || !layer || promptUnits.length === 0) continue;
            const orderedRefs = promptUnits
                .map((unit: any, index: number) => {
                    const unitIds = Array.isArray(unit?.sourceUnitIds)
                        ? unit.sourceUnitIds
                              .map((id: any) => (typeof id === "string" ? id : ""))
                              .filter(Boolean)
                        : typeof unit?.id === "string" && unit.id
                          ? [unit.id]
                          : [];
                    const narrativeRecordId =
                        typeof unit?.narrativeRecordId === "string" ? unit.narrativeRecordId : "";
                    const narrativeRef =
                        typeof unit?.narrativeRef === "string" ? unit.narrativeRef : "";
                    const charStart =
                        typeof unit?.charStart === "number" ? unit.charStart : Number.NaN;
                    const charEnd =
                        typeof unit?.charEnd === "number" ? unit.charEnd : Number.NaN;
                    if (unitIds.length === 0 && !Number.isFinite(charStart)) {
                        return null;
                    }
                    return {
                        layer,
                        unitIds,
                        narrativeRecordId,
                        narrativeRef,
                        ordinal: typeof unit?.ordinal === "number" ? unit.ordinal : index + 1,
                        charStart: Number.isFinite(charStart) ? charStart : 0,
                        charEnd: Number.isFinite(charEnd) ? charEnd : 0,
                        text: typeof unit?.text === "string" ? unit.text : "",
                        role: typeof unit?.role === "string" ? unit.role : null,
                        timestamp: typeof unit?.timestamp === "string" ? unit.timestamp : null,
                    } satisfies JobPromptRef;
                })
                .filter((ref: JobPromptRef | null): ref is JobPromptRef => ref !== null);
            if (orderedRefs.length > 0) {
                map.set(jobId, orderedRefs);
            }
        }
        return map;
    } catch {
        return new Map();
    }
}

function resolvePromptRefsFromRaw(raw: any, jobsById?: Map<string, JobPromptRef[]>): JobPromptRef[] {
    if (!jobsById || jobsById.size === 0) return [];
    const jobId = typeof raw?._job_id === "string" ? raw._job_id : "";
    if (!jobId) return [];
    const ordered = jobsById.get(jobId);
    if (!ordered || ordered.length === 0) return [];
    const explicitEvidence = parseEvidenceAnchorFromRaw(raw);
    if (explicitEvidence) {
        return ordered.filter(
            (ref) =>
                (!explicitEvidence.narrativeRecordId || ref.narrativeRecordId === explicitEvidence.narrativeRecordId) &&
                ref.ordinal >= explicitEvidence.turnStart &&
                ref.ordinal <= explicitEvidence.turnEnd
        );
    }
    const rawNumber =
        typeof raw?.unit_number === "number"
            ? raw.unit_number
            : typeof raw?.unit_number === "string"
              ? Number.parseInt(raw.unit_number, 10)
              : typeof raw?.unit_ref === "string"
                ? Number.parseInt(String(raw.unit_ref).replace(/^unit\s*/i, ""), 10)
                : NaN;
    const rawNumbers =
        typeof raw?.unit_numbers === "string"
            ? String(raw.unit_numbers)
                  .split(/[,，\s]+/)
                  .map((value) => Number.parseInt(value, 10))
                  .filter((value) => Number.isFinite(value))
            : [];
    const resolvedNumbers = rawNumbers.length > 0 ? rawNumbers : Number.isFinite(rawNumber) ? [rawNumber] : [];
    if (resolvedNumbers.length === 0) return [];
    const output: JobPromptRef[] = [];
    for (const number of resolvedNumbers) {
        const index = Math.trunc(number) - 1;
        if (index < 0) continue;
        const ref = ordered[index];
        if (ref) {
            output.push(ref);
        }
    }
    return output;
}

function parseEvidenceAnchorFromRaw(raw: any): { narrativeRecordId?: string; turnStart: number; turnEnd: number; startAnchor?: string; endAnchor?: string } | null {
    const start = typeof raw?.evidence_start_turn === 'string' || typeof raw?.evidence_start_turn === 'number'
        ? Number.parseInt(String(raw.evidence_start_turn), 10)
        : NaN;
    const end = typeof raw?.evidence_end_turn === 'string' || typeof raw?.evidence_end_turn === 'number'
        ? Number.parseInt(String(raw.evidence_end_turn), 10)
        : NaN;
    if (Number.isFinite(start) && Number.isFinite(end)) {
        return {
            turnStart: Math.min(start, end),
            turnEnd: Math.max(start, end),
            startAnchor: typeof raw?.evidence_start_anchor === 'string' ? raw.evidence_start_anchor.trim() || undefined : undefined,
            endAnchor: typeof raw?.evidence_end_anchor === 'string' ? raw.evidence_end_anchor.trim() || undefined : undefined,
        };
    }
    const legacy = parseEvidenceDescriptor(typeof raw?.evidence === 'string' ? raw.evidence : '');
    if (!legacy) return null;
    return {
        ...legacy,
        startAnchor: typeof raw?.anchor_start === 'string' ? raw.anchor_start.trim() || undefined : undefined,
        endAnchor: typeof raw?.anchor_end === 'string' ? raw.anchor_end.trim() || undefined : undefined,
    };
}

function parseEvidenceDescriptor(value: string): { narrativeRecordId?: string; turnStart: number; turnEnd: number } | null {
    const trimmed = String(value || "").trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(?:(.*?)\s+)?turns?\s+(\d+)(?:\s*-\s*(\d+))?$/i);
    if (!match) return null;
    const turnStart = Number.parseInt(match[2] || "", 10);
    const turnEnd = Number.parseInt(match[3] || match[2] || "", 10);
    if (!Number.isFinite(turnStart) || !Number.isFinite(turnEnd)) return null;
    return {
        narrativeRecordId: String(match[1] || "").trim() || undefined,
        turnStart: Math.min(turnStart, turnEnd),
        turnEnd: Math.max(turnStart, turnEnd),
    };
}

function inferLayerFromRaw(raw: any): V8GraphLayer | null {
    const itemType =
        (typeof raw?.itemType === "string" && raw.itemType) ||
        (typeof raw?.item_type === "string" && raw.item_type) ||
        "";
    const normalized = String(itemType || "").trim().toLowerCase();
    if (!normalized) return null;
    for (const layer of ["micro", "meso", "macro"] as V8GraphLayer[]) {
        if ((ITEM_TYPES_BY_LAYER[layer] || []).includes(normalized)) {
            return layer;
        }
    }
    return null;
}

function materializeIrAnchorFromPromptRefs(
    refs: JobPromptRef[],
    unitsById: Map<string, V8Unit>,
    raw?: any
): IrAnchor | null {
    if (refs.length === 0) return null;
    const ordered = refs
        .slice()
        .sort((a, b) => a.ordinal - b.ordinal || a.charStart - b.charStart);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const layer = first.layer || resolveLayerFromLegacyUnitRefs(ordered, unitsById);
    if (!layer) return null;
    const narrativeText = readRawFile(first.narrativeRef);
    const resolved = resolveCharRangeFromAnchors(ordered, raw);
    const charStart = resolved?.charStart ?? Math.max(0, first.charStart);
    const charEnd = resolved?.charEnd ?? Math.max(charStart, last.charEnd);
    const text =
        narrativeText && charEnd > charStart
            ? narrativeText.slice(charStart, charEnd).trim()
            : "";
    return {
        layer,
        narrativeRecordId: first.narrativeRecordId,
        narrativeRef: first.narrativeRef,
        turnStart: first.ordinal,
        turnEnd: last.ordinal,
        charStart,
        charEnd,
        role: first.role || null,
        timestamp: first.timestamp || null,
        text,
    };
}


function resolveCharRangeFromAnchors(refs: JobPromptRef[], raw: any): { charStart: number; charEnd: number } | null {
    const startAnchor = pickAnchorValue(raw?.evidence_start_anchor, raw?.anchor_start);
    const endAnchor = pickAnchorValue(raw?.evidence_end_anchor, raw?.anchor_end);
    if (!startAnchor && !endAnchor) return null;
    let charStart: number | null = null;
    let charEnd: number | null = null;
    if (startAnchor) {
        for (const ref of refs) {
            const range = locateAnchorRange(String(ref.text || ""), startAnchor, "start");
            if (range) {
                charStart = ref.charStart + range.start;
                break;
            }
        }
    }
    if (endAnchor) {
        for (const ref of refs.slice().reverse()) {
            const range = locateAnchorRange(String(ref.text || ""), endAnchor, "end");
            if (range) {
                charEnd = ref.charStart + range.end;
                break;
            }
        }
    }
    if (charStart === null && charEnd === null) return null;
    return {
        charStart: charStart ?? refs[0]!.charStart,
        charEnd: charEnd ?? refs[refs.length - 1]!.charEnd,
    };
}

function pickAnchorValue(primary: unknown, fallback: unknown): string {
    if (typeof primary === "string" && primary.trim()) return primary.trim();
    if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
    return "";
}

function locateAnchorRange(
    text: string,
    anchor: string,
    mode: "start" | "end"
): { start: number; end: number } | null {
    if (!text || !anchor) return null;

    const directIndex =
        mode === "start" ? text.indexOf(anchor) : text.lastIndexOf(anchor);
    if (directIndex >= 0) {
        return { start: directIndex, end: directIndex + anchor.length };
    }

    const textMap = buildNormalizedIndexMap(text);
    const anchorMap = buildNormalizedIndexMap(anchor);
    if (!textMap.normalized || !anchorMap.normalized) return null;
    const normalizedIndex =
        mode === "start"
            ? textMap.normalized.indexOf(anchorMap.normalized)
            : textMap.normalized.lastIndexOf(anchorMap.normalized);
    if (normalizedIndex < 0) return null;

    const start = textMap.indexMap[normalizedIndex];
    const normalizedEndIndex = normalizedIndex + anchorMap.normalized.length - 1;
    const endRawIndex = textMap.indexMap[normalizedEndIndex];
    if (!Number.isFinite(start) || !Number.isFinite(endRawIndex)) return null;
    return { start, end: endRawIndex + 1 };
}

function buildNormalizedIndexMap(value: string): { normalized: string; indexMap: number[] } {
    let normalized = "";
    const indexMap: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const rawChar = value[index]!;
        const normalizedChar = rawChar.normalize("NFKC");
        for (const ch of normalizedChar) {
            if (/\s/u.test(ch)) continue;
            normalized += ch;
            indexMap.push(index);
        }
    }
    return { normalized, indexMap };
}
function resolveLayerFromLegacyUnitRefs(
    refs: JobPromptRef[],
    unitsById: Map<string, V8Unit>
): V8GraphLayer | null {
    for (const ref of refs) {
        for (const unitId of ref.unitIds) {
            const unit = unitsById.get(unitId);
            if (unit) return unit.layer;
        }
    }
    return null;
}

function materializeDerivedArtifacts(
    drafts: LlmItemDraft[],
    legacyUnits: V8Unit[],
    legacyEvidenceSpans: V8EvidenceSpan[]
): V8LoadedLlmArtifacts {
    const unitByKey = new Map<string, V8Unit>();
    const spanByKey = new Map<string, V8EvidenceSpan>();
    const items: V8MemoryItem[] = [];
    const legacyUnitsById = new Map(legacyUnits.map((unit) => [unit.id, unit]));
    const legacySpansById = new Map(legacyEvidenceSpans.map((span) => [span.id, span]));

    for (const draft of drafts) {
        let unitIds = draft.legacyUnitIds.slice();
        let evidenceSpanIds = draft.legacyEvidenceSpanIds.slice();

        if (draft.anchor) {
            const unit = ensureDerivedUnit(draft, draft.anchor, unitByKey, legacyUnitsById);
            const span = ensureDerivedEvidenceSpan(draft, unit, spanByKey);
            unitIds = [unit.id];
            evidenceSpanIds = [span.id];
        }

        if (unitIds.length === 0 || evidenceSpanIds.length === 0) continue;
        const candidate: V8MemoryItem = {
            id: draft.rawId,
            narrativeRecordId: draft.narrativeRecordId,
            sourceRef: draft.sourceRef,
            itemType: draft.itemType,
            originType: draft.originType,
            layer: draft.layer,
            subject: draft.subject,
            predicate: draft.predicate,
            object: draft.object,
            label: draft.label,
            qualifiers: draft.qualifiers,
            evidenceSpanIds,
            unitIds,
            confidence: 0.7,
            scope: draft.scope,
            validity: draft.validity,
            createdAt: draft.createdAt,
            updatedAt: draft.updatedAt,
        };
        const allowedUnits = new Set(unitIds);
        const allowedSpans = new Set(evidenceSpanIds);
        const validity = validateAnnotatedItem(candidate, allowedUnits, allowedSpans);
        if (!validity.ok) continue;
        items.push(candidate);
    }

    const units = Array.from(unitByKey.values());
    assignDerivedParents(units);
    const evidenceSpans = Array.from(spanByKey.values()).filter((span) => {
        if (unitByKey.size === 0) return true;
        return units.some((unit) => unit.id === span.unitId) || legacySpansById.has(span.id);
    });

    return {
        items: pruneLlmItems(items),
        units,
        evidenceSpans,
    };
}

function ensureDerivedUnit(
    draft: LlmItemDraft,
    anchor: IrAnchor,
    unitByKey: Map<string, V8Unit>,
    legacyUnitsById: Map<string, V8Unit>
): V8Unit {
    const key = `${anchor.layer}|${anchor.narrativeRecordId}|${anchor.turnStart}|${anchor.turnEnd}`;
    const existing = unitByKey.get(key);
    if (existing) return existing;
    const fallbackUnit =
        draft.legacyUnitIds.length > 0 ? legacyUnitsById.get(draft.legacyUnitIds[0]!) || null : null;
    const unit: V8Unit = {
        id: `unit_ir_${anchor.layer}_${sanitizeIdPart(anchor.narrativeRecordId)}_${anchor.turnStart}_${anchor.turnEnd}`,
        narrativeRecordId: anchor.narrativeRecordId,
        narrativeRef: anchor.narrativeRef,
        layer: anchor.layer,
        ordinal: anchor.turnStart,
        charStart: anchor.charStart,
        charEnd: anchor.charEnd,
        text: anchor.text,
        parentUnitId: null,
        language: fallbackUnit?.language || inferLanguage(anchor.text),
        role: anchor.role ?? fallbackUnit?.role ?? null,
        timestamp: anchor.timestamp ?? fallbackUnit?.timestamp ?? null,
        sourceCategory: fallbackUnit?.sourceCategory || inferSourceCategory(anchor.role),
    };
    unitByKey.set(key, unit);
    return unit;
}

function ensureDerivedEvidenceSpan(
    draft: LlmItemDraft,
    unit: V8Unit,
    spanByKey: Map<string, V8EvidenceSpan>
): V8EvidenceSpan {
    const key = `${unit.id}|${unit.charStart}|${unit.charEnd}`;
    const existing = spanByKey.get(key);
    if (existing) return existing;
    const span: V8EvidenceSpan = {
        id: `es_${unit.id}`,
        narrativeRecordId: unit.narrativeRecordId,
        narrativeRef: unit.narrativeRef,
        unitId: unit.id,
        charStart: unit.charStart,
        charEnd: unit.charEnd,
        text: unit.text,
        role: unit.role,
        timestamp: unit.timestamp,
        sourceClass: "raw",
        sourceType: "session_narrative",
        score: 1,
    };
    spanByKey.set(key, span);
    return span;
}

function assignDerivedParents(units: V8Unit[]): void {
    const byNarrative = new Map<string, V8Unit[]>();
    for (const unit of units) {
        const list = byNarrative.get(unit.narrativeRecordId) || [];
        list.push(unit);
        byNarrative.set(unit.narrativeRecordId, list);
    }
    for (const group of byNarrative.values()) {
        const mesos = group.filter((unit) => unit.layer === "meso");
        const macros = group.filter((unit) => unit.layer === "macro");
        for (const unit of group) {
            if (unit.layer === "micro") {
                unit.parentUnitId = findSmallestContainingUnit(unit, mesos)?.id || null;
            } else if (unit.layer === "meso") {
                unit.parentUnitId = findSmallestContainingUnit(unit, macros)?.id || null;
            } else {
                unit.parentUnitId = null;
            }
        }
    }
}

function findSmallestContainingUnit(unit: V8Unit, candidates: V8Unit[]): V8Unit | null {
    const containing = candidates
        .filter(
            (candidate) =>
                candidate.charStart <= unit.charStart && candidate.charEnd >= unit.charEnd
        )
        .sort(
            (a, b) =>
                a.charEnd - a.charStart - (b.charEnd - b.charStart) ||
                a.charStart - b.charStart
        );
    return containing[0] || null;
}

function inferLanguage(text: string): V8Unit["language"] {
    if (!text) return "unknown";
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const enCount = (text.match(/[A-Za-z]/g) || []).length;
    if (zhCount === 0 && enCount === 0) return "unknown";
    if (zhCount > enCount * 2) return "zh";
    if (enCount > zhCount * 2) return "en";
    return "mixed";
}

function inferSourceCategory(role: string | null): V8Unit["sourceCategory"] {
    const normalized = String(role || "").toLowerCase();
    if (normalized.includes("tool")) return "operation";
    if (normalized) return "conversation";
    return "unknown";
}

function sanitizeIdPart(value: string): string {
    return String(value || "")
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "narr";
}

function resolveUnitIdsFromPromptRefs(
    refs: JobPromptRef[],
    unitsById: Map<string, V8Unit>
): string[] {
    if (refs.length === 0) return [];
    const units = Array.from(unitsById.values());
    const output = new Set<string>();
    for (const ref of refs) {
        for (const unitId of ref.unitIds) {
            if (unitsById.has(unitId)) {
                output.add(unitId);
            }
        }
        if (!ref.narrativeRecordId || !ref.narrativeRef) continue;
        if (ref.charEnd <= ref.charStart) continue;
        for (const unit of units) {
            if (unit.narrativeRecordId !== ref.narrativeRecordId) continue;
            if (unit.narrativeRef !== ref.narrativeRef) continue;
            if (unit.charStart < ref.charEnd && unit.charEnd > ref.charStart) {
                output.add(unit.id);
            }
        }
    }
    return Array.from(output);
}

function spanOverlapsPromptRefs(span: V8EvidenceSpan, refs: JobPromptRef[]): boolean {
    if (refs.length === 0) return true;
    return refs.some((ref) => {
        if (ref.unitIds.includes(span.unitId)) return true;
        if (!ref.narrativeRecordId || !ref.narrativeRef) return false;
        if (span.narrativeRecordId !== ref.narrativeRecordId) return false;
        if (span.narrativeRef !== ref.narrativeRef) return false;
        if (ref.charEnd <= ref.charStart) return false;
        return span.charStart < ref.charEnd && span.charEnd > ref.charStart;
    });
}

function normalizeQualifiers(raw: Record<string, unknown>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw || {})) {
        const normalizedKey = String(key || "").trim().toLowerCase();
        if (!normalizedKey) continue;
        const normalizedValue = String(value ?? "").trim().toLowerCase();
        if (!normalizedValue) continue;
        normalized[normalizedKey] = normalizedValue;
    }
    return normalized;
}

function pruneLlmItems(items: V8MemoryItem[]): V8MemoryItem[] {
    if (items.length <= 1) return items;
    const sorted = items
        .slice()
        .sort((a, b) => {
            const stabilityDelta = itemStabilityRank(b) - itemStabilityRank(a);
            if (stabilityDelta !== 0) return stabilityDelta;
            return (b.confidence || 0) - (a.confidence || 0);
        });

    const kept: V8MemoryItem[] = [];
    const seenGlobal = new Set<string>();
    const seenNarrativeRelation = new Set<string>();
    const perUnitCount = new Map<string, number>();
    const perNarrativeLayerCount = new Map<string, number>();

    for (const item of sorted) {
        if (!item.unitIds || item.unitIds.length === 0) continue;
        if (!item.evidenceSpanIds || item.evidenceSpanIds.length === 0) continue;
        if (item.layer === "macro" && item.confidence < 0.6) continue;
        if (item.layer === "meso" && item.confidence < 0.55) continue;

        const unitId = item.unitIds[0]!;
        const unitKey = `${item.layer}:${unitId}`;
        const currentCount = perUnitCount.get(unitKey) || 0;
        const cap = MAX_ITEMS_PER_UNIT[item.layer] || 6;
        if (currentCount >= cap) continue;
        const narrativeKey = `${item.layer}:${item.narrativeRecordId}`;
        const narrativeCount = perNarrativeLayerCount.get(narrativeKey) || 0;
        const narrativeCap = MAX_ITEMS_PER_NARRATIVE_LAYER[item.layer] || 80;
        if (narrativeCount >= narrativeCap) continue;

        const dedupeKey = [
            item.layer,
            item.narrativeRecordId,
            unitId,
            item.itemType,
            normalizeDedupe(item.subject),
            normalizeDedupe(item.predicate),
            normalizeDedupe(item.object),
        ].join("|");
        if (seenGlobal.has(dedupeKey)) continue;
        seenGlobal.add(dedupeKey);

        if (item.layer !== "micro") {
            const narrativeRelationKey = [
                item.layer,
                item.narrativeRecordId,
                item.itemType,
                normalizeDedupe(item.subject),
                normalizeDedupe(item.predicate),
                normalizeDedupe(item.object),
            ].join("|");
            if (seenNarrativeRelation.has(narrativeRelationKey)) continue;
            seenNarrativeRelation.add(narrativeRelationKey);
        }

        kept.push(item);
        perUnitCount.set(unitKey, currentCount + 1);
        perNarrativeLayerCount.set(narrativeKey, narrativeCount + 1);
    }

    return kept;
}

function normalizeDedupe(text: string): string {
    return (text || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

function itemStabilityRank(item: V8MemoryItem): number {
    const qualifiers = item.qualifiers || {};
    const epistemic = String(qualifiers.epistemic_status || "").toLowerCase();
    const role = String(qualifiers.operation_role || "").toLowerCase();
    const durability = String(qualifiers.durability || "").toLowerCase();
    let score = 0;
    if (durability === "durable") score += 3;
    if (epistemic === "applied") score += 4;
    else if (epistemic === "verified") score += 3;
    else if (epistemic === "observed") score += 2;
    else if (epistemic === "hypothesized") score -= 1;

    if (role === "fix" || role === "outcome") score += 2;
    else if (role === "verification") score += 1;
    else if (role === "observation") score += 1;

    return score;
}
