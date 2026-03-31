#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runWithConcurrency } from "../dist/v8/review/async-pool.js";
import { buildExtractPrompt } from "../dist/v8/architecture/ir-llm-workflow.js";
import { parseExtractionMarkdownResponse } from "../dist/v8/architecture/ir-windowed-extraction.js";
import {
  buildDiagnosticRepairPrompt,
  classifyRepairableExtractionFailure,
  splitDiagnosticRepairResponse,
} from "../dist/v8/review/ir-diagnostic-repair.js";
const PROVIDER_CONFIG = readProviderConfig();
const API_URL =
  process.env.SILICONFLOW_URL?.trim() ||
  PROVIDER_CONFIG.apiUrl ||
  "https://api.siliconflow.cn/v1/chat/completions";
const API_KEY =
  process.env.SILICONFLOW_API_KEY?.trim() ||
  PROVIDER_CONFIG.apiKey;
const MODEL =
  process.env.SILICONFLOW_MODEL?.trim() ||
  PROVIDER_CONFIG.model ||
  "qwen3.5-plus";
const SYSTEM_PROMPT =
  process.env.SILICONFLOW_SYSTEM?.trim() || "";

const args = parseArgs(process.argv.slice(2));

const jobsPath =
  args.jobs ||
  process.env.V8_IR_JOBS ||
  process.env.V8_IR_ITEMS_INPUT;
const outMdPath =
  args.out ||
  args.items_md ||
  process.env.V8_IR_ITEMS_MD ||
  process.env.V8_IR_ITEMS ||
  "";
const outJsonlPath =
  args.items_jsonl ||
  process.env.V8_IR_ITEMS_JSONL ||
  "";
const outPendingJsonlPath =
  args.items_pending_jsonl ||
  process.env.V8_IR_PENDING_JSONL ||
  "";
const outDiagnosticJsonlPath =
  args.diagnostic_jsonl ||
  process.env.V8_IR_DIAGNOSTIC_JSONL ||
  "";
const maxJobs = Math.max(1, Number(args.max_jobs || process.env.SILICONFLOW_MAX_JOBS || 0) || Number.MAX_SAFE_INTEGER);
const maxTokens = Math.max(64, Number(args.max_tokens || process.env.SILICONFLOW_MAX_TOKENS || 700));
const temperature = Number.isFinite(Number(args.temperature || process.env.SILICONFLOW_TEMPERATURE))
  ? Number(args.temperature || process.env.SILICONFLOW_TEMPERATURE)
  : 0.2;
const includeLayers = normalizeCsv(args.include_layers || process.env.SILICONFLOW_INCLUDE_LAYERS || "");
const excludeLayers = normalizeCsv(args.exclude_layers || process.env.SILICONFLOW_EXCLUDE_LAYERS || "");
const concurrency = Math.max(1, Number(args.concurrency || process.env.SILICONFLOW_CONCURRENCY || 32));
const extractLanes = Math.max(1, Number(args.extract_lanes || process.env.SILICONFLOW_EXTRACT_LANES || 1));
const connectTimeoutSec = Math.max(5, Number(args.connect_timeout_sec || 15));
const maxTimeSec = Math.max(15, Number(args.max_time_sec || 180));
const sleepMs = Math.max(0, Number(args.sleep_ms || 0));
const diagnoseOnFailure =
  String(args.diagnose_on_failure || process.env.SILICONFLOW_DIAGNOSE_ON_FAILURE || "")
    .trim()
    .toLowerCase() === "1" ||
  String(args.diagnose_on_failure || process.env.SILICONFLOW_DIAGNOSE_ON_FAILURE || "")
    .trim()
    .toLowerCase() === "true";

if (!API_KEY) {
  console.error("Missing SILICONFLOW_API_KEY");
  process.exit(1);
}
if (!jobsPath || !outMdPath) {
  console.error(
    "Usage: node scripts/ir-llm-siliconflow.mjs --jobs <ir_llm_jobs.jsonl> --out <ir_llm_items.md> [--items-jsonl <ir_llm_items.jsonl>]"
  );
  process.exit(1);
}

const raw = safeReadTrimmed(jobsPath);
if (!raw) {
  ensureParent(outMdPath);
  fs.writeFileSync(outMdPath, "", "utf-8");
  if (outJsonlPath) {
    ensureParent(outJsonlPath);
    fs.writeFileSync(outJsonlPath, "", "utf-8");
  }
  process.exit(0);
}

