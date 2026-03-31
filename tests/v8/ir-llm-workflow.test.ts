import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildExtractPrompt,
  validateAnnotatedItem,
} from "../../src/v8/architecture/ir-llm-workflow.js";
import { loadLlmIrArtifacts, loadLlmIrItems } from "../../src/v8/architecture/ir-llm.js";
import type { V8MemoryItem, V8Unit, V8EvidenceSpan } from "../../src/v8/types_v8.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function makeUnit(id: string, ordinal: number, text: string): V8Unit {
  return {
    id,
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    layer: "micro",
    ordinal,
    charStart: 0,
    charEnd: text.length,
    text,
    parentUnitId: null,
    language: "en",
    role: "user",
    timestamp: "2026-03-23T00:00:00.000Z",
    sourceCategory: "conversation",
  };
}

function makePromptUnit(id: string, ordinal: number, text: string) {
  return {
    id,
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    ordinal,
    charStart: 0,
    charEnd: text.length,
    text,
    role: "Tim" as const,
    timestamp: "2026-03-23T00:00:00.000Z",
  };
}

function makeItem(overrides: Partial<V8MemoryItem>): V8MemoryItem {
  return {
    id: "item_1",
    narrativeRecordId: "narr_1",
    sourceRef: "/tmp/narrative.md",
    itemType: "entity",
    originType: "asserted",
    layer: "micro",
    subject: "Tim",
    predicate: "prefers",
    object: "Lord of the Rings",
    label: "Tim prefers Lord of the Rings",
    qualifiers: {},
    evidenceSpanIds: ["es_1"],
    unitIds: ["unit_target"],
    confidence: 0.8,
    scope: "session",
    validity: "active",
    createdAt: "2026-03-23T00:00:00.000Z",
    updatedAt: "2026-03-23T00:00:00.000Z",
    ...overrides,
  };
}

