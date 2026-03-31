#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { aggregateSmokeSummaries } from "../dist/v8/review/benchmark-smoke-aggregate.js";
import { writeBenchmarkReviewMarkdown } from "../dist/v8/review/markdown-writer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, ".tmp", "locomo-smoke");

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.input) {
        printHelp();
        process.exit(args.help ? 0 : 1);
    }

    const input = path.resolve(String(args.input));
    const evaluationPath = String(args.evaluation_path || "compiled_memory_recall");
    const limit = Math.max(1, Number(args.limit || 10));
    const topK = Math.max(1, Number(args.top_k || 8));
    const questionConcurrency = Math.max(1, Number(args.question_concurrency || 20));
    const sampleConcurrency = Math.max(1, Number(args.sample_concurrency || limit));
    const outRoot = path.resolve(String(args.out || DEFAULT_OUT));
    const irLlmCommand = args.ir_llm_command ? String(args.ir_llm_command) : "";
    const answerLlmCommand = args.answer_llm_command ? String(args.answer_llm_command) : "";
    const ruleIrMode = args.rule_ir_mode ? String(args.rule_ir_mode) : "off";
    const preparedRoot = path.join(outRoot, "prepared");
    const runsRoot = path.join(outRoot, "runs");
    const runId = `locomo_smoke_${Date.now()}`;

    runNode([
        path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        path.join(ROOT, "tsconfig.json"),
    ]);

    runNode([
        path.join(ROOT, "scripts", "benchmark-eval-prep.mjs"),
        "--benchmark", "locomo",
        "--input", input,
        "--out", preparedRoot,
        "--smoke", "true",
        "--limit", String(limit),
    ]);

    const preparedDir = path.join(preparedRoot, "locomo");
    const sampleDirs = fs.readdirSync(preparedDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(preparedDir, entry.name))
        .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));

    await runWithConcurrency(sampleDirs, sampleConcurrency, async (sampleDir) => {
        const runnerArgs = [
            path.join(ROOT, "scripts", "benchmark-eval-runner.mjs"),
            "--prepared-sample", sampleDir,
            "--evaluation-path", evaluationPath,
            "--top-k", String(topK),
            "--question-concurrency", String(questionConcurrency),
            "--out", runsRoot,
            "--rule-ir-mode", ruleIrMode,
        ];
        if (irLlmCommand) {
            runnerArgs.push("--ir-llm-command", irLlmCommand);
        }
        if (answerLlmCommand) {
            runnerArgs.push("--answer-llm-command", answerLlmCommand);
        }
        await runNodeAsync(runnerArgs);
    });

    const summaries = sampleDirs.map((sampleDir) => {
        const sampleId = path.basename(sampleDir);
        const summaryPath = path.join(runsRoot, "locomo", sampleId, "benchmark_eval_summary.json");
        return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    });

    const executedWorkflows = summaries[0]?.executed_workflows || {
        backgroundCompile: true,
        compiledRecall: true,
        frontSearchEscalation: false,
        backendRelationMining: false,
    };
    const aggregate = aggregateSmokeSummaries({
        runId,
        dataset: "locomo",
        evaluationPath,
        executedWorkflows,
        summaries,
    });

    fs.mkdirSync(outRoot, { recursive: true });
    const aggregateJsonPath = path.join(outRoot, "locomo_smoke_summary.json");
    fs.writeFileSync(aggregateJsonPath, JSON.stringify({
        runId,
        dataset: "locomo",
        evaluationPath,
        sampleCount: sampleDirs.length,
        scorecard: aggregate.scorecard,
        failedSamples: aggregate.failedSamples,
    }, null, 2), "utf8");

    writeBenchmarkReviewMarkdown({
        outputPath: path.join(outRoot, "benchmark_review.md"),
        runContext: {
            runId,
            dataset: "locomo",
            evaluationPath,
        },
        scorecard: aggregate.scorecard,
        failedSamples: aggregate.failedSamples,
    });

    console.log(`out=${outRoot}`);
    console.log(`aggregate=${aggregateJsonPath}`);
    console.log(`sample_count=${sampleDirs.length}`);
    console.log(`sample_concurrency=${Math.min(sampleConcurrency, sampleDirs.length)}`);
}

function runNode(args) {
    const result = spawnSync(process.execPath, args, {
        cwd: ROOT,
        stdio: "inherit",
    });
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

function runNodeAsync(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: ROOT,
            stdio: "inherit",
        });
        child.on("error", reject);
        child.on("close", (status) => {
            if (status && status !== 0) {
                reject(new Error(`child exited with status ${status}`));
                return;
            }
            resolve();
        });
    });
}

async function runWithConcurrency(items, concurrency, worker) {
    const normalizedConcurrency = Math.max(1, Math.floor(concurrency || 1));
    let nextIndex = 0;
    async function runWorker() {
        while (true) {
            const currentIndex = nextIndex;
            if (currentIndex >= items.length) return;
            nextIndex += 1;
            await worker(items[currentIndex], currentIndex);
        }
    }
    const workers = Array.from(
        { length: Math.min(normalizedConcurrency, items.length) },
        () => runWorker(),
    );
    await Promise.all(workers);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            out.help = true;
            continue;
        }
        if (!arg.startsWith("--")) continue;
        const key = arg.slice(2).replace(/-/g, "_");
        const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
        out[key] = value;
    }
    return out;
}

function printHelp() {
    console.log([
        "Usage:",
        "  node scripts/locomo-benchmark-smoke.mjs --input <locomo.json> [--evaluation-path compiled_memory_recall] [--limit 10] [--top-k 8] [--question-concurrency 20] [--sample-concurrency <limit>] [--rule-ir-mode off] [--ir-llm-command <cmd>] [--answer-llm-command <cmd>] [--out <dir>]",
    ].join("\n"));
}
