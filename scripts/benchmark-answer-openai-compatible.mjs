#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const API_URL =
  process.env.OPENAI_COMPAT_URL?.trim() ||
  process.env.BENCH_LLM_URL?.trim() ||
  process.env.SILICONFLOW_URL?.trim() ||
  "https://api.openai.com/v1/chat/completions";
const API_KEY =
  process.env.OPENAI_COMPAT_API_KEY?.trim() ||
  process.env.BENCH_LLM_API_KEY?.trim() ||
  process.env.SILICONFLOW_API_KEY?.trim() ||
  "";
const MODEL =
  process.env.OPENAI_COMPAT_MODEL?.trim() ||
  process.env.BENCH_LLM_MODEL?.trim() ||
  process.env.SILICONFLOW_MODEL?.trim() ||
  "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.OPENAI_COMPAT_ANSWER_SYSTEM?.trim() ||
  process.env.BENCH_LLM_SYSTEM?.trim() ||
  process.env.SILICONFLOW_ANSWER_SYSTEM?.trim() ||
  "You answer benchmark questions from provided memory and search evidence. Stay concise and factual. If evidence is insufficient, say so.";

const args = parseArgs(process.argv.slice(2));
const promptFile = args.prompt_file || process.env.V8_BENCH_PROMPT_FILE;
const outputFile = args.output_file || process.env.V8_BENCH_OUTPUT_FILE || "";
const maxTokens = Math.max(
  64,
  Number(
    args.max_tokens ||
      process.env.OPENAI_COMPAT_MAX_TOKENS ||
      process.env.BENCH_LLM_MAX_TOKENS ||
      process.env.SILICONFLOW_MAX_TOKENS ||
      512,
  ),
);
const temperature = Number.isFinite(
  Number(
    args.temperature ||
      process.env.OPENAI_COMPAT_TEMPERATURE ||
      process.env.BENCH_LLM_TEMPERATURE ||
      process.env.SILICONFLOW_TEMPERATURE,
  ),
)
  ? Number(
      args.temperature ||
        process.env.OPENAI_COMPAT_TEMPERATURE ||
        process.env.BENCH_LLM_TEMPERATURE ||
        process.env.SILICONFLOW_TEMPERATURE,
    )
  : 0.2;

if (!API_KEY) {
  console.error("Missing OPENAI_COMPAT_API_KEY/BENCH_LLM_API_KEY");
  process.exit(1);
}
if (!promptFile) {
  console.error("Missing prompt file");
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, "utf-8").trim();
const body = {
  model: MODEL,
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ],
  temperature,
  max_tokens: maxTokens,
};
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-bench-answer-"));
const bodyPath = path.join(tempDir, "request.json");
fs.writeFileSync(bodyPath, JSON.stringify(body), "utf-8");

const result = spawnSync(
  "curl",
  [
    "-sS",
    "--request",
    "POST",
    "--url",
    API_URL,
    "-H",
    "Content-Type: application/json",
    "-H",
    `Authorization: Bearer ${API_KEY}`,
    "--data-binary",
    `@${bodyPath}`,
  ],
  { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
);
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {
  // ignore temp cleanup failures
}

if (result.error) throw result.error;
if (typeof result.status === "number" && result.status !== 0) {
  console.error(result.stderr || `curl exit ${result.status}`);
  process.exit(result.status || 1);
}

const parsed = JSON.parse(result.stdout || "{}");
const answer = String(
  parsed?.choices?.[0]?.message?.content || parsed?.choices?.[0]?.text || "",
).trim();

if (!answer && process.env.V8_BENCH_DEBUG === "1") {
  console.error(
    "[bench-answer] empty response payload",
    JSON.stringify(parsed).slice(0, 4000),
  );
}

if (outputFile) {
  fs.writeFileSync(outputFile, answer, "utf-8");
} else {
  process.stdout.write(answer);
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
