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

function sample(sampleId: string, sessionCount: number, turnsPerSession: number, bodyChars: number) {
  const conversation: Record<string, unknown> = {};
  for (let s = 1; s <= sessionCount; s += 1) {
    conversation[`session_${s}_date_time`] = `2026-03-${String(s).padStart(2, "0")} 10:00`;
    conversation[`session_${s}`] = JSON.stringify(
      Array.from({ length: turnsPerSession }, (_, idx) => ({
        speaker: idx % 2 === 0 ? "Alice" : "Bob",
        text: `${sampleId} ${"x".repeat(bodyChars)}`,
      })),
    );
  }
  return {
    sample_id: sampleId,
    conversation,
    qa: [{ question: `question for ${sampleId}`, answer: "answer" }],
  };
}

await run("locomo smoke selector returns deterministic 10-sample subset above minimum scale", async () => {
  const mod = await import("../../src/v8/review/" + "locomo-smoke-selection.js");
  const inputs = [
    sample("too_short_1", 2, 8, 20),
    sample("too_short_2", 3, 9, 20),
    sample("too_short_3", 1, 5, 30),
    ...Array.from({ length: 12 }, (_, idx) => sample(`good_${idx + 1}`, 6, 10, 220)),
  ];

  const first = mod.selectLoCoMoSmokeSamples(inputs, { size: 10 });
  const second = mod.selectLoCoMoSmokeSamples(inputs, { size: 10 });

  assert.equal(first.length, 10);
  assert.deepEqual(first.map((item: any) => item.sample_id), second.map((item: any) => item.sample_id));
  assert.ok(first.every((item: any) => item.__smokeMetrics.sessionCount >= 4));
  assert.ok(first.every((item: any) => item.__smokeMetrics.turnCount >= 30));
  assert.ok(first.every((item: any) => item.__smokeMetrics.narrativeChars >= 12000));
});
