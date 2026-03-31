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

await run("combineRecallPrompts joins recall blocks deterministically", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-answering.js");
  const combined = mod.combineRecallPrompts([
    { prompt: "  first block  " },
    { prompt: "" },
    { prompt: "second block" },
  ]);
  assert.equal(combined, "first block\n\nsecond block");
});

await run("buildBenchmarkAnswerPrompt includes memory and search sections", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-answering.js");
  const prompt = mod.buildBenchmarkAnswerPrompt({
    question: "Who won the game?",
    memoryPrompt: "<!-- Memory Recall (high) -->\nTopic: game\n<!-- End Memory Recall -->",
    searchHits: [{ spanText: "John won the game 3-1.", score: 0.9 }],
  });
  assert.match(prompt, /## Question/);
  assert.match(prompt, /## Memory Recall/);
  assert.match(prompt, /## Search Evidence/);
  assert.match(prompt, /John won the game 3-1\./);
});

await run("runBenchmarkAnswerCommand returns stdout answer for simple command", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-answering.js");
  const result = mod.runBenchmarkAnswerCommand({
    command: `cmd /c echo answer from command`,
    mode: "memory",
    question: "question",
    memoryPrompt: "memory",
  });
  if (/EPERM|EACCES|Access is denied/i.test(String(result.commandStatus || ""))) {
    console.log("SKIP runBenchmarkAnswerCommand returns stdout answer for simple command (shell access denied in sandbox)");
    return;
  }
  assert.equal(result.commandStatus, "completed");
  assert.equal(result.answer, "answer from command");
});

await run("runBenchmarkAnswerCommandAsync returns stdout answer for simple command", async () => {
  const mod = await import("../../src/v8/review/" + "benchmark-answering.js");
  const result = await mod.runBenchmarkAnswerCommandAsync({
    command: `cmd /c echo async answer from command`,
    mode: "memory",
    question: "question",
    memoryPrompt: "memory",
  });
  if (/EPERM|EACCES|Access is denied/i.test(String(result.commandStatus || ""))) {
    console.log("SKIP runBenchmarkAnswerCommandAsync returns stdout answer for simple command (shell access denied in sandbox)");
    return;
  }
  assert.equal(result.commandStatus, "completed");
  assert.equal(result.answer, "async answer from command");
});
