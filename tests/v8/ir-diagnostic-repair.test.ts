import assert from "node:assert/strict";

import {
  buildDiagnosticRepairPrompt,
  classifyRepairableExtractionFailure,
  splitDiagnosticRepairResponse,
} from "../../src/v8/review/ir-diagnostic-repair.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("classifyRepairableExtractionFailure flags blank pending triple", () => {
  const issues = classifyRepairableExtractionFailure({
    layer: "micro",
    completedRecords: [{ point_a: "Tim", relation: "plans", point_b: "a trip" }],
    pendingRecords: [{ turnRefs: [], startAnchor: "", endAnchor: "" }],
  });

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["pending_missing_fields", "pending_invalid_evidence"],
  );
});

run("classifyRepairableExtractionFailure flags pending end evidence as invalid", () => {
  const issues = classifyRepairableExtractionFailure({
    layer: "micro",
    completedRecords: [],
    pendingRecords: [
      {
        point_a: "final choice",
        relation: "depends on",
        point_b: "cost totals",
        evidence_start_turn: 8,
        evidence_end_turn: 8,
      },
    ],
  });

  assert.match(issues.map((issue) => issue.code).join(","), /pending_invalid_evidence/);
});

run("classifyRepairableExtractionFailure flags unresolved references", () => {
  const issues = classifyRepairableExtractionFailure({
    layer: "micro",
    completedRecords: [{ point_a: "That", relation: "favors", point_b: "Kyoto" }],
    pendingRecords: [],
  });

  assert.deepEqual(
    issues.map((issue) => issue.code),
    ["unresolved_reference"],
  );
});

run("buildDiagnosticRepairPrompt appends diagnosis and corrected extraction sections", () => {
  const prompt = buildDiagnosticRepairPrompt({
    originalPrompt: "# Extraction Task\n\n## Output Format\n...",
    previousOutput: "### Pending Item\nstatus: pending",
    issues: [{ code: "pending_missing_fields", detail: "A Pending Item left point_a, relation, and point_b all blank." }],
  });

  assert.match(prompt, /^# Extraction Task/m);
  assert.match(prompt, /^## Validation Feedback$/m);
  assert.match(prompt, /^### Diagnosis$/m);
  assert.match(prompt, /^### Previous Output$/m);
  assert.match(prompt, /^### Corrected Extraction$/m);
  assert.match(prompt, /do not leave point_a, relation, and point_b all blank/i);
  assert.match(prompt, /Pending records the start of the unresolved continuation only\. Do not add end evidence to a Pending Item\./);
  assert.match(prompt, /If the window contains both a still-active gate and a hypothetical closure, choose the still-controlling unresolved line\./);
});

run("splitDiagnosticRepairResponse separates diagnosis from corrected extraction", () => {
  const parsed = splitDiagnosticRepairResponse(`
### Diagnosis
failure_type: pending_missing_fields

### Corrected Extraction
### Completed Item
point_a: Tim
relation: plans
point_b: a trip
  `);

  assert.match(parsed.diagnosis, /failure_type: pending_missing_fields/);
  assert.match(parsed.correctedExtraction, /^### Completed Item/m);
});
