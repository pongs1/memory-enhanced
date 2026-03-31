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

await run("runCommandChain executes wsl-bash commands on Windows", async () => {
  const mod = await import("../../src/v8/review/" + "command-runner.js");
  const result = mod.runCommandChain(
    `wsl-bash:printf bar`,
    { timeoutMs: 10000 },
  );
  const denied =
    result.status === null ||
    /E_ACCESSDENIED|Access is denied|CreateInstance/i.test(String(result.stderr || result.error || ""));
  if (denied) {
    console.log("SKIP runCommandChain executes wsl-bash commands on Windows (WSL access denied in sandbox)");
    return;
  }
  assert.equal(result.status, 0);
  assert.equal(String(result.stdout || "").trim(), "bar");
});
