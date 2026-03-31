import assert from "node:assert/strict";

import { getRecentRecallTraces, recordRecallTrace, takeRecentRecalls, takeRecentRecallUnits } from "../../src/v8/feedback-runtime.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("recordRecallTrace preserves sourceUnitIds on unit-centered bundles", () => {
  const sessionId = `test-${Date.now()}`;
  recordRecallTrace(sessionId, {
    mode: "profile",
    bundles: [
      {
        bundleId: "unit_1",
        nodeIds: ["node_auth"],
        sourceUnitIds: ["unit_1"],
        evidenceSpanIds: ["span_1"],
        tier: "critical",
      },
    ],
  });

  const traces = getRecentRecallTraces(sessionId);
  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0]?.bundles[0]?.sourceUnitIds, ["unit_1"]);
});

run("takeRecentRecalls still aggregates node ids for legacy consumers", () => {
  const sessionId = `test-${Date.now()}-legacy`;
  recordRecallTrace(sessionId, {
    mode: "profile",
    bundles: [
      {
        bundleId: "unit_1",
        nodeIds: ["node_auth", "node_policy"],
        sourceUnitIds: ["unit_1"],
        evidenceSpanIds: ["span_1"],
        tier: "background",
      },
    ],
  });

  const nodeIds = takeRecentRecalls(sessionId);
  assert.deepEqual(nodeIds.sort(), ["node_auth", "node_policy"]);
});
run("takeRecentRecallUnits aggregates delivered unit ids for unit-centered traces", () => {
  const sessionId = `test-${Date.now()}-units`;
  recordRecallTrace(sessionId, {
    mode: "profile",
    bundles: [
      {
        bundleId: "unit_1",
        nodeIds: ["node_auth"],
        sourceUnitIds: ["unit_1", "unit_2"],
        evidenceSpanIds: ["span_1"],
        tier: "background",
      },
    ],
  });

  const unitIds = takeRecentRecallUnits(sessionId);
  assert.deepEqual(unitIds.sort(), ["unit_1", "unit_2"]);
});
run("recordRecallTrace defaults mode to profile when omitted", () => {
  const sessionId = `test-${Date.now()}-default-mode`;
  recordRecallTrace(sessionId, {
    bundles: [
      {
        bundleId: "unit_1",
        nodeIds: ["node_auth"],
        sourceUnitIds: ["unit_1"],
        evidenceSpanIds: ["span_1"],
        tier: "background",
      },
    ],
  });

  const traces = getRecentRecallTraces(sessionId);
  assert.equal(traces[0]?.mode, "profile");
});
