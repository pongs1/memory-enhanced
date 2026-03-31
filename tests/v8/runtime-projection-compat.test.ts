import assert from "node:assert/strict";

import { buildRuntimeProjections } from "../../src/v8/architecture/runtime-projection.js";
import type { V8EvidenceSpan, V8GraphEdge, V8GraphNode } from "../../src/v8/types_v8.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("buildRuntimeProjections can derive serving text from graph nodes without relying on recall bundle membership", () => {
  const node: V8GraphNode = {
    id: "node_auth",
    memoryType: "workflow_validity_state",
    canonicalLabel: "jwt auth valid",
    aliases: ["authentication"],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_1"],
    evidenceSpanIds: ["span_1"],
    bestEvidenceSpanIds: ["span_1"],
    state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
  };

  const edge: V8GraphEdge = {
    id: "edge_1",
    type: "state_supersedes_state",
    src: "node_auth",
    dst: "node_auth_prev",
    layer: "cross",
    originType: "inferred",
    sourceItemIds: ["ir_1"],
    evidenceSpanIds: ["span_1"],
    qualifiers: { aspect: "auth_scheme" },
    confidence: 0.8,
    forwardDimension: "T_forward",
    reverseDimension: "T_backward",
    state: { scope: "session", validity: "active" },
  };

  const span: V8EvidenceSpan = {
    id: "span_1",
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_1",
    charStart: 0,
    charEnd: 24,
    text: "JWT v2 replaced JWT v1",
    role: "assistant",
    timestamp: "2026-03-21T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 0.9,
  };

  const result = buildRuntimeProjections({
    nodes: [node],
    edges: [edge],
    evidenceSpans: [span],
  });

  assert.ok(result.ignitionNodes.length > 0);
  assert.equal(result.ignitionNodes[0]?.nodeId, "node_auth");
  assert.ok((result.ignitionNodes[0]?.triggerTerms || []).includes("jwt"));
});

run("buildRuntimeProjections falls back to memoryItems evidence spans when graph nodes do not carry them", () => {
  const node: V8GraphNode = {
    id: "node_auth_fallback",
    memoryType: "workflow_validity_state",
    canonicalLabel: "jwt auth valid",
    aliases: [],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_fallback"],
    evidenceSpanIds: [],
    bestEvidenceSpanIds: [],
    state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
  };

  const result = buildRuntimeProjections({
    nodes: [node],
    edges: [],
    evidenceSpans: [{
      id: "span_fallback",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_fallback",
      charStart: 0,
      charEnd: 24,
      text: "JWT fallback evidence",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    }],
    memoryItems: [{
      id: "ir_fallback",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "workflow_validity_state",
      originType: "asserted",
      layer: "micro",
      subject: "jwt",
      predicate: "state_supersedes_state",
      object: "legacy",
      label: "jwt auth valid",
      qualifiers: { aspect: "auth_scheme" },
      evidenceSpanIds: ["span_fallback"],
      unitIds: ["unit_fallback"],
      confidence: 0.9,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    }],
  });

  assert.equal(result.ignitionNodes[0]?.bundleId, "unit_fallback");
  assert.deepEqual(result.ignitionNodes[0]?.evidenceSpanIds, ["span_fallback"]);
  assert.equal(result.ignitionNodes[0]?.sourceRef, "/tmp/narrative.md");
  assert.equal(result.ignitionNodes[0]?.dayKey, "2026-03-21");
  assert.equal(result.ignitionNodes[0]?.kind, "episodic");
});

run("buildRuntimeProjections tolerates nodes without bestEvidenceSpanIds", () => {
  const node = {
    id: "node_missing_best_spans",
    memoryType: "discourse_unit",
    canonicalLabel: "Missing best evidence spans should not throw.",
    aliases: [],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_missing_best_spans"],
    evidenceSpanIds: [],
    state: { scope: "session", validity: "active", confidence: 0.34, supportCount: 1 },
  } as unknown as V8GraphNode;

  const result = buildRuntimeProjections({
    nodes: [node],
    edges: [],
    evidenceSpans: [{
      id: "span_missing_best_spans",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_missing_best_spans",
      charStart: 0,
      charEnd: 44,
      text: "Missing best evidence spans should not throw.",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.34,
    }],
    memoryItems: [{
      id: "ir_missing_best_spans",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "discourse_unit",
      originType: "aggregated",
      layer: "micro",
      subject: "unknown",
      predicate: "summarizes",
      object: "Missing best evidence spans should not throw.",
      label: "Missing best evidence spans should not throw.",
      qualifiers: {},
      evidenceSpanIds: ["span_missing_best_spans"],
      unitIds: ["unit_missing_best_spans"],
      confidence: 0.34,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    }],
  });

  assert.equal(result.ignitionNodes[0]?.bundleId, "unit_missing_best_spans");
});