const jobs = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((job) => {
    const layer = String(job.layer || "").trim().toLowerCase();
    if (includeLayers.length > 0 && !includeLayers.includes(layer)) return false;
    if (excludeLayers.includes(layer)) return false;
    return true;
  })
  .slice(0, maxJobs);

ensureParent(outMdPath);
fs.writeFileSync(outMdPath, "", "utf-8");
if (outJsonlPath) {
  ensureParent(outJsonlPath);
  fs.writeFileSync(outJsonlPath, "", "utf-8");
}
if (outPendingJsonlPath) {
  ensureParent(outPendingJsonlPath);
  fs.writeFileSync(outPendingJsonlPath, "", "utf-8");
}
if (outDiagnosticJsonlPath) {
  ensureParent(outDiagnosticJsonlPath);
  fs.writeFileSync(outDiagnosticJsonlPath, "", "utf-8");
}

let completed = 0;
let failed = 0;
const outputs = await runPipeline(jobs);
writeOutputs(outputs);

console.error(`[ir-llm] summary completed=${completed} failed=${failed} jobs=${jobs.length}`);
if (jobs.length > 0 && completed === 0) {
  process.exit(2);
}

async function runJob(job) {
  const prompt = String(job.prompt || "").trim();
  if (!prompt) return null;
  try {
    const output = await callLlm(prompt, {
      apiKey: API_KEY,
      apiUrl: API_URL,
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      temperature,
      maxTokens,
      connectTimeoutSec,
      maxTimeSec,
    });
    if (!output) return null;
    completed += 1;
    console.error(`[ir-llm] ${completed}/${jobs.length} ${job.jobId}`);
    if (sleepMs > 0) sleep(sleepMs);
    return { job, output };
  } catch (error) {
    failed += 1;
    console.error(`[ir-llm] failed ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
    if (sleepMs > 0) sleep(sleepMs);
    return null;
  }
}

async function runPipeline(jobs) {
  const orderedExtractJobs = jobs
    .slice()
    .sort((a, b) =>
      (a.promptUnits?.[0]?.ordinal ?? 0) - (b.promptUnits?.[0]?.ordinal ?? 0) ||
      String(a.jobId).localeCompare(String(b.jobId))
    );
  const lanes = partitionSerialExtractLanes(orderedExtractJobs, extractLanes);
  const laneOutputs = await runWithConcurrency(
    lanes,
    Math.max(1, Math.min(extractLanes, lanes.length || 1)),
    async (lane) => runExtractLane(lane)
  );
  const extractOutputs = laneOutputs.flat();
  return extractOutputs.filter(Boolean);
}

async function runExtractLane(jobs) {
  const outputs = [];
  let carriedPending = [];
  for (const job of jobs) {
    const prompt = buildExtractPrompt({
      layer: job.layer,
      workingUnits: job.promptUnits || [],
      pendingItems: carriedPending,
      targetUnitIds: job.targetUnitIds || [],
    });
    const output = await runJob({ ...job, prompt });
    if (!output) continue;
    let parsed = parseExtractionMarkdownResponse(output.output);
    let hydratedPending = hydratePendingItems(parsed.pending, job.promptUnits || []);
    let completedRecords = parsed.completedBlocks.flatMap((block) => parseMarkdownItems(block));
    let issues = classifyRepairableExtractionFailure({
      layer: job.layer,
      completedRecords,
      pendingRecords: hydratedPending.map((item) => ({
        subject: item.subject,
        predicate: item.predicate,
        object: item.object,
        evidence_start_turn: item.startTurn,
        evidence_end_turn: item.endTurn,
        startAnchor: item.startAnchor,
        endAnchor: item.endAnchor,
        hasExplicitEndEvidence: item.hasExplicitEndEvidence,
        turnRefs: item.turnRefs,
      })),
    });
    let diagnosis = "";
    let repaired = false;

    if (diagnoseOnFailure && issues.length > 0) {
      try {
        const repairPrompt = buildDiagnosticRepairPrompt({
          originalPrompt: prompt,
          previousOutput: output.output,
          issues,
        });
        const repairRaw = await callLlm(repairPrompt, {
          apiKey: API_KEY,
          apiUrl: API_URL,
          model: MODEL,
          systemPrompt: SYSTEM_PROMPT,
          temperature,
          maxTokens,
          connectTimeoutSec,
          maxTimeSec,
        });
        const split = splitDiagnosticRepairResponse(repairRaw);
        diagnosis = split.diagnosis || "";
        const corrected = String(split.correctedExtraction || "").trim();
        if (corrected) {
          const repairedParsed = parseExtractionMarkdownResponse(corrected);
          const repairedPending = hydratePendingItems(repairedParsed.pending, job.promptUnits || []);
          const repairedCompletedRecords = repairedParsed.completedBlocks.flatMap((block) => parseMarkdownItems(block));
          const repairedIssues = classifyRepairableExtractionFailure({
            layer: job.layer,
            completedRecords: repairedCompletedRecords,
            pendingRecords: repairedPending.map((item) => ({
              subject: item.subject,
              predicate: item.predicate,
              object: item.object,
              evidence_start_turn: item.startTurn,
              evidence_end_turn: item.endTurn,
              startAnchor: item.startAnchor,
              endAnchor: item.endAnchor,
              hasExplicitEndEvidence: item.hasExplicitEndEvidence,
              turnRefs: item.turnRefs,
            })),
          });
          if (repairedIssues.length <= issues.length) {
            parsed = repairedParsed;
            hydratedPending = repairedPending;
            completedRecords = repairedCompletedRecords;
            issues = repairedIssues;
            repaired = true;
          }
        }
      } catch (error) {
        diagnosis = `repair_call_failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    carriedPending = hydratedPending;
    outputs.push({
      job: output.job,
      output: parsed.completedBlocks.length > 0 ? parsed.completedBlocks.join("\n\n") : output.output,
      completedBlocks: parsed.completedBlocks,
      pending: hydratedPending,
      diagnosis,
      issues,
      repaired,
      completedRecords,
    });
  }
  return outputs;
}

function hydratePendingItems(items, promptUnits) {
  const refs = Array.isArray(promptUnits) ? promptUnits : [];
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item) => {
    const orderedTurns = Array.from(new Set(Array.isArray(item.turnRefs) ? item.turnRefs : []))
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (orderedTurns.length === 0) {
      return {
        ...item,
        narrativeRecordId: item.narrativeRecordId || refs[0]?.narrativeRecordId,
      };
    }
    const start = orderedTurns[0];
    const end = orderedTurns[orderedTurns.length - 1];
    const matched = refs.filter((ref) => Number(ref?.ordinal) >= start && Number(ref?.ordinal) <= end);
    const first = matched[0] || refs.find((ref) => Number(ref?.ordinal) === start);
    const last = matched[matched.length - 1] || refs.find((ref) => Number(ref?.ordinal) === end);
    return {
      ...item,
      narrativeRecordId: item.narrativeRecordId || first?.narrativeRecordId || refs[0]?.narrativeRecordId,
      turnRefs: orderedTurns,
      charStart: Number.isFinite(Number(item.charStart)) && Number(item.charStart) > 0
        ? Number(item.charStart)
        : Number(first?.charStart) || 0,
      charEnd: Number.isFinite(Number(item.charEnd)) && Number(item.charEnd) > 0
        ? Number(item.charEnd)
        : Number(last?.charEnd) || 0,
    };
  });
}

