import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureV8StoreDirs } from "../../src/v8/paths_v8.js";
import { hasReusableArtifacts } from "../../src/v8/compiler_clean_slate.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("hasReusableArtifacts does not require compatibility projection files", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-compiler-reuse-"));
  const store = ensureV8StoreDirs(workspace);

  const requiredFiles = [
    store.units,
    store.evidenceSpans,
    store.memoryItems,
    store.graphNodes,
    store.graphEdges,
    store.entityPostings,
    store.entityScopeCards,
    store.groupSummaries,
    store.relationSearchPlans,
    store.narrativeShardSelections,
    store.relationCandidateHits,
    store.relationReviewJobs,
    store.learningEvents,
    store.searchFeedbackSignals,
  ];

  for (const filePath of requiredFiles) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "", "utf8");
  }

  assert.equal(fs.existsSync(store.ignitionNodes), false);
  assert.equal(fs.existsSync(store.ignitionEdges), false);
  assert.equal(fs.existsSync(store.recallBundles), false);

  assert.equal(hasReusableArtifacts(store), true);
});
