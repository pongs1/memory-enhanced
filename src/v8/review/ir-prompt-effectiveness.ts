import type { V8GraphLayer } from "../types_v8.js";

export interface V8IrPromptEvalJobInput {
  jobId: string;
  layer: V8GraphLayer;
  narrativeRecordId?: string | null;
  prompt?: string | null;
  promptUnits?: Array<{
    ordinal?: number | null;
    text?: string | null;
  }> | null;
}

export interface V8IrPromptCompletedRecord {
  _job_id?: string | null;
  item_type?: string | null;
  point_a?: string | null;
  relation?: string | null;
  point_b?: string | null;
  subject?: string | null;
  predicate?: string | null;
  relation_family?: string | null;
  object?: string | null;
  evidence?: string | null;
  evidence_start_turn?: string | number | null;
  evidence_end_turn?: string | number | null;
  evidence_start_anchor?: string | null;
  evidence_end_anchor?: string | null;
}

export interface V8IrPromptPendingRecord {
  _job_id?: string | null;
  tensionRole?: string | null;
  tension_role?: string | null;
  point_a?: string | null;
  relation?: string | null;
  point_b?: string | null;
  subject?: string | null;
  predicate?: string | null;
  relation_family?: string | null;
  object?: string | null;
  evidence?: string | null;
  evidence_start_turn?: string | number | null;
  evidence_end_turn?: string | number | null;
  evidence_start_anchor?: string | null;
  evidence_end_anchor?: string | null;
  turnRefs?: number[] | null;
  startAnchor?: string | null;
  endAnchor?: string | null;
  status?: string | null;
}

export interface V8IrPromptJobMetrics {
  jobId: string;
  layer: V8GraphLayer;
  narrativeRecordId: string;
  turnRange: { start: number; end: number } | null;
  completedCount: number;
  pendingCount: number;
  completedWithRequiredFields: number;
  completedWithValidEvidence: number;
  pendingWithRequiredFields: number;
  pendingWithValidEvidence: number;
  pendingTouchingTail: number;
  typeViolations: number;
  predicateViolations: number;
  unresolvedReferenceCount: number;
  issueTags: string[];
  windowExcerpt: string;
}

export interface V8IrPromptEffectivenessScorecard {
  sampleCount: number;
  jobCount: number;
  layerBreakdown: Record<V8GraphLayer, number>;
  outputCoverage: {
    jobsWithCompleted: number;
    jobsWithPending: number;
    jobsWithAnyOutput: number;
    emptyJobs: number;
    completedItems: number;
    pendingItems: number;
  };
  schemaValidity: {
    completedWithRequiredFields: number;
    completedWithValidEvidence: number;
    pendingWithRequiredFields: number;
    pendingWithValidEvidence: number;
    acceptedCompletedItems: number;
    rejectedCompletedItems: number;
  };
  layerFit: {
    typeAllowedRate: number;
    predicateAllowedRate: number;
    crossLayerTypeViolations: number;
    crossLayerPredicateViolations: number;
  };
  workflowQuality: {
    tailPendingRate: number;
    pendingTouchesWindowTailRate: number;
    completedOutOfWindowEvidenceCount: number;
    unresolvedReferenceCount: number;
    overDenseJobs: number;
    underDenseJobs: number;
  };
  headline: {
    coverageHealth: number;
    schemaHealth: number;
    handoffHealth: number;
  };
}

export interface V8IrPromptEffectivenessResult {
  scorecard: V8IrPromptEffectivenessScorecard;
  jobs: V8IrPromptJobMetrics[];
}

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

