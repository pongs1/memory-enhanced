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

await run("failure taxonomy prefers workflow attribution mismatch when attribution disagrees", async () => {
  const mod = await import("../../src/v8/review/" + "failure-taxonomy.js");
  const result = mod.classifyBenchmarkFailure({
    correctnessVerdict: "wrong",
    groundingVerdict: "missing",
    attributionMismatch: true,
    evaluationError: false,
    workflowStage: "compiled_memory_recall",
  });

  assert.equal(result, "workflow_attribution_mismatch");
});

await run("failure taxonomy classifies missing grounding before workflow stage fallback", async () => {
  const mod = await import("../../src/v8/review/" + "failure-taxonomy.js");
  const result = mod.classifyBenchmarkFailure({
    correctnessVerdict: "partial",
    groundingVerdict: "missing",
    attributionMismatch: false,
    evaluationError: false,
    workflowStage: "compiled_memory_recall",
  });

  assert.equal(result, "grounding_missing");
});

await run("failure taxonomy classifies runner failures directly", async () => {
  const mod = await import("../../src/v8/review/" + "failure-taxonomy.js");
  const result = mod.classifyBenchmarkFailure({
    correctnessVerdict: "wrong",
    groundingVerdict: "missing",
    attributionMismatch: false,
    evaluationError: true,
    workflowStage: "compiled_memory_recall",
  });

  assert.equal(result, "runner_or_eval_failure");
});