run("buildExtractPrompt renders pending handoff and markdown output sections", () => {
  const prompt = buildExtractPrompt({
    layer: "micro",
    workingUnits: [
      makePromptUnit("u1", 1, "Tim is checking the visa rules."),
      makePromptUnit("u2", 2, "He still has not decided where to go next."),
    ],
    pendingItems: [
      {
        id: "pending_1",
        tensionRole: "open",
        subject: "Tim",
        predicate: "targets",
        object: "travel plan",
        turnRefs: [1],
        charStart: 0,
        charEnd: 10,
        status: "pending",
      },
    ],
    targetUnitIds: ["u1", "u2"],
  });

  assert.match(prompt, /^# Extraction Task$/m);
  assert.match(prompt, /^## Objective$/m);
  assert.match(prompt, /^## Layer Boundary$/m);
  assert.match(prompt, /^## IR Meaning$/m);
  assert.match(prompt, /^## Field Guide$/m);
  assert.match(prompt, /^## Expression Style$/m);
  assert.match(prompt, /^## Pending Rules$/m);
  assert.match(prompt, /^### Types$/m);
  assert.match(prompt, /^### Relation Families$/m);
  assert.match(prompt, /^## Prior Pending IR$/m);
  assert.match(prompt, /^## Window$/m);
  assert.match(prompt, /^## Output Format$/m);
  assert.match(prompt, /Extract IR from the current narrative window\./);
  assert.match(prompt, /IR is a compact semantic record grounded in the cited narrative turns\./);
  assert.match(prompt, /Completed Item records content whose meaning is already complete inside this window\./);
  assert.match(prompt, /Pending Item carries an unfinished tail whose meaning still depends on the next window\./);
  assert.match(prompt, /- relation: fill a short grounded relation phrase from the evidence span, interpreted with the Relation Families section\./);
  assert.match(prompt, /- point_a: fill one grounded semantic side of the relation using content that fits this layer and the Types section\./);
  assert.match(prompt, /- point_b: fill the other grounded semantic side that stands in relation to point_a using content that fits this layer and the Types section\./);
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
  assert.match(prompt, /## Prior Pending IR\s+### Pending Item/m);
  assert.doesNotMatch(prompt, /### Pending 1/);
  assert.match(prompt, /status: pending/);
  assert.match(prompt, /### Completed Item/);
  assert.match(prompt, /### Pending Item/);
  assert.doesNotMatch(prompt, /^item_type:/m);
  assert.doesNotMatch(prompt, /^qualifiers:/m);
  assert.match(prompt, /point_a: <grounded expression>/);
  assert.match(prompt, /relation: <short relation phrase close to the evidence wording>/);
  assert.match(prompt, /relation_family: <one listed relation family>/);
  assert.match(prompt, /evidence_start_anchor: <exact short snippet/);
  assert.match(prompt, /evidence_end_anchor: <exact short snippet/);
  assert.match(prompt, /point_b: <grounded expression>/);
  const outputFormat = prompt.slice(prompt.lastIndexOf("## Output Format"));
  assert.doesNotMatch(outputFormat, /### Pending Item[\s\S]*?status: pending[\s\S]*?evidence_end_turn:/m);
  assert.doesNotMatch(outputFormat, /### Pending Item[\s\S]*?status: pending[\s\S]*?evidence_end_anchor:/m);
  assert.match(prompt, /### turn 1 2026-03-23 00:00 Tim:/);
});

run("validateAnnotatedItem rejects unresolved core references", () => {
  const result = validateAnnotatedItem(
    makeItem({ object: '"That"', label: 'Tim prefers "That"' }),
    new Set(["unit_target"]),
    new Set(["es_1"])
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unresolved_reference");
});

run("validateAnnotatedItem accepts concrete evidence-bound items", () => {
  const result = validateAnnotatedItem(
    makeItem({ object: "Lord of the Rings" }),
    new Set(["unit_target"]),
    new Set(["es_1"])
  );

  assert.equal(result.ok, true);
});

run("validateAnnotatedItem rejects invalid relation family for layer", () => {
  const result = validateAnnotatedItem(
    makeItem({
      itemType: "claim",
      layer: "micro",
      qualifiers: { relation_family: "anchoring" },
    }),
    new Set(["unit_target"]),
    new Set(["es_1"])
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_relation_family");
});

run("loadLlmIrItems drops unresolved final items before persistence", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ir-workflow-"));
  const jsonlPath = path.join(tmpDir, "items.jsonl");
  fs.writeFileSync(jsonlPath, JSON.stringify({
    subject: "Tim",
    predicate: "prefers",
    object: '"That"',
    unit_id: "unit_target",
    evidence_span_ids: ["es_1"],
    confidence: 0.9,
  }) + "\n");

  const units = [makeUnit("unit_target", 1, 'Tim said that "That" is still his favorite.')];
  const spans: V8EvidenceSpan[] = [{
    id: "es_1",
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_target",
    charStart: 0,
    charEnd: units[0]!.text.length,
    text: units[0]!.text,
    role: "user",
    timestamp: "2026-03-23T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 1,
  }];

  const items = loadLlmIrItems({ jsonlPath }, units, spans);
  assert.equal(items.length, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

run("loadLlmIrArtifacts derives unit and span from evidence turn range", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ir-workflow-map-"));
  const jsonlPath = path.join(tmpDir, "items.jsonl");
  const jobsPath = path.join(tmpDir, "jobs.jsonl");
  const narrativePath = path.join(tmpDir, "narrative.md");
  fs.writeFileSync(
    narrativePath,
    [
      "### 2026-03-23 00:00 user:",
      "John mentioned fantasy books.",
      "",
      "### 2026-03-23 00:01 user:",
      "Tim said Lord of the Rings is still his favorite.",
      "",
    ].join("\n")
  );
  const units = [
    {
      ...makeUnit("unit_left", 1, "John mentioned fantasy books."),
      narrativeRef: narrativePath,
      charStart: 0,
      charEnd: 29,
    },
    {
      ...makeUnit("unit_target", 2, "Tim said Lord of the Rings is still his favorite."),
      narrativeRef: narrativePath,
      charStart: 30,
      charEnd: 78,
    },
  ];
  fs.writeFileSync(jsonlPath, JSON.stringify({
    _job_id: "job_micro_1",
    point_a: "Tim",
    relation: "prefers",
    point_b: "Lord of the Rings",
    evidence: "turn 2",
    evidence_span_ids: ["es_2"],
  }) + "\n");
  fs.writeFileSync(jobsPath, JSON.stringify({
    jobId: "job_micro_1",
    layer: "micro",
    promptUnits: [
      {
        id: "prompt_1",
        narrativeRecordId: "narr_1",
        narrativeRef: narrativePath,
        layer: "micro",
        charStart: 0,
        charEnd: 29,
        ordinal: 1,
        role: "user",
        timestamp: "2026-03-23 00:00",
      },
      {
        id: "prompt_2",
        narrativeRecordId: "narr_1",
        narrativeRef: narrativePath,
        layer: "micro",
        charStart: 30,
        charEnd: 78,
        ordinal: 2,
        role: "user",
        timestamp: "2026-03-23 00:01",
      },
    ],
  }) + "\n");
  const spans: V8EvidenceSpan[] = [
    {
      id: "es_1",
      narrativeRecordId: "narr_1",
      narrativeRef: narrativePath,
      unitId: "unit_left",
      charStart: 0,
      charEnd: 29,
      text: units[0]!.text,
      role: "user",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 1,
    },
    {
      id: "es_2",
      narrativeRecordId: "narr_1",
      narrativeRef: narrativePath,
      unitId: "unit_target",
      charStart: 30,
      charEnd: 78,
      text: units[1]!.text,
      role: "user",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 1,
    },
  ];

  const artifacts = loadLlmIrArtifacts({ jsonlPath, jobsPath }, units, spans);
  assert.equal(artifacts.items.length, 1);
  assert.equal(artifacts.items[0]!.itemType, "claim");
  assert.equal(artifacts.units.length, 1);
  assert.equal(artifacts.evidenceSpans.length, 1);
  assert.deepEqual(artifacts.items[0]!.unitIds, [artifacts.units[0]!.id]);
  assert.deepEqual(artifacts.items[0]!.evidenceSpanIds, [artifacts.evidenceSpans[0]!.id]);
  assert.equal(artifacts.units[0]!.layer, "micro");
  assert.equal(artifacts.units[0]!.ordinal, 2);
  assert.equal(artifacts.evidenceSpans[0]!.unitId, artifacts.units[0]!.id);
  assert.equal(artifacts.evidenceSpans[0]!.charStart, artifacts.units[0]!.charStart);
  assert.equal(artifacts.evidenceSpans[0]!.charEnd, artifacts.units[0]!.charEnd);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

run("loadLlmIrItems allows meso items with a single grounded side", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ir-meso-open-side-"));
  const jsonlPath = path.join(tmpDir, "items.jsonl");
  fs.writeFileSync(jsonlPath, JSON.stringify({
    point_a: "hybrid option remains leading",
    relation: "stays active as",
    point_b: "",
    relation_family: "transformation",
    unit_id: "unit_target",
    evidence_span_ids: ["es_1"],
    confidence: 0.9,
    _job_id: "job_meso_1",
  }) + "\n");

  const units = [{
    ...makeUnit("unit_target", 1, "The hybrid option remains leading."),
    layer: "meso" as const,
  }];
  const spans: V8EvidenceSpan[] = [{
    id: "es_1",
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_target",
    charStart: 0,
    charEnd: units[0]!.text.length,
    text: units[0]!.text,
    role: "user",
    timestamp: "2026-03-23T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 1,
  }];

  const items = loadLlmIrItems({ jsonlPath }, units, spans);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.layer, "meso");
  assert.equal(items[0]!.subject, "hybrid option remains leading");
  assert.equal(items[0]!.object, "");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