run("buildRuntimeProjections excludes legacy control item-edge shortcuts from ignition candidates", () => {
  const nodes: V8GraphNode[] = [
    {
      id: "node_edge_pref_1",
      memoryType: "preference",
      canonicalLabel: "prefers Kyoto",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_pref_1"],
      evidenceSpanIds: ["span_pref_1"],
      bestEvidenceSpanIds: ["span_pref_1"],
      state: { scope: "session", validity: "active", confidence: 0.7, supportCount: 1 },
    },
    {
      id: "node_edge_open_1",
      memoryType: "open_question",
      canonicalLabel: "open destination question",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_open_1"],
      evidenceSpanIds: ["span_open_1"],
      bestEvidenceSpanIds: ["span_open_1"],
      state: { scope: "session", validity: "active", confidence: 0.7, supportCount: 1 },
    },
    {
      id: "node_edge_act_1",
      memoryType: "conversation_act",
      canonicalLabel: "asks for recommendation",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_act_1"],
      evidenceSpanIds: ["span_act_1"],
      bestEvidenceSpanIds: ["span_act_1"],
      state: { scope: "session", validity: "active", confidence: 0.7, supportCount: 1 },
    },
    {
      id: "node_edge_goal_1",
      memoryType: "goal",
      canonicalLabel: "plan trip",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_goal_1"],
      evidenceSpanIds: ["span_goal_1"],
      bestEvidenceSpanIds: ["span_goal_1"],
      state: { scope: "session", validity: "active", confidence: 0.8, supportCount: 1 },
    },
    {
      id: "node_edge_state_1",
      memoryType: "topic_state",
      canonicalLabel: "destination decision still open",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_state_1"],
      evidenceSpanIds: ["span_state_1"],
      bestEvidenceSpanIds: ["span_state_1"],
      state: { scope: "session", validity: "active", confidence: 0.85, supportCount: 1 },
    },
    {
      id: "node_sem_entity_1",
      memoryType: "entity",
      canonicalLabel: "Kyoto",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: [],
      evidenceSpanIds: ["span_entity_1"],
      bestEvidenceSpanIds: ["span_entity_1"],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    },
  ];

  const evidenceSpans: V8EvidenceSpan[] = [
    {
      id: "span_pref_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_pref_1",
      charStart: 0,
      charEnd: 12,
      text: "prefers Kyoto",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.7,
    },
    {
      id: "span_open_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_open_1",
      charStart: 13,
      charEnd: 34,
      text: "open destination question",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.7,
    },
    {
      id: "span_act_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_act_1",
      charStart: 35,
      charEnd: 58,
      text: "asks for recommendation",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.7,
    },
    {
      id: "span_goal_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_goal_1",
      charStart: 59,
      charEnd: 68,
      text: "plan trip",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.8,
    },
    {
      id: "span_state_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_state_1",
      charStart: 69,
      charEnd: 99,
      text: "destination decision still open",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.85,
    },
    {
      id: "span_entity_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_entity_1",
      charStart: 100,
      charEnd: 105,
      text: "Kyoto",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    },
  ];

  const result = buildRuntimeProjections({
    nodes,
    edges: [],
    evidenceSpans,
  });

  const projectedIds = new Set(result.ignitionNodes.map((node) => node.nodeId));
  const bundlesById = new Map(result.recallBundles.map((bundle) => [bundle.bundleId, bundle]));

  assert.ok(!projectedIds.has("node_edge_pref_1"));
  assert.ok(!projectedIds.has("node_edge_open_1"));
  assert.ok(!projectedIds.has("node_edge_act_1"));
  assert.ok(!projectedIds.has("node_edge_goal_1"));
  assert.ok(projectedIds.has("node_edge_state_1"));
  assert.ok(projectedIds.has("node_sem_entity_1"));
  assert.equal(bundlesById.get("unit_goal_1"), undefined);
  assert.equal(bundlesById.get("unit_entity_1")?.packType, "raw_evidence");
  assert.equal(bundlesById.get("unit_state_1")?.packType, "state");
});
