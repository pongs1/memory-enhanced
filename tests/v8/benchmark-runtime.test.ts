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

await run("buildBenchmarkQuerySignals is question-centric", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-runtime.js");
  const signals = mod.buildBenchmarkQuerySignals("Who won the game?");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, "question");
  assert.equal(signals[0].text, "Who won the game?");
  assert.equal(signals[0].weight, 1);
});

await run("choosePreferredBenchmarkAnswer prefers search over insufficient memory answer", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-runtime.js");
  const chosen = mod.choosePreferredBenchmarkAnswer({
    llmMemoryAnswer:
      "There is insufficient evidence provided to answer this question.",
    llmMemoryStatus: "completed",
    llmSearchAnswer:
      "Based on the provided evidence, reading The Alchemist made John think again about following dreams.",
    llmSearchStatus: "completed",
    fallbackText: "fallback",
  });
  assert.equal(
    chosen,
    "Based on the provided evidence, reading The Alchemist made John think again about following dreams.",
  );
});

await run("choosePreferredBenchmarkAnswer keeps substantive memory answer over weaker fallback", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-runtime.js");
  const chosen = mod.choosePreferredBenchmarkAnswer({
    llmMemoryAnswer: "John won the game 3-1.",
    llmMemoryStatus: "completed",
    llmSearchAnswer: "The evidence is insufficient.",
    llmSearchStatus: "completed",
    fallbackText: "fallback",
  });
  assert.equal(chosen, "John won the game 3-1.");
});

await run("mergeBenchmarkHits prioritizes archive hits over synthetic seed summaries", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-runtime.js");
  const merged = mod.mergeBenchmarkHits(
    [{ spanId: "archive_1", score: 9, spanText: "archive hit" }],
    [{ spanId: "state_summary_1", score: 1.4, spanText: "seed hit" }],
    4,
  );
  assert.equal(merged[0].spanId, "archive_1");
  assert.equal(merged[1].spanId, "state_summary_1");
});

await run("filterBenchmarkBundlesByQuestion drops unrelated bundles", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-runtime.js");
  const bundles = mod.filterBenchmarkBundlesByQuestion(
    "How many games has John mentioned winning?",
    [
      {
        bundleId: "b1",
        title: "Tim prefers Star Wars",
        summaryText: "state now: Tim prefers Star Wars",
        nodeLabels: ["Tim prefers Star Wars"],
        evidenceTexts: ["Tim prefers Star Wars and fantasy reading."],
      },
      {
        bundleId: "b2",
        title: "John won a close game",
        summaryText: "John described winning a close game last week",
        nodeLabels: ["John", "won", "game"],
        evidenceTexts: ["John said they got the win in a close game."],
      },
    ],
  );
  assert.deepEqual(
    bundles.map((item: { bundleId: string }) => item.bundleId),
    ["b2"],
  );
});

await run("buildSearchAnswerHits prioritizes static then ignition then raw hits", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-runtime.js");
  const hits = mod.buildSearchAnswerHits({
    staticGuidedHits: [{ spanId: "static_1", score: 8, spanText: "static" }],
    ignitionGuidedHits: [{ spanId: "ignition_1", score: 6, spanText: "ignition" }],
    rawHits: [{ spanId: "raw_1", score: 5, spanText: "raw" }],
    topK: 4,
  });
  assert.deepEqual(
    hits.map((item: { spanId: string }) => item.spanId),
    ["static_1", "ignition_1", "raw_1"],
  );
});

await run("scoreBenchmarkAnswerSupport measures whether propagated hits already contain the answer", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-runtime.js");
  const supported = mod.scoreBenchmarkAnswerSupport({
    answer: "Aragorn",
    hits: [{ spanId: "h1", spanText: "John said Aragorn is his favorite character.", rawText: "" }],
  });
  const unsupported = mod.scoreBenchmarkAnswerSupport({
    answer: "House of MinaLima",
    hits: [{ spanId: "h2", spanText: "Tim likes fantasy books and castles.", rawText: "" }],
  });
  assert.ok(supported > 0.9);
  assert.equal(unsupported, 0);
});
