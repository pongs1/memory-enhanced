export interface DiagnosticIssue {
    code:
        | "empty_output"
        | "completed_missing_fields"
        | "pending_missing_fields"
        | "pending_invalid_evidence"
        | "unresolved_reference";
    detail: string;
}

export interface DiagnosticRecord {
    point_a?: string;
    relation?: string;
    point_b?: string;
    subject?: string;
    predicate?: string;
    object?: string;
    startAnchor?: string;
    endAnchor?: string;
    evidence_start_anchor?: string;
    evidence_end_anchor?: string;
    turnRefs?: number[];
    evidence_start_turn?: string | number;
    evidence_end_turn?: string | number;
    hasExplicitEndEvidence?: boolean;
}

const UNRESOLVED_REFERENCE_PATTERNS: RegExp[] = [
    /^["']?(that|this|it|they|them|there|these|those)["']?$/i,
    /^["']?(something|someone|somewhere|some place|some places|stuff|thing|things)["']?$/i,
];

function pickLeft(record: DiagnosticRecord): string {
    return String(record.point_a || record.subject || "").trim();
}

function pickRelation(record: DiagnosticRecord): string {
    return String(record.relation || record.predicate || "").trim();
}

function pickRight(record: DiagnosticRecord): string {
    return String(record.point_b || record.object || "").trim();
}

function hasUnresolvedReference(value: string): boolean {
    const trimmed = String(value || "").trim();
    if (!trimmed) return false;
    return UNRESOLVED_REFERENCE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function classifyRepairableExtractionFailure(input: {
    layer: string;
    completedRecords: DiagnosticRecord[];
    pendingRecords: DiagnosticRecord[];
}): DiagnosticIssue[] {
    const layer = String(input.layer || "").trim().toLowerCase();
    const issues: DiagnosticIssue[] = [];
    const completed = Array.isArray(input.completedRecords) ? input.completedRecords : [];
    const pending = Array.isArray(input.pendingRecords) ? input.pendingRecords : [];

    if (completed.length === 0 && pending.length === 0) {
        issues.push({ code: "empty_output", detail: "No Completed Item or Pending Item was produced." });
        return issues;
    }

    for (const record of completed) {
        const left = pickLeft(record);
        const rel = pickRelation(record);
        const right = pickRight(record);
        if (layer === "micro") {
            if (!left || !rel || !right) {
                issues.push({ code: "completed_missing_fields", detail: "A micro Completed Item is missing point_a, relation, or point_b." });
                break;
            }
        } else if (!rel || (!left && !right)) {
            issues.push({ code: "completed_missing_fields", detail: "A higher-layer Completed Item is missing relation or both semantic sides." });
            break;
        }
        if (hasUnresolvedReference(left) || hasUnresolvedReference(right)) {
            issues.push({ code: "unresolved_reference", detail: "A Completed Item still contains an unresolved demonstrative or placeholder reference." });
            break;
        }
    }

    for (const record of pending) {
        const left = pickLeft(record);
        const rel = pickRelation(record);
        const right = pickRight(record);
        if (!left && !rel && !right) {
            issues.push({ code: "pending_missing_fields", detail: "A Pending Item left point_a, relation, and point_b all blank." });
            continue;
        }
        const explicitEndTurn = String(record.evidence_end_turn ?? "").trim();
        const hasExplicitEndEvidence = Boolean(
            explicitEndTurn ||
            record.endAnchor ||
            record.evidence_end_anchor ||
            record.hasExplicitEndEvidence
        );
        if (hasExplicitEndEvidence) {
            issues.push({ code: "pending_invalid_evidence", detail: "A Pending Item includes end evidence even though Pending should only mark the unresolved start." });
        }
        const startAnchor = String(record.startAnchor || record.evidence_start_anchor || "").trim();
        const endAnchor = String(record.endAnchor || record.evidence_end_anchor || "").trim();
        const turnRefs = Array.isArray(record.turnRefs) ? record.turnRefs.filter((value) => Number.isFinite(Number(value))) : [];
        const startTurn = String(record.evidence_start_turn ?? "").trim();
        if (turnRefs.length === 0 && !startAnchor && !startTurn) {
            issues.push({ code: "pending_invalid_evidence", detail: "A Pending Item has no turnRefs and no evidence anchors." });
        }
        if (hasUnresolvedReference(left) || hasUnresolvedReference(right)) {
            issues.push({ code: "unresolved_reference", detail: "A Pending Item still contains an unresolved demonstrative or placeholder reference." });
        }
    }

    return issues;
}

export function buildDiagnosticRepairPrompt(input: {
    originalPrompt: string;
    previousOutput: string;
    issues: DiagnosticIssue[];
}): string {
    const issuesBlock = input.issues
        .map((issue) => `- ${issue.code}: ${issue.detail}`)
        .join("\n");
    return [
        input.originalPrompt.trim(),
        "",
        "## Validation Feedback",
        "Your previous extraction did not satisfy the schema.",
        issuesBlock,
        "",
        "## Repair Task",
        "First explain the failure briefly in the format below.",
        "",
        "### Diagnosis",
        "failure_type:",
        "dominant_unresolved_line:",
        "why_previous_output_failed:",
        "text_structure_trigger:",
        "repair_strategy:",
        "",
        "Then output a corrected extraction for the same window.",
        "Keep the grounded content already present in this window.",
        "If you output a Pending Item, do not leave point_a, relation, and point_b all blank.",
        "Pending records the start of the unresolved continuation only. Do not add end evidence to a Pending Item.",
        "If the window contains both a still-active gate and a hypothetical closure, choose the still-controlling unresolved line.",
        "If a newer unresolved line becomes active later in the window and remains active by the end, choose that newer line.",
        "",
        "### Previous Output",
        input.previousOutput.trim() || "_empty_",
        "",
        "### Corrected Extraction",
        "Repeat the extraction in the same Markdown schema as the original task.",
    ].join("\n");
}

export function splitDiagnosticRepairResponse(markdown: string): {
    diagnosis: string;
    correctedExtraction: string;
} {
    const text = String(markdown || "").replace(/\r\n/g, "\n");
    const marker = /^###\s+Corrected Extraction\s*$/m;
    const match = text.match(marker);
    if (!match || match.index === undefined) {
        return { diagnosis: text.trim(), correctedExtraction: "" };
    }
    const diagnosis = text.slice(0, match.index).trim();
    const correctedExtraction = text.slice(match.index + match[0].length).trim();
    return { diagnosis, correctedExtraction };
}
