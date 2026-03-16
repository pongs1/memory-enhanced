#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildCleanSlateGraph } from "../dist/v8/compiler_clean_slate.js";
import { searchArchiveSpans } from "../dist/v8/archive-search.js";
import { v8StorePaths } from "../dist/v8/paths_v8.js";
import { V8GraphScanner } from "../dist/v8/scanner.js";

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
    const irLlmCommand = args.ir_llm_command ? String(args.ir_llm_command) : undefined;
    const ruleIrMode = args.rule_ir_mode ? String(args.rule_ir_mode) : "off";

    prepareWorkspace({
        preparedSampleDir,
        workspace,
        sampleId,
    });

    await buildCleanSlateGraph({
        workspace,
        startAt: "narrative",
        compilePhase: "final",
        ruleIrMode,
        rebuildMode: "full",
        emitUnitPreview: false,
        llmCommand: irLlmCommand,
    });

    const store = v8StorePaths(workspace);
    const questions = readJsonl(path.join(preparedSampleDir, "questions.jsonl"));
    const turnMap = readJsonl(path.join(preparedSampleDir, "turn_map.jsonl"));
    const graphNodes = readJsonl(store.graphNodes);
    const evidenceSpans = readJsonl(store.evidenceSpans);
    const relationSearchPlans = readJsonl(store.relationSearchPlans);
    const narrativeShardSelections = readJsonl(store.narrativeShardSelections);
    const scanner = new V8GraphScanner(workspace, {}, "trajectory");
    const results = questions.map((question) =>
        evaluateQuestion({
            workspace,
            benchmark,
            question,
            turnMap,
            graphNodes,
            evidenceSpans,
            relationSearchPlans,
            narrativeShardSelections,
            scanner,
            topK,
        })
    );

    const summary = {
        benchmark,
        sample_id: sampleId,
        ir_llm_command: irLlmCommand || null,
        rule_ir_mode: ruleIrMode,
        question_count: questions.length,
        top_k: topK,
        evidence_spans_path: store.evidenceSpans,
        relation_search_plan_count: relationSearchPlans.length,
        result_count: results.length,
        raw_hit_at_k: results.filter((item) => item.raw_hit).length,
        raw_full_support_hit_at_k: results.filter((item) => item.raw_full_support_hit).length,
        static_guided_hit_at_k: results.filter((item) => item.static_guided_hit).length,
        static_guided_full_support_hit_at_k: results.filter((item) => item.static_guided_full_support_hit).length,
        ignition_guided_hit_at_k: results.filter((item) => item.ignition_guided_hit).length,
        ignition_guided_full_support_hit_at_k: results.filter((item) => item.ignition_guided_full_support_hit).length,
        results,
    };

    const summaryPath = path.join(workspace, "benchmark_eval_summary.json");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
    const markdownPath = path.join(workspace, "benchmark_eval_summary.md");
    fs.writeFileSync(markdownPath, renderSummaryMarkdown(summary), "utf-8");

    console.log(`workspace=${workspace}`);
    console.log(`summary=${summaryPath}`);
    console.log(`raw_hit_at_${topK}=${summary.raw_hit_at_k}/${summary.question_count}`);
    console.log(`raw_full_support_hit_at_${topK}=${summary.raw_full_support_hit_at_k}/${summary.question_count}`);
    console.log(`static_guided_hit_at_${topK}=${summary.static_guided_hit_at_k}/${summary.question_count}`);
    console.log(`static_guided_full_support_hit_at_${topK}=${summary.static_guided_full_support_hit_at_k}/${summary.question_count}`);
    console.log(`ignition_guided_hit_at_${topK}=${summary.ignition_guided_hit_at_k}/${summary.question_count}`);
    console.log(`ignition_guided_full_support_hit_at_${topK}=${summary.ignition_guided_full_support_hit_at_k}/${summary.question_count}`);
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

