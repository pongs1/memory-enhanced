import assert from "node:assert/strict";

import { assembleRecallPrompts } from "../../src/v8/recall.js";
import type { AssembleRecallInput, AssembleRecallOutput, V8ActivatedBundle, V8EvidenceSpan, V8GraphEdge, V8GraphNode } from "../../src/v8/types_v8.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("assembleRecallPrompts supports unit-centered bundles without recall bundle projection", () => {
  const bundle: V8ActivatedBundle = {
    bundleId: "unit_1",
    nodeIds: ["node_auth"],
    tier: "critical",
    energy: 0.91,
    evidenceSpanIds: ["span_1"],
    sourceRefs: ["/tmp/narrative.md"],
  };

  const input: AssembleRecallInput = {
    workspace: ".",
    bundles: [bundle],
    goal: "remember auth state",
    activeTask: "answer current auth question",
    latestUserRequest: "what is the auth status now",
  };

  const node: V8GraphNode = {
    id: "node_auth",
    memoryType: "workflow_validity_state",
    canonicalLabel: "jwt auth valid",
    aliases: [],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_1"],
    evidenceSpanIds: ["span_1"],
    bestEvidenceSpanIds: ["span_1"],
    state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
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

  const context = {
    nodesById: new Map<string, V8GraphNode>([[node.id, node]]),
    evidenceById: new Map<string, V8EvidenceSpan>([[span.id, span]]),
    edges: [] as V8GraphEdge[],
    edgesByNode: new Map<string, V8GraphEdge[]>(),
    edgeKinds: new Map<string, any>(),
    policyByKindMode: new Map<string, any>(),
    recallBundlesById: new Map<string, any>(),
    hypothesisByNode: new Map<string, any>(),
    packCacheById: new Map<string, any>(),
  } as Parameters<typeof assembleRecallPrompts>[1];

  const outputs: AssembleRecallOutput[] = assembleRecallPrompts(input, context);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.bundleId, "unit_1");
  assert.deepEqual(outputs[0]?.nodeIds, ["node_auth"]);
  assert.match(outputs[0]?.prompt || "", /JWT v2 replaced JWT v1/);
});

