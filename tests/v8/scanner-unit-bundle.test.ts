import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { V8GraphScanner } from "../../src/v8/scanner.js";

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
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

run("scanner resolves activated nodes onto unit-centered bundles", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-scanner-"));
  const memoryDir = path.join(workspace, ".memory");
  const graphDir = path.join(memoryDir, "graph");
  const runtimeDir = path.join(memoryDir, "runtime");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  writeJsonl(path.join(graphDir, "graph_nodes.jsonl"), [
    {
      id: "node_auth",
      memoryType: "workflow_validity_state",
      canonicalLabel: "jwt auth",
      aliases: ["authentication"],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_1"],
      evidenceSpanIds: ["span_1"],
      bestEvidenceSpanIds: ["span_1"],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    },
  ]);

  writeJsonl(path.join(graphDir, "graph_edges.jsonl"), []);
  writeJsonl(path.join(graphDir, "memory_items.jsonl"), [
    {
      id: "ir_1",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "workflow_validity_state",
      originType: "asserted",
      layer: "micro",
      subject: "jwt",
      predicate: "state_supersedes_state",
      object: "legacy",
      label: "jwt auth",
      qualifiers: { aspect: "auth_scheme" },
      evidenceSpanIds: ["span_1"],
      unitIds: ["unit_1"],
      confidence: 0.9,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
  ]);

  writeJsonl(path.join(graphDir, "units.jsonl"), [
    {
      id: "unit_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 24,
      text: "JWT v2 replaced JWT v1",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ]);

  writeJsonl(path.join(graphDir, "evidence_spans.jsonl"), [
    {
      id: "span_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_1",
      charStart: 0,
      charEnd: 24,
      text: "JWT v2 replaced JWT v1",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    },
  ]);

  fs.writeFileSync(path.join(runtimeDir, "feedback_overrides.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "hypothesis_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_nodes.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "recall_bundles.jsonl"), "", "utf8");

  const scanner = new V8GraphScanner(workspace, { scanIntervalChars: 1, maxInjectedBundles: 3, criticalThreshold: 0.2, decisionThreshold: 0.1, backgroundThreshold: 0.05 });
  scanner.preExcite("jwt auth", { goal: "auth", activeTask: "auth", latestUserRequest: "auth" });
  const result = scanner.processChunk("jwt", { goal: "auth", activeTask: "auth", latestUserRequest: "auth" });

  assert.ok(result.activatedBundles.length > 0);
  assert.equal(result.activatedBundles[0]?.bundleId, "unit_1");
  assert.deepEqual(result.activatedBundles[0]?.nodeIds, ["node_auth"]);
});

run("scanner compatibility group bundles carry sourceUnitIds when group merge happens", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-scanner-group-"));
  const memoryDir = path.join(workspace, ".memory");
  const graphDir = path.join(memoryDir, "graph");
  const runtimeDir = path.join(memoryDir, "runtime");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  writeJsonl(path.join(graphDir, "graph_nodes.jsonl"), [
    {
      id: "node_auth",
      memoryType: "workflow_validity_state",
      canonicalLabel: "jwt auth",
      aliases: ["authentication"],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_1"],
      evidenceSpanIds: ["span_1"],
      bestEvidenceSpanIds: ["span_1"],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    },
    {
      id: "node_policy",
      memoryType: "constraint",
      canonicalLabel: "token policy",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_2"],
      evidenceSpanIds: ["span_2"],
      bestEvidenceSpanIds: ["span_2"],
      state: { scope: "session", validity: "active", confidence: 0.88, supportCount: 1 },
    },
  ]);

  writeJsonl(path.join(graphDir, "graph_edges.jsonl"), [
    {
      id: "edge_1",
      type: "supports",
      src: "node_auth",
      dst: "node_policy",
      layer: "micro",
      originType: "asserted",
      sourceItemIds: ["ir_1", "ir_2"],
      evidenceSpanIds: ["span_1", "span_2"],
      qualifiers: {},
      confidence: 0.8,
      forwardDimension: "H",
      reverseDimension: "H",
      state: { scope: "session", validity: "active" },
    },
  ]);
  writeJsonl(path.join(graphDir, "memory_items.jsonl"), [
    {
      id: "ir_1",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "workflow_validity_state",
      originType: "asserted",
      layer: "micro",
      subject: "jwt",
      predicate: "state_supersedes_state",
      object: "legacy",
      label: "jwt auth",
      qualifiers: { aspect: "auth_scheme" },
      evidenceSpanIds: ["span_1"],
      unitIds: ["unit_1"],
      confidence: 0.9,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
    {
      id: "ir_2",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "constraint",
      originType: "asserted",
      layer: "micro",
      subject: "token",
      predicate: "supports",
      object: "policy",
      label: "token policy",
      qualifiers: {},
      evidenceSpanIds: ["span_2"],
      unitIds: ["unit_2"],
      confidence: 0.88,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
  ]);
  writeJsonl(path.join(graphDir, "units.jsonl"), [
    {
      id: "unit_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 24,
      text: "JWT v2 replaced JWT v1",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    },
    {
      id: "unit_2",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 1,
      charStart: 25,
      charEnd: 44,
      text: "Token policy updated",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ]);
  writeJsonl(path.join(graphDir, "evidence_spans.jsonl"), [
    {
      id: "span_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_1",
      charStart: 0,
      charEnd: 24,
      text: "JWT v2 replaced JWT v1",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    },
    {
      id: "span_2",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_2",
      charStart: 25,
      charEnd: 44,
      text: "Token policy updated",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.88,
    },
  ]);
  writeJsonl(path.join(runtimeDir, "recall_bundles.jsonl"), [{
    bundleId: "group_1",
    title: "jwt auth group",
    kind: "semantic",
    nodeIds: ["node_auth", "node_policy"],
    sourceRefs: ["/tmp/narrative.md"],
    evidenceSpanIds: ["span_1", "span_2"],
    bestEvidenceSpanIds: ["span_1", "span_2"],
    summaryText: "jwt auth group",
    packType: "state",
  }]);
  fs.writeFileSync(path.join(runtimeDir, "feedback_overrides.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "hypothesis_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_nodes.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_edges.jsonl"), "", "utf8");

  const scanner = new V8GraphScanner(workspace, {
    scanIntervalChars: 1,
    maxInjectedBundles: 3,
    criticalThreshold: 0.2,
    decisionThreshold: 0.1,
    backgroundThreshold: 0.05,
    groupTriggerScoreThreshold: 0.0,
    groupEnergyGain: 1.2,
  });
  scanner.preExcite("jwt auth token policy", { goal: "auth", activeTask: "auth", latestUserRequest: "auth" });
  const result = scanner.processChunk("jwt token", { goal: "auth", activeTask: "auth", latestUserRequest: "auth" });

  const groupBundle = result.activatedBundles.find((bundle) => bundle.bundleId === "group_1");
  assert.ok(groupBundle);
  assert.deepEqual((groupBundle?.sourceUnitIds || []).sort(), ["unit_1", "unit_2"]);
});

run("scanner propagates across geometry dimensions even when mode policy map is empty", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-scanner-geometry-"));
  const memoryDir = path.join(workspace, ".memory");
  const graphDir = path.join(memoryDir, "graph");
  const runtimeDir = path.join(memoryDir, "runtime");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  writeJsonl(path.join(graphDir, "graph_nodes.jsonl"), [
    {
      id: "node_previous",
      memoryType: "workflow_validity_state",
      canonicalLabel: "jwt legacy state",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_previous"],
      evidenceSpanIds: ["span_previous"],
      bestEvidenceSpanIds: ["span_previous"],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    },
    {
      id: "node_current",
      memoryType: "workflow_validity_state",
      canonicalLabel: "token rotation active",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_current"],
      evidenceSpanIds: ["span_current"],
      bestEvidenceSpanIds: ["span_current"],
      state: { scope: "session", validity: "active", confidence: 0.92, supportCount: 1 },
    },
  ]);

  writeJsonl(path.join(graphDir, "graph_edges.jsonl"), [
    {
      id: "edge_state_line",
      type: "state_supersedes_state",
      src: "node_previous",
      dst: "node_current",
      layer: "micro",
      originType: "asserted",
      sourceItemIds: ["ir_previous", "ir_current"],
      evidenceSpanIds: ["span_previous", "span_current"],
      qualifiers: { aspect: "auth_scheme" },
      confidence: 0.95,
      forwardDimension: "T_forward",
      reverseDimension: "T_backward",
      state: { scope: "session", validity: "active" },
    },
  ]);

  writeJsonl(path.join(graphDir, "memory_items.jsonl"), [
    {
      id: "ir_previous",
      narrativeRecordId: "narr_1",
      sourceRef: "/tmp/narrative.md",
      itemType: "workflow_validity_state",
      originType: "asserted",
      layer: "micro",
      subject: "auth",
      predicate: "state_supersedes_state",
      object: "legacy",
      label: "jwt legacy state",
      qualifiers: { aspect: "auth_scheme" },
      evidenceSpanIds: ["span_previous"],
      unitIds: ["unit_previous"],
      confidence: 0.9,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
    {
      id: "ir_current",
      narrativeRecordId: "narr_2",
      sourceRef: "/tmp/narrative.md",
      itemType: "workflow_validity_state",
      originType: "asserted",
      layer: "micro",
      subject: "auth",
      predicate: "state_supersedes_state",
      object: "rotation",
      label: "token rotation active",
      qualifiers: { aspect: "auth_scheme" },
      evidenceSpanIds: ["span_current"],
      unitIds: ["unit_current"],
      confidence: 0.92,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
  ]);

  writeJsonl(path.join(graphDir, "units.jsonl"), [
    {
      id: "unit_previous",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 18,
      text: "JWT legacy state",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    },
    {
      id: "unit_current",
      narrativeRecordId: "narr_2",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 1,
      charStart: 19,
      charEnd: 40,
      text: "Token rotation active",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ]);

  writeJsonl(path.join(graphDir, "evidence_spans.jsonl"), [
    {
      id: "span_previous",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_previous",
      charStart: 0,
      charEnd: 18,
      text: "JWT legacy state",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    },
    {
      id: "span_current",
      narrativeRecordId: "narr_2",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_current",
      charStart: 19,
      charEnd: 40,
      text: "Token rotation active",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.92,
    },
  ]);

  fs.writeFileSync(path.join(runtimeDir, "feedback_overrides.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "hypothesis_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_nodes.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "recall_bundles.jsonl"), "", "utf8");

  const scanner = new V8GraphScanner(workspace, {
    scanIntervalChars: 1,
    maxInjectedBundles: 3,
    criticalThreshold: 0.2,
    decisionThreshold: 0.1,
    backgroundThreshold: 0.05,
  });

  (scanner as any).graph.policyByKindMode = new Map();

  scanner.preExcite("jwt legacy", { goal: "auth", activeTask: "auth", latestUserRequest: "auth" });
  const result = scanner.processChunk("legacy", { goal: "auth", activeTask: "auth", latestUserRequest: "auth" });

  const currentBundle = result.activatedBundles.find((bundle) => bundle.bundleId === "unit_current");
  assert.ok(currentBundle, "current state unit should still activate through T_forward geometry");
  assert.equal(result.activatedBundles[0]?.bundleId, "unit_current");
});

run("scanner keeps episodic nodes available when no active day keys are established", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-scanner-episodic-"));
  const memoryDir = path.join(workspace, ".memory");
  const graphDir = path.join(memoryDir, "graph");
  const runtimeDir = path.join(memoryDir, "runtime");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  writeJsonl(path.join(graphDir, "graph_nodes.jsonl"), [
    {
      id: "node_trip",
      memoryType: "event",
      canonicalLabel: "Italy trip",
      aliases: ["trip"],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_trip"],
      evidenceSpanIds: ["span_trip"],
      bestEvidenceSpanIds: ["span_trip"],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    },
  ]);
  writeJsonl(path.join(graphDir, "graph_edges.jsonl"), []);
  writeJsonl(path.join(graphDir, "memory_items.jsonl"), [
    {
      id: "ir_trip",
      narrativeRecordId: "narr_trip",
      sourceRef: "/tmp/trip.md",
      itemType: "event",
      originType: "asserted",
      layer: "micro",
      subject: "John",
      predicate: "visited",
      object: "Italy",
      label: "Italy trip",
      qualifiers: {},
      evidenceSpanIds: ["span_trip"],
      unitIds: ["unit_trip"],
      confidence: 0.9,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-21T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
    },
  ]);
  writeJsonl(path.join(graphDir, "units.jsonl"), [
    {
      id: "unit_trip",
      narrativeRecordId: "narr_trip",
      narrativeRef: "/tmp/trip.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 20,
      text: "John visited Italy",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ]);
  writeJsonl(path.join(graphDir, "evidence_spans.jsonl"), [
    {
      id: "span_trip",
      narrativeRecordId: "narr_trip",
      narrativeRef: "/tmp/trip.md",
      unitId: "unit_trip",
      charStart: 0,
      charEnd: 20,
      text: "John visited Italy",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    },
  ]);
  writeJsonl(path.join(runtimeDir, "ignition_nodes.jsonl"), [
    {
      nodeId: "node_trip",
      kind: "episodic",
      names: { en: "Italy trip" },
      aliases: ["trip"],
      triggerTerms: ["italy"],
      searchText: "John Italy trip",
      summary: "John visited Italy",
      dayKey: "2026-03-21",
    },
  ]);

  fs.writeFileSync(path.join(runtimeDir, "feedback_overrides.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "hypothesis_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "recall_bundles.jsonl"), "", "utf8");

  const scanner = new V8GraphScanner(workspace, {
    scanIntervalChars: 1,
    maxInjectedBundles: 3,
    criticalThreshold: 0.2,
    decisionThreshold: 0.1,
    backgroundThreshold: 0.05,
  });

  scanner.preExcite("italy", { goal: "travel", activeTask: "travel", latestUserRequest: "italy" });
  const result = scanner.processChunk("italy", { goal: "travel", activeTask: "travel", latestUserRequest: "italy" });

  assert.ok(result.activatedBundles.length > 0);
  assert.equal(result.activatedBundles[0]?.bundleId, "unit_trip");
});

run("scanner favors specific fact nodes over short generic hubs during ignition", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-scanner-specificity-"));
  const memoryDir = path.join(workspace, ".memory");
  const graphDir = path.join(memoryDir, "graph");
  const runtimeDir = path.join(memoryDir, "runtime");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  writeJsonl(path.join(graphDir, "graph_nodes.jsonl"), [
    {
      id: "node_generic",
      memoryType: "goal",
      canonicalLabel: "John winning target",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_generic"],
      evidenceSpanIds: ["span_generic"],
      bestEvidenceSpanIds: ["span_generic"],
      state: { scope: "session", validity: "active", confidence: 0.9, supportCount: 1 },
    },
    {
      id: "node_specific",
      memoryType: "event",
      canonicalLabel: "John mentioned winning board games at camp",
      aliases: [],
      primaryLayer: "micro",
      layerMemberships: ["micro"],
      sourceItemIds: ["ir_specific"],
      evidenceSpanIds: ["span_specific"],
      bestEvidenceSpanIds: ["span_specific"],
      state: { scope: "session", validity: "active", confidence: 0.92, supportCount: 1 },
    },
  ]);
  writeJsonl(path.join(graphDir, "graph_edges.jsonl"), []);
  writeJsonl(path.join(graphDir, "memory_items.jsonl"), [
    {
      id: "ir_generic",
      narrativeRecordId: "narr_generic",
      sourceRef: "/tmp/generic.md",
      itemType: "goal",
      originType: "asserted",
      layer: "micro",
      subject: "john",
      predicate: "targets",
      object: "winning",
      label: "John winning target",
      qualifiers: {},
      evidenceSpanIds: ["span_generic"],
      unitIds: ["unit_generic"],
      confidence: 0.9,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    },
    {
      id: "ir_specific",
      narrativeRecordId: "narr_specific",
      sourceRef: "/tmp/specific.md",
      itemType: "event",
      originType: "asserted",
      layer: "micro",
      subject: "john",
      predicate: "mentioned",
      object: "winning board games",
      label: "John mentioned winning board games at camp",
      qualifiers: {},
      evidenceSpanIds: ["span_specific"],
      unitIds: ["unit_specific"],
      confidence: 0.92,
      scope: "session",
      validity: "active",
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    },
  ]);
  writeJsonl(path.join(graphDir, "units.jsonl"), [
    {
      id: "unit_generic",
      narrativeRecordId: "narr_generic",
      narrativeRef: "/tmp/generic.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 19,
      text: "John winning target",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceCategory: "conversation",
    },
    {
      id: "unit_specific",
      narrativeRecordId: "narr_specific",
      narrativeRef: "/tmp/specific.md",
      layer: "micro",
      ordinal: 1,
      charStart: 20,
      charEnd: 61,
      text: "John mentioned winning board games at camp",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ]);
  writeJsonl(path.join(graphDir, "evidence_spans.jsonl"), [
    {
      id: "span_generic",
      narrativeRecordId: "narr_generic",
      narrativeRef: "/tmp/generic.md",
      unitId: "unit_generic",
      charStart: 0,
      charEnd: 19,
      text: "John winning target",
      speaker: "assistant",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.9,
    },
    {
      id: "span_specific",
      narrativeRecordId: "narr_specific",
      narrativeRef: "/tmp/specific.md",
      unitId: "unit_specific",
      charStart: 20,
      charEnd: 61,
      text: "John mentioned winning board games at camp",
      speaker: "assistant",
      timestamp: "2026-03-23T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.92,
    },
  ]);

  fs.writeFileSync(path.join(runtimeDir, "feedback_overrides.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "hypothesis_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_nodes.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "recall_bundles.jsonl"), "", "utf8");

  const scanner = new V8GraphScanner(workspace, {
    scanIntervalChars: 1,
    maxInjectedBundles: 3,
    criticalThreshold: 0.2,
    decisionThreshold: 0.1,
    backgroundThreshold: 0.05,
  });

  const question = "How many board games has John mentioned winning?";
  scanner.preExcite(question, {
    goal: "memory recall",
    activeTask: "answer question",
    latestUserRequest: question,
  });
  const result = scanner.processChunk(question, {
    goal: "memory recall",
    activeTask: "answer question",
    latestUserRequest: question,
  });

  assert.ok(result.activatedBundles.length > 0);
  assert.equal(
    result.activatedBundles[0]?.bundleId,
    "unit_specific",
    "specific fact unit should outrank the short generic hub",
  );
});

run("scanner group bundle fallback does not use memoryType as a trigger token", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-scanner-no-type-fallback-"));
  const memoryDir = path.join(workspace, ".memory");
  const graphDir = path.join(memoryDir, "graph");
  const runtimeDir = path.join(memoryDir, "runtime");
  fs.mkdirSync(graphDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  writeJsonl(path.join(graphDir, "graph_nodes.jsonl"), [
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
  ]);
  writeJsonl(path.join(graphDir, "graph_edges.jsonl"), []);
  writeJsonl(path.join(graphDir, "memory_items.jsonl"), [
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
  ]);
  writeJsonl(path.join(graphDir, "units.jsonl"), [
    {
      id: "unit_goal_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      layer: "micro",
      ordinal: 0,
      charStart: 0,
      charEnd: 9,
      text: "plan trip",
      parentUnitId: null,
      language: "en",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceCategory: "conversation",
    },
  ]);
  writeJsonl(path.join(graphDir, "evidence_spans.jsonl"), [
    {
      id: "span_goal_1",
      narrativeRecordId: "narr_1",
      narrativeRef: "/tmp/narrative.md",
      unitId: "unit_goal_1",
      charStart: 0,
      charEnd: 9,
      text: "plan trip",
      speaker: "assistant",
      timestamp: "2026-03-21T00:00:00.000Z",
      sourceClass: "raw",
      sourceType: "session_narrative",
      score: 0.8,
    },
  ]);
  writeJsonl(path.join(runtimeDir, "recall_bundles.jsonl"), [
    {
      bundleId: "group_goal",
      title: "plan trip",
      kind: "semantic",
      nodeIds: ["node_edge_goal_1"],
      sourceRefs: ["/tmp/narrative.md"],
      evidenceSpanIds: ["span_goal_1"],
      bestEvidenceSpanIds: ["span_goal_1"],
      summaryText: "plan trip",
      packType: "raw_evidence",
    },
  ]);
  fs.writeFileSync(path.join(runtimeDir, "feedback_overrides.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "hypothesis_edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_nodes.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "ignition_edges.jsonl"), "", "utf8");

  const scanner = new V8GraphScanner(workspace, {
    scanIntervalChars: 1,
    maxInjectedBundles: 3,
    criticalThreshold: 0.2,
    decisionThreshold: 0.1,
    backgroundThreshold: 0.05,
    groupTriggerScoreThreshold: 0.0,
    groupEnergyGain: 1.2,
  });

  const result = scanner.processChunk("goal", {
    goal: "",
    activeTask: "",
    latestUserRequest: "",
  });

  assert.equal(result.activatedBundles.some((bundle) => bundle.bundleId === "group_goal"), false);
});

