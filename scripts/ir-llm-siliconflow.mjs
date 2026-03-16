#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const API_URL =
  process.env.SILICONFLOW_URL?.trim() ||
  "https://api.siliconflow.cn/v1/chat/completions";
const API_KEY = process.env.SILICONFLOW_API_KEY?.trim();
const MODEL =
  process.env.SILICONFLOW_MODEL?.trim() || "Pro/zai-org/GLM-4.7";
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
const maxJobs = Math.max(1, Number(args.max_jobs || process.env.SILICONFLOW_MAX_JOBS || 0) || Number.MAX_SAFE_INTEGER);
const maxTokens = Math.max(64, Number(args.max_tokens || process.env.SILICONFLOW_MAX_TOKENS || 700));
const temperature = Number.isFinite(Number(args.temperature || process.env.SILICONFLOW_TEMPERATURE))
  ? Number(args.temperature || process.env.SILICONFLOW_TEMPERATURE)
  : 0.2;
const includeLayers = normalizeCsv(args.include_layers || process.env.SILICONFLOW_INCLUDE_LAYERS || "");
const excludeLayers = normalizeCsv(args.exclude_layers || process.env.SILICONFLOW_EXCLUDE_LAYERS || "");
const connectTimeoutSec = Math.max(5, Number(args.connect_timeout_sec || 15));
const maxTimeSec = Math.max(15, Number(args.max_time_sec || 180));
const sleepMs = Math.max(0, Number(args.sleep_ms || 0));

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

let completed = 0;
for (const job of jobs) {
  const prompt = String(job.prompt || "").trim();
  if (!prompt) continue;
  try {
    const output = callLlm(prompt, {
      apiKey: API_KEY,
      apiUrl: API_URL,
      model: MODEL,
      systemPrompt: SYSTEM_PROMPT,
      temperature,
      maxTokens,
      connectTimeoutSec,
      maxTimeSec,
    });
    if (!output) continue;
    fs.appendFileSync(outMdPath, output + "\n\n", "utf-8");
    if (outJsonlPath) {
      const records = parseMarkdownItems(output).map((item) => ({
        ...item,
        _job_id: job.jobId,
      }));
      for (const record of records) {
        fs.appendFileSync(outJsonlPath, JSON.stringify(record, null, 0) + "\n", "utf-8");
      }
    }
    completed += 1;
    console.error(`[ir-llm] ${completed}/${jobs.length} ${job.jobId}`);
  } catch (error) {
    console.error(`[ir-llm] failed ${job.jobId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sleepMs > 0) sleep(sleepMs);
}

function callLlm(
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

  const result = spawnSync(
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
      "-d",
      JSON.stringify(body),
    ],
    {
      encoding: "utf-8",
      env,
      maxBuffer: 32 * 1024 * 1024,
    }
  );

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
