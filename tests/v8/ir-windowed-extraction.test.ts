import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  buildNextWindowInput,
  buildSerialIrWindows,
  parseExtractionMarkdownResponse,
  parseNarrativeTurns,
} from "../../src/v8/architecture/ir-windowed-extraction.js";
import type { V8PendingIr } from "../../src/v8/types_v8.js";

type NarrativeTurn = ReturnType<typeof parseNarrativeTurns>[number];

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function makeTurns(count: number, startIdx = 1): NarrativeTurn[] {
  return Array.from({ length: count }, (_, offset) => {
    const idx = startIdx + offset;
    return {
      idx,
      charStart: idx * 10,
      charEnd: idx * 10 + 9,
      role: idx % 2 === 0 ? "assistant" : "user",
      turnType: idx % 2 === 0 ? "assistant_text" : "user_message",
      text: `turn ${idx}`,
      timestamp: `2026-03-25 00:0${Math.min(idx, 9)}`,
    };
  });
}

run("types_v8 does not export V8NarrativeTurn", () => {
  const filePath = path.resolve("src/v8/types_v8.ts");
  const contents = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(contents, /export interface V8NarrativeTurn\b/);
});

run("parseNarrativeTurns returns ordered turns with offsets", () => {
  const turns = parseNarrativeTurns(
    [
      "### 2023-05-21 19:48 user:",
      "hello",
      "",
      "### 2023-05-21 19:49 assistant:",
      "world",
      "",
    ].join("\n")
  );

  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.role, "user");
  assert.equal(turns[1]!.role, "assistant");
  assert.match(turns[0]!.text, /hello/);
  assert.match(turns[1]!.text, /world/);
  assert.equal(turns[0]!.charStart, turns[0]!.charEnd - turns[0]!.text.length);
  assert.equal(turns[0]!.charStart, [
    "### 2023-05-21 19:48 user:",
    "hello",
    "",
    "### 2023-05-21 19:49 assistant:",
    "world",
    "",
  ].join("\n").indexOf("hello"));
  assert.ok(turns[1]!.charStart > turns[0]!.charEnd);
});

run("buildSerialIrWindows creates overlapping windows in narrative order", () => {
  const turns = makeTurns(7);
  const windows = buildSerialIrWindows(turns, { windowSize: 5, overlapTurns: 2 });
  assert.deepEqual(
    windows.map((window) => [window.turnIdxStart, window.turnIdxEnd]),
    [
      [1, 5],
      [4, 7],
    ]
  );
});

run("buildNextWindowInput carries pending IR into the following window", () => {
  const pending: V8PendingIr[] = [
    {
      id: "pending_1",
      tensionRole: "open",
      turnRefs: [4, 5],
      charStart: 40,
      charEnd: 59,
      status: "pending",
    },
  ];
  const next = buildNextWindowInput({
    pending,
    overlapTurns: makeTurns(2, 4),
    newTurns: makeTurns(3, 6),
  });

  assert.equal(next.pending.length, 1);
  assert.deepEqual(next.pending[0]!.turnRefs, [4, 5]);
  assert.deepEqual(
    next.turns.map((turn) => turn.idx),
    [4, 5, 6, 7, 8]
  );
});

run("parseExtractionMarkdownResponse splits completed and pending sections", () => {
  const parsed = parseExtractionMarkdownResponse(`
### Completed Item
item_type: entity
subject: Tim
predicate: targets
object: travel plan
origin_type: asserted
evidence_start_turn: 1
evidence_end_turn: 1
evidence_start_anchor: travel
evidence_end_anchor: plan

### Pending Item
- tension_role: open
- subject: Tim
- predicate: targets
- object: travel plan
- evidence_start_turn: 1
- evidence_start_anchor: travel
- status: pending
  `);

  assert.equal(parsed.completedBlocks.length, 1);
  assert.equal(parsed.pending.length, 1);
  assert.equal(parsed.pending[0]!.tensionRole, "open");
  assert.deepEqual(parsed.pending[0]!.turnRefs, [1]);
  assert.equal(parsed.pending[0]!.startTurn, 1);
  assert.equal(parsed.pending[0]!.endTurn, undefined);
  assert.equal(parsed.pending[0]!.startAnchor, "travel");
  assert.equal(parsed.pending[0]!.endAnchor, undefined);
});

run("parseExtractionMarkdownResponse maps pending point_a relation point_b into legacy fields", () => {
  const parsed = parseExtractionMarkdownResponse(`
### Pending Item
- tension_role: open
- point_a: final choice
- relation: depends on
- relation_family: causality
- point_b: hotel and rail totals
- evidence_start_turn: 14
- evidence_start_anchor: final choice still depends on
- status: pending
  `);

  assert.equal(parsed.pending.length, 1);
  assert.equal(parsed.pending[0]!.subject, "final choice");
  assert.equal(parsed.pending[0]!.predicate, "depends on");
  assert.equal(parsed.pending[0]!.object, "hotel and rail totals");
  assert.equal(parsed.pending[0]!.relationFamily, "causality");
  assert.deepEqual(parsed.pending[0]!.turnRefs, [14]);
  assert.equal(parsed.pending[0]!.startTurn, 14);
  assert.equal(parsed.pending[0]!.endTurn, undefined);
});
