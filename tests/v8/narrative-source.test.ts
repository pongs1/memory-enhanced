import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadNarrativeRecords } from "../../src/v8/architecture/narrative-source.js";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("loadNarrativeRecords reads assembled narratives from raw/assembled", () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-raw-"));
  const assembledDir = path.join(rawDir, "assembled");
  fs.mkdirSync(assembledDir, { recursive: true });

  fs.writeFileSync(
    path.join(assembledDir, "session_demo_narrative.md"),
    "# Session Narrative\n\nSession: `demo`\n\n2026-03-21 12:00\n\nhello",
    "utf8"
  );

  const records = loadNarrativeRecords(rawDir);
  assert.equal(records.length, 1);
  const sourceRef = records[0]?.sourceRef || "";
  assert.ok(sourceRef.includes(`${path.sep}assembled${path.sep}`));
  assert.ok(sourceRef.endsWith(`${path.sep}session_demo_narrative.md`));
});

run("loadNarrativeRecords falls back to legacy raw/observations/assembled", () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-raw-legacy-"));
  const legacyDir = path.join(rawDir, "observations", "assembled");
  fs.mkdirSync(legacyDir, { recursive: true });

  fs.writeFileSync(
    path.join(legacyDir, "session_legacy_narrative.md"),
    "# Session Narrative\n\nSession: `legacy`\n\n2026-03-21 12:00\n\nlegacy",
    "utf8"
  );

  const records = loadNarrativeRecords(rawDir);
  assert.equal(records.length, 1);
  const sourceRef = records[0]?.sourceRef || "";
  assert.ok(sourceRef.includes(`${path.sep}observations${path.sep}assembled${path.sep}`));
  assert.ok(sourceRef.endsWith(`${path.sep}session_legacy_narrative.md`));
});

run("loadNarrativeRecords prefers raw/assembled when both new and legacy directories exist", () => {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-raw-both-"));
  const assembledDir = path.join(rawDir, "assembled");
  const legacyDir = path.join(rawDir, "observations", "assembled");
  fs.mkdirSync(assembledDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });

  fs.writeFileSync(
    path.join(assembledDir, "session_new_narrative.md"),
    "# Session Narrative\n\nSession: `new`\n\n2026-03-21 12:00\n\nnew",
    "utf8"
  );
  fs.writeFileSync(
    path.join(legacyDir, "session_legacy_narrative.md"),
    "# Session Narrative\n\nSession: `legacy`\n\n2026-03-21 12:00\n\nlegacy",
    "utf8"
  );

  const records = loadNarrativeRecords(rawDir);
  assert.equal(records.length, 1);
  const sourceRef = records[0]?.sourceRef || "";
  assert.ok(sourceRef.includes(`${path.sep}assembled${path.sep}`));
  assert.ok(!sourceRef.includes(`${path.sep}observations${path.sep}assembled${path.sep}`));
  assert.ok(sourceRef.endsWith(`${path.sep}session_new_narrative.md`));
});
