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

await run("benchmark scorecard summarizes workflow metrics", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-scorecard.js");
  const scorecard = mod.buildBenchmarkScorecard({
    runId: "run_1",
    dataset: "locomo",
    evaluationPath: "compiled_memory_recall",
    executedWorkflows: {
      backgroundCompile: true,
      compiledRecall: true,
      frontSearchEscalation: false,
      backendRelationMining: false,
    },
    samples: [
      {
        correctness: { verdict: "correct" },
        grounding: { verdict: "grounded" },
        attribution: { mismatch: false },
        latencyMs: 120,
        promptTokens: 100,
        completionTokens: 40,
      },
      {
        correctness: { verdict: "partial" },
        grounding: { verdict: "weak" },
        attribution: { mismatch: true },
        latencyMs: 80,
        promptTokens: 50,
        completionTokens: 20,
      },
    ],
  });

  assert.equal(scorecard.runId, "run_1");
  assert.equal(scorecard.dataset, "locomo");
  assert.equal(scorecard.evaluationPath, "compiled_memory_recall");
  assert.equal(scorecard.sampleCount, 2);
  assert.equal(scorecard.correctness.correct, 1);
  assert.equal(scorecard.correctness.partial, 1);
  assert.equal(scorecard.grounding.grounded, 1);
  assert.equal(scorecard.grounding.weak, 1);
  assert.equal(scorecard.workflowAttribution.mismatchCount, 1);
  assert.equal(scorecard.latency.medianMs, 100);
  assert.equal(scorecard.tokens.prompt, 150);
  assert.equal(scorecard.tokens.completion, 60);
});
