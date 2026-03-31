import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCleanSlateGraph } from "../../src/v8/compiler_clean_slate.js";

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await run("source to narrative renders time-first role headers", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "v8-src-narr-format-"));
  const sessionDir = path.join(workspace, ".memory", "raw", "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const tracePath = path.join(sessionDir, "session_trace.jsonl");
  const rows = [
    {
      id: "m1",
      role: "John",
      timestamp: "2023-05-21T19:48:00.000Z",
      message: {
        role: "John",
        timestamp: "2023-05-21T19:48:00.000Z",
        content: "Hey Tim, nice to meet you!",
      },
    },
    {
      id: "m2",
      role: "Tim",
      timestamp: "2023-05-21T19:48:00.000Z",
      message: {
        role: "Tim",
        timestamp: "2023-05-21T19:48:00.000Z",
        content: "Hey John! Great to meet you.",
      },
    },
  ];
  fs.writeFileSync(tracePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

  await buildCleanSlateGraph({
    workspace,
    sessionTraceDir: sessionDir,
    startAt: "source",
    stopAfter: "evidence",
    ruleIrMode: "off",
    rebuildMode: "full",
    compilePhase: "final",
    hotTailSkipUnits: 0,
  });

  const narrativePath = path.join(
    workspace,
    ".memory",
    "raw",
    "assembled",
    "session_session_trace_narrative.md"
  );
  const narrative = fs.readFileSync(narrativePath, "utf8");
  assert.match(narrative, /### 2023-05-21 19:48 John:/);
  assert.match(narrative, /### 2023-05-21 19:48 Tim:/);
  assert.doesNotMatch(narrative, /### John \(2023-05-21 19:48\)/);

  const unitsPath = path.join(workspace, ".memory", "graph", "units.jsonl");
  const units = fs
    .readFileSync(unitsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const microJohn = units.find((unit) => unit.id === "unit_narr_session_trace_micro_1");
  const microTim = units.find((unit) => unit.id === "unit_narr_session_trace_micro_2");
  assert.equal(microJohn?.timestamp, "2023-05-21 19:48");
  assert.equal(microTim?.timestamp, "2023-05-21 19:48");

  const previewPath = path.join(
    workspace,
    ".memory",
    "raw",
    "assembled",
    "session_session_trace_units.md"
  );
  const preview = fs.readFileSync(previewPath, "utf8");
  assert.doesNotMatch(preview, /# Session Narrative/);
  assert.doesNotMatch(preview, /## Timeline/);
  assert.match(
    preview,
    /- unit_narr_session_trace_micro_1\r?\n### 2023-05-21 19:48 John:\r?\nHey Tim, nice to meet you!/
  );
  assert.match(
    preview,
    /- unit_narr_session_trace_micro_2\r?\n### 2023-05-21 19:48 Tim:\r?\nHey John! Great to meet you\./
  );
});
