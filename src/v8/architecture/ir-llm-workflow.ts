import type { V8AnnotationValidityResult, V8GraphLayer, V8MemoryItem, V8PendingIr } from "../types_v8.js";

const UNRESOLVED_REFERENCE_PATTERNS: RegExp[] = [
    /^["']?(that|this|it|they|them|there|these|those)["']?$/i,
    /^["']?(something|someone|somewhere|some place|some places|stuff|thing|things)["']?$/i,
];

const RELATION_FAMILIES_BY_LAYER: Record<V8GraphLayer, Set<string>> = {
    micro: new Set(["identity", "participation", "event", "causality", "temporal", "comparison", "support", "discourse"]),
    meso: new Set(["anchoring", "dynamics", "transformation", "organization"]),
    macro: new Set(["structure", "evolution", "global_condition", "interaction"]),
};

export interface V8IrPromptUnit {
    id: string;
    narrativeRecordId: string;
    narrativeRef: string;
    ordinal: number;
    charStart: number;
    charEnd: number;
    text: string;
    role: string | null;
    timestamp: string | null;
}

const IR_MEANING_BY_LAYER: Record<
    V8GraphLayer,
    {
        boundary: string[];
        types: Array<{ family: string; entries: string[] }>;
        relations: Array<{ family: string; entries: string[] }>;
    }
> = {
    micro: {
        boundary: [
            "Work at the smallest directly grounded scale visible in the text.",
            "Record each grounded local object, event, attribute, claim, evidence cue, context cue, or discourse cue that fits this layer.",
        ],
        types: [
            {
                family: "object",
                entries: [
                    "entity: stable object such as a person, place, organization, system, file, or thing.",
                    "concept: abstract term, topic, or category named in the text.",
                    "method: method, tactic, procedure fragment, or way of doing something.",
                ],
            },
            {
                family: "event",
                entries: [
                    "event: a concrete happening, action, or change.",
                    "attribute: a property, state, configuration, or descriptive feature.",
                    "metric: a number, score, quantity, or measurable value.",
                ],
            },
            {
                family: "proposition",
                entries: [
                    "claim: a proposition, judgment, conclusion, or evaluation.",
                ],
            },
            {
                family: "support",
                entries: [
                    "evidence: evidence, citation, source, material, or supporting item.",
                    "context: condition, background, environment, scope, or prerequisite.",
                ],
            },
            {
                family: "discourse",
                entries: [
                    "discourse_unit: a local discourse role such as definition, explanation, summary, or recommendation.",
                ],
            },
        ],
        relations: [
            {
                family: "identity",
                entries: [
                    "is_a, instance_of, part_of, has_part, belongs_to, equivalent_to: use when the text states identity, type, composition, belonging, or equivalence.",
                ],
            },
            {
                family: "participation",
                entries: [
                    "performs, acts_on, uses, produces, targets: use when the text states who does what, acts on what, uses what, produces what, or aims at what.",
                ],
            },
            {
                family: "event",
                entries: [
                    "initiates, involves, occurs_at, results_in_event: use when the text states event start, participants, location/time anchoring, or a resulting event.",
                ],
            },
            {
                family: "causality",
                entries: [
                    "causes, caused_by, enables, prevents, requires, conditioned_on: use when the text states cause, dependency, enabling, blocking, or a condition.",
                ],
            },
            {
                family: "temporal",
                entries: [
                    "before, after, simultaneous_with, evolves_to: use when the text states ordering, simultaneity, or evolution.",
                ],
            },
            {
                family: "comparison",
                entries: [
                    "better_than, worse_than, similar_to, differs_from: use when the text states comparison, similarity, or difference.",
                ],
            },
            {
                family: "support",
                entries: [
                    "supports, contradicts, cites: use when the text states support, contradiction, or citation.",
                ],
            },
            {
                family: "discourse",
                entries: [
                    "elaborates, summarizes, contrasts, explains, concludes, recommends: use when the text states explanation, summary, contrast, conclusion, or recommendation.",
                ],
            },
        ],
    },
    meso: {
        boundary: [
            "Work at the local block scale.",
            "Record each grounded scene, objective block, problem block, procedure block, interaction block, shift, or outcome supported by the visible text.",
        ],
        types: [
            {
                family: "scene",
                entries: [
                    "scene_block: a locally complete scene or semantic block.",
                    "situation_frame: the local setting, background, or starting situation of the block.",
                ],
            },
            {
                family: "objective",
                entries: [
                    "objective_block: a local goal block.",
                    "problem_block: a local obstacle, conflict, or problem block.",
                ],
            },
            {
                family: "method",
                entries: [
                    "strategy_block: a local strategy or response direction.",
                    "procedure_block: a local ordered step chain or workflow block.",
                ],
            },
            {
                family: "interaction",
                entries: [
                    "interaction_block: a local interaction or exchange block.",
                    "decision_block: a local decision, commitment, or choice block.",
                ],
            },
            {
                family: "support",
                entries: [
                    "evidence_frame: a local evidence cluster supporting a block.",
                ],
            },
            {
                family: "transition",
                entries: [
                    "shift_block: a local turn, switch, or pivot.",
                    "outcome_block: a local result or response block.",
                    "block_function: the role a block plays inside a larger local structure.",
                ],
            },
        ],
        relations: [
            {
                family: "anchoring",
                entries: [
                    "grounded_in, oriented_to, focuses_on, realized_by, evidenced_by_block, functions_as: use when the text anchors a local block in its frame, support, realization, or function.",
                ],
            },
            {
                family: "dynamics",
                entries: [
                    "triggered_by, responds_to, constrained_by, attempts_to_resolve, escalates, mitigates, reframes, revises: use when the text states how a local block reacts to or changes a local issue.",
                ],
            },
            {
                family: "transformation",
                entries: [
                    "culminates_in, leads_to, produces_shift, stabilizes, destabilizes, opens, closes: use when the text states result, turn, opening, closure, stabilization, or destabilization.",
                ],
            },
            {
                family: "organization",
                entries: [
                    "precedes_block, branches_to, merges_into, parallels, contrasts_with_block, echoes, sets_up, mirrors_locally: use when the text states how local blocks are ordered, branched, mirrored, or contrasted.",
                ],
            },
        ],
    },
    macro: {
        boundary: [
            "Work at the cross-block structural scale.",
            "Record each grounded thread, phase, arc, regime, line, pattern, turning point, or global state supported by the visible text.",
        ],
        types: [
            {
                family: "structure",
                entries: [
                    "arc: a long-running development arc.",
                    "thread: a recurring issue line, object line, or continuing strand.",
                    "phase: a bounded stage inside a larger development.",
                    "global_scene_type: a higher-order global scene pattern.",
                    "regime: a global environment, version regime, or operating paradigm.",
                ],
            },
            {
                family: "line",
                entries: [
                    "objective_line: a long-running goal line.",
                    "conflict_line: a long-running conflict or tension line.",
                    "relationship_arc: a long-running relationship evolution line.",
                    "method_line: a long-running method or capability evolution line.",
                ],
            },
            {
                family: "theme",
                entries: [
                    "theme: a recurring high-level theme or motif.",
                    "pattern: a recurring structural or behavioral pattern.",
                    "turning_point: a major inflection point or irreversible pivot.",
                    "global_state: a broad, persistent overall state.",
                ],
            },
        ],
        relations: [
            {
                family: "structure",
                entries: [
                    "unfolds_through, spans_phase, organized_as, governed_by, centered_on_line, dominated_by: use when the text states how a long-running structure is staged or governed.",
                ],
            },
            {
                family: "evolution",
                entries: [
                    "transitions_to_phase, evolves_to, branches_into, converges_with, interrupted_by, resumes_after, culminates_at, resolved_by: use when the text states phase change, branching, interruption, recovery, climax, or resolution.",
                ],
            },
            {
                family: "global_condition",
                entries: [
                    "produces_state, shifts_regime, stabilizes_state, destabilizes_state, constrains, enables: use when the text states how a long-running structure reshapes overall conditions or constraints.",
                ],
            },
            {
                family: "interaction",
                entries: [
                    "competes_with, reinforces, undermines, mirrors, recurs_as, foreshadows, pays_off, recontextualizes, opens_arc, closes_arc: use when the text states interaction, recurrence, foreshadowing, payoff, or opening/closing across long-running structures.",
                ],
            },
        ],
    },
};

const EXPRESSION_STYLE_BY_LAYER: Record<V8GraphLayer, string[]> = {
    micro: [
        "Keep point_a and point_b close to the evidence wording.",
        "Preserve local distinctions instead of paraphrasing them into a broader abstraction.",
    ],
    meso: [
        "Keep distinct grounded meanings visible instead of collapsing them into one theme label.",
    ],
    macro: [
        "Name a higher-order structure only when the visible turns support it explicitly.",
    ],
};

const FIELD_GUIDE_BY_LAYER: Record<
    V8GraphLayer,
    {
        pointA: string;
        relation: string;
        pointB: string;
    }
> = {
    micro: {
        pointA:
            "fill one grounded semantic side of the relation using content that fits this layer and the Types section.",
        relation:
            "fill a short grounded relation phrase from the evidence span, interpreted with the Relation Families section.",
        pointB:
            "fill the other grounded semantic side that stands in relation to point_a using content that fits this layer and the Types section.",
    },
    meso: {
        pointA:
            "fill one grounded semantic side of the relation using content that fits this layer and the Types section. When the grounded structure has only one explicit side, point_a may be the only filled side, but point_a and point_b must not both be blank.",
        relation:
            "fill a short grounded relation phrase from the evidence span, interpreted with the Relation Families section.",
        pointB:
            "fill the other grounded semantic side that stands in relation to point_a using content that fits this layer and the Types section. Leave point_b blank when the grounded structure does not require a second explicit side, but point_a and point_b must not both be blank.",
    },
    macro: {
        pointA:
            "fill one grounded semantic side of the relation using content that fits this layer and the Types section. When the grounded structure has only one explicit side, point_a may be the only filled side, but point_a and point_b must not both be blank.",
        relation:
            "fill a short grounded relation phrase from the evidence span, interpreted with the Relation Families section.",
        pointB:
            "fill the other grounded semantic side that stands in relation to point_a using content that fits this layer and the Types section. Leave point_b blank when the grounded structure does not require a second explicit side, but point_a and point_b must not both be blank.",
    },
};

const PENDING_RULES_BY_LAYER: Record<V8GraphLayer, string[]> = {
    micro: [
        "**Write Pending only for unfinished local objects, events, conditions, dependencies, comparisons, or states that are visible in the current window.**",
        "Treat it as unfinished when point_a, relation, or point_b is only partly expressed, or when one side is present but the local relation is not yet grounded.",
        "Pending records the start of that unfinished local meaning. Use evidence_start_turn and evidence_start_anchor to mark where it becomes active.",
        "**Write the unfinished meaning in the local wording and scope already visible in the text, and do not leave point_a, relation, and point_b all blank.**",
        "Keep earlier resolved content as Completed Item(s); when a later window resolves the pending line, convert it to Completed Item(s) and stop carrying it forward.",
    ],
    meso: [
        "**Write Pending only for unfinished scenes, objective blocks, problem blocks, strategy blocks, procedure blocks, interaction blocks, decision blocks, shifts, or outcomes that are visible in the current window.**",
        "Treat it as unfinished when the block is opened here but not yet locally completed in the visible text.",
        "Pending records the start of that unfinished block-level meaning. Use evidence_start_turn and evidence_start_anchor to mark where it becomes active.",
        "**Write the unfinished meaning in the block wording and scope already visible in the text, and do not leave point_a, relation, and point_b all blank.**",
        "Keep earlier resolved content as Completed Item(s); when a later window resolves the pending line, convert it to Completed Item(s) and stop carrying it forward.",
    ],
    macro: [
        "**Write Pending only for unfinished threads, phases, arcs, regimes, lines, patterns, turning points, or global states that are visible in the current window.**",
        "Treat it as unfinished when the visible text has opened a larger structural development but has not yet completed it.",
        "Pending records the start of that unfinished structural meaning. Use evidence_start_turn and evidence_start_anchor to mark where it becomes active.",
        "**Write the unfinished meaning in the structural wording and scope already visible in the text, and do not leave point_a, relation, and point_b all blank.**",
        "Keep earlier resolved content as Completed Item(s); when a later window resolves the pending line, convert it to Completed Item(s) and stop carrying it forward.",
    ],
};

function normalizeRoleLabel(role: string | null | undefined): string {
    return String(role || "").trim();
}

function stripLeadingPromptHeaders(text: string): string {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    while (lines.length > 0) {
        const current = lines[0]!.trim();
        if (!current) {
            lines.shift();
            continue;
        }
        if (/^###\s+.+$/.test(current)) {
            lines.shift();
            continue;
        }
        break;
    }
    return lines.join("\n").trim();
}

function rewriteEmbeddedTurnHeaders(text: string): string {
    return String(text || "")
        .replace(/^###\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+?):\s*$/gm, "### $2:")
        .replace(/^###\s+(.+?)\s+\([^)]*\)\s*$/gm, "### $1:")
        .replace(/^###\s+(.+?)\s*$/gm, (_match, role) => {
            const normalized = String(role || "").trim();
            if (!normalized) return "";
            return /^.+:\s*$/i.test(normalized) ? `### ${normalized}` : `### ${normalized}:`;
        });
}

export function formatPromptUnitBody(text: string, role?: string | null): string {
    const body = stripLeadingPromptHeaders(rewriteEmbeddedTurnHeaders(String(text || "")));
    const explicitRole = normalizeRoleLabel(role);
    if (!explicitRole) {
        return body;
    }
    return `### ${explicitRole}:\n${body}`;
}

function formatEvidenceDescriptor(_narrativeRecordId: string, turnRefs: number[]): string {
    const ordered = Array.from(new Set(turnRefs)).sort((a, b) => a - b);
    if (ordered.length === 0) return "";
    if (ordered.length === 1) {
        return `turn ${ordered[0]}`;
    }
    return `turns ${ordered[0]}-${ordered[ordered.length - 1]}`;
}
function formatPromptTimestamp(timestamp: string | null | undefined): string | null {
    const raw = String(timestamp || "").trim();
    if (!raw) return null;
    const normalized = raw.replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "");
    return normalized.slice(0, 16);
}

function formatNarrativePromptBlock(unit: V8IrPromptUnit): string {
    const body = stripLeadingPromptHeaders(rewriteEmbeddedTurnHeaders(String(unit.text || "")));
    const timestamp = formatPromptTimestamp(unit.timestamp);
    const role = normalizeRoleLabel(unit.role);
    const headerParts = [timestamp, role].filter(Boolean);
    const header = headerParts.length > 0
        ? `### turn ${unit.ordinal} ${headerParts.join(" ")}:`
        : `### turn ${unit.ordinal}:`;
    return [header, body].filter(Boolean).join("\n");
}

export function buildExtractPrompt(input: {
    layer: V8GraphLayer;
    workingUnits: V8IrPromptUnit[];
    pendingItems: V8PendingIr[];
    targetUnitIds: string[];
}): string {
    const { layer, workingUnits, pendingItems } = input;
    const unitBlocks = workingUnits.flatMap((unit) => [
        formatNarrativePromptBlock(unit),
        "",
    ]);
    const pendingBlocks =
        pendingItems.length > 0
            ? pendingItems.flatMap((item) => {
                  const startTurn = item.turnRefs.length > 0 ? Math.min(...item.turnRefs) : null;
                  const explicitStartTurn = Number.isFinite((item as any).startTurn) ? Number((item as any).startTurn) : startTurn;
                  const startAnchor = (item as any).startAnchor;
                  return [
                      "### Pending Item",
                      `status: ${item.status}`,
                      `tension_role: ${item.tensionRole}`,
                      item.subject ? `point_a: ${item.subject}` : null,
                      item.predicate ? `relation: ${item.predicate}` : null,
                      item.relationFamily ? `relation_family: ${item.relationFamily}` : null,
                      item.object ? `point_b: ${item.object}` : null,
                      Number.isFinite(explicitStartTurn) ? `evidence_start_turn: ${explicitStartTurn}` : null,
                      startAnchor ? `evidence_start_anchor: ${startAnchor}` : null,
                      "",
                  ].filter(Boolean);
              })
            : ["_none_", ""];

    const layerMeaning = IR_MEANING_BY_LAYER[layer];
    const boundaryLines = layerMeaning.boundary.flatMap((line) => [`- ${line}`]);
    const expressionLines = EXPRESSION_STYLE_BY_LAYER[layer].flatMap((line) => [`- ${line}`]);
    const fieldGuide = FIELD_GUIDE_BY_LAYER[layer];
    const pendingRuleLines = PENDING_RULES_BY_LAYER[layer].map((line) => `- ${line}`);
    const relationFamilyNames = layerMeaning.relations.map((group) => group.family).join(", ");
    const typeLines = layerMeaning.types.flatMap((group) =>
        group.entries.map((entry) => `- ${entry}`)
    );
    const relationLines = layerMeaning.relations.flatMap((group) => [
        `#### ${group.family}`,
        ...group.entries.map((entry) => `- ${entry}`),
        "",
    ]);
    return [
        "# Extraction Task",
        "",
        "## Objective",
        "Extract IR from the current narrative window.",
        "",
        "## Layer Boundary",
        ...boundaryLines,
        "",
        "## IR Meaning",
        "IR is a compact semantic record grounded in the cited narrative turns.",
        "Completed Item records content whose meaning is already complete inside this window.",
        "Pending Item carries an unfinished tail whose meaning still depends on the next window.",
        "Each window header begins with `turn N`; treat each such header as one turn.",
        "Use evidence as anchored boundaries: specify the start turn, end turn, and exact short boundary snippets.",
        "Use the Types section below to interpret what kinds of semantic content belong in point_a and point_b.",
        "",
        "## Field Guide",
        `- point_a: ${fieldGuide.pointA} Resolve local pronouns or demonstratives into the explicit local referent whenever the visible turns make it clear.`,
        `- relation: ${fieldGuide.relation}`,
        `- relation_family: fill exactly one family heading name from the Relation Families section below. Valid outputs are: ${relationFamilyNames}. Do not copy an example relation token from the examples below into this field.`,
        `- point_b: ${fieldGuide.pointB} Resolve local pronouns or demonstratives into the explicit local referent whenever the visible turns make it clear.`,
        "- evidence_start_turn / evidence_end_turn: mark which turn or turn range supports a Completed Item.",
        "- evidence_start_anchor / evidence_end_anchor: mark the exact local boundary snippets inside that Completed span.",
        "- Record each grounded item supported by the evidence and fill the fields that the grounded structure requires at this layer.",
        "",
        "## Expression Style",
        ...expressionLines,
        "",
        "## Pending Rules",
        ...pendingRuleLines,
        "",
        "### Types",
        ...typeLines,
        "",
        "### Relation Families",
        ...relationLines,
        "",
        "## Prior Pending IR",
        ...pendingBlocks,
        "## Window",
        ...unitBlocks.flat(),
        "## Output Format",
        "### Completed Item",
        layer === "micro"
            ? "point_a: <grounded expression>"
            : "point_a: <grounded expression or blank>",
        "relation: <short relation phrase close to the evidence wording>",
        "relation_family: <one listed relation family>",
        layer === "micro"
            ? "point_b: <grounded expression>"
            : "point_b: <grounded expression or blank>",
        "origin_type: asserted|aggregated|inferred",
        "evidence_start_turn: <number>",
        "evidence_end_turn: <number>",
        "evidence_start_anchor: <exact short snippet at evidence start>",
        "evidence_end_anchor: <exact short snippet at evidence end>",
        "",
        "### Pending Item",
        "tension_role: open|advance|state|none",
        layer === "micro"
            ? "point_a: <grounded continuation expression>"
            : "point_a: <grounded continuation expression or blank>",
        "relation: <short relation phrase close to the evidence wording or blank>",
        "relation_family: <one listed relation family or blank>",
        layer === "micro"
            ? "point_b: <grounded continuation expression>"
            : "point_b: <grounded continuation expression or blank>",
        "evidence_start_turn: <number>",
        "evidence_start_anchor: <exact short snippet at unresolved start or blank>",
        "status: pending",
        "",
        "Output Markdown only.",
    ].join("\n");
}

function hasUnresolvedCoreReference(value: string): boolean {
    const trimmed = (value || "").trim();
    if (!trimmed) return true;
    return UNRESOLVED_REFERENCE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function validateAnnotatedItem(
    item: V8MemoryItem,
    allowedUnitIds: Set<string>,
    allowedEvidenceSpanIds: Set<string>
): V8AnnotationValidityResult {
    if (!item.unitIds.length || item.unitIds.some((id) => !allowedUnitIds.has(id))) {
        return { ok: false, reason: "out_of_scope_target" };
    }
    if (
        !item.evidenceSpanIds.length ||
        item.evidenceSpanIds.some((id) => !allowedEvidenceSpanIds.has(id))
    ) {
        return { ok: false, reason: "invalid_anchor" };
    }
    const requireBothSides = item.layer === "micro";
    if (requireBothSides && (!String(item.subject || "").trim() || !String(item.object || "").trim())) {
        return { ok: false, reason: "unresolved_reference" };
    }
    const subjectInvalid = String(item.subject || "").trim()
        ? hasUnresolvedCoreReference(item.subject)
        : false;
    const objectInvalid = String(item.object || "").trim()
        ? hasUnresolvedCoreReference(item.object)
        : false;
    if (subjectInvalid || objectInvalid) {
        return { ok: false, reason: "unresolved_reference" };
    }
    const relationFamily = String(item.qualifiers?.relation_family || "").trim().toLowerCase();
    if (relationFamily) {
        const allowedFamilies = RELATION_FAMILIES_BY_LAYER[item.layer];
        if (allowedFamilies && !allowedFamilies.has(relationFamily)) {
            return { ok: false, reason: "invalid_relation_family" };
        }
    }
    return { ok: true };
}


