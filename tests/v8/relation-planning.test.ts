import assert from "node:assert/strict";

import { buildRelationPlanningArtifacts } from "../../src/v8/architecture/relation-planning.js";
import type { V8EvidenceSpan, V8GraphNode, V8MemoryItem } from "../../src/v8/types_v8.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("buildRelationPlanningArtifacts can derive postings from memoryItems when graph nodes do not carry spans", () => {
  const node: V8GraphNode = {
    id: "node_sem_1",
    memoryType: "entity",
    canonicalLabel: "jwt auth",
    aliases: [],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_1"],
    evidenceSpanIds: [],
    bestEvidenceSpanIds: [],
    state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
  };

  const item: V8MemoryItem = {
    id: "ir_1",
    narrativeRecordId: "narr_1",
    sourceRef: "/tmp/narrative.md",
    itemType: "entity",
    originType: "asserted",
    layer: "micro",
    subject: "jwt",
    predicate: "uses",
    object: "auth",
    label: "jwt auth",
    qualifiers: {},
    evidenceSpanIds: ["span_1"],
    unitIds: ["unit_1"],
    confidence: 0.9,
    scope: "session",
    validity: "active",
    createdAt: "2026-03-21T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
  };

  const span: V8EvidenceSpan = {
    id: "span_1",
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_1",
    charStart: 0,
    charEnd: 20,
    text: "JWT auth evidence",
    role: "assistant",
    timestamp: "2026-03-21T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 0.9,
  };

  const artifacts = buildRelationPlanningArtifacts({
    nodes: [node],
    edges: [],
    evidenceSpans: [span],
    memoryItems: [item],
    compilePhase: "final",
  });

  assert.ok(artifacts.entityPostings.length > 0);
  assert.ok(artifacts.relationSearchPlans.length > 0);
});

run("buildRelationPlanningArtifacts does not inject item-type priors into edge hints or query terms", () => {
  const node: V8GraphNode = {
    id: "node_sem_goal_1",
    memoryType: "goal",
    canonicalLabel: "plan trip",
    aliases: [],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_goal_1"],
    evidenceSpanIds: ["span_goal_1"],
    bestEvidenceSpanIds: ["span_goal_1"],
    state: { scope: "session", validity: "active", confidence: 0.8, supportCount: 1 },
  };

  const item: V8MemoryItem = {
    id: "ir_goal_1",
    narrativeRecordId: "narr_1",
    sourceRef: "/tmp/narrative.md",
    itemType: "goal",
    originType: "asserted",
    layer: "micro",
    subject: "Tim",
    predicate: "targets",
    object: "trip plan",
    label: "plan trip",
    qualifiers: {},
    evidenceSpanIds: ["span_goal_1"],
    unitIds: ["unit_goal_1"],
    confidence: 0.8,
    scope: "session",
    validity: "active",
    createdAt: "2026-03-21T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
  };

  const span: V8EvidenceSpan = {
    id: "span_goal_1",
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_goal_1",
    charStart: 0,
    charEnd: 9,
    text: "plan trip",
    role: "assistant",
    timestamp: "2026-03-21T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 0.8,
  };

  const artifacts = buildRelationPlanningArtifacts({
    nodes: [node],
    edges: [],
    evidenceSpans: [span],
    memoryItems: [item],
    compilePhase: "final",
  });

  const scopeCard = artifacts.entityScopeCards.find((card) => card.entityNodeId === "node_sem_goal_1");
  assert.ok(scopeCard);
  assert.deepEqual(scopeCard?.edgeFamilyHints ?? [], []);

  const plan = artifacts.relationSearchPlans.find((candidate) =>
    candidate.anchorNodeIds.includes("node_sem_goal_1")
  );
  assert.ok(plan);
  assert.ok(!(plan?.queryTerms || []).includes("goal"));
  assert.ok(!(plan?.queryTerms || []).includes("targets"));
  assert.ok(!(plan?.queryTerms || []).includes("requires"));
});

run("buildRelationPlanningArtifacts only admits semantic nodes and explicit state nodes as anchors", () => {
  const nodes: V8GraphNode[] = [
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
      id: "node_state_topic_1",
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
      id: "node_sem_1",
      memoryType: "entity",
      canonicalLabel: "Kyoto",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: [],
      evidenceSpanIds: ["span_sem_1"],
      bestEvidenceSpanIds: ["span_sem_1"],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    },
  ];

  const memoryItems: V8MemoryItem[] = [
    {
      id: "ir_goal_1",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "goal",
      originType: "asserted",
      layer: "micro",
      subject: "Tim",
      predicate: "targets",
      object: "trip plan",
      label: "plan trip",
      qualifiers: {},
      evidenceSpanIds: ["span_goal_1"],
      unitIds: ["unit_goal_1"],
      confidence: 0.8,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
    {
      id: "ir_state_1",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "topic_state",
      originType: "asserted",
      layer: "micro",
      subject: "destination decision",
      predicate: "state_refines_state",
      object: "open choice",
      label: "destination decision still open",
      qualifiers: {},
      evidenceSpanIds: ["span_state_1"],
      unitIds: ["unit_state_1"],
      confidence: 0.85,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
  ];

  const evidenceSpans: V8EvidenceSpan[] = [
    {
      id: "span_goal_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_goal_1",
      charStart: 0,
      charEnd: 9,
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
      charStart: 10,
      charEnd: 40,
      text: "destination decision still open",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.85,
    },
    {
      id: "span_sem_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_sem_1",
      charStart: 41,
      charEnd: 46,
      text: "Kyoto",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    },
  ];

  const artifacts = buildRelationPlanningArtifacts({
    nodes,
    edges: [],
    evidenceSpans,
    memoryItems,
    compilePhase: "final",
  });

  const anchorIds = new Set(artifacts.entityScopeCards.map((card) => card.entityNodeId));
  assert.ok(!anchorIds.has("node_edge_goal_1"));
  assert.ok(anchorIds.has("node_state_topic_1"));
  assert.ok(anchorIds.has("node_sem_1"));
});
