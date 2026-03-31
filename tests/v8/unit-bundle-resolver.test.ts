import assert from "node:assert/strict";

import { resolveUnitBundles } from "../../src/v8/unit-bundle-resolver.js";
import type { V8GraphNode, V8MemoryItem, V8Unit } from "../../src/v8/types_v8.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("resolveUnitBundles aggregates node energy onto supporting units", () => {
  const activations = new Map([
    ["node_a", 0.62],
    ["node_b", 0.21],
  ]);

  const nodesById = new Map<string, V8GraphNode>([
    ["node_a", {
      id: "node_a",
      memoryType: "entity",
      canonicalLabel: "jwt auth",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_1"],
      evidenceSpanIds: [],
      bestEvidenceSpanIds: [],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    }],
    ["node_b", {
      id: "node_b",
      memoryType: "workflow_validity_state",
      canonicalLabel: "jwt validity",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_2"],
      evidenceSpanIds: [],
      bestEvidenceSpanIds: [],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    }],
  ]);

  const itemsById = new Map<string, V8MemoryItem>([
    ["ir_1", {
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
      confidence: 0.8,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    }],
    ["ir_2", {
      id: "ir_2",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "workflow_validity_state",
      originType: "asserted",
      layer: "micro",
      subject: "jwt",
      predicate: "state_supersedes_state",
      object: "legacy",
      label: "jwt validity",
      qualifiers: { aspect: "auth_scheme" },
      evidenceSpanIds: ["span_2"],
      unitIds: ["unit_1"],
      confidence: 0.9,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    }],
  ]);

  const unitsById = new Map<string, V8Unit>([
    ["unit_1", {
      id: "unit_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 32,
      text: "JWT v2 replaced JWT v1",
      parentUnitId: null,
      language: "en",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    }],
  ]);

  const bundles = resolveUnitBundles({
    activations,
    nodesById,
    itemsById,
    unitsById,
    criticalThreshold: 0.4,
    decisionThreshold: 0.3,
    backgroundThreshold: 0.2,
    maxBundles: 3,
  });

  assert.equal(bundles.length, 1);
  assert.equal(bundles[0]?.bundleId, "unit_1");
  assert.equal(bundles[0]?.tier, "critical");
  assert.deepEqual(bundles[0]?.nodeIds.sort(), ["node_a", "node_b"]);
  assert.deepEqual(bundles[0]?.evidenceSpanIds.sort(), ["span_1", "span_2"]);
});

run("resolveUnitBundles filters unsupported units below thresholds", () => {
  const bundles = resolveUnitBundles({
    activations: new Map([["node_a", 0.1]]),
    nodesById: new Map([
      ["node_a", {
        id: "node_a",
        memoryType: "entity",
        canonicalLabel: "jwt auth",
        aliases: [],
        primaryLayer: "micro",
        layerMemberships: ["micro"],
        sourceItemIds: ["ir_1"],
        evidenceSpanIds: [],
        bestEvidenceSpanIds: [],
        state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
      }],
    ]),
    itemsById: new Map([
      ["ir_1", {
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
        confidence: 0.8,
        scope: "session",
        validity: "active",
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      }],
    ]),
    unitsById: new Map([
      ["unit_1", {
        id: "unit_1",
        narrativeRecordId: "narr_1",
        narrativeRef: "/tmp/narrative.md",
        layer: "micro",
        ordinal: 0,
        charStart: 0,
        charEnd: 32,
        text: "JWT v2 replaced JWT v1",
        parentUnitId: null,
        language: "en",
        role: "assistant",
        timestamp: "2026-03-21T00:00:00.000Z",
        sourceCategory: "conversation",
      }],
    ]),
    criticalThreshold: 0.82,
    decisionThreshold: 0.74,
    backgroundThreshold: 0.68,
    maxBundles: 3,
  });

  assert.equal(bundles.length, 0);
});

run("resolveUnitBundles normalizes support by total source-item count per unit", () => {
  const activations = new Map([
    ["node_dense_a", 0.4],
    ["node_dense_b", 0.4],
    ["node_sparse", 0.4],
  ]);

  const nodesById = new Map<string, V8GraphNode>([
    ["node_dense_a", {
      id: "node_dense_a",
      memoryType: "entity",
      canonicalLabel: "dense a",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_dense_1"],
      evidenceSpanIds: [],
      bestEvidenceSpanIds: [],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    }],
    ["node_dense_b", {
      id: "node_dense_b",
      memoryType: "entity",
      canonicalLabel: "dense b",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_dense_2"],
      evidenceSpanIds: [],
      bestEvidenceSpanIds: [],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    }],
    ["node_sparse", {
      id: "node_sparse",
      memoryType: "entity",
      canonicalLabel: "sparse",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_sparse"],
      evidenceSpanIds: [],
      bestEvidenceSpanIds: [],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    }],
  ]);

  const itemsById = new Map<string, V8MemoryItem>([
    ["ir_dense_1", {
      id: "ir_dense_1",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "entity",
      originType: "asserted",
      layer: "micro",
      subject: "dense",
      predicate: "uses",
      object: "one",
      label: "dense one",
      qualifiers: {},
      evidenceSpanIds: ["span_dense_1"],
      unitIds: ["unit_dense"],
      confidence: 0.8,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    }],
    ["ir_dense_2", {
      id: "ir_dense_2",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "entity",
      originType: "asserted",
      layer: "micro",
      subject: "dense",
      predicate: "uses",
      object: "two",
      label: "dense two",
      qualifiers: {},
      evidenceSpanIds: ["span_dense_2"],
      unitIds: ["unit_dense"],
      confidence: 0.8,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    }],
    ["ir_sparse", {
      id: "ir_sparse",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "entity",
      originType: "asserted",
      layer: "micro",
      subject: "sparse",
      predicate: "uses",
      object: "one",
      label: "sparse one",
      qualifiers: {},
      evidenceSpanIds: ["span_sparse"],
      unitIds: ["unit_sparse"],
      confidence: 0.8,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    }],
  ]);

  const unitsById = new Map<string, V8Unit>([
    ["unit_dense", {
      id: "unit_dense",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 20,
      text: "dense unit",
      parentUnitId: null,
      language: "en",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    }],
    ["unit_sparse", {
      id: "unit_sparse",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 1,
      charStart: 21,
      charEnd: 40,
      text: "sparse unit",
      parentUnitId: null,
      language: "en",
      role: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    }],
  ]);

  const bundles = resolveUnitBundles({
    activations,
    nodesById,
    itemsById,
    unitsById,
    criticalThreshold: 0.7,
    decisionThreshold: 0.39,
    backgroundThreshold: 0.2,
    maxBundles: 4,
  });

  assert.equal(bundles.length, 2);
  const dense = bundles.find((bundle) => bundle.bundleId === "unit_dense");
  const sparse = bundles.find((bundle) => bundle.bundleId === "unit_sparse");
  assert.ok(dense);
  assert.ok(sparse);
  assert.equal(dense?.energy, 0.4);
  assert.equal(sparse?.energy, 0.4);
});
