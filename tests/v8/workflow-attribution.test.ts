import assert from "node:assert/strict";

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("workflow attribution matches compiled memory recall when compile and recall both executed", async () => {
  const mod = await import("../../src/v8/review/" + "workflow-attribution.js");
  const result = mod.evaluateWorkflowAttribution({
    evaluationPath: "compiled_memory_recall",
    executedWorkflows: {
      backgroundCompile: true,
      compiledRecall: true,
      frontSearchEscalation: false,
      backendRelationMining: false,
    },
  });

  assert.equal(result.mismatch, false);
  assert.equal(result.failureCategory, null);
});

await run("workflow attribution flags mismatch when search escalation path did not execute", async () => {
  const mod = await import("../../src/v8/review/" + "workflow-attribution.js");
  const result = mod.evaluateWorkflowAttribution({
    evaluationPath: "front_search_escalation",
    executedWorkflows: {
      backgroundCompile: true,
      compiledRecall: true,
      frontSearchEscalation: false,
      backendRelationMining: false,
    },
  });

  assert.equal(result.mismatch, true);
  assert.equal(result.failureCategory, "workflow_attribution_mismatch");
});