const RELATIONS_BY_LAYER: Record<V8GraphLayer, string[]> = {
  micro: [
    "is_a", "instance_of", "part_of", "has_part", "belongs_to", "equivalent_to",
    "performs", "acts_on", "uses", "produces", "targets",
    "initiates", "involves", "occurs_at", "results_in_event",
    "causes", "caused_by", "enables", "prevents", "requires", "conditioned_on",
    "before", "after", "simultaneous_with", "evolves_to",
    "better_than", "worse_than", "similar_to", "differs_from",
    "supports", "contradicts", "cites",
    "elaborates", "summarizes", "contrasts", "explains", "concludes", "recommends",
  ],
  meso: [
    "grounded_in", "oriented_to", "focuses_on", "realized_by", "evidenced_by_block", "functions_as",
    "triggered_by", "responds_to", "constrained_by", "attempts_to_resolve", "escalates", "mitigates", "reframes", "revises",
    "culminates_in", "leads_to", "produces_shift", "stabilizes", "destabilizes", "opens", "closes",
    "precedes_block", "branches_to", "merges_into", "parallels", "contrasts_with_block", "echoes", "sets_up", "mirrors_locally",
  ],
  macro: [
    "unfolds_through", "spans_phase", "organized_as", "governed_by", "centered_on_line", "dominated_by",
    "transitions_to_phase", "evolves_to", "branches_into", "converges_with", "interrupted_by", "resumes_after", "culminates_at", "resolved_by",
    "produces_state", "shifts_regime", "stabilizes_state", "destabilizes_state", "constrains", "enables",
    "competes_with", "reinforces", "undermines", "mirrors", "recurs_as", "foreshadows", "pays_off", "recontextualizes", "opens_arc", "closes_arc",
  ],
};

const RELATION_FAMILIES_BY_LAYER: Record<V8GraphLayer, string[]> = {
  micro: ["identity", "participation", "event", "causality", "temporal", "comparison", "support", "discourse"],
  meso: ["anchoring", "dynamics", "transformation", "organization"],
  macro: ["structure", "evolution", "global_condition", "interaction"],
};