function partitionSerialExtractLanes(jobs, laneCount) {
  if (!Array.isArray(jobs) || jobs.length === 0) return [];

  const groups = new Map();
  for (const job of jobs) {
    const key = `${String(job.narrativeRecordId || "")}::${String(job.layer || "")}`;
    const list = groups.get(key) || [];
    list.push(job);
    groups.set(key, list);
  }

  const lanes = [];
  for (const group of groups.values()) {
    lanes.push(group);
  }
  return lanes;
}

function writeOutputs(outputs) {
  for (const entry of outputs) {
    if (!entry) continue;
    const completedBlocks =
      Array.isArray(entry.completedBlocks) && entry.completedBlocks.length > 0
        ? entry.completedBlocks
        : [entry.output];
    fs.appendFileSync(outMdPath, completedBlocks.join("\n\n") + "\n\n", "utf-8");
    if (outJsonlPath) {
      const records = completedBlocks.flatMap((block) => parseMarkdownItems(block)).map((item) => ({
        ...item,
        _job_id: entry.job.jobId,
      }));
      for (const record of records) {
        fs.appendFileSync(outJsonlPath, JSON.stringify(record, null, 0) + "\n", "utf-8");
      }
    }
    if (outPendingJsonlPath && Array.isArray(entry.pending) && entry.pending.length > 0) {
      for (const pending of entry.pending) {
        fs.appendFileSync(outPendingJsonlPath, JSON.stringify({
          ...pending,
          _job_id: entry.job.jobId,
        }) + "\n", "utf-8");
      }
    }
    if (outDiagnosticJsonlPath && (entry.diagnosis || (Array.isArray(entry.issues) && entry.issues.length > 0))) {
      fs.appendFileSync(
        outDiagnosticJsonlPath,
        JSON.stringify({
          job_id: entry.job.jobId,
          layer: entry.job.layer,
          repaired: !!entry.repaired,
          issues: Array.isArray(entry.issues) ? entry.issues : [],
          diagnosis: entry.diagnosis || "",
        }) + "\n",
        "utf-8",
      );
    }
  }
}

