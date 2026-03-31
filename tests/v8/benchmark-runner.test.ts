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

await run("benchmark run identity rejects missing evaluationPath", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-run-identity.js");
  assert.throws(
    () => mod.validateBenchmarkRunIdentity({ benchmark: "locomo", sampleId: "sample_1" }),
    /evaluationPath/i,
  );
});

await run("benchmark run identity preserves explicit workflow list", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-run-identity.js");
  const identity = mod.validateBenchmarkRunIdentity({
    benchmark: "locomo",
    sampleId: "sample_1",
    evaluationPath: "compiled_memory_recall",
    executedWorkflows: {
      backgroundCompile: true,
      compiledRecall: true,
      frontSearchEscalation: false,
      backendRelationMining: false,
    },
  });

  assert.equal(identity.evaluationPath, "compiled_memory_recall");
  assert.equal(identity.executedWorkflows.compiledRecall, true);
  assert.equal(identity.executedWorkflows.frontSearchEscalation, false);
});
