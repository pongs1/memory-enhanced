import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildLlmIrJobs } from "../../src/v8/architecture/ir-llm.js";
import type { V8EvidenceSpan, V8Unit } from "../../src/v8/types_v8.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function writeNarrativeFile(markdown: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ir-prompt-"));
  const filePath = path.join(dir, "narrative.md");
  fs.writeFileSync(filePath, markdown, "utf-8");
  return filePath;
}

run("buildLlmIrJobs builds extract jobs for micro windows", () => {
  const narrativeRef = writeNarrativeFile([
    "### 2026-03-23 00:00 user:",
    "John said he is researching visa requirements for some places he wants to visit.",
    "",
  ].join("\n"));
  const units: V8Unit[] = [
    {
      id: "unit_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      layer: "micro",
      ordinal: 1,
      charStart: 0,
      charEnd: 80,
      text: "John said he is researching visa requirements for some places he wants to visit.",
      parentUnitId: null,
      language: "en",
      role: "user",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ];

  const spans: V8EvidenceSpan[] = [
    {
      id: "es_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      unitId: "unit_1",
      charStart: 0,
      charEnd: 80,
      text: "John said he is researching visa requirements for some places he wants to visit.",
      role: "user",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 1,
    },
  ];

  const jobs = buildLlmIrJobs(units, spans, { layers: ["micro"] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.kind, "extract");
  const prompt = jobs[0]!.prompt;

  assert.match(prompt, /^# Extraction Task$/m);
  assert.match(prompt, /^## Objective$/m);
  assert.match(prompt, /^## Layer Boundary$/m);
  assert.match(prompt, /^## IR Meaning$/m);
  assert.match(prompt, /^## Field Guide$/m);
  assert.match(prompt, /^## Expression Style$/m);
  assert.match(prompt, /^## Pending Rules$/m);
  assert.match(prompt, /^### Types$/m);
  assert.match(prompt, /^### Relation Families$/m);
  assert.match(prompt, /^## Window$/m);
  assert.match(prompt, /^## Output Format$/m);
  assert.doesNotMatch(prompt, /^## Unit ID Map$/m);
  assert.doesNotMatch(prompt, /unit_1/);
  assert.match(prompt, /Extract IR from the current narrative window\./);
  assert.match(prompt, /IR is a compact semantic record grounded in the cited narrative turns\./);
  assert.match(prompt, /Completed Item records content whose meaning is already complete inside this window\./);
  assert.match(prompt, /Pending Item carries an unfinished tail whose meaning still depends on the next window\./);
  assert.match(
    prompt,
    /Use the Types section below to interpret what kinds of semantic content belong in point_a and point_b\./,
  );
  assert.match(
    prompt,
    /- relation_family: fill exactly one family heading name from the Relation Families section below\. Valid outputs are: identity, participation, event, causality, temporal, comparison, support, discourse\./,
  );
  assert.match(
    prompt,
    /Do not copy an example relation token from the examples below into this field\./,
  );
  assert.match(
    prompt,
    /Resolve local pronouns or demonstratives into the explicit local referent whenever the visible turns make it clear\./,
  );
  assert.match(
    prompt,
    /- Record each grounded item supported by the evidence and fill the fields that the grounded structure requires at this layer\./,
  );
  assert.match(
    prompt,
    /- \*\*Write Pending only for unfinished local objects, events, conditions, dependencies, comparisons, or states that are visible in the current window\.\*\*/,
  );
  assert.match(
    prompt,
    /Treat it as unfinished when point_a, relation, or point_b is only partly expressed, or when one side is present but the local relation is not yet grounded\./,
  );
  assert.match(
    prompt,
    /Pending records the start of that unfinished local meaning\. Use evidence_start_turn and evidence_start_anchor to mark where it becomes active\./,
  );
  assert.match(
    prompt,
    /- \*\*Write the unfinished meaning in the local wording and scope already visible in the text, and do not leave point_a, relation, and point_b all blank\.\*\*/,
  );
  assert.match(
    prompt,
    /- Keep earlier resolved content as Completed Item\(s\); when a later window resolves the pending line, convert it to Completed Item\(s\) and stop carrying it forward\./,
  );
  assert.match(prompt, /Keep point_a and point_b close to the evidence wording\./);
  assert.doesNotMatch(prompt, /\bnode\b/i);
  assert.doesNotMatch(prompt, /\bedge\b/i);
  assert.match(prompt, /Work at the smallest directly grounded scale visible in the text\./);
  assert.match(prompt, /- entity: stable object such as a person, place, organization, system, file, or thing\./);
  assert.doesNotMatch(prompt, /^### object$/m);
  assert.match(prompt, /^#### participation$/m);
  assert.match(prompt, /- performs, acts_on, uses, produces, targets: use when the text states who does what, acts on what, uses what, produces what, or aims at what\./);
  assert.doesNotMatch(prompt, /preference_state|workflow_validity_state|session_state|topic_state/);
  assert.doesNotMatch(prompt, /precedes_block|organized_as|opens_arc/);
  assert.doesNotMatch(prompt, /You are a text structure extraction worker\./);
  assert.match(prompt, /### turn 1 2026-03-23 00:00 user:/i);
  assert.doesNotMatch(prompt, /source_category:/i);
  assert.doesNotMatch(prompt, /evidence_spans:/i);
  assert.doesNotMatch(prompt, /^item_type:/m);
  assert.doesNotMatch(prompt, /^qualifiers:/m);
  assert.match(prompt, /point_a: <grounded expression>/);
  assert.match(prompt, /relation: <short relation phrase close to the evidence wording>/);
  assert.match(prompt, /point_b: <grounded expression>/);
  const outputFormat = prompt.slice(prompt.lastIndexOf("## Output Format"));
  assert.doesNotMatch(outputFormat, /### Pending Item[\s\S]*?status: pending[\s\S]*?evidence_end_turn:/m);
  assert.doesNotMatch(outputFormat, /### Pending Item[\s\S]*?status: pending[\s\S]*?evidence_end_anchor:/m);
});

run("buildLlmIrJobs builds extract jobs for meso windows", () => {
  const narrativeRef = writeNarrativeFile([
    "### 2026-03-23 00:00 user:",
    "John decided to keep the migration incremental because the old approach caused regressions.",
    "",
  ].join("\n"));
  const units: V8Unit[] = [
    {
      id: "unit_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      layer: "meso",
      ordinal: 1,
      charStart: 0,
      charEnd: 80,
      text: "John decided to keep the migration incremental because the old approach caused regressions.",
      parentUnitId: null,
      language: "en",
      role: "user",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ];

  const spans: V8EvidenceSpan[] = units.map((unit, index) => ({
    id: `es_${index + 1}`,
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
  }));

  const jobs = buildLlmIrJobs(units, spans, { layers: ["meso"] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.kind, "extract");
  const prompt = jobs[0]!.prompt;

  assert.match(prompt, /^# Extraction Task$/m);
  assert.match(prompt, /^## Objective$/m);
  assert.match(prompt, /^## Layer Boundary$/m);
  assert.match(prompt, /^## IR Meaning$/m);
  assert.match(prompt, /^## Expression Style$/m);
  assert.match(prompt, /^## Pending Rules$/m);
  assert.match(prompt, /^### Types$/m);
  assert.match(prompt, /^### Relation Families$/m);
  assert.match(prompt, /^## Prior Pending IR$/m);
  assert.match(prompt, /^## Window$/m);
  assert.match(prompt, /^## Output Format$/m);
  assert.doesNotMatch(prompt, /^### Unit ID Map$/m);
  assert.doesNotMatch(prompt, /unit_1/);
  assert.match(prompt, /Extract IR from the current narrative window\./);
  assert.match(prompt, /IR is a compact semantic record grounded in the cited narrative turns\./);
  assert.match(prompt, /Completed Item records content whose meaning is already complete inside this window\./);
  assert.match(prompt, /Pending Item carries an unfinished tail whose meaning still depends on the next window\./);
  assert.match(prompt, /Keep distinct grounded meanings visible instead of collapsing them into one theme label\./);
  assert.match(prompt, /point_a and point_b must not both be blank\./);
  assert.match(prompt, /- \*\*Write Pending only for unfinished scenes, objective blocks, problem blocks, strategy blocks, procedure blocks, interaction blocks, decision blocks, shifts, or outcomes that are visible in the current window\.\*\*/);
  assert.match(prompt, /Treat it as unfinished when the block is opened here but not yet locally completed in the visible text\./);
  assert.match(prompt, /Pending records the start of that unfinished block-level meaning\. Use evidence_start_turn and evidence_start_anchor to mark where it becomes active\./);
  assert.match(
    prompt,
    /- relation_family: fill exactly one family heading name from the Relation Families section below\. Valid outputs are: anchoring, dynamics, transformation, organization\./,
  );
  assert.match(
    prompt,
    /- \*\*Write the unfinished meaning in the block wording and scope already visible in the text, and do not leave point_a, relation, and point_b all blank\.\*\*/,
  );
  assert.match(
    prompt,
    /- Keep earlier resolved content as Completed Item\(s\); when a later window resolves the pending line, convert it to Completed Item\(s\) and stop carrying it forward\./,
  );
  assert.doesNotMatch(prompt, /\bnode\b/i);
  assert.doesNotMatch(prompt, /\bedge\b/i);
  assert.match(prompt, /Work at the local block scale\./);
  assert.match(prompt, /- scene_block: a locally complete scene or semantic block\./);
  assert.doesNotMatch(prompt, /^### scene$/m);
  assert.match(prompt, /^#### anchoring$/m);
  assert.match(prompt, /- grounded_in, oriented_to, focuses_on, realized_by, evidenced_by_block, functions_as: use when the text anchors a local block in its frame, support, realization, or function\./);
  assert.doesNotMatch(prompt, /global_state|relationship_arc|opens_arc/);
  assert.doesNotMatch(prompt, /You are a text structure extraction worker\./);
  assert.match(prompt, /### turn 1 2026-03-23 00:00 user:/i);
  assert.doesNotMatch(prompt, /source_category:/i);
  assert.doesNotMatch(prompt, /evidence_spans:/i);
  assert.match(prompt, /### Completed Item/);
  assert.match(prompt, /### Pending Item/);
  assert.doesNotMatch(prompt, /^item_type:/m);
  assert.doesNotMatch(prompt, /^qualifiers:/m);
  assert.match(prompt, /point_a: <grounded expression or blank>/);
  assert.match(prompt, /point_b: <grounded expression or blank>/);
  const outputFormat = prompt.slice(prompt.lastIndexOf("## Output Format"));
  assert.doesNotMatch(outputFormat, /### Pending Item[\s\S]*?status: pending[\s\S]*?evidence_end_turn:/m);
  assert.doesNotMatch(outputFormat, /### Pending Item[\s\S]*?status: pending[\s\S]*?evidence_end_anchor:/m);
});

run("buildLlmIrJobs builds extract jobs for macro windows", () => {
  const narrativeRef = writeNarrativeFile([
    "### 2026-03-23 00:00 assistant:",
    "The migration effort moved from exploration to implementation after the regression fixes held.",
    "",
  ].join("\n"));
  const units: V8Unit[] = [
    {
      id: "macro_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      layer: "macro",
      ordinal: 1,
      charStart: 0,
      charEnd: 120,
      text: "The migration effort moved from exploration to implementation after the regression fixes held.",
      parentUnitId: null,
      language: "en",
      role: "assistant",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ];

  const spans: V8EvidenceSpan[] = [
    {
      id: "es_macro_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      unitId: "macro_1",
      charStart: 0,
      charEnd: 120,
      text: units[0]!.text,
      role: "assistant",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 1,
    },
  ];

  const jobs = buildLlmIrJobs(units, spans, { layers: ["macro"] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.kind, "extract");
  assert.match(jobs[0]!.prompt, /^# Extraction Task$/m);
  assert.match(jobs[0]!.prompt, /^## Layer Boundary$/m);
  assert.match(jobs[0]!.prompt, /^## Expression Style$/m);
  assert.match(
    jobs[0]!.prompt,
    /- relation_family: fill exactly one family heading name from the Relation Families section below\. Valid outputs are: structure, evolution, global_condition, interaction\./,
  );
  assert.match(jobs[0]!.prompt, /### turn 1 2026-03-23 00:00 assistant:/i);
  assert.match(jobs[0]!.prompt, /Work at the cross-block structural scale\./);
  assert.match(jobs[0]!.prompt, /- arc: a long-running development arc\./);
  assert.doesNotMatch(jobs[0]!.prompt, /^### line$/m);
  assert.doesNotMatch(jobs[0]!.prompt, /^### theme$/m);
  assert.match(jobs[0]!.prompt, /^#### evolution$/m);
  assert.match(jobs[0]!.prompt, /- transitions_to_phase, evolves_to, branches_into, converges_with, interrupted_by, resumes_after, culminates_at, resolved_by: use when the text states phase change, branching, interruption, recovery, climax, or resolution\./);
  assert.match(jobs[0]!.prompt, /Name a higher-order structure only when the visible turns support it explicitly\./);
  assert.match(jobs[0]!.prompt, /point_a and point_b must not both be blank\./);
  assert.match(jobs[0]!.prompt, /point_a: <grounded expression or blank>/);
  assert.match(jobs[0]!.prompt, /point_b: <grounded expression or blank>/);
});

run("buildLlmIrJobs rewrites benchmark-style speaker headers into natural speech form", () => {
  const narrativeRef = writeNarrativeFile([
    "### 2026-03-23 00:00 Tim:",
    "### Tim",
    "Wow, sounds awesome! Winning after that game must have felt amazing.",
    "",
  ].join("\n"));
  const units: V8Unit[] = [
    {
      id: "unit_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      layer: "micro",
      ordinal: 1,
      charStart: 0,
      charEnd: 80,
      text: "### Tim\nWow, sounds awesome! Winning after that game must have felt amazing.",
      parentUnitId: null,
      language: "en",
      role: "Tim",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ];

  const spans: V8EvidenceSpan[] = [
    {
      id: "es_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      unitId: "unit_1",
      charStart: 0,
      charEnd: 80,
      text: units[0]!.text,
      role: "Tim",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 1,
    },
  ];

  const jobs = buildLlmIrJobs(units, spans, { layers: ["micro"] });
  assert.equal(jobs.length, 1);
  assert.match(jobs[0]!.prompt, /### turn 1 2026-03-23 00:00 Tim:/);
  assert.doesNotMatch(jobs[0]!.prompt, /### Tim\r?\n/);
  assert.doesNotMatch(jobs[0]!.prompt, /#### Unit unit_/i);
});

run("buildAnnotationPrompt strips embedded timestamp headers and keeps a single speaker prefix", () => {
  const narrativeRef = writeNarrativeFile([
    "### 2026-01-07 16:00 Tim:",
    "### Tim (2026-01-07 16:00)",
    "That looks awesome! Where did you get this tree?",
    "",
  ].join("\n"));
  const units: V8Unit[] = [
    {
      id: "unit_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      layer: "micro",
      ordinal: 1,
      charStart: 0,
      charEnd: 160,
      text: "### Tim (2026-01-07 16:00)\nThat looks awesome! Where did you get this tree?",
      parentUnitId: null,
      language: "en",
      role: "Tim",
      timestamp: "2026-01-07T16:00:00.000Z",
      sourceCategory: "conversation",
    },
  ];

  const spans: V8EvidenceSpan[] = [
    {
      id: "es_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      unitId: "unit_1",
      charStart: 0,
      charEnd: 160,
      text: units[0]!.text,
      role: "Tim",
      timestamp: "2026-01-07T16:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 1,
    },
  ];

  const jobs = buildLlmIrJobs(units, spans, { layers: ["micro"] });
  const prompt = jobs[0]!.prompt;
  assert.match(prompt, /### turn 1 2026-01-07 16:00 Tim:\s+That looks awesome!/i);
  assert.doesNotMatch(prompt, /### Tim \(2026-01-07 16:00\)/i);
  assert.doesNotMatch(prompt, /### Tim \(/i);
});

run("buildAnnotationPrompt rewrites nested turn headers inside a meso block", () => {
  const narrativeRef = writeNarrativeFile([
    "### 2026-01-01 00:00 Tim:",
    "I went to London.",
    "",
    "### 2026-01-03 00:00 John:",
    "I scored 40 points.",
    "",
    "### 2026-01-08 00:00 Tim:",
    "I decorated this tree myself.",
    "",
  ].join("\n"));
  const units: V8Unit[] = [
    {
      id: "unit_meso_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      layer: "meso",
      ordinal: 1,
      charStart: 0,
      charEnd: 260,
      text: "### Tim (2026-01-01 00:00)\nI went to London.\n\n### John (2026-01-03 00:00)\nI scored 40 points.\n\n### Tim (2026-01-08 00:00)\nI decorated this tree myself.",
      parentUnitId: null,
      language: "en",
      role: "Tim",
      timestamp: "2026-01-08T16:00:00.000Z",
      sourceCategory: "conversation",
    },
  ];

  const spans: V8EvidenceSpan[] = [
    {
      id: "es_1",
      narrativeRecordId: "narr_1",
      narrativeRef,
      unitId: "unit_meso_1",
      charStart: 0,
      charEnd: 260,
      text: units[0]!.text,
      role: "Tim",
      timestamp: "2026-01-08T16:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 1,
    },
  ];

  const jobs = buildLlmIrJobs(units, spans, { layers: ["meso"] });
  const prompt = jobs[0]!.prompt;
  assert.match(prompt, /### turn 1 2026-01-01 00:00 Tim:\s+I went to London\./i);
  assert.match(prompt, /### turn 2 2026-01-03 00:00 John:\s+I scored 40 points\./i);
  assert.match(prompt, /### turn 3 2026-01-08 00:00 Tim:\s+I decorated this tree myself\./i);
  assert.doesNotMatch(prompt, /### John \(2026-01-03 00:00\)/i);
  assert.doesNotMatch(prompt, /### Tim \(2026-01-01 00:00\)/i);
});
