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

await run("grounding eval marks answer grounded when units and source refs exist with sufficient coverage", async () => {
  const mod = await import("../../src/v8/review/" + "grounding-eval.js");
  const result = mod.evaluateGrounding({
    answer: "JWT v2 replaced JWT v1 for auth.",
    selectedUnitIds: ["unit_1"],
    selectedUnitExcerpts: ["JWT v2 replaced JWT v1 for auth."],
    supportingSourceRefs: ["/tmp/narrative.md#u1"],
    supportingMemoryItems: [{ id: "ir_1", evidenceSpans: [{ id: "span_1" }] }],
  });

  assert.equal(result.verdict, "grounded");
  assert.ok(result.coverageScore >= 0.8);
});

await run("grounding eval marks answer weak when support exists but coverage is low", async () => {
  const mod = await import("../../src/v8/review/" + "grounding-eval.js");
  const result = mod.evaluateGrounding({
    answer: "JWT v2 replaced JWT v1 and enabled token rotation rollout.",
    selectedUnitIds: ["unit_1"],
    selectedUnitExcerpts: ["JWT v2 replaced JWT v1."],
    supportingSourceRefs: ["/tmp/narrative.md#u1"],
    supportingMemoryItems: [{ id: "ir_1", evidenceSpans: [{ id: "span_1" }] }],
  });

  assert.equal(result.verdict, "weak");
});

await run("grounding eval marks answer missing when no selected units exist", async () => {
  const mod = await import("../../src/v8/review/" + "grounding-eval.js");
  const result = mod.evaluateGrounding({
    answer: "JWT v2 replaced JWT v1.",
    selectedUnitIds: [],
    selectedUnitExcerpts: [],
    supportingSourceRefs: [],
    supportingMemoryItems: [],
  });

  assert.equal(result.verdict, "missing");
});
