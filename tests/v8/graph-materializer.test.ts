import assert from "node:assert/strict";

import { materializeGraph } from "../../src/v8/architecture/graph-materializer.js";
import type { V8EvidenceSpan, V8MemoryItem, V8Unit } from "../../src/v8/types_v8.js";

function makeUnit(overrides: Partial<V8Unit> = {}): V8Unit {
  return {
    id: "unit_micro_1",
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    layer: "micro",
    ordinal: 0,
    charStart: 0,
    charEnd: 40,
    text: "JWT v2 replaced JWT v1 after token migration.",
    parentUnitId: null,
    language: "en",
    role: "assistant",
    timestamp: "2026-03-21T00:00:00.000Z",
    sourceCategory: "conversation",
    ...overrides,
  };
}

function makeSpan(id: string, unitId = "unit_micro_1"): V8EvidenceSpan {
  return {
    id,
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    unitId,
    charStart: 0,
    charEnd: 20,
    text: "JWT v2 replaced JWT v1",
    role: "assistant",
    timestamp: "2026-03-21T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 0.9,
  };
}

function makeItem(overrides: Partial<V8MemoryItem> = {}): V8MemoryItem {
  return {
    id: "ir_1",
    narrativeRecordId: "narr_1",
    sourceRef: "/tmp/narrative.md",
    itemType: "workflow_validity_state",
    originType: "asserted",
    layer: "micro",
    subject: "jwt_auth",
    predicate: "state_supersedes_state",
    object: "jwt_auth_legacy",
    label: "jwt auth validity",
    qualifiers: { aspect: "auth_scheme" },
    evidenceSpanIds: ["span_1"],
    unitIds: ["unit_micro_1"],
    confidence: 0.92,
    scope: "session",
    validity: "active",
    createdAt: "2026-03-21T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
    ...overrides,
  };
}

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("materializeGraph emits propagation dimensions for state-transition edges", () => {
  const result = materializeGraph(
    [makeItem()],
    [makeUnit()],
    [makeSpan("span_1")]
  );

  const transitionEdge = result.edges.find((edge) => edge.type === "state_supersedes_state");
  assert.ok(transitionEdge, "expected a state transition edge");
  assert.equal((transitionEdge as any).forwardDimension, "T_forward");
  assert.equal((transitionEdge as any).reverseDimension, "T_backward");
});

run("materializeGraph emits oblique dimensions for line-binding edges", () => {
  const result = materializeGraph(
    [
      makeItem({
        id: "ir_2",
        itemType: "goal",
        predicate: "local_goal_in_objective_line",
        subject: "local_goal",
        object: "platform_reliability",
        label: "goal line",
        evidenceSpanIds: ["span_2"],
        unitIds: ["unit_micro_1"],
      }),
    ],
    [makeUnit()],
    [makeSpan("span_2")]
  );

  const lineBindingEdge = result.edges.find((edge) => edge.type === "local_goal_in_objective_line");
  assert.ok(lineBindingEdge, "expected a line binding edge");
  assert.equal((lineBindingEdge as any).forwardDimension, "O_up");
  assert.equal((lineBindingEdge as any).reverseDimension, "O_down");
});

run("graph nodes and edges keep source item ownership instead of graph-level evidence span ids", () => {
  const result = materializeGraph(
    [makeItem()],
    [makeUnit()],
    [makeSpan("span_1")]
  );

  for (const node of result.nodes) {
    assert.ok(Array.isArray((node as any).sourceItemIds), "node should keep source item ids");
    assert.equal("evidenceSpanIds" in node, false, "graph nodes should not own evidenceSpanIds");
  }

  for (const edge of result.edges) {
    assert.ok(Array.isArray((edge as any).sourceItemIds), "edge should keep source item ids");
    assert.equal("evidenceSpanIds" in edge, false, "graph edges should not own evidenceSpanIds");
  }
});
