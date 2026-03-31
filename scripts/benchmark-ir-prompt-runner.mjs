#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildCleanSlateGraph } from "../dist/v8/compiler_clean_slate.js";
import { v8StorePaths } from "../dist/v8/paths_v8.js";
import { loadLlmIrArtifacts } from "../dist/v8/architecture/ir-llm.js";
import { evaluateIrPromptEffectiveness } from "../dist/v8/review/ir-prompt-effectiveness.js";
import { writeIrPromptReviewMarkdown } from "../dist/v8/review/ir-prompt-review-markdown.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_TMP = path.join(ROOT, ".tmp", "benchmark-ir-prompt-run");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.prepared_sample) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const preparedSampleDir = path.resolve(String(args.prepared_sample));
  const sampleId = path.basename(preparedSampleDir);
  const benchmark = inferBenchmark(preparedSampleDir);
  const outRoot = path.resolve(String(args.out || DEFAULT_TMP));
  const existingWorkspace = args.existing_workspace
    ? path.resolve(String(args.existing_workspace))
    : null;
  const workspace = existingWorkspace || path.join(outRoot, benchmark, sampleId);
  const irLlmCommand = args.ir_llm_command ? String(args.ir_llm_command) : undefined;
  const ruleIrMode = args.rule_ir_mode ? String(args.rule_ir_mode) : "off";

  if (existingWorkspace) {
    syncBenchmarkInputs({ preparedSampleDir, workspace });
  } else {
    prepareWorkspace({ preparedSampleDir, workspace, sampleId });
    await buildCleanSlateGraph({
      workspace,
      startAt: "source",
      compilePhase: "final",
      ruleIrMode,
      emitUnitPreview: false,
      rebuildMode: "full",
      llmCommand: irLlmCommand,
    });
  }

  const store = v8StorePaths(workspace);
  const jobs = readJsonl(store.irLlmJobs);
  const rawCompleted = readJsonl(store.irLlmItems);
  const rawPending = readJsonl(store.irLlmPending);
  const units = readJsonl(store.units);
  const evidenceSpans = readJsonl(store.evidenceSpans);
  const accepted = loadLlmIrArtifacts(
    {
      jsonlPath: store.irLlmItems,
      jobsPath: store.irLlmJobs,
    },
    units,
    evidenceSpans,
  );

  const result = evaluateIrPromptEffectiveness({
    jobs,
    completedRecords: rawCompleted,
    pendingRecords: rawPending,
    acceptedCompletedItems: accepted.items.length,
  });

  const summary = {
    benchmark,
    sampleId,
    workspace,
    scorecard: result.scorecard,
    failedJobs: result.jobs.filter((job) => job.issueTags.length > 0),
  };
  const summaryPath = path.join(workspace, "ir_prompt_eval_summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  writeIrPromptReviewMarkdown({
    outputPath: path.join(store.runtimeDir, "review", "ir_prompt_review.md"),
    runContext: {
      runId: `${benchmark}_${sampleId}`,
      dataset: benchmark,
      sampleCount: result.scorecard.sampleCount,
      jobCount: result.scorecard.jobCount,
    },
    scorecard: result.scorecard,
    failedSamples: [
      {
        sampleId,
        layers: groupFailedJobsByLayer(result.jobs.filter((job) => job.issueTags.length > 0)),
      },
    ].filter((entry) => entry.layers.length > 0),
  });

  console.log(`workspace=${workspace}`);
  console.log(`summary=${summaryPath}`);
  console.log(`coverageHealth=${round4(result.scorecard.headline.coverageHealth)}`);
  console.log(`schemaHealth=${round4(result.scorecard.headline.schemaHealth)}`);
  console.log(`handoffHealth=${round4(result.scorecard.headline.handoffHealth)}`);
}

function groupFailedJobsByLayer(jobs) {
  const byLayer = new Map();
  for (const job of jobs) {
    const list = byLayer.get(job.layer) || [];
    list.push(job);
    byLayer.set(job.layer, list);
  }
  return Array.from(byLayer.entries()).map(([layer, layerJobs]) => ({
    layer,
    jobs: layerJobs,
  }));
}

function prepareWorkspace({ preparedSampleDir, workspace, sampleId }) {
  fs.rmSync(workspace, { recursive: true, force: true });
  const assembledDir = path.join(workspace, ".memory", "raw", "observations", "assembled");
  fs.mkdirSync(assembledDir, { recursive: true });

  const srcNarrative = path.join(preparedSampleDir, "session_narrative.md");
  const dstNarrative = path.join(assembledDir, `session_${sampleId}_narrative.md`);
  let content = fs.readFileSync(srcNarrative, "utf-8");
  if (!/Session:\s*`/.test(content)) {
    content = `Session: \`${sampleId}\`\n\n${content}`;
  }
  fs.writeFileSync(dstNarrative, content, "utf-8");
  syncBenchmarkInputs({ preparedSampleDir, workspace });
}

function syncBenchmarkInputs({ preparedSampleDir, workspace }) {
  for (const name of ["questions.jsonl", "turn_map.jsonl", "metadata.json"]) {
    const src = path.join(preparedSampleDir, name);
    if (!fs.existsSync(src)) continue;
    const dstDir = path.join(workspace, "benchmark_eval_inputs");
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, path.join(dstDir, name));
  }
}

function inferBenchmark(preparedSampleDir) {
  const lower = preparedSampleDir.toLowerCase();
  if (lower.includes("locomo")) return "locomo";
  return "benchmark";
}

function readJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-/g, "_");
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function printHelp() {
  console.error(
    "Usage: node scripts/benchmark-ir-prompt-runner.mjs --prepared-sample <dir> [--out <dir>] [--existing-workspace <dir>] [--ir-llm-command <cmd>] [--rule-ir-mode <mode>]",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
