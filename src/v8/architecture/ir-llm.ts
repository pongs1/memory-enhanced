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
    V8Unit,
} from "../types_v8.js";

export interface V8IrLlmJob {
    jobId: string;
    unitId: string;
    unitIds: string[];
    layer: V8GraphLayer;
    narrativeRecordId: string;
    narrativeRecordIds: string[];
    sourceRef: string;
    sourceRefs: string[];
    speaker: string | null;
    language: string;
    text: string;
    evidenceSpanIds: string[];
    prompt: string;
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

interface LlmBatchConfig {
    maxUnits: number;
    maxChars: number;
    maxEvidenceSpans: number;
}

const BATCH_CONFIG_BY_LAYER: Record<V8GraphLayer, LlmBatchConfig> = {
    micro: { maxUnits: 8, maxChars: 2600, maxEvidenceSpans: 24 },
    meso: { maxUnits: 4, maxChars: 4200, maxEvidenceSpans: 18 },
    macro: { maxUnits: 2, maxChars: 6000, maxEvidenceSpans: 12 },
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

const LAYER_OBJECTIVE_LINES: Record<V8GraphLayer, string[]> = {
    micro: [
        "Extract only local, directly stated memory facts.",
        "Prefer concrete entity-action-object, attribute, comparison, condition, support, contradiction, or explicit user control signals.",
        "Do not abstract across multiple turns here.",
    ],
    meso: [
        "Extract mid-range structure from a coherent local block.",
        "Prefer decisions, goals, constraints, strategy shifts, problem/solution framing, evidence-backed state changes, and interaction structure.",
        "Do not repeat every micro fact; compress to the block-level relation that matters for later recall.",
    ],
    macro: [
        "Extract only long-range, high-value lines that survive compression.",
        "Prefer phase shifts, enduring regimes, relationship arcs, method lines, objective lines, conflict lines, and global state transitions.",
        "Do not emit local details unless they clearly define the arc or regime.",
    ],
};

const LAYER_AVOID_LINES: Record<V8GraphLayer, string[]> = {
    micro: [
        "Avoid greetings, retries, filler, acknowledgements, and tool noise unless they explicitly change memory state.",
        "Avoid splitting one short fact into multiple near-duplicate items.",
    ],
    meso: [
        "Avoid restating micro-level entity facts one by one.",
        "Avoid weak topic labels with no actionable relation or state change.",
    ],
    macro: [
        "Avoid local episodic details, one-off facts, and shallow restatements of meso items.",
        "Avoid emitting more than a few strongest lines for the batch.",
    ],
};

const LAYER_EXAMPLE_LINES: Record<V8GraphLayer, string[]> = {
    micro: [
        "Good micro example: a direct instruction changes a constraint, a sentence states A supports B, a line explicitly says X was replaced by Y.",
        "Bad micro example: \"hi\", \"继续\", or generic chatter with no durable fact.",
    ],
    meso: [
        "Good meso example: a block establishes a design decision, reframes a problem, or records that a previous approach was replaced.",
        "Bad meso example: listing every noun or every repeated sentence from the block.",
    ],
    macro: [
        "Good macro example: a thread evolves from early preference to later rejection, or a project phase shifts from exploration to implementation.",
        "Bad macro example: replaying one local turn or emitting a vague theme with no evidence-backed transition.",
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
    options?: BuildLlmIrJobOptions
): V8IrLlmJob[] {
    const evidenceIndex = buildEvidenceIndex(units, evidenceSpans);
    const requestedLayers =
        options?.layers && options.layers.length > 0
            ? options.layers
            : evidenceIndex.layerOrder;
    const enabledLayers = requestedLayers.filter((layer) =>
        evidenceIndex.layerOrder.includes(layer)
    );

    const jobs: V8IrLlmJob[] = [];
    for (const layer of enabledLayers) {
        const layerUnits = (evidenceIndex.unitsByLayer.get(layer) || []).filter((unit) =>
            unit.text.trim().length > 0
        );
        const batchConfig = BATCH_CONFIG_BY_LAYER[layer];
        const batches = buildLayerBatches(layer, layerUnits, batchConfig);
        for (const batch of batches) {
            const spansByUnit = new Map<string, V8EvidenceSpan[]>();
            for (const unit of batch) {
                spansByUnit.set(unit.id, evidenceIndex.spansByUnit.get(unit.id) || []);
            }
            const perUnitLimit = Math.max(
                1,
                Math.floor(batchConfig.maxEvidenceSpans / Math.max(1, batch.length))
            );
            const supportSpans = batch
                .flatMap((unit) =>
                    (spansByUnit.get(unit.id) || []).slice(0, perUnitLimit)
                )
                .sort((a, b) => b.score - a.score);
            const dedupedSpans = dedupeSpans(supportSpans).slice(0, batchConfig.maxEvidenceSpans);
            const prompt = buildPrompt({
                layer,
                units: batch,
                spansByUnit: new Map(
                    batch.map((unit) => [unit.id, (spansByUnit.get(unit.id) || []).slice(0, 8)])
                ),
            });
            jobs.push({
                jobId: `job_${layer}_${batch[0].id}_${batch[batch.length - 1].id}`,
                unitId: batch[0].id,
                unitIds: batch.map((unit) => unit.id),
                layer,
                narrativeRecordId: batch[0].narrativeRecordId,
                narrativeRecordIds: Array.from(new Set(batch.map((unit) => unit.narrativeRecordId))),
                sourceRef: batch[0].narrativeRef,
                sourceRefs: Array.from(new Set(batch.map((unit) => unit.narrativeRef))),
                speaker: batch[0].speaker ?? null,
                language: batch[0].language,
                text: batch.map((unit) => unit.text.trim()).filter(Boolean).join("\n\n"),
                evidenceSpanIds: dedupedSpans.map((span) => span.id),
                prompt,
            });
        }
    }

    return jobs;
}

function buildLayerBatches(
    layer: V8GraphLayer,
    units: V8Unit[],
    config: LlmBatchConfig
): V8Unit[][] {
    if (units.length === 0) return [];
    if (layer === "micro") {
        return buildSequentialBatches(units, config);
    }
    return buildOverlappingBatches(units, config, layer === "macro" ? 2 : 1);
}

function buildSequentialBatches(units: V8Unit[], config: LlmBatchConfig): V8Unit[][] {
    const batches: V8Unit[][] = [];
    let batch: V8Unit[] = [];
    let batchChars = 0;
    const flush = () => {
        if (batch.length === 0) return;
        batches.push(batch);
        batch = [];
        batchChars = 0;
    };
    for (const unit of units) {
        const unitChars = unit.text.trim().length;
        const wouldOverflow =
            batch.length > 0 &&
            (batch.length >= config.maxUnits || batchChars + unitChars > config.maxChars);
        if (wouldOverflow) flush();
        batch.push(unit);
        batchChars += unitChars;
    }
    flush();
    return batches;
}

function buildOverlappingBatches(
    units: V8Unit[],
    config: LlmBatchConfig,
    overlapUnits: number
): V8Unit[][] {
    const batches: V8Unit[][] = [];
    const groups = groupUnitsByNarrative(units);
    const stride = Math.max(1, config.maxUnits - overlapUnits);
    for (const group of groups) {
        if (group.length <= config.maxUnits) {
            batches.push(trimBatchByChars(group, config.maxChars));
            continue;
        }
        for (let start = 0; start < group.length; start += stride) {
            const window = trimBatchByChars(
                group.slice(start, start + config.maxUnits),
                config.maxChars
            );
            if (window.length === 0) break;
            batches.push(window);
            if (start + config.maxUnits >= group.length) break;
        }
    }
    return dedupeBatchWindows(batches);
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

function trimBatchByChars(units: V8Unit[], maxChars: number): V8Unit[] {
    if (units.length === 0) return [];
    const output: V8Unit[] = [];
    let chars = 0;
    for (const unit of units) {
        const len = unit.text.trim().length;
        if (output.length > 0 && chars + len > maxChars) break;
        output.push(unit);
        chars += len;
    }
    return output;
}

function dedupeBatchWindows(batches: V8Unit[][]): V8Unit[][] {
    const seen = new Set<string>();
    const output: V8Unit[][] = [];
    for (const batch of batches) {
        if (batch.length === 0) continue;
        const key = batch.map((unit) => unit.id).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(batch);
    }
    return output;
}

interface EvidenceIndex {
    spansByUnit: Map<string, V8EvidenceSpan[]>;
    unitsByLayer: Map<V8GraphLayer, V8Unit[]>;
    layerOrder: V8GraphLayer[];
}

function buildEvidenceIndex(
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[]
): EvidenceIndex {
    const spansByNarrative = new Map<string, V8EvidenceSpan[]>();
    for (const span of evidenceSpans) {
        const list = spansByNarrative.get(span.narrativeRecordId) || [];
        list.push(span);
        spansByNarrative.set(span.narrativeRecordId, list);
    }
    for (const list of spansByNarrative.values()) {
        list.sort((a, b) => a.charStart - b.charStart);
    }

    const spansByUnit = new Map<string, V8EvidenceSpan[]>();
    const unitsByLayer = new Map<V8GraphLayer, V8Unit[]>();
    for (const unit of units) {
        const layerBucket = unitsByLayer.get(unit.layer) || [];
        layerBucket.push(unit);
        unitsByLayer.set(unit.layer, layerBucket);
        spansByUnit.set(unit.id, collectSupportingSpans(unit, spansByNarrative));
    }

    return {
        spansByUnit,
        unitsByLayer,
        layerOrder: ["macro", "meso", "micro"],
    };
}

function collectSupportingSpans(
    unit: V8Unit,
    spansByNarrative: Map<string, V8EvidenceSpan[]>
): V8EvidenceSpan[] {
    const spans = spansByNarrative.get(unit.narrativeRecordId) || [];
    if (spans.length === 0) return [];
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (spans[mid].charStart < unit.charStart) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    const collected: V8EvidenceSpan[] = [];
    for (let idx = lo; idx < spans.length; idx += 1) {
        const span = spans[idx];
        if (span.charStart >= unit.charEnd) break;
        if (span.charStart >= unit.charStart && span.charEnd <= unit.charEnd) {
            collected.push(span);
        }
    }
    return collected;
}

function dedupeSpans(spans: V8EvidenceSpan[]): V8EvidenceSpan[] {
    const seen = new Set<string>();
    const output: V8EvidenceSpan[] = [];
    for (const span of spans) {
        if (seen.has(span.id)) continue;
        seen.add(span.id);
        output.push(span);
    }
    return output;
}

export function writeIrLlmJobs(filePath: string, jobs: V8IrLlmJob[]): void {
    writeJsonl(filePath, jobs);
}

export function loadLlmIrItems(
    input: { mdPath?: string; jsonlPath?: string },
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[]
): V8MemoryItem[] {
    const mdPath = input.mdPath;
    const jsonlPath = input.jsonlPath;
    const fromMd =
        mdPath && mdPath.trim().length > 0
            ? parseMarkdownFile(mdPath, units, evidenceSpans)
            : [];
    if (fromMd.length > 0) {
        const pruned = pruneLlmItems(fromMd);
        if (jsonlPath) {
            writeJsonl(jsonlPath, pruned);
        }
        return pruned;
    }
    if (!jsonlPath) return [];
    const raw = readJsonl<any>(jsonlPath);
    if (raw.length === 0) return [];
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const spansByUnit = new Map<string, V8EvidenceSpan[]>();
    for (const span of evidenceSpans) {
        const list = spansByUnit.get(span.unitId) || [];
        list.push(span);
        spansByUnit.set(span.unitId, list);
    }
    const items: V8MemoryItem[] = [];
    for (const entry of raw) {
        const item = normalizeLlmItem(entry, unitsById, spansByUnit);
        if (item) {
            items.push(item);
        }
    }
    return pruneLlmItems(items);
}

function parseMarkdownFile(
    filePath: string,
    units: V8Unit[],
    evidenceSpans: V8EvidenceSpan[]
): V8MemoryItem[] {
    try {
        const raw = readFileTrimmed(filePath);
        if (!raw) return [];
        const blocks = splitMarkdownItems(raw);
        if (blocks.length === 0) return [];
        const unitsById = new Map(units.map((u) => [u.id, u]));
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
            const item = normalizeLlmItem(rawItem, unitsById, spansByUnit);
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
    spansByUnit: Map<string, V8EvidenceSpan[]>
): V8MemoryItem | null {
    if (!raw || typeof raw !== "object") return null;
    const unitId =
        typeof raw.unitId === "string"
            ? raw.unitId
            : typeof raw.unit_id === "string"
              ? raw.unit_id
              : Array.isArray(raw.unit_ids) && typeof raw.unit_ids[0] === "string"
                ? raw.unit_ids[0]
              : "";
    if (!unitId) return null;
    const unit = unitsById.get(unitId);
    if (!unit) return null;
    const itemType =
        (typeof raw.itemType === "string" && raw.itemType) ||
        (typeof raw.item_type === "string" && raw.item_type) ||
        "";
    if (!itemType) return null;
    const normalizedItemType = itemType.trim().toLowerCase() as V8MemoryItemType;
    const allowedItemTypes = new Set(ITEM_TYPES_BY_LAYER[unit.layer] || []);
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
    const normalizedPredicate = predicate.trim().toLowerCase();
    if (!normalizedPredicate) return null;

    if (!CONTROL_ITEM_TYPES.has(normalizedItemType)) {
        const allowed = ALLOWED_PREDICATES[unit.layer] || new Set();
        if (!allowed.has(normalizedPredicate)) return null;
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
    const unitSpanIds = new Set((spansByUnit.get(unitId) || []).map((span) => span.id));
    const explicitEvidence = Array.isArray(rawEvidence);
    const evidenceSpanIds = explicitEvidence
        ? rawEvidence.filter(
              (id: any) => typeof id === "string" && id && unitSpanIds.has(id)
          )
        : [];
    if (explicitEvidence && evidenceSpanIds.length === 0) {
        return null;
    }
    if (!explicitEvidence && evidenceSpanIds.length === 0) {
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
        narrativeRecordId: unit.narrativeRecordId,
        sourceRef: unit.narrativeRef,
        itemType: normalizedItemType,
        originType:
            (typeof raw.originType === "string" && raw.originType) ||
            (typeof raw.origin_type === "string" && raw.origin_type) ||
            "asserted",
        layer: unit.layer,
        subject,
        predicate: normalizedPredicate,
        object,
        label:
            (typeof raw.label === "string" && raw.label) ||
            truncateLabel(`${subject} ${normalizedPredicate} ${object}`),
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
    layer: V8GraphLayer;
    units: V8Unit[];
    spansByUnit: Map<string, V8EvidenceSpan[]>;
}): string {
    const { layer, units, spansByUnit } = input;
    const allowed = Array.from(ALLOWED_PREDICATES[layer] || []).sort();
    const groupMap = ALLOWED_GROUPS[layer];
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
        ? `Allowed relations (${layer}): ${allowed.join(", ")}`
        : "";
    const itemTypeLine = ITEM_TYPES_BY_LAYER[layer]?.length
        ? `Allowed item_type (${layer}): ${ITEM_TYPES_BY_LAYER[layer].join(", ")}`
        : "";
    const layerBudgetHint =
        layer === "macro"
            ? "Extraction budget: usually 1-3 high-value relations per unit. Skip weak ones."
            : layer === "meso"
              ? "Extraction budget: usually 1-6 relations per unit. Do not force coverage."
              : "Extraction budget: keep local object/fact relations only.";
    const suggestedBatchBudget =
        layer === "macro"
            ? `Suggested total items for this batch: 2-${Math.min(10, units.length * 3)}`
            : layer === "meso"
              ? `Suggested total items for this batch: 4-${Math.min(24, units.length * 6)}`
              : `Suggested total items for this batch: ${Math.min(80, units.length * 18)} max`;
    const hardBatchCap =
        layer === "macro"
            ? Math.min(8, units.length * 3)
            : layer === "meso"
              ? Math.min(16, units.length * 5)
              : Math.min(48, units.length * 12);
    const layerObjectives = LAYER_OBJECTIVE_LINES[layer] || [];
    const layerAvoid = LAYER_AVOID_LINES[layer] || [];
    const layerExamples = LAYER_EXAMPLE_LINES[layer] || [];
    const unitBlocks = units.flatMap((unit) => {
        const evidenceLines = (spansByUnit.get(unit.id) || []).map(
            (span) => `- (${span.id}) ${sanitizeLine(span.text)}`
        );
        return [
            `#### Unit ${unit.id}`,
            `speaker: ${unit.speaker ?? "unknown"}`,
            `timestamp: ${unit.timestamp ?? "unknown"}`,
            `source_category: ${unit.sourceCategory || "conversation"}`,
            unit.text.trim(),
            evidenceLines.length ? "evidence_spans:" : null,
            ...evidenceLines,
            "",
        ].filter(Boolean);
    });
    return [
        "Please extract only evidence-backed relations from the batched units below.",
        "If nothing can be extracted, output `[]` only.",
        "",
        "Primary objective:",
        "- Capture high-value memory facts for future recall: decisions, constraints, goals, preference shifts, state changes, and stable entity relations.",
        "- Avoid noisy restatements and avoid splitting one fact into many near-duplicate items.",
        ...layerObjectives.map((line) => `- ${line}`),
        "",
        "Avoid:",
        ...layerAvoid.map((line) => `- ${line}`),
        "",
        "Examples:",
        ...layerExamples.map((line) => `- ${line}`),
        "",
        "Rules:",
        "- Use only the relations listed under Allowed relations (by group).",
        "- Do not infer beyond the text; skip vague or speculative claims.",
        "- Precision over coverage: if uncertain, skip.",
        "- If the unit is mostly greeting/retry/noise and has no durable fact, output no item for it.",
        `- Hard cap: output at most ${hardBatchCap} items for this batch.`,
        "- `evidence_span_ids` must come from the provided evidence spans.",
        "- `unit_id` must be one of the listed Unit IDs.",
        "- Output Markdown only. No JSON. No extra commentary.",
        "",
        "Output format:",
        "### Item",
        "item_type: <type>",
        "subject: <text>",
        "predicate: <relation>",
        "object: <text>",
        "qualifiers: key=value; key=value (leave blank if none)",
        "origin_type: asserted|aggregated|inferred",
        "evidence_span_ids: es_xxx, es_yyy",
        "unit_id: <unit_id>",
        "confidence: 0.0-1.0",
        "",
        "One relation per `### Item` block.",
        "If none, output: `[]`",
        "",
        "Optional control types (only if explicitly stated):",
        "- item_type: preference, goal, constraint, decision, open_question, conversation_act, session_state, topic_state",
        "- predicate: prefers, requires, targets, decides, acts",
        "",
        allowedLine,
        itemTypeLine,
        layerBudgetHint,
        suggestedBatchBudget,
        ...groupedLines,
        "",
        "### Batch",
        `Layer: ${layer}`,
        `Unit IDs: ${units.map((unit) => unit.id).join(", ")}`,
        "",
        ...unitBlocks,
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
            case "unit_ids": {
                item[key] = value
                    .split(/[,，\s]+/)
                    .map((id) => id.trim())
                    .filter(Boolean);
                break;
            }
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

function pruneLlmItems(items: V8MemoryItem[]): V8MemoryItem[] {
    if (items.length <= 1) return items;
    const sorted = items
        .slice()
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

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
