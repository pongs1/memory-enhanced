import fs from "node:fs";
import path from "node:path";

const API_URL =
  process.env.SILICONFLOW_URL?.trim() ||
  "https://api.siliconflow.cn/v1/chat/completions";
const API_KEY = process.env.SILICONFLOW_API_KEY?.trim();
const MODEL =
  process.env.SILICONFLOW_MODEL?.trim() || "Pro/zai-org/GLM-4.7";
const SYSTEM_PROMPT =
  process.env.SILICONFLOW_SYSTEM?.trim() || "";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!key || !value) continue;
  if (!key.startsWith("--")) continue;
  args.set(key.slice(2), value);
  i += 1;
}

const jobsPath =
  args.get("jobs") ||
  process.env.V8_IR_JOBS ||
  process.env.V8_IR_ITEMS_INPUT;
const outPath =
  args.get("out") ||
  process.env.V8_IR_ITEMS_MD ||
  process.env.V8_IR_ITEMS ||
  "";

if (!API_KEY) {
  console.error("Missing SILICONFLOW_API_KEY");
  process.exit(1);
}
if (!jobsPath || !outPath) {
  console.error("Usage: node scripts/ir-llm-siliconflow.mjs --jobs <ir_llm_jobs.jsonl> --out <ir_llm_items.md>");
  process.exit(1);
}

const raw = fs.readFileSync(jobsPath, "utf-8").trim();
if (!raw) {
  fs.writeFileSync(outPath, "", "utf-8");
  process.exit(0);
}

const jobs = raw
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, "", "utf-8");

async function callLlm(prompt) {
  const messages = [];
  if (SYSTEM_PROMPT) {
    messages.push({ role: "system", content: SYSTEM_PROMPT });
  }
  messages.push({ role: "user", content: prompt });
  const body = {
    model: MODEL,
    messages,
    temperature: 0.2,
  };
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";
  return String(content || "").trim();
}

for (const job of jobs) {
  const prompt = String(job.prompt || "").trim();
  if (!prompt) continue;
  const output = await callLlm(prompt);
  if (!output) continue;
  fs.appendFileSync(outPath, output + "\n\n", "utf-8");
}
