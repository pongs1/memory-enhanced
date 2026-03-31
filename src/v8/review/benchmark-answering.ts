import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommandChain, runCommandChainAsync } from "./command-runner.js";

export interface BenchmarkAnswerHit {
  spanId?: string | null;
  spanText?: string | null;
  rawText?: string | null;
  score?: number | null;
}

export interface BenchmarkAnswerPromptInput {
  question: string;
  memoryPrompt?: string;
  searchHits?: BenchmarkAnswerHit[];
}

export interface BenchmarkAnswerCommandInput extends BenchmarkAnswerPromptInput {
  command: string;
  workspace?: string;
  mode: "memory" | "search";
}

export interface BenchmarkAnswerCommandOutput {
  answer: string;
  commandStatus: string;
}

export function combineRecallPrompts(prompts: Array<{ prompt: string }>): string {
  return prompts
    .map((item) => String(item?.prompt || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function buildBenchmarkAnswerPrompt(input: BenchmarkAnswerPromptInput): string {
  const question = String(input.question || "").trim();
  const memoryPrompt = String(input.memoryPrompt || "").trim();
  const searchSection = buildSearchEvidenceSection(input.searchHits || []);
  const lines = [
    "You are answering a benchmark question.",
    "Use the provided memory recall blocks and search evidence when relevant.",
    "Answer concisely and factually.",
    "If the evidence is insufficient, say so instead of inventing details.",
    "",
    "## Question",
    question,
  ];
  if (memoryPrompt) {
    lines.push("", "## Memory Recall", memoryPrompt);
  }
  if (searchSection) {
    lines.push("", "## Search Evidence", searchSection);
  }
  lines.push("", "## Answer");
  return lines.join("\n").trim() + "\n";
}

export function runBenchmarkAnswerCommand(
  input: BenchmarkAnswerCommandInput,
): BenchmarkAnswerCommandOutput {
  const command = String(input.command || "").trim();
  if (!command) {
    return { answer: "", commandStatus: "skipped" };
  }

  const workspace = input.workspace || process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-bench-answer-"));
  const questionPath = path.join(tmpDir, "question.txt");
  const memoryPath = path.join(tmpDir, "memory.txt");
  const searchPath = path.join(tmpDir, "search.txt");
  const promptPath = path.join(tmpDir, "prompt.txt");
  const outputPath = path.join(tmpDir, "answer.txt");

  const question = String(input.question || "").trim();
  const memoryPrompt = String(input.memoryPrompt || "").trim();
  const searchSection = buildSearchEvidenceSection(input.searchHits || []);
  const fullPrompt = buildBenchmarkAnswerPrompt(input);

  fs.writeFileSync(questionPath, question, "utf-8");
  fs.writeFileSync(memoryPath, memoryPrompt, "utf-8");
  fs.writeFileSync(searchPath, searchSection, "utf-8");
  fs.writeFileSync(promptPath, fullPrompt, "utf-8");

  const interpolated = command
    .replace(/\{question_file\}/g, questionPath)
    .replace(/\{memory_file\}/g, memoryPath)
    .replace(/\{search_file\}/g, searchPath)
    .replace(/\{prompt_file\}/g, promptPath)
    .replace(/\{output_file\}/g, outputPath);

  const result = runCommandChain(interpolated, {
    cwd: workspace,
    env: {
      ...process.env,
      V8_BENCH_MODE: input.mode,
      V8_BENCH_QUESTION_FILE: questionPath,
      V8_BENCH_MEMORY_FILE: memoryPath,
      V8_BENCH_SEARCH_FILE: searchPath,
      V8_BENCH_PROMPT_FILE: promptPath,
      V8_BENCH_OUTPUT_FILE: outputPath,
    },
    maxBuffer: 16 * 1024 * 1024,
  });

  let answer = "";
  if (fs.existsSync(outputPath)) {
    answer = fs.readFileSync(outputPath, "utf-8").trim();
  } else {
    answer = String(result.stdout || "").trim();
  }

  let commandStatus = "completed";
  if (result.error) {
    commandStatus = `failed:${result.error.message}`;
  } else if (typeof result.status === "number" && result.status !== 0) {
    commandStatus = `exit:${result.status}`;
  } else if (!answer) {
    commandStatus = "empty";
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup failures
  }

  return { answer, commandStatus };
}

export async function runBenchmarkAnswerCommandAsync(
  input: BenchmarkAnswerCommandInput,
): Promise<BenchmarkAnswerCommandOutput> {
  const command = String(input.command || "").trim();
  if (!command) {
    return { answer: "", commandStatus: "skipped" };
  }

  const workspace = input.workspace || process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v8-bench-answer-"));
  const questionPath = path.join(tmpDir, "question.txt");
  const memoryPath = path.join(tmpDir, "memory.txt");
  const searchPath = path.join(tmpDir, "search.txt");
  const promptPath = path.join(tmpDir, "prompt.txt");
  const outputPath = path.join(tmpDir, "answer.txt");

  const question = String(input.question || "").trim();
  const memoryPrompt = String(input.memoryPrompt || "").trim();
  const searchSection = buildSearchEvidenceSection(input.searchHits || []);
  const fullPrompt = buildBenchmarkAnswerPrompt(input);

  fs.writeFileSync(questionPath, question, "utf-8");
  fs.writeFileSync(memoryPath, memoryPrompt, "utf-8");
  fs.writeFileSync(searchPath, searchSection, "utf-8");
  fs.writeFileSync(promptPath, fullPrompt, "utf-8");

  const interpolated = command
    .replace(/\{question_file\}/g, questionPath)
    .replace(/\{memory_file\}/g, memoryPath)
    .replace(/\{search_file\}/g, searchPath)
    .replace(/\{prompt_file\}/g, promptPath)
    .replace(/\{output_file\}/g, outputPath);

  const result = await runCommandChainAsync(interpolated, {
    cwd: workspace,
    env: {
      ...process.env,
      V8_BENCH_MODE: input.mode,
      V8_BENCH_QUESTION_FILE: questionPath,
      V8_BENCH_MEMORY_FILE: memoryPath,
      V8_BENCH_SEARCH_FILE: searchPath,
      V8_BENCH_PROMPT_FILE: promptPath,
      V8_BENCH_OUTPUT_FILE: outputPath,
    },
    maxBuffer: 16 * 1024 * 1024,
  });

  let answer = "";
  if (fs.existsSync(outputPath)) {
    answer = fs.readFileSync(outputPath, "utf-8").trim();
  } else {
    answer = String(result.stdout || "").trim();
  }

  let commandStatus = "completed";
  if (result.error) {
    commandStatus = `failed:${result.error.message}`;
  } else if (typeof result.status === "number" && result.status !== 0) {
    commandStatus = `exit:${result.status}`;
  } else if (!answer) {
    commandStatus = "empty";
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore temp cleanup failures
  }

  return { answer, commandStatus };
}

function buildSearchEvidenceSection(hits: BenchmarkAnswerHit[]): string {
  const lines = hits
    .filter(Boolean)
    .slice(0, 8)
    .map((hit, index) => {
      const scoreText =
        typeof hit.score === "number" && Number.isFinite(hit.score)
          ? ` score=${hit.score.toFixed(4)}`
          : "";
      const text = String(hit.spanText || hit.rawText || "").trim();
      if (!text) return "";
      return `- [${index + 1}]${scoreText} ${text}`;
    })
    .filter(Boolean);
  return lines.join("\n");
}
