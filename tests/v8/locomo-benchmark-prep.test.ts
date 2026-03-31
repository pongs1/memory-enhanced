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

function sample() {
  return {
    sample_id: "conv_test",
    conversation: {
      speaker_a: "Caroline",
      speaker_b: "Melanie",
      session_1_date_time: "1:56 pm on 8 May, 2023",
      session_1: JSON.stringify([
        { speaker: "Caroline", text: "Hi there." },
        { speaker: "Melanie", text: "Hello back.", query: "greeting" },
      ]),
      session_2_date_time: "9:15 am on 1 June, 2023",
      session_2: JSON.stringify([
        { speaker: "Caroline", text: "Another update.", blip_caption: "smiling photo" },
      ]),
    },
    qa: Array.from({ length: 9 }, (_, idx) => ({
      question_id: `q${idx + 1}`,
      question: `question ${idx + 1}`,
      answer: `answer ${idx + 1}`,
      category: (idx % 3) + 1,
    })),
  };
}

await run("buildLoCoMoSessionTrace emits raw session-like turns with roles", async () => {
  const mod = await import("../../src/v8/review/" + "locomo-benchmark-prep.js");
  const trace = mod.buildLoCoMoSessionTrace(sample(), "conv_test");

  assert.equal(trace.length, 3);
  assert.equal(trace[0]?.type, "message");
  assert.equal(trace[0]?.parentId, "");
  assert.equal(trace[0]?.role, undefined);
  assert.ok(!("speaker" in (trace[0] || {})));
  assert.equal(trace[0]?.timestamp, "2023-05-08T13:56:00.000Z");
  assert.equal(trace[2]?.timestamp, "2023-06-01T09:15:00.000Z");
  assert.equal(trace[0]?.message?.role, "Caroline");
  assert.equal(trace[0]?.message?.role, "Caroline");
  assert.match(JSON.stringify(trace[1]?.message?.content || ""), /Referenced search query: greeting\./);
  assert.match(JSON.stringify(trace[2]?.message?.content || ""), /Image context: smiling photo\./);
});

await run("normalizeSessionMessages preserves narrator names from role and parses LoCoMo time strings", async () => {
  const prep = await import("../../src/v8/review/" + "locomo-benchmark-prep.js");
  const normalizer = await import("../../src/v8/architecture/" + "narrative-normalizer.js");
  const trace = prep.buildLoCoMoSessionTrace(sample(), "conv_test");
  const records = normalizer.normalizeSessionMessages(trace, {
    sourceRefPrefix: "/tmp/conv_test/session_trace.jsonl",
    includeOperations: false,
  });

  assert.equal(records.length, 3);
  assert.equal(records[0]?.role, "Caroline");
  assert.equal(records[1]?.role, "Melanie");
  assert.equal(records[0]?.timestamp, "2023-05-08T13:56:00.000Z");
  assert.equal(records[2]?.timestamp, "2023-06-01T09:15:00.000Z");
});

await run("selectLoCoMoQuestionSubset is deterministic and bounded", async () => {
  const mod = await import("../../src/v8/review/" + "locomo-benchmark-prep.js");
  const questions = sample().qa;

  const first = mod.selectLoCoMoQuestionSubset(questions, { maxQuestions: 5 });
  const second = mod.selectLoCoMoQuestionSubset(questions, { maxQuestions: 5 });

  assert.equal(first.length, 5);
  assert.deepEqual(
    first.map((item: any) => item.question_id),
    second.map((item: any) => item.question_id),
  );
  assert.ok(new Set(first.map((item: any) => String(item.category))).size >= 2);
});
