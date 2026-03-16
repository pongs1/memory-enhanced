#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildCleanSlateGraph } from "../dist/v8/compiler_clean_slate.js";
import { searchArchiveSpans } from "../dist/v8/archive-search.js";
import { v8StorePaths } from "../dist/v8/paths_v8.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_TMP = path.join(ROOT, ".tmp", "benchmark-run");

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.prepared_sample) {
        printHelp();
        process.exit(args.help ? 0 : 1);
    }

    const preparedSampleDir = path.resolve(String(args.prepared_sample));
    const sampleId = path.basename(preparedSampleDir);
    const benchmark = inferBenchmark(preparedSampleDir);
    const topK = Math.max(1, Number(args.top_k || 8));
    const outRoot = path.resolve(String(args.out || DEFAULT_TMP));
    const workspace = path.join(outRoot, benchmark, sampleId);

    prepareWorkspace({
        preparedSampleDir,
        workspace,
        sampleId,
    });

    await buildCleanSlateGraph({
        workspace,
        startAt: "narrative",
        compilePhase: "final",
        ruleIrMode: "off",
        rebuildMode: "full",
        emitUnitPreview: false,
    });

    const store = v8StorePaths(workspace);
    const questions = readJsonl(path.join(preparedSampleDir, "questions.jsonl"));
    const turnMap = readJsonl(path.join(preparedSampleDir, "turn_map.jsonl"));
    const results = questions.map((question) =>
        evaluateQuestion({
            workspace,
            benchmark,
            question,
            turnMap,
            topK,
        })
    );

    const summary = {
        benchmark,
        sample_id: sampleId,
        question_count: questions.length,
        top_k: topK,
        evidence_spans_path: store.evidenceSpans,
        result_count: results.length,
        hit_at_k: results.filter((item) => item.hit).length,
        results,
    };

    const summaryPath = path.join(workspace, "benchmark_eval_summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
    const markdownPath = path.join(workspace, "benchmark_eval_summary.md");
    fs.writeFileSync(markdownPath, renderSummaryMarkdown(summary), "utf-8");

    console.log(`workspace=${workspace}`);
    console.log(`summary=${summaryPath}`);
    console.log(`hit_at_${topK}=${summary.hit_at_k}/${summary.question_count}`);
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

    for (const name of ["questions.jsonl", "turn_map.jsonl", "metadata.json"]) {
        const src = path.join(preparedSampleDir, name);
        if (fs.existsSync(src)) {
            const dstDir = path.join(workspace, "benchmark_eval_inputs");
            fs.mkdirSync(dstDir, { recursive: true });
            fs.copyFileSync(src, path.join(dstDir, name));
        }
    }
}

function evaluateQuestion({ workspace, benchmark, question, turnMap, topK }) {
    const hits = searchArchiveSpans({
        workspace,
        query: String(question.question || ""),
        topK,
        mode: "hybrid",
        windowChars: 260,
    });

    const match = findFirstMatch({ benchmark, question, turnMap, hits });
    return {
        question_id: question.question_id,
        question: question.question,
        answer: question.answer,
        evidence_refs: question.evidence_refs || [],
        hit: Boolean(match),
        first_hit_rank: match ? match.rank : null,
        matched_span_id: match ? match.spanId : null,
        top_hits: hits.slice(0, topK).map((hit, index) => ({
            rank: index + 1,
            span_id: hit.spanId,
            score: round4(hit.score),
            span_text: hit.spanText,
            raw_text: hit.rawText,
        })),
    };
}

function findFirstMatch({ benchmark, question, turnMap, hits }) {
    if (benchmark === "locomo") {
        const expectedTurns = new Set(
            turnMap
                .filter((turn) => (question.evidence_refs || []).includes(turn.dialogue_id))
                .map((turn) => turn.dialogue_id)
        );
        for (let index = 0; index < hits.length; index += 1) {
            const hit = hits[index];
            const overlapping = turnMap.some(
                (turn) =>
                    expectedTurns.has(turn.dialogue_id) &&
                    rangesOverlap(turn.char_start, turn.char_end, hit.charStart, hit.charEnd)
            );
            if (overlapping) {
                return { rank: index + 1, spanId: hit.spanId };
            }
        }
        return null;
    }

    const evidenceTexts = (question.evidence_refs || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    const answer = String(question.answer || "").trim();
    for (let index = 0; index < hits.length; index += 1) {
        const hit = hits[index];
        const hay = `${hit.spanText} ${hit.rawText}`.toLowerCase();
        const evidenceMatched = evidenceTexts.some((needle) => hay.includes(needle.toLowerCase()));
        const answerMatched = answer ? hay.includes(answer.toLowerCase()) : false;
        if (evidenceMatched || answerMatched) {
            return { rank: index + 1, spanId: hit.spanId };
        }
    }
    return null;
}

function renderSummaryMarkdown(summary) {
    const lines = [];
    lines.push(`# Benchmark Eval`);
    lines.push("");
    lines.push(`- benchmark: ${summary.benchmark}`);
    lines.push(`- sample_id: ${summary.sample_id}`);
    lines.push(`- hit_at_${summary.top_k}: ${summary.hit_at_k}/${summary.question_count}`);
    lines.push("");
    for (const item of summary.results) {
        lines.push(`## ${item.question_id}`);
        lines.push(`- question: ${item.question}`);
        lines.push(`- expected answer: ${item.answer}`);
        lines.push(`- hit: ${item.hit ? "yes" : "no"}`);
        lines.push(`- first_hit_rank: ${item.first_hit_rank ?? "none"}`);
        lines.push(`- evidence_refs: ${(item.evidence_refs || []).join(", ") || "(none)"}`);
        lines.push("");
        item.top_hits.forEach((hit) => {
            lines.push(
                `  - [${hit.rank}] ${hit.span_id} score=${hit.score} text=${trim(hit.span_text, 180)}`
            );
        });
        lines.push("");
    }
    return `${lines.join("\n").trim()}\n`;
}

function inferBenchmark(preparedSampleDir) {
    const parts = preparedSampleDir.split(path.sep);
    const idx = parts.lastIndexOf("locomo");
    if (idx >= 0) return "locomo";
    if (parts.includes("longmemeval")) return "longmemeval";
    if (parts.includes("memoryagentbench")) return "memoryagentbench";
    return "unknown";
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function round4(value) {
    return Math.round(Number(value) * 10000) / 10000;
}

function trim(text, maxChars) {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}...`;
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
    console.log(
        [
            "Usage:",
            "  node scripts/benchmark-eval-runner.mjs --prepared-sample <dir> [--top-k 8] [--out <dir>]",
            "",
            "Expected prepared sample dir contents:",
            "  session_narrative.md",
            "  questions.jsonl",
            "  turn_map.jsonl (optional but used for LoCoMo evidence checks)",
        ].join("\n")
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