async function callLlm(
  prompt,
  { apiKey, apiUrl, model, systemPrompt, temperature, maxTokens, connectTimeoutSec, maxTimeSec }
) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-ir-llm-"));
  const bodyPath = path.join(tempDir, "request.json");
  fs.writeFileSync(bodyPath, JSON.stringify(body), "utf-8");

  const env = { ...process.env };
  for (const key of [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    delete env[key];
  }

  const result = await spawnCurlJson({
    apiUrl,
    apiKey,
    bodyPath,
    connectTimeoutSec,
    maxTimeSec,
    env,
  });
  cleanupTempDir(tempDir);

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(result.stderr?.trim() || `curl exit ${result.status}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch (error) {
    throw new Error(`Invalid JSON response: ${String(result.stdout || "").slice(0, 300)}`);
  }
  const content =
    parsed?.choices?.[0]?.message?.content ??
    parsed?.choices?.[0]?.text ??
    "";
  return String(content || "").trim();
}

function spawnCurlJson({ apiUrl, apiKey, bodyPath, connectTimeoutSec, maxTimeSec, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "--connect-timeout",
        String(connectTimeoutSec),
        "--max-time",
        String(maxTimeSec),
        "-sS",
        "--request",
        "POST",
        "--url",
        apiUrl,
        "-H",
        "Content-Type: application/json",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "--data-binary",
        `@${bodyPath}`,
      ],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (typeof code === "number" && code !== 0) {
        reject(new Error(stderr.trim() || `curl exit ${code}`));
        return;
      }
      resolve({ stdout, stderr, status: code ?? 0 });
    });
  });
}

function cleanupTempDir(tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup failures
  }
}

function parseMarkdownItems(markdown) {
  if (!markdown || markdown.trim() === "[]") return [];
  const parts = markdown.split(/^\s*###\s+Item\s*$/m).slice(1);
  return parts
    .map((part) => parseMarkdownItemBlock(part.trim()))
    .filter(Boolean);
}

function parseMarkdownItemBlock(block) {
  const lines = String(block || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const item = {};
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "evidence_span_ids") {
      item[key] = value
        .split(/[,，\s]+/)
        .map((v) => v.trim())
        .filter(Boolean);
    } else if (key === "confidence") {
      const parsed = Number.parseFloat(value);
      if (!Number.isNaN(parsed)) item[key] = parsed;
    } else {
      item[key] = value;
    }
  }
  return Object.keys(item).length > 0 ? item : null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-/g, "_");
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function normalizeCsv(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function safeReadTrimmed(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readProviderConfig() {
  const configPath =
    process.env.OPENCLAW_CONFIG?.trim() ||
    "\\\\wsl.localhost\\Ubuntu-24.04\\home\\pongs\\.openclaw\\openclaw.json";
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const provider = parsed?.models?.providers?.bailian || {};
    let apiUrl = String(provider.baseUrl || "").trim();
    if (apiUrl && !apiUrl.endsWith("/chat/completions")) {
      apiUrl = apiUrl.replace(/\/+$/, "") + "/chat/completions";
    }
    const apiKey = String(provider.apiKey || "").trim();
    const models = Array.isArray(provider.models) ? provider.models : [];
    const preferred = models.find((model) => String(model?.id || "").trim() === "qwen3.5-plus");
    const model = String(preferred?.name || preferred?.id || "qwen3.5-plus").trim();
    return { apiUrl, apiKey, model };
  } catch {
    return { apiUrl: "", apiKey: "", model: "" };
  }
}

