#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
    renderLoCoMoNarrative,
    buildLoCoMoSessionTrace,
    selectLoCoMoQuestionSubset,
} from "../dist/v8/review/locomo-benchmark-prep.js";
import { selectLoCoMoSmokeSamples } from "../dist/v8/review/locomo-smoke-selection.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_OUT = path.join(ROOT, ".tmp", "benchmark-eval");

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.benchmark) {
        printHelp();
        process.exit(args.help ? 0 : 1);
    }

    const benchmark = String(args.benchmark).toLowerCase();
    const input = args.input ? path.resolve(String(args.input)) : "";
    const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined;
    const smoke = args.smoke === true || String(args.smoke || "").toLowerCase() === "true";
    const outDir = path.resolve(String(args.out || DEFAULT_OUT));

    if (benchmark === "locomo") {
        if (!input) throw new Error("--input is required for benchmark=locomo");
        prepareLoCoMo({ input, limit, outDir, smoke });
        return;
    }

    if (benchmark === "longmemeval") {
        if (!input) throw new Error("--input is required for benchmark=longmemeval");
        prepareGenericHistoryQa({
            benchmark: "longmemeval",
            input,
            outDir,
            limit,
            normalizer: normalizeLongMemEvalRecord,
        });
        return;
    }

    if (benchmark === "memoryagentbench") {
        if (!input) throw new Error("--input is required for benchmark=memoryagentbench");
        prepareGenericHistoryQa({
            benchmark: "memoryagentbench",
            input,
            outDir,
            limit,
            normalizer: normalizeMemoryAgentBenchRecord,
        });
        return;
    }

    throw new Error(`Unsupported benchmark: ${benchmark}`);
}

function prepareLoCoMo({ input, limit, outDir, smoke }) {
    const raw = JSON.parse(fs.readFileSync(input, "utf-8"));
    const samples = Array.isArray(raw) ? raw : [];
    if (!Array.isArray(samples) || samples.length === 0) {
        throw new Error("LoCoMo input must be a non-empty JSON array.");
    }

    const finalSamples = smoke
        ? selectLoCoMoSmokeSamples(samples, { size: typeof limit === "number" ? limit : 10 })
        : typeof limit === "number"
          ? samples.slice(0, limit)
          : samples;
    for (let idx = 0; idx < finalSamples.length; idx += 1) {
        const sample = finalSamples[idx];
        const sampleId = String(sample.sample_id || `locomo_${idx + 1}`);
        const sampleDir = path.join(outDir, "locomo", sampleId);
        mkdirp(sampleDir);

        const { markdown, turnMap } = renderLoCoMoNarrative(sample);
        const sessionTrace = buildLoCoMoSessionTrace(sample, sampleId);
        const selectedQa = smoke
            ? selectLoCoMoQuestionSubset(sample.qa || [], { maxQuestions: 16 })
            : (sample.qa || []);
        const questions = selectedQa.map((qa, qIndex) => ({
            question_id: `${sampleId}_q${qIndex + 1}`,
            question: qa.question || "",
            answer: normalizeTextish(qa.answer),
            evidence_refs: Array.isArray(qa.evidence) ? qa.evidence : [],
            category: qa.category ?? null,
            benchmark: "locomo",
            sample_id: sampleId,
        }));

        fs.writeFileSync(path.join(sampleDir, "session_narrative.md"), markdown, "utf-8");
        writeJsonl(path.join(sampleDir, "session_trace.jsonl"), sessionTrace);
        writeJsonl(path.join(sampleDir, "turn_map.jsonl"), turnMap);
        writeJsonl(path.join(sampleDir, "questions.jsonl"), questions);
        fs.writeFileSync(
            path.join(sampleDir, "metadata.json"),
            JSON.stringify(
                {
                    benchmark: "locomo",
                    sample_id: sampleId,
                    speakers: [sample.conversation?.speaker_a, sample.conversation?.speaker_b].filter(Boolean),
                    question_count: questions.length,
                    original_question_count: Array.isArray(sample.qa) ? sample.qa.length : 0,
                    session_count: countSessionKeys(sample.conversation || {}),
                    source_input: input,
                    smoke_question_limit: smoke ? 16 : null,
                },
                null,
                2
            ),
            "utf-8"
        );
    }
}

function countSessionKeys(conv) {
    return Object.keys(conv)
        .map((key) => key.match(/^session_(\d+)$/))
        .filter(Boolean)
        .reduce((max, match) => Math.max(max, Number(match[1])), 0);
}

function prepareGenericHistoryQa({ benchmark, input, outDir, limit, normalizer }) {
    const raw = JSON.parse(fs.readFileSync(input, "utf-8"));
    const samples = Array.isArray(raw)
        ? raw
        : Array.isArray(raw.samples)
          ? raw.samples
          : Array.isArray(raw.data)
            ? raw.data
            : [];
    if (samples.length === 0) {
        throw new Error(`${benchmark} input must expose an array at top-level, .samples, or .data`);
    }

    const selected = typeof limit === "number" ? samples.slice(0, limit) : samples;
    for (let idx = 0; idx < selected.length; idx += 1) {
        const normalized = normalizer(selected[idx], idx);
        const sampleDir = path.join(outDir, benchmark, normalized.sampleId);
        mkdirp(sampleDir);
        fs.writeFileSync(
            path.join(sampleDir, "session_narrative.md"),
            `${normalized.markdown.trim()}\n`,
            "utf-8"
        );
        writeJsonl(path.join(sampleDir, "questions.jsonl"), normalized.questions);
        writeJsonl(path.join(sampleDir, "turn_map.jsonl"), normalized.turnMap || []);
        fs.writeFileSync(
            path.join(sampleDir, "metadata.json"),
            JSON.stringify(
                {
                    benchmark,
                    sample_id: normalized.sampleId,
                    question_count: normalized.questions.length,
                    source_input: input,
                    notes: normalized.notes || "",
                },
                null,
                2
            ),
            "utf-8"
        );
    }
}