function evaluateQuestion({
    workspace,
    benchmark,
    question,
    turnMap,
    graphNodes,
    evidenceSpans,
    relationSearchPlans,
    narrativeShardSelections,
    scanner,
    topK,
}) {
    const rawHits = searchArchiveSpans({
        workspace,
        query: String(question.question || ""),
        topK,
        mode: "hybrid",
        windowChars: 260,
    });
    const selectedPlans = selectPlansForQuestion(question, relationSearchPlans, 3);
    const staticGuidedHits = selectedPlans.length > 0
        ? searchArchiveSpans({
              workspace,
              query: joinQuery(
                  question.question,
                  uniqueStrings(selectedPlans.flatMap((plan) => plan.queryTerms || []))
              ),
              topK,
              mode: "hybrid",
              windowChars: 260,
              allowedShardIds: uniqueStrings(
                  selectedPlans.flatMap((plan) =>
                      loadAllowedShardIds(plan.id, narrativeShardSelections)
                  )
              ),
              boostSpanIds: uniqueStrings(
                  selectedPlans.flatMap((plan) => plan.hintSpanIds || [])
              ),
          })
        : [];

    const ignitionGuided = runIgnitionGuidedSearch({
        question,
        scanner,
        graphNodes,
        evidenceSpans,
        workspace,
        topK,
    });

    const rawMatch = findFirstMatch({ benchmark, question, turnMap, hits: rawHits });
    const staticGuidedMatch = findFirstMatch({
        benchmark,
        question,
        turnMap,
        hits: staticGuidedHits,
    });
    const ignitionGuidedMatch = findFirstMatch({
        benchmark,
        question,
        turnMap,
        hits: ignitionGuided.hits,
    });
    const rawSupport = scoreSupportCoverage({ benchmark, question, turnMap, hits: rawHits });
    const staticGuidedSupport = scoreSupportCoverage({
        benchmark,
        question,
        turnMap,
        hits: staticGuidedHits,
    });
    const ignitionGuidedSupport = scoreSupportCoverage({
        benchmark,
        question,
        turnMap,
        hits: ignitionGuided.hits,
    });
    return {
        question_id: question.question_id,
        question: question.question,
        answer: question.answer,
        evidence_refs: question.evidence_refs || [],
        selected_plan_ids: selectedPlans.map((plan) => plan.id),
        selected_plan_anchor_labels: uniqueStrings(
            selectedPlans.flatMap((plan) => plan.anchorLabels || [])
        ),
        raw_hit: Boolean(rawMatch),
        raw_first_hit_rank: rawMatch ? rawMatch.rank : null,
        raw_matched_span_id: rawMatch ? rawMatch.spanId : null,
        raw_support_coverage: round4(rawSupport.coverage),
        raw_support_hits: rawSupport.hits,
        raw_full_support_hit: rawSupport.fullHit,
        static_guided_hit: Boolean(staticGuidedMatch),
        static_guided_first_hit_rank: staticGuidedMatch ? staticGuidedMatch.rank : null,
        static_guided_matched_span_id: staticGuidedMatch ? staticGuidedMatch.spanId : null,
        static_guided_support_coverage: round4(staticGuidedSupport.coverage),
        static_guided_support_hits: staticGuidedSupport.hits,
        static_guided_full_support_hit: staticGuidedSupport.fullHit,
        ignition_guided_bundle_ids: ignitionGuided.bundleIds,
        ignition_guided_anchor_labels: ignitionGuided.anchorLabels,
        ignition_guided_hit: Boolean(ignitionGuidedMatch),
        ignition_guided_first_hit_rank: ignitionGuidedMatch ? ignitionGuidedMatch.rank : null,
        ignition_guided_matched_span_id: ignitionGuidedMatch ? ignitionGuidedMatch.spanId : null,
        ignition_guided_support_coverage: round4(ignitionGuidedSupport.coverage),
        ignition_guided_support_hits: ignitionGuidedSupport.hits,
        ignition_guided_full_support_hit: ignitionGuidedSupport.fullHit,
        raw_top_hits: rawHits.slice(0, topK).map((hit, index) => ({
            rank: index + 1,
            span_id: hit.spanId,
            score: round4(hit.score),
            span_text: hit.spanText,
            raw_text: hit.rawText,
        })),
        static_guided_top_hits: staticGuidedHits.slice(0, topK).map((hit, index) => ({
            rank: index + 1,
            span_id: hit.spanId,
            score: round4(hit.score),
            span_text: hit.spanText,
            raw_text: hit.rawText,
        })),
        ignition_guided_top_hits: ignitionGuided.hits.slice(0, topK).map((hit, index) => ({
            rank: index + 1,
            span_id: hit.spanId,
            score: round4(hit.score),
            span_text: hit.spanText,
            raw_text: hit.rawText,
        })),
    };
}

