import assert from "node:assert/strict";

import {
  DEFAULT_V8_DIMENSION_WEIGHTS,
  dimensionWeight,
  edgeDirectionDimension,
  familyWeight,
  scopeGate,
  trajectoryAffinity,
} from "../../src/v8/geometry-runtime.js";
import type { V8GraphEdge } from "../../src/v8/types_v8.js";

function makeEdge(overrides: Partial<V8GraphEdge> = {}): V8GraphEdge {
  return {
    id: "edge_1",
    type: "state_supersedes_state",
    src: "node_a",
    dst: "node_b",
    layer: "cross",
    originType: "inferred",
    sourceItemIds: ["ir_1"],
    evidenceSpanIds: [],
    qualifiers: {},
    confidence: 0.8,
    state: { scope: "session", validity: "active" },
    forwardDimension: "T_forward",
    reverseDimension: "T_backward",
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

run("dimensionWeight uses the documented defaults", () => {
  assert.equal(dimensionWeight("H"), DEFAULT_V8_DIMENSION_WEIGHTS.H);
  assert.equal(dimensionWeight("T_forward"), 1.1);
  assert.equal(dimensionWeight("gate"), 1.0);
  assert.equal(dimensionWeight("none"), 0.0);
});

run("trajectoryAffinity rewards meaningful dimension switches", () => {
  assert.equal(trajectoryAffinity("T_forward", ["H"]), 1.3);
  assert.equal(trajectoryAffinity("O_up", ["V_up"]), 1.3);
  assert.equal(trajectoryAffinity("H", ["O_down"]), 1.2);
});

run("trajectoryAffinity penalizes repeated same-dimension expansion", () => {
  assert.equal(trajectoryAffinity("H", ["H", "H"]), 0.7);
  assert.equal(trajectoryAffinity("V_up", ["V_up", "V_up"]), 0.4);
  assert.equal(trajectoryAffinity("T_backward", ["T_forward", "T_backward"]), 0.6);
});

run("scopeGate only gates gate-dimension edges", () => {
  const gateEdge = makeEdge({ type: "state_valid_in_phase", forwardDimension: "gate", reverseDimension: "gate" });
  const semanticEdge = makeEdge({ type: "causes", forwardDimension: "H", reverseDimension: "H" });

  assert.equal(scopeGate(gateEdge, true), 1.0);
  assert.equal(scopeGate(gateEdge, false), 0.15);
  assert.equal(scopeGate(semanticEdge, false), 1.0);
});

run("edgeDirectionDimension and familyWeight follow the documented defaults", () => {
  const obliqueEdge = makeEdge({ type: "local_goal_in_objective_line", forwardDimension: "O_up", reverseDimension: "O_down" });
  const causeEdge = makeEdge({ type: "causes", forwardDimension: "H", reverseDimension: "H" });
  const ontologyEdge = makeEdge({ type: "is_a", forwardDimension: "H", reverseDimension: "H" });

  assert.equal(edgeDirectionDimension(obliqueEdge, "forward"), "O_up");
  assert.equal(edgeDirectionDimension(obliqueEdge, "reverse"), "O_down");
  assert.equal(familyWeight(causeEdge), 1.3);
  assert.equal(familyWeight(ontologyEdge), 0.7);
});