const UNRESOLVED_REFERENCE_PATTERNS: RegExp[] = [
  /^["']?(that|this|it|they|them|there|these|those)["']?$/i,
  /^["']?(something|someone|somewhere|some place|some places|stuff|thing|things)["']?$/i,
];

const MICRO_PENDING_EXPECTATION_PATTERNS: RegExp[] = [
  /\bstill open until\b/i,
  /\bhave not checked\b/i,
  /\bneed to check\b/i,
  /\bbiggest unknowns\b/i,
  /\bstill gate\b/i,
  /\bdepends on\b/i,
  /\bnot yet\b/i,
];

export function evaluateIrPromptEffectiveness(input: {
  jobs: V8IrPromptEvalJobInput[];
  completedRecords: V8IrPromptCompletedRecord[];
  pendingRecords: V8IrPromptPendingRecord[];
  acceptedCompletedItems?: number | null;
}): V8IrPromptEffectivenessResult {
  const completedByJob = groupByJob(input.completedRecords);
  const pendingByJob = groupByJob(input.pendingRecords);
  const jobs = input.jobs.map((job) =>
    evaluateIrPromptJob({
      job,
      completedRecords: completedByJob.get(job.jobId) || [],
      pendingRecords: pendingByJob.get(job.jobId) || [],
    }),
  );

  const sampleIds = new Set(jobs.map((job) => job.narrativeRecordId).filter(Boolean));
  const completedItems = jobs.reduce((sum, job) => sum + job.completedCount, 0);
  const pendingItems = jobs.reduce((sum, job) => sum + job.pendingCount, 0);
  const completedWithRequiredFields = jobs.reduce((sum, job) => sum + job.completedWithRequiredFields, 0);
  const completedWithValidEvidence = jobs.reduce((sum, job) => sum + job.completedWithValidEvidence, 0);
  const pendingWithRequiredFields = jobs.reduce((sum, job) => sum + job.pendingWithRequiredFields, 0);
  const pendingWithValidEvidence = jobs.reduce((sum, job) => sum + job.pendingWithValidEvidence, 0);
  const pendingTouchingTail = jobs.reduce((sum, job) => sum + job.pendingTouchingTail, 0);
  const typeViolations = jobs.reduce((sum, job) => sum + job.typeViolations, 0);
  const predicateViolations = jobs.reduce((sum, job) => sum + job.predicateViolations, 0);
  const unresolvedReferenceCount = jobs.reduce((sum, job) => sum + job.unresolvedReferenceCount, 0);
  const jobsWithCompleted = jobs.filter((job) => job.completedCount > 0).length;
  const jobsWithPending = jobs.filter((job) => job.pendingCount > 0).length;
  const jobsWithAnyOutput = jobs.filter((job) => job.completedCount > 0 || job.pendingCount > 0).length;
  const emptyJobs = jobs.length - jobsWithAnyOutput;
  const underDenseJobs = emptyJobs;
  const overDenseJobs = jobs.filter((job) => {
    const turnCount = job.turnRange ? job.turnRange.end - job.turnRange.start + 1 : 0;
    return job.completedCount > Math.max(6, turnCount * 3);
  }).length;
  const completedOutOfWindowEvidenceCount = Math.max(
    0,
    completedWithRequiredFields - completedWithValidEvidence,
  );
  const acceptedCompletedItems = Math.max(0, Number(input.acceptedCompletedItems ?? completedWithValidEvidence) || 0);
  const rejectedCompletedItems = Math.max(0, completedItems - acceptedCompletedItems);

  const scorecard: V8IrPromptEffectivenessScorecard = {
    sampleCount: sampleIds.size,
    jobCount: jobs.length,
    layerBreakdown: {
      micro: jobs.filter((job) => job.layer === "micro").length,
      meso: jobs.filter((job) => job.layer === "meso").length,
      macro: jobs.filter((job) => job.layer === "macro").length,
    },
    outputCoverage: {
      jobsWithCompleted,
      jobsWithPending,
      jobsWithAnyOutput,
      emptyJobs,
      completedItems,
      pendingItems,
    },
    schemaValidity: {
      completedWithRequiredFields,
      completedWithValidEvidence,
      pendingWithRequiredFields,
      pendingWithValidEvidence,
      acceptedCompletedItems,
      rejectedCompletedItems,
    },
    layerFit: {
      typeAllowedRate: ratio(completedItems - typeViolations, completedItems),
      predicateAllowedRate: ratio(completedItems - predicateViolations, completedItems),
      crossLayerTypeViolations: typeViolations,
      crossLayerPredicateViolations: predicateViolations,
    },
    workflowQuality: {
      tailPendingRate: ratio(jobsWithPending, jobs.length),
      pendingTouchesWindowTailRate: ratio(pendingTouchingTail, pendingItems),
      completedOutOfWindowEvidenceCount,
      unresolvedReferenceCount,
      overDenseJobs,
      underDenseJobs,
    },
    headline: {
      coverageHealth: ratio(jobsWithAnyOutput, jobs.length),
      schemaHealth: average([
        ratio(completedWithValidEvidence, completedItems),
        ratio(pendingWithValidEvidence, pendingItems),
      ]),
      handoffHealth: average([
        ratio(pendingTouchingTail, pendingItems),
        1 - ratio(emptyJobs, jobs.length),
      ]),
    },
  };

  return { scorecard, jobs };
}

export function evaluateIrPromptJob(input: {
  job: V8IrPromptEvalJobInput;
  completedRecords: V8IrPromptCompletedRecord[];
  pendingRecords: V8IrPromptPendingRecord[];
}): V8IrPromptJobMetrics {
  const layer = input.job.layer;
  const ordinals = (input.job.promptUnits || [])
    .map((unit) => Number(unit?.ordinal ?? NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const turnRange =
    ordinals.length > 0 ? { start: ordinals[0]!, end: ordinals[ordinals.length - 1]! } : null;
  const lastOrdinal = turnRange?.end ?? null;
  const pendingExpected = expectsPendingAtLayer(input.job);
  let completedWithRequiredFields = 0;
  let completedWithValidEvidence = 0;
  let pendingWithRequiredFields = 0;
  let pendingWithValidEvidence = 0;
  let pendingTouchingTail = 0;
  let typeViolations = 0;
  let predicateViolations = 0;
  let unresolvedReferenceCount = 0;

  for (const record of input.completedRecords) {
    const pointA = cleanText(record.point_a || record.subject);
    const relation = cleanText(record.relation || record.predicate);
    const pointB = cleanText(record.point_b || record.object);
    const required =
      Boolean(relation) &&
      (layer === "micro" ? Boolean(pointA) && Boolean(pointB) : Boolean(pointA) || Boolean(pointB)) &&
      hasEvidenceFields(record);
    if (required) completedWithRequiredFields += 1;
    const evidence = parseEvidenceAnchor(record);
    if (required && evidence && evidenceFitsJob(evidence, input.job, turnRange)) {
      completedWithValidEvidence += 1;
    }
    if (cleanText(record.item_type) && !isAllowedType(layer, record.item_type)) typeViolations += 1;
    if (!isAllowedRelationFamily(layer, record.relation_family)) predicateViolations += 1;
    if (hasUnresolvedReference(pointA) || hasUnresolvedReference(pointB)) {
      unresolvedReferenceCount += 1;
    }
  }

  for (const record of input.pendingRecords) {
    const tensionRole = cleanText(record.tension_role || record.tensionRole);
    const pointA = cleanText(record.point_a || record.subject);
    const relation = cleanText(record.relation || record.predicate);
    const pointB = cleanText(record.point_b || record.object);
    const required =
      Boolean(tensionRole) &&
      Boolean(cleanText(record.status)) &&
      Boolean(pointA || relation || pointB) &&
      hasPendingStartEvidence(record);
    if (required) pendingWithRequiredFields += 1;
    const evidence = parseEvidenceAnchor(record);
    if (required && !hasPendingEndEvidence(record) && evidence && evidenceFitsJob(evidence, input.job, turnRange)) {
      pendingWithValidEvidence += 1;
      if (lastOrdinal !== null && evidence.turnStart <= lastOrdinal) {
        pendingTouchingTail += 1;
      }
    }
    if (hasUnresolvedReference(pointA) || hasUnresolvedReference(pointB)) {
      unresolvedReferenceCount += 1;
    }
  }

  if (!pendingExpected && input.pendingRecords.length > 0) {
    pendingWithRequiredFields = input.pendingRecords.length;
    pendingWithValidEvidence = input.pendingRecords.length;
    pendingTouchingTail = input.pendingRecords.length;
  }

  const issueTags = new Set<string>();
  if (input.completedRecords.length === 0 && input.pendingRecords.length === 0) {
    issueTags.add("empty_output");
  }
  if (completedWithRequiredFields < input.completedRecords.length) {
    issueTags.add("completed_missing_fields");
  }
  if (completedWithValidEvidence < completedWithRequiredFields) {
    issueTags.add("completed_evidence_out_of_window");
  }
  if (pendingExpected && pendingWithRequiredFields < input.pendingRecords.length) {
    issueTags.add("pending_missing_fields");
  }
  if (pendingExpected && pendingWithValidEvidence < pendingWithRequiredFields) {
    issueTags.add("pending_invalid_evidence");
  }
  if (pendingExpected && input.pendingRecords.length > 0 && pendingWithValidEvidence === 0) {
    issueTags.add("pending_not_on_tail");
  }
  if (typeViolations > 0) issueTags.add("cross_layer_type");
  if (predicateViolations > 0) issueTags.add("cross_layer_relation_family");
  if (unresolvedReferenceCount > 0) issueTags.add("unresolved_reference");

  return {
    jobId: input.job.jobId,
    layer,
    narrativeRecordId: cleanText(input.job.narrativeRecordId) || "unknown",
    turnRange,
    completedCount: input.completedRecords.length,
    pendingCount: input.pendingRecords.length,
    completedWithRequiredFields,
    completedWithValidEvidence,
    pendingWithRequiredFields,
    pendingWithValidEvidence,
    pendingTouchingTail,
    typeViolations,
    predicateViolations,
    unresolvedReferenceCount,
    issueTags: Array.from(issueTags),
    windowExcerpt: buildWindowExcerpt(input.job.promptUnits || []),
  };
}

function buildWindowExcerpt(units: Array<{ text?: string | null }>): string {
  return units
    .map((unit) => cleanText(unit.text))
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .slice(0, 240);
}

function groupByJob<T extends { _job_id?: string | null }>(records: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records || []) {
    const jobId = cleanText(record._job_id);
    if (!jobId) continue;
    const list = grouped.get(jobId) || [];
    list.push(record);
    grouped.set(jobId, list);
  }
  return grouped;
}

function parseEvidenceDescriptor(value: string | null | undefined) {
  const trimmed = cleanText(value);
  if (!trimmed) return null;
  const match = trimmed.match(/^(?:(.*?)\s+)?turns?\s+(\d+)(?:\s*-\s*(\d+))?$/i);
  if (!match) return null;
  const turnStart = Number.parseInt(match[2] || "", 10);
  const turnEnd = Number.parseInt(match[3] || match[2] || "", 10);
  if (!Number.isFinite(turnStart) || !Number.isFinite(turnEnd)) return null;
  return {
    narrativeRecordId: cleanText(match[1]) || undefined,
    turnStart: Math.min(turnStart, turnEnd),
    turnEnd: Math.max(turnStart, turnEnd),
  };
}

function parseEvidenceAnchor(record: V8IrPromptCompletedRecord | V8IrPromptPendingRecord) {
  const start = Number.parseInt(cleanText(String((record as any).evidence_start_turn ?? "")), 10);
  const end = Number.parseInt(cleanText(String((record as any).evidence_end_turn ?? "")), 10);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return {
      narrativeRecordId: undefined,
      turnStart: Math.min(start, end),
      turnEnd: Math.max(start, end),
    };
  }
  if (Number.isFinite(start)) {
    return {
      narrativeRecordId: undefined,
      turnStart: start,
      turnEnd: start,
    };
  }
  const turnRefs = Array.isArray((record as any).turnRefs)
    ? (record as any).turnRefs
        .map((value: unknown) => Number.parseInt(String(value), 10))
        .filter((value: number) => Number.isFinite(value))
        .sort((a: number, b: number) => a - b)
    : [];
  if (turnRefs.length > 0) {
    return {
      narrativeRecordId: undefined,
      turnStart: turnRefs[0]!,
      turnEnd: turnRefs[turnRefs.length - 1]!,
    };
  }
  return parseEvidenceDescriptor(record.evidence);
}

function expectsPendingAtLayer(job: V8IrPromptEvalJobInput): boolean {
  if (job.layer !== "micro") return true;
  const text = (job.promptUnits || [])
    .map((unit) => cleanText(unit.text))
    .filter(Boolean)
    .join("\n");
  return MICRO_PENDING_EXPECTATION_PATTERNS.some((pattern) => pattern.test(text));
}

function hasEvidenceFields(record: V8IrPromptCompletedRecord | V8IrPromptPendingRecord): boolean {
  const start = cleanText(String((record as any).evidence_start_turn ?? ""));
  const end = cleanText(String((record as any).evidence_end_turn ?? ""));
  if (start && end) return true;
  if (Array.isArray((record as any).turnRefs) && (record as any).turnRefs.length > 0) return true;
  return Boolean(cleanText(record.evidence));
}

function hasPendingStartEvidence(record: V8IrPromptPendingRecord): boolean {
  const startTurn = cleanText(String((record as any).evidence_start_turn ?? ""));
  const startAnchor = cleanText(String((record as any).evidence_start_anchor ?? (record as any).startAnchor ?? ""));
  if (startTurn) return true;
  if (startAnchor) return true;
  if (Array.isArray((record as any).turnRefs) && (record as any).turnRefs.length > 0) return true;
  return Boolean(cleanText(record.evidence));
}

function hasPendingEndEvidence(record: V8IrPromptPendingRecord): boolean {
  const endTurn = cleanText(String((record as any).evidence_end_turn ?? (record as any).endTurn ?? ""));
  const endAnchor = cleanText(String((record as any).evidence_end_anchor ?? (record as any).endAnchor ?? ""));
  return Boolean(endTurn || endAnchor);
}

function evidenceFitsJob(
  evidence: { narrativeRecordId?: string; turnStart: number; turnEnd: number },
  job: V8IrPromptEvalJobInput,
  turnRange: { start: number; end: number } | null,
): boolean {
  if (cleanText(job.narrativeRecordId) && evidence.narrativeRecordId && evidence.narrativeRecordId !== cleanText(job.narrativeRecordId)) {
    return false;
  }
  if (!turnRange) return true;
  return evidence.turnStart >= turnRange.start && evidence.turnEnd <= turnRange.end;
}

function isAllowedType(layer: V8GraphLayer, itemType: string | null | undefined): boolean {
  const normalized = cleanText(itemType).toLowerCase();
  return normalized ? (ITEM_TYPES_BY_LAYER[layer] || []).includes(normalized) : false;
}

function isAllowedPredicate(layer: V8GraphLayer, predicate: string | null | undefined): boolean {
  const normalized = cleanText(predicate).toLowerCase();
  return normalized ? (RELATIONS_BY_LAYER[layer] || []).includes(normalized) : false;
}

function isAllowedRelationFamily(layer: V8GraphLayer, family: string | null | undefined): boolean {
  const normalized = cleanText(family).toLowerCase();
  return normalized ? (RELATION_FAMILIES_BY_LAYER[layer] || []).includes(normalized) : false;
}

function hasUnresolvedReference(value: string | null | undefined): boolean {
  const normalized = cleanText(value);
  if (!normalized) return false;
  return UNRESOLVED_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function cleanText(value: string | null | undefined): string {
  return String(value || "").trim();
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return numerator / denominator;
}

function average(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}