function findFirstMatch({ benchmark, question, turnMap, hits }) {
    const support = scoreSupportCoverage({ benchmark, question, turnMap, hits });
    if (support.fullHit && support.firstRank !== null) {
        return { rank: support.firstRank, spanId: support.firstSpanId };
    }

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
        const evidenceMatched = evidenceTexts.some((needle) =>
            textEvidenceMatches({
                haystack: hay,
                needle,
                answer,
            })
        );
        const answerMatched = answer
            ? textEvidenceMatches({
                  haystack: hay,
                  needle: answer,
                  answer,
              })
            : false;
        if (evidenceMatched || answerMatched) {
            return { rank: index + 1, spanId: hit.spanId };
        }
    }
    return null;
}

function scoreSupportCoverage({ benchmark, question, turnMap, hits }) {
    if (benchmark === "locomo") {
        const expectedTurns = new Set(
            turnMap
                .filter((turn) => (question.evidence_refs || []).includes(turn.dialogue_id))
                .map((turn) => turn.dialogue_id)
        );
        const matchedTurns = new Set();
        let firstRank = null;
        let firstSpanId = null;
        for (let index = 0; index < hits.length; index += 1) {
            const hit = hits[index];
            const overlappingTurns = turnMap
                .filter(
                    (turn) =>
                        expectedTurns.has(turn.dialogue_id) &&
                        rangesOverlap(turn.char_start, turn.char_end, hit.charStart, hit.charEnd)
                )
                .map((turn) => turn.dialogue_id);
            if (overlappingTurns.length > 0 && firstRank === null) {
                firstRank = index + 1;
                firstSpanId = hit.spanId;
            }
            for (const dialogueId of overlappingTurns) {
                matchedTurns.add(dialogueId);
            }
        }

        return {
            coverage: expectedTurns.size > 0 ? matchedTurns.size / expectedTurns.size : 0,
            hits: Array.from(matchedTurns),
            fullHit: expectedTurns.size > 0 && matchedTurns.size === expectedTurns.size,
            firstRank,
            firstSpanId,
        };
    }

    const evidenceTexts = (question.evidence_refs || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    const answer = String(question.answer || "").trim();
    const matchedEvidence = [];
    let firstRank = null;
    let firstSpanId = null;
    for (const evidenceText of evidenceTexts) {
        const match = findSupportingHit({ hits, needle: evidenceText, answer });
        if (!match) continue;
        matchedEvidence.push(evidenceText);
        if (firstRank === null || match.rank < firstRank) {
            firstRank = match.rank;
            firstSpanId = match.spanId;
        }
    }

    const answerMatch = answer ? findSupportingHit({ hits, needle: answer, answer }) : null;
    if (firstRank === null && answerMatch) {
        firstRank = answerMatch.rank;
        firstSpanId = answerMatch.spanId;
    }

    return {
        coverage: evidenceTexts.length > 0 ? matchedEvidence.length / evidenceTexts.length : answerMatch ? 1 : 0,
        hits: matchedEvidence,
        fullHit: evidenceTexts.length > 0 ? matchedEvidence.length === evidenceTexts.length : Boolean(answerMatch),
        firstRank,
        firstSpanId,
    };
}

function findSupportingHit({ hits, needle, answer }) {
    for (let index = 0; index < hits.length; index += 1) {
        const hit = hits[index];
        const hay = `${hit.spanText} ${hit.rawText}`.toLowerCase();
        if (textEvidenceMatches({ haystack: hay, needle, answer })) {
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
    lines.push(`- relation_search_plan_count: ${summary.relation_search_plan_count}`);
    lines.push(`- raw_hit_at_${summary.top_k}: ${summary.raw_hit_at_k}/${summary.question_count}`);
    lines.push(`- raw_full_support_hit_at_${summary.top_k}: ${summary.raw_full_support_hit_at_k}/${summary.question_count}`);
    lines.push(`- static_guided_hit_at_${summary.top_k}: ${summary.static_guided_hit_at_k}/${summary.question_count}`);
    lines.push(`- static_guided_full_support_hit_at_${summary.top_k}: ${summary.static_guided_full_support_hit_at_k}/${summary.question_count}`);
    lines.push(`- ignition_guided_hit_at_${summary.top_k}: ${summary.ignition_guided_hit_at_k}/${summary.question_count}`);
    lines.push(`- ignition_guided_full_support_hit_at_${summary.top_k}: ${summary.ignition_guided_full_support_hit_at_k}/${summary.question_count}`);
    lines.push("");
    for (const item of summary.results) {
        lines.push(`## ${item.question_id}`);
        lines.push(`- question: ${item.question}`);
        lines.push(`- expected answer: ${item.answer}`);
        lines.push(
            `- selected_plan_ids: ${(item.selected_plan_ids || []).join(", ") || "none"}`
        );
        lines.push(
            `- selected_plan_anchor_labels: ${(item.selected_plan_anchor_labels || []).join(", ") || "(none)"}`
        );
        lines.push(`- raw_hit: ${item.raw_hit ? "yes" : "no"}`);
        lines.push(`- raw_first_hit_rank: ${item.raw_first_hit_rank ?? "none"}`);
        lines.push(`- raw_support_coverage: ${item.raw_support_coverage}`);
        lines.push(`- raw_full_support_hit: ${item.raw_full_support_hit ? "yes" : "no"}`);
        lines.push(`- static_guided_hit: ${item.static_guided_hit ? "yes" : "no"}`);
        lines.push(`- static_guided_first_hit_rank: ${item.static_guided_first_hit_rank ?? "none"}`);
        lines.push(`- static_guided_support_coverage: ${item.static_guided_support_coverage}`);
        lines.push(`- static_guided_full_support_hit: ${item.static_guided_full_support_hit ? "yes" : "no"}`);
        lines.push(`- ignition_guided_bundle_ids: ${(item.ignition_guided_bundle_ids || []).join(", ") || "(none)"}`);
        lines.push(
            `- ignition_guided_anchor_labels: ${(item.ignition_guided_anchor_labels || []).join(", ") || "(none)"}`
        );
        lines.push(`- ignition_guided_hit: ${item.ignition_guided_hit ? "yes" : "no"}`);
        lines.push(`- ignition_guided_first_hit_rank: ${item.ignition_guided_first_hit_rank ?? "none"}`);
        lines.push(`- ignition_guided_support_coverage: ${item.ignition_guided_support_coverage}`);
        lines.push(`- ignition_guided_full_support_hit: ${item.ignition_guided_full_support_hit ? "yes" : "no"}`);
        lines.push(`- evidence_refs: ${(item.evidence_refs || []).join(", ") || "(none)"}`);
        lines.push("");
        lines.push("### Raw Hits");
        item.raw_top_hits.forEach((hit) => {
            lines.push(
                `  - [${hit.rank}] ${hit.span_id} score=${hit.score} text=${trim(hit.span_text, 180)}`
            );
        });
        lines.push("");
        lines.push("### Static Guided Hits");
        item.static_guided_top_hits.forEach((hit) => {
            lines.push(
                `  - [${hit.rank}] ${hit.span_id} score=${hit.score} text=${trim(hit.span_text, 180)}`
            );
        });
        lines.push("");
        lines.push("### Ignition Guided Hits");
        item.ignition_guided_top_hits.forEach((hit) => {
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

function textEvidenceMatches({ haystack, needle, answer }) {
    const normalizedHaystack = normalizeText(haystack);
    const normalizedNeedle = normalizeText(needle);
    if (!normalizedNeedle || !normalizedHaystack) return false;
    if (normalizedHaystack.includes(normalizedNeedle)) return true;

    const hayTokens = tokenize(normalizedHaystack);
    const needleTokens = tokenize(normalizedNeedle);
    if (needleTokens.length === 0) return false;

    const overlap = tokenOverlapRatio(hayTokens, needleTokens);
    const containsRareNeedle = containsAnyLongToken(hayTokens, needleTokens);
    if (needleTokens.length <= 4) {
        if (overlap >= 0.5 && containsRareNeedle) return true;
    } else if (overlap >= 0.45) {
        return true;
    }

    const answerTokens = tokenize(normalizeText(answer || ""));
    const answerOverlap = answerTokens.length > 0 ? tokenOverlapRatio(hayTokens, answerTokens) : 0;
    return answerOverlap >= 0.6 && overlap >= 0.3;
}

function normalizeText(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[`"'“”‘’.,;:!?()[\]{}<>/\\|@#$%^&*_+=~-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenize(text) {
    return String(text || "")
        .split(/[^a-z0-9\u4e00-\u9fff]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2 || /[\u4e00-\u9fff]/.test(item));
}

function tokenOverlapRatio(hayTokens, needleTokens) {
    const haySet = new Set(hayTokens);
    let hits = 0;
    for (const token of needleTokens) {
        if (haySet.has(token)) hits += 1;
    }
    return hits / Math.max(needleTokens.length, 1);
}

function containsAnyLongToken(hayTokens, needleTokens) {
    const haySet = new Set(hayTokens);
    return needleTokens.some((token) => token.length >= 5 && haySet.has(token));
}

function runIgnitionGuidedSearch({
    question,
    scanner,
    graphNodes,
    evidenceSpans,
    workspace,
    topK,
}) {
    const anchors = {
        goal: String(question.question || ""),
        activeTask: "benchmark_recall_eval",
        latestUserRequest: String(question.question || ""),
    };
    scanner.refreshScene([{ source: "task", text: String(question.question || ""), weight: 1 }], anchors);
    scanner.preExcite(String(question.question || ""), anchors);
    const scan = scanner.processChunk(`${String(question.question || "")} `.repeat(2), anchors);
    const bundles = scan.activatedBundles || [];
    const nodeById = new Map((graphNodes || []).map((node) => [node.id, node]));
    const spanById = new Map((evidenceSpans || []).map((span) => [span.id, span]));
    const anchorLabels = uniqueStrings(
        bundles.flatMap((bundle) =>
            (bundle.nodeIds || [])
                .map((nodeId) => nodeById.get(nodeId)?.canonicalLabel || "")
                .filter(Boolean)
        )
    );
    const boostSpanIds = uniqueStrings(bundles.flatMap((bundle) => bundle.evidenceSpanIds || []));
    const allowedShardIds = uniqueStrings(
        boostSpanIds
            .map((spanId) => spanById.get(spanId)?.narrativeRecordId || "")
            .filter(Boolean)
    );
    const hits =
        bundles.length > 0
            ? searchArchiveSpans({
                  workspace,
                  query: joinQuery(question.question, anchorLabels),
                  topK,
                  mode: "hybrid",
                  windowChars: 260,
                  allowedShardIds,
                  boostSpanIds,
              })
            : [];
    return {
        bundleIds: bundles.map((bundle) => bundle.bundleId),
        anchorLabels,
        hits,
    };
}

function selectPlansForQuestion(question, relationSearchPlans, limit) {
    const q = String(question.question || "").toLowerCase();
    return (relationSearchPlans || [])
        .map((plan) => ({
            plan,
            score: [
                ...(plan.anchorLabels || []),
                ...(plan.queryTerms || []),
                ...(plan.anchorKinds || []),
            ]
                .map((item) => String(item || "").trim().toLowerCase())
                .filter(Boolean)
                .reduce((acc, label) => acc + termOverlapScore(q, label), 0),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.plan.id.localeCompare(b.plan.id))
        .slice(0, limit)
        .map((entry) => entry.plan);
}

function loadAllowedShardIds(planId, narrativeShardSelections) {
    const selection = (narrativeShardSelections || []).find((item) => item.planId === planId);
    return (selection?.selectedShardHints || [])
        .map((item) => String(item?.id || "").trim())
        .filter(Boolean);
}

function joinQuery(base, extraTerms) {
    return [String(base || "").trim(), ...(extraTerms || []).map((item) => String(item || "").trim())]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}

function uniqueStrings(values) {
    return Array.from(
        new Set(
            (values || [])
                .map((item) => String(item || "").trim())
                .filter(Boolean)
        )
    );
}

function termOverlapScore(question, label) {
    if (!question || !label) return 0;
    if (question.includes(label)) return Math.min(4, label.length / 4);
    const qTerms = question.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
    const lTerms = label.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
    let hits = 0;
    for (const term of lTerms) {
        if (term.length < 2) continue;
        if (qTerms.includes(term)) hits += 1;
    }
    return hits;
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
            "  node scripts/benchmark-eval-runner.mjs --prepared-sample <dir> [--ir-llm-command '<cmd>'] [--rule-ir-mode micro_light]",
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