function normalizeLongMemEvalRecord(record, idx) {
    const sampleId = String(
        record.id || record.sample_id || record.question_id || `longmemeval_${idx + 1}`
    );
    const history = extractHistoryItems(record);
    const { markdown, turnMap } = renderGenericNarrative(history);
    const question = firstNonEmpty(
        record.question,
        record.query,
        record.prompt,
        record.task?.question,
        record.qa?.question
    );
    const answer = firstNonEmpty(record.answer, record.target, record.gold, record.reference_answer);

    return {
        sampleId,
        markdown,
        turnMap,
        notes: "Flexible adapter for local LongMemEval-style subsets.",
        questions: [
            {
                question_id: `${sampleId}_q1`,
                question: question || "",
                answer: normalizeTextish(answer),
                evidence_refs: record.evidence || record.supporting_facts || [],
                benchmark: "longmemeval",
                sample_id: sampleId,
            },
        ],
    };
}

function normalizeMemoryAgentBenchRecord(record, idx) {
    const sampleId = String(record.id || record.sample_id || record.task_id || `mab_${idx + 1}`);
    const history = extractHistoryItems(record);
    const { markdown, turnMap } = renderGenericNarrative(history);
    const question = firstNonEmpty(
        record.question,
        record.query,
        record.prompt,
        record.task,
        record.task_description,
        record.goal
    );
    const answer = firstNonEmpty(record.answer, record.gold, record.reference_answer, record.expected);

    return {
        sampleId,
        markdown,
        turnMap,
        notes: "Flexible adapter for local MemoryAgentBench thin subsets.",
        questions: [
            {
                question_id: `${sampleId}_q1`,
                question: question || "",
                answer: normalizeTextish(answer),
                evidence_refs: record.evidence || record.supporting_facts || [],
                benchmark: "memoryagentbench",
                sample_id: sampleId,
                competency: record.competency || record.category || null,
            },
        ],
    };
}

function extractHistoryItems(record) {
    const raw =
        record.messages ||
        record.conversation ||
        record.dialogue ||
        record.history ||
        record.sessions ||
        record.memory ||
        record.context ||
        [];

    if (typeof raw === "string") {
        return [{ speaker: "assistant", text: raw }];
    }
    if (!Array.isArray(raw)) return [];

    return raw
        .map((item, idx) => {
            if (typeof item === "string") {
                return { speaker: idx % 2 === 0 ? "user" : "assistant", text: item };
            }
            if (!item || typeof item !== "object") return null;
            const speaker = firstNonEmpty(item.role, item.speaker, item.author, item.name, "unknown");
            const text = firstNonEmpty(
                item.text,
                item.content,
                item.message,
                item.value,
                item.summary
            );
            const timestamp = firstNonEmpty(item.timestamp, item.time, item.date);
            return text ? { speaker, text, timestamp } : null;
        })
        .filter(Boolean);
}

function renderGenericNarrative(items) {
    const lines = [];
    const turnMap = [];
    let charCursor = 0;
    for (let idx = 0; idx < items.length; idx += 1) {
        const item = items[idx];
        const header = `### ${String(item.speaker || "unknown")}`;
        const body = item.timestamp
            ? `[${String(item.timestamp)}] ${String(item.text || "").trim()}`
            : String(item.text || "").trim();
        const chunk = `${header}\n${body}\n`;
        lines.push(header);
        lines.push(body);
        lines.push("");
        const start = charCursor + header.length + 1;
        const end = start + body.length;
        turnMap.push({
            turn_index: idx + 1,
            speaker: String(item.speaker || "unknown"),
            char_start: start,
            char_end: end,
            text: body,
        });
        charCursor += chunk.length + 1;
    }
    return {
        markdown: lines.join("\n").trim(),
        turnMap,
    };
}

function writeJsonl(filePath, rows) {
    const lines = rows.map((row) => JSON.stringify(row)).join("\n");
    fs.writeFileSync(filePath, lines ? `${lines}\n` : "", "utf-8");
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function normalizeTextish(value) {
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value.trim() : String(value);
}

function mkdirp(dir) {
    fs.mkdirSync(dir, { recursive: true });
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
            "  node scripts/benchmark-eval-prep.mjs --benchmark locomo --input <locomo.json> [--limit 2] [--smoke true] [--out <dir>]",
            "  node scripts/benchmark-eval-prep.mjs --benchmark longmemeval --input <subset.json> [--limit 8]",
            "  node scripts/benchmark-eval-prep.mjs --benchmark memoryagentbench --input <subset.json> [--limit 8]",
            "",
            "Outputs per sample:",
            "  session_narrative.md",
            "  questions.jsonl",
            "  turn_map.jsonl",
            "  metadata.json",
        ].join("\n")
    );
}

main();