run("assembleRecallPrompts trajectory mode can backtrace through sourceItemIds when graph nodes do not carry spans", () => {
  const bundle: import("../../src/v8/types_v8.js").V8ActivatedBundle = {
    bundleId: "unit_2",
    nodeIds: ["node_auth_fallback"],
    sourceUnitIds: ["unit_2"],
    tier: "background",
    energy: 0.7,
    evidenceSpanIds: [],
    sourceRefs: ["/tmp/narrative.md"],
  };

  const node = {
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

  const span = {
    id: "span_fallback",
    narrativeRecordId: "narr_1",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_2",
    charStart: 0,
    charEnd: 24,
    text: "JWT fallback evidence",
    role: "assistant",
    timestamp: "2026-03-21T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 0.9,
  };

  const context = {
    nodesById: new Map([[node.id, node]]),
    evidenceById: new Map([[span.id, span]]),
    edges: [],
    edgesByNode: new Map(),
    edgeKinds: new Map(),
    policyByKindMode: new Map(),
    recallBundlesById: new Map(),
    hypothesisByNode: new Map(),
    itemsById: new Map([[
      "ir_fallback",
      {
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
        unitIds: ["unit_2"],
        confidence: 0.9,
        scope: "session",
        validity: "active",
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      },
    ]]),
    packCacheById: new Map(),
  } as Parameters<typeof assembleRecallPrompts>[1];

  const outputs = assembleRecallPrompts(
    {
      workspace: ".",
      bundles: [bundle],
      goal: "auth",
      activeTask: "trace auth",
      latestUserRequest: "what changed",
      mode: "trajectory",
    },
    context
  );

  assert.equal(outputs.length, 1);
  assert.match(outputs[0]?.prompt || "", /JWT fallback evidence/);
});

run("assembleRecallPrompts backtraces through geometry dimensions without explicit recall mode", () => {
  const stateEdge: V8GraphEdge = {
    id: "edge_state_line",
    src: "node_previous",
    dst: "node_current",
    type: "state_supersedes_state",
    layer: "micro",
    originType: "inferred",
    sourceItemIds: ["ir_current", "ir_previous"],
    evidenceSpanIds: [],
    qualifiers: { aspect: "auth_scheme" },
    confidence: 0.9,
    state: { scope: "session", validity: "active" },
    forwardDimension: "T_forward",
    reverseDimension: "T_backward",
  };

  const bundle: import("../../src/v8/types_v8.js").V8ActivatedBundle = {
    bundleId: "unit_current",
    nodeIds: ["node_current"],
    sourceUnitIds: ["unit_current"],
    tier: "decision",
    energy: 0.76,
    evidenceSpanIds: ["span_current"],
    sourceRefs: ["/tmp/narrative.md"],
  };

  const currentNode = {
    id: "node_current",
    memoryType: "workflow_validity_state",
    canonicalLabel: "jwt v2 active",
    aliases: [],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_current"],
    evidenceSpanIds: [],
    bestEvidenceSpanIds: [],
    state: { scope: "session", validity: "active", confidence: 0.92, supportCount: 1 },
  };

  const previousNode = {
    id: "node_previous",
    memoryType: "workflow_validity_state",
    canonicalLabel: "jwt v1 active",
    aliases: [],
    primaryLayer: "micro",
    layerMemberships: ["micro"],
    sourceItemIds: ["ir_previous"],
    evidenceSpanIds: [],
    bestEvidenceSpanIds: [],
    state: { scope: "session", validity: "inactive", confidence: 0.88, supportCount: 1 },
  };

  const spanCurrent = {
    id: "span_current",
    narrativeRecordId: "narr_current",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_current",
    charStart: 0,
    charEnd: 14,
    text: "JWT v2 active",
    role: "assistant",
    timestamp: "2026-03-21T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 0.92,
  };

  const spanPrevious = {
    id: "span_previous",
    narrativeRecordId: "narr_previous",
    narrativeRef: "/tmp/narrative.md",
    unitId: "unit_previous",
    charStart: 15,
    charEnd: 43,
    text: "JWT v1 was active before",
    role: "assistant",
    timestamp: "2026-03-20T00:00:00.000Z",
    sourceClass: "raw",
    sourceType: "session_narrative",
    score: 0.89,
  };

  const context = {
    nodesById: new Map([
      [currentNode.id, currentNode],
      [previousNode.id, previousNode],
    ]),
    evidenceById: new Map([
      [spanCurrent.id, spanCurrent],
      [spanPrevious.id, spanPrevious],
    ]),
    edges: [stateEdge],
    edgesByNode: new Map([
      ["node_current", [stateEdge]],
      ["node_previous", [stateEdge]],
    ]),
    edgeKinds: new Map([["state_supersedes_state", "change"]]),
    policyByKindMode: new Map(),
    recallBundlesById: new Map(),
    hypothesisByNode: new Map(),
    itemsById: new Map([
      ["ir_current", {
        id: "ir_current",
        narrativeRecordId: "narr_current",
        sourceRef: "/tmp/narrative.md",
        itemType: "workflow_validity_state",
        originType: "asserted",
        layer: "micro",
        subject: "jwt",
        predicate: "state_supersedes_state",
        object: "jwt_v1",
        label: "jwt v2 active",
        qualifiers: { aspect: "auth_scheme" },
        evidenceSpanIds: ["span_current"],
        unitIds: ["unit_current"],
        confidence: 0.92,
        scope: "session",
        validity: "active",
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      }],
      ["ir_previous", {
        id: "ir_previous",
        narrativeRecordId: "narr_previous",
        sourceRef: "/tmp/narrative.md",
        itemType: "workflow_validity_state",
        originType: "asserted",
        layer: "micro",
        subject: "jwt",
        predicate: "state_supersedes_state",
        object: "jwt_v2",
        label: "jwt v1 active",
        qualifiers: { aspect: "auth_scheme" },
        evidenceSpanIds: ["span_previous"],
        unitIds: ["unit_previous"],
        confidence: 0.88,
        scope: "session",
        validity: "inactive",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
      }],
    ]),
    packCacheById: new Map(),
  } as unknown as Parameters<typeof assembleRecallPrompts>[1];

  const outputs = assembleRecallPrompts(
    {
      workspace: ".",
      bundles: [bundle],
      goal: "auth",
      activeTask: "explain state transition",
      latestUserRequest: "what changed in auth",
    },
    context
  );

  assert.equal(outputs.length, 1);
  assert.match(outputs[0]?.prompt || "", /JWT v1 was active before/);
});

run("assembleRecallPrompts trajectory mode still backtraces through geometry when policy map is empty", () => {
  const stateEdge: V8GraphEdge = {
    id: "edge_state_line_policyless",
    src: "node_old",
    dst: "node_new",
    type: "state_supersedes_state",
    layer: "micro",
    originType: "inferred",
    sourceItemIds: ["ir_old", "ir_new"],
    evidenceSpanIds: [],
    qualifiers: { aspect: "auth_scheme" },
    confidence: 0.9,
    state: { scope: "session", validity: "active" },
    forwardDimension: "T_forward",
    reverseDimension: "T_backward",
  };

  const context = {
    nodesById: new Map([
      ["node_old", {
        id: "node_old",
        memoryType: "workflow_validity_state",
        canonicalLabel: "jwt v1 active",
        aliases: [],
        primaryLayer: "micro",
        layerMemberships: ["micro"],
        sourceItemIds: ["ir_old"],
        evidenceSpanIds: [],
        bestEvidenceSpanIds: [],
        state: { scope: "session", validity: "superseded", confidence: 0.85, supportCount: 1 },
      }],
      ["node_new", {
        id: "node_new",
        memoryType: "workflow_validity_state",
        canonicalLabel: "jwt v2 active",
        aliases: [],
        primaryLayer: "micro",
        layerMemberships: ["micro"],
        sourceItemIds: ["ir_new"],
        evidenceSpanIds: [],
        bestEvidenceSpanIds: [],
        state: { scope: "session", validity: "active", confidence: 0.93, supportCount: 1 },
      }],
    ]),
    evidenceById: new Map([
      ["span_old", {
        id: "span_old",
        narrativeRecordId: "narr_old",
        narrativeRef: "/tmp/narrative.md",
        unitId: "unit_old",
        charStart: 0,
        charEnd: 22,
        text: "JWT v1 was active before",
        role: "assistant",
        timestamp: "2026-03-20T00:00:00.000Z",
        sourceClass: "raw",
        sourceType: "session_narrative",
        score: 0.88,
      }],
      ["span_new", {
        id: "span_new",
        narrativeRecordId: "narr_new",
        narrativeRef: "/tmp/narrative.md",
        unitId: "unit_new",
        charStart: 23,
        charEnd: 37,
        text: "JWT v2 active",
        role: "assistant",
        timestamp: "2026-03-21T00:00:00.000Z",
        sourceClass: "raw",
        sourceType: "session_narrative",
        score: 0.93,
      }],
    ]),
    edges: [stateEdge],
    edgesByNode: new Map([
      ["node_old", [stateEdge]],
      ["node_new", [stateEdge]],
    ]),
    edgeKinds: new Map([["state_supersedes_state", "change"]]),
    policyByKindMode: new Map(),
    recallBundlesById: new Map(),
    hypothesisByNode: new Map(),
    itemsById: new Map([
      ["ir_old", {
        id: "ir_old",
        narrativeRecordId: "narr_old",
        sourceRef: "/tmp/narrative.md",
        itemType: "workflow_validity_state",
        originType: "asserted",
        layer: "micro",
        subject: "jwt",
        predicate: "state_supersedes_state",
        object: "jwt_v2",
        label: "jwt v1 active",
        qualifiers: { aspect: "auth_scheme" },
        evidenceSpanIds: ["span_old"],
        unitIds: ["unit_old"],
        confidence: 0.88,
        scope: "session",
        validity: "superseded",
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
      }],
      ["ir_new", {
        id: "ir_new",
        narrativeRecordId: "narr_new",
        sourceRef: "/tmp/narrative.md",
        itemType: "workflow_validity_state",
        originType: "asserted",
        layer: "micro",
        subject: "jwt",
        predicate: "state_supersedes_state",
        object: "jwt_v1",
        label: "jwt v2 active",
        qualifiers: { aspect: "auth_scheme" },
        evidenceSpanIds: ["span_new"],
        unitIds: ["unit_new"],
        confidence: 0.93,
        scope: "session",
        validity: "active",
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      }],
    ]),
    packCacheById: new Map(),
  } as unknown as Parameters<typeof assembleRecallPrompts>[1];

  const outputs = assembleRecallPrompts(
    {
      workspace: ".",
      bundles: [{
        bundleId: "unit_new",
        nodeIds: ["node_new"],
        sourceUnitIds: ["unit_new"],
        tier: "decision",
        energy: 0.8,
        evidenceSpanIds: ["span_new"],
        sourceRefs: ["/tmp/narrative.md"],
      }],
      goal: "auth",
      activeTask: "trace state line",
      latestUserRequest: "how did auth change",
      mode: "trajectory",
    },
    context
  );

  assert.equal(outputs.length, 1);
  assert.match(outputs[0]?.prompt || "", /JWT v1 was active before/);
});


