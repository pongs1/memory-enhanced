import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("benchmark review markdown writer emits scorecard and failed sample sections", async () => {
  const mod = await import("../../src/v8/review/" + "markdown-writer.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-benchmark-review-"));
  const filePath = path.join(dir, "benchmark_review.md");

  mod.writeBenchmarkReviewMarkdown({
    outputPath: filePath,
    runContext: {
      runId: "run_1",
      dataset: "locomo",
      evaluationPath: "compiled_memory_recall",
    },
    scorecard: {
      sampleCount: 2,
      correctness: { correct: 1, partial: 0, wrong: 1 },
      grounding: { grounded: 1, weak: 0, missing: 1 },
      workflowAttribution: { mismatchCount: 1 },
      latency: { medianMs: 120 },
      tokens: { prompt: 100, completion: 40 },
    },
    failedSamples: [{
      sampleId: "conv-26",
      topFailures: [
        {
          questionId: "conv-26_q1",
          verdict: "answer_wrong",
          question: "What replaced JWT v1?",
          expectedAnswer: "JWT v2",
          producedAnswer: "Unknown",
          selectedUnitIds: ["unit_1"],
          selectedUnitExcerpts: ["JWT v2 replaced JWT v1."],
        },
        {
          questionId: "conv-26_q2",
          verdict: "grounding_missing",
          question: "Why was JWT v1 removed?",
          expectedAnswer: "Security rotation",
          producedAnswer: "Unknown",
          selectedUnitIds: ["unit_2"],
          selectedUnitExcerpts: ["Security rotation drove the migration."],
        },
      ],
    }],
  });

  const markdown = fs.readFileSync(filePath, "utf8");
  assert.match(markdown, /Run Context/);
  assert.match(markdown, /Workflow Scorecard/);
  assert.match(markdown, /Failed Samples/);
  assert.match(markdown, /conv-26/);
  assert.match(markdown, /conv-26_q1/);
  assert.match(markdown, /conv-26_q2/);
  assert.match(markdown, /JWT v2 replaced JWT v1/);
  assert.match(markdown, /Security rotation drove the migration/);
});
