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

await run("runWithConcurrency preserves input order", async () => {
  const mod = await import("../../src/v8/review/" + "async-pool.js");
  const result = await mod.runWithConcurrency([3, 1, 2], 2, async (value: number) => {
    await new Promise((resolve) => setTimeout(resolve, value * 5));
    return value * 10;
  });
  assert.deepEqual(result, [30, 10, 20]);
});

await run("runWithConcurrency enforces max concurrency", async () => {
  const mod = await import("../../src/v8/review/" + "async-pool.js");
  let active = 0;
  let maxActive = 0;
  const result = await mod.runWithConcurrency([1, 2, 3, 4, 5], 3, async (value: number) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return value;
  });
  assert.deepEqual(result, [1, 2, 3, 4, 5]);
  assert.equal(maxActive, 3);
});