import assert from "node:assert/strict";

import { partitionSerialExtractLanes } from "../../src/v8/review/extract-lanes.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function job(jobId: string, narrativeRecordId: string, ordinal: number, layer = "micro") {
  return {
    jobId,
    narrativeRecordId,
    layer,
    promptUnits: [{ ordinal }],
  };
}

run("partitionSerialExtractLanes keeps narrative order inside each lane", () => {
  const lanes = partitionSerialExtractLanes(
    [
      job("j1", "n1", 1),
      job("j2", "n1", 3),
      job("j3", "n1", 5),
      job("j4", "n1", 7),
    ],
    2
  );

  assert.equal(lanes.length, 1);
  assert.deepEqual(lanes[0]!.map((entry) => entry.jobId), ["j1", "j2", "j3", "j4"]);
});

run("partitionSerialExtractLanes keeps one serial lane per narrative and layer", () => {
  const lanes = partitionSerialExtractLanes(
    [
      job("n1_j1", "n1", 1),
      job("n1_j2", "n1", 3),
      job("n1_j3", "n1", 5),
      job("n2_j1", "n2", 1),
      job("n2_j2", "n2", 3),
    ],
    2
  );

  assert.deepEqual(
    lanes.map((lane) => lane.map((entry) => entry.jobId)),
    [["n1_j1", "n1_j2", "n1_j3"], ["n2_j1", "n2_j2"]]
  );
});

run("partitionSerialExtractLanes collapses to one lane when concurrency is one", () => {
  const lanes = partitionSerialExtractLanes(
    [job("j1", "n1", 2), job("j2", "n1", 4)],
    1
  );

  assert.equal(lanes.length, 1);
  assert.deepEqual(lanes[0]!.map((entry) => entry.jobId), ["j1", "j2"]);
});

run("partitionSerialExtractLanes keeps different layers in separate lanes", () => {
  const lanes = partitionSerialExtractLanes(
    [
      job("micro_1", "n1", 1, "micro"),
      job("meso_1", "n1", 1, "meso"),
      job("macro_1", "n1", 1, "macro"),
    ],
    4
  );

  assert.deepEqual(
    lanes.map((lane) => lane.map((entry) => entry.jobId)),
    [["macro_1"], ["meso_1"], ["micro_1"]]
  );
});
