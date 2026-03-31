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

await run("benchmark smoke aggregate combines sample summaries into one scorecard", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-smoke-aggregate.js");
  const result = mod.aggregateSmokeSummaries({
    runId: "smoke_1",
    dataset: "locomo",
    evaluationPath: "compiled_memory_recall",
    executedWorkflows: {
      backgroundCompile: true,
      compiledRecall: true,
      frontSearchEscalation: false,
      backendRelationMining: false,
    },
    summaries: [
      {
        sample_id: "sample_1",
        results: [
          {
            question_id: "sample_1_q1",
            question: "What replaced JWT v1?",
            answer: "JWT v2",
            proxy_answer: "JWT v2",
            selected_unit_ids: ["unit_1"],
            selected_unit_excerpts: ["JWT v2 replaced JWT v1."],
            correctness: { verdict: "correct" },
            grounding: { verdict: "grounded" },
            attribution: { mismatch: false },
            failureCategory: null,
          },
        ],
      },
      {
        sample_id: "sample_2",
        results: [
          {
            question_id: "sample_2_q1",
            question: "What replaced JWT v1?",
            answer: "JWT v2",
            proxy_answer: "Unknown",
            selected_unit_ids: ["unit_2"],
            selected_unit_excerpts: ["JWT legacy state remained active."],
            correctness: { verdict: "partial" },
            grounding: { verdict: "weak" },
            attribution: { mismatch: true },
            failureCategory: "workflow_attribution_mismatch",
          },
          {
            question_id: "sample_2_q2",
            question: "Why was JWT v1 removed?",
            answer: "Security rotation",
            proxy_answer: "Unknown",
            selected_unit_ids: ["unit_3"],
            selected_unit_excerpts: ["Security rotation was required."],
            correctness: { verdict: "wrong" },
            grounding: { verdict: "missing" },
            attribution: { mismatch: false },
            failureCategory: "grounding_missing",
          },
          {
            question_id: "sample_2_q3",
            question: "Which phase enabled token rotation?",
            answer: "Auth modernization",
            proxy_answer: "Unknown",
            selected_unit_ids: ["unit_4"],
            selected_unit_excerpts: ["Auth modernization phase activated rotation."],
            correctness: { verdict: "wrong" },
            grounding: { verdict: "missing" },
            attribution: { mismatch: false },
            failureCategory: "grounding_missing",
          },
        ],
      },
    ],
    maxFailuresPerSample: 2,
  });

  assert.equal(result.scorecard.sampleCount, 4);
  assert.equal(result.scorecard.correctness.correct, 1);
  assert.equal(result.scorecard.correctness.partial, 1);
  assert.equal(result.scorecard.correctness.wrong, 2);
  assert.equal(result.failedSamples.length, 1);
  assert.equal(result.failedSamples[0]?.sampleId, "sample_2");
  assert.equal(result.failedSamples[0]?.topFailures.length, 2);
  assert.equal(result.failedSamples[0]?.topFailures[0]?.questionId, "sample_2_q1");
  assert.equal(result.failedSamples[0]?.topFailures[1]?.questionId, "sample_2_q2");
});
