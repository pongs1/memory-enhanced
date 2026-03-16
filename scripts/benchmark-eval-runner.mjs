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
    const graphEdges = readJsonl(store.graphEdges);
    const evidenceSpans = readJsonl(store.evidenceSpans);
    const recallBundles = readJsonl(store.recallBundles);
    const relationSearchPlans = readJsonl(store.relationSearchPlans);
    const verticalTriggerCards = readJsonl(path.join(store.runtimeDir, "vertical_trigger_cards.jsonl"));
    const narrativeShardSelections = readJsonl(store.narrativeShardSelections);
    const buildReport = readJsonFile(store.buildReport);
    const results = questions.map((question) =>
        evaluateQuestion({
            workspace,
            benchmark,
            question,
            turnMap,
            graphNodes,
            graphEdges,
            evidenceSpans,
            recallBundles,
            relationSearchPlans,
            verticalTriggerCards,
            narrativeShardSelections,
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
        build_llm_status: buildReport?.llmStatus || null,
        build_ir_llm_items: buildReport?.buildStats?.irLlmItems ?? null,
        build_ir_fallback_items: buildReport?.buildStats?.irFallbackItems ?? null,
        build_relation_scope_cards: buildReport?.buildStats?.relationScopeCards ?? null,
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
    graphEdges,
    evidenceSpans,
    recallBundles,
    relationSearchPlans,
    verticalTriggerCards,
    narrativeShardSelections,
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
        turnMap,
        graphNodes,
        graphEdges,
        evidenceSpans,
        recallBundles,
        relationSearchPlans,
        verticalTriggerCards,
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
        ignition_guided_vertical_plan_ids: ignitionGuided.verticalPlanIds,
        ignition_guided_vertical_plan_anchor_labels: ignitionGuided.verticalPlanAnchorLabels,
        ignition_guided_vertical_seed_bundle_ids: ignitionGuided.verticalSeedBundleIds,
        ignition_guided_modes: ignitionGuided.modes,
        ignition_guided_background_turns: ignitionGuided.backgroundTurns,
        ignition_guided_profile_bundle_ids: ignitionGuided.profileBundleIds,
        ignition_guided_trajectory_bundle_ids: ignitionGuided.trajectoryBundleIds,
        ignition_guided_vertical_state_nodes: ignitionGuided.verticalDiagnostics.stateNodeCount,
        ignition_guided_vertical_edge_hits: ignitionGuided.verticalDiagnostics.verticalEdgeCount,
        ignition_guided_vertical_edge_types: ignitionGuided.verticalDiagnostics.verticalEdgeTypes,
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
    lines.push(`- build_llm_status: ${summary.build_llm_status ?? "unknown"}`);
    lines.push(`- build_ir_llm_items: ${summary.build_ir_llm_items ?? "unknown"}`);
    lines.push(`- build_ir_fallback_items: ${summary.build_ir_fallback_items ?? "unknown"}`);
    lines.push(`- build_relation_scope_cards: ${summary.build_relation_scope_cards ?? "unknown"}`);
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
        lines.push(
            `- ignition_guided_vertical_plan_ids: ${(item.ignition_guided_vertical_plan_ids || []).join(", ") || "(none)"}`
        );
        lines.push(
            `- ignition_guided_vertical_plan_anchor_labels: ${(item.ignition_guided_vertical_plan_anchor_labels || []).join(", ") || "(none)"}`
        );
        lines.push(`- ignition_guided_modes: ${(item.ignition_guided_modes || []).join(", ") || "(none)"}`);
        lines.push(`- ignition_guided_background_turns: ${item.ignition_guided_background_turns ?? 0}`);
        lines.push(`- ignition_guided_profile_bundle_ids: ${(item.ignition_guided_profile_bundle_ids || []).join(", ") || "(none)"}`);
        lines.push(`- ignition_guided_trajectory_bundle_ids: ${(item.ignition_guided_trajectory_bundle_ids || []).join(", ") || "(none)"}`);
        lines.push(`- ignition_guided_vertical_state_nodes: ${item.ignition_guided_vertical_state_nodes ?? 0}`);
        lines.push(`- ignition_guided_vertical_edge_hits: ${item.ignition_guided_vertical_edge_hits ?? 0}`);
        lines.push(
            `- ignition_guided_vertical_edge_types: ${(item.ignition_guided_vertical_edge_types || []).join(", ") || "(none)"}`
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

function readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return null;
    }
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
    turnMap,
    graphNodes,
    graphEdges,
    evidenceSpans,
    recallBundles,
    relationSearchPlans,
    verticalTriggerCards,
    workspace,
    topK,
}) {
    const questionText = String(question.question || "");
    const warmupTurns = Array.isArray(turnMap) ? turnMap : [];
    const textSignals = buildIgnitionTextSignals(questionText, warmupTurns);
    const verticalCards = selectVerticalTriggerCardsFromSignals(
        textSignals,
        verticalTriggerCards,
        relationSearchPlans,
        4
    );
    const bundleById = new Map((recallBundles || []).map((bundle) => [bundle.bundleId, bundle]));
    const bundleByNodeId = new Map();
    for (const bundle of recallBundles || []) {
        for (const nodeId of bundle.nodeIds || []) {
            if (!bundleByNodeId.has(nodeId)) {
                bundleByNodeId.set(nodeId, []);
            }
            bundleByNodeId.get(nodeId).push(bundle);
        }
    }
    const verticalSeedBundles = uniqueById(
        verticalCards
            .flatMap((card) => card.hintBundleIds || [])
            .flatMap((bundleId) => resolveBundleHint(bundleId, bundleById, bundleByNodeId))
            .filter(Boolean)
    );
    const verticalPlanLabels = uniqueStrings(
        verticalCards.flatMap((card) => card.anchorLabels || [])
    );
    const verticalPlanSpanIds = uniqueStrings(
        verticalCards.flatMap((card) => card.hintSpanIds || [])
    );
    const replayAnchors = {
        goal: "",
        activeTask: "benchmark_replay",
        latestUserRequest: "",
    };
    const scanner = new V8GraphScanner(workspace, benchmarkScannerConfig(), "profile");
    scanner.setMode("profile");
    for (const turn of warmupTurns) {
        const turnText = String(turn.text || "").trim();
        if (!turnText) continue;
        scanner.processChunk(`${turnText}\n`, replayAnchors);
    }

    const backgroundTurns = warmupTurns.slice(-Math.min(3, warmupTurns.length));
    const backgroundText = backgroundTurns.map((turn) => String(turn.text || "").trim()).filter(Boolean).join("\n");
    const modes = ["profile", "trajectory"];
    const passBundles = new Map();
    const modeBundleIds = {
        profile: [],
        trajectory: [],
    };

    for (const mode of modes) {
        scanner.setMode(mode);
        const anchors = {
            goal: [questionText, ...verticalPlanLabels].filter(Boolean).join("\n"),
            activeTask: backgroundText || "benchmark_recall_eval",
            latestUserRequest: questionText,
        };
        const signals = textSignals.filter((item) => item.text);
        scanner.refreshScene(signals, anchors);
        scanner.preExcite(
            [questionText, ...verticalPlanLabels].filter(Boolean).join("\n"),
            anchors
        );
        const scan = scanner.processChunk(
            [questionText, ...verticalPlanLabels].filter(Boolean).join("\n") + "\n",
            anchors
        );
        for (const bundle of scan.activatedBundles || []) {
            modeBundleIds[mode].push(bundle.bundleId);
            const existing = passBundles.get(bundle.bundleId);
            if (!existing || (bundle.energy || 0) > (existing.energy || 0)) {
                passBundles.set(bundle.bundleId, bundle);
            }
        }
    }

    for (const bundle of verticalSeedBundles) {
        const existing = passBundles.get(bundle.bundleId);
        const seededBundle = {
            ...bundle,
            energy: Math.max(Number(bundle.energy || 0), 0.52),
        };
        if (!existing || Number(seededBundle.energy || 0) > Number(existing.energy || 0)) {
            passBundles.set(bundle.bundleId, seededBundle);
        }
    }

    const bundles = Array.from(passBundles.values());
    const nodeById = new Map((graphNodes || []).map((node) => [node.id, node]));
    const spanById = new Map((evidenceSpans || []).map((span) => [span.id, span]));
    const verticalDiagnostics = analyzeVerticalParticipation({
        bundles,
        graphNodes,
        graphEdges,
    });
    const anchorLabels = uniqueStrings(
        bundles.flatMap((bundle) =>
            (bundle.nodeIds || [])
                .map((nodeId) => nodeById.get(nodeId)?.canonicalLabel || "")
                .filter(Boolean)
        )
    );
    const boostSpanIds = uniqueStrings(bundles.flatMap((bundle) => bundle.evidenceSpanIds || []));
    const mergedBoostSpanIds = uniqueStrings([...boostSpanIds, ...verticalPlanSpanIds]);
    const allowedShardIds = uniqueStrings(
        mergedBoostSpanIds
            .map((spanId) => spanById.get(spanId)?.narrativeRecordId || "")
            .filter(Boolean)
    );
    const hits =
        bundles.length > 0 || verticalPlanLabels.length > 0 || mergedBoostSpanIds.length > 0
            ? searchArchiveSpans({
                  workspace,
                  query: joinQuery(question.question, [...anchorLabels, ...verticalPlanLabels]),
                  topK,
                  mode: "hybrid",
                  windowChars: 260,
                  allowedShardIds,
                  boostSpanIds: mergedBoostSpanIds,
              })
            : [];
    return {
        bundleIds: bundles.map((bundle) => bundle.bundleId),
        anchorLabels,
        modes,
        backgroundTurns: backgroundTurns.length,
        profileBundleIds: uniqueStrings(modeBundleIds.profile),
        trajectoryBundleIds: uniqueStrings(modeBundleIds.trajectory),
        verticalPlanIds: verticalCards.map((card) => card.id),
        verticalPlanAnchorLabels: verticalPlanLabels,
        verticalSeedBundleIds: verticalSeedBundles.map((bundle) => bundle.bundleId),
        verticalDiagnostics,
        hits,
    };
}

function benchmarkScannerConfig() {
    return {
        nodeCooldownMs: 0,
        bundleCooldownMs: 0,
        scanIntervalChars: 1,
        maxInjectedBundles: 4,
    };
}

function buildIgnitionTextSignals(questionText, turnMap) {
    const turns = Array.isArray(turnMap) ? turnMap : [];
    const signals = turns.map((turn, index) => ({
        source: String(turn.speaker || "turn"),
        text: String(turn.text || "").trim(),
        weight: weightTextSignalSource(String(turn.speaker || "turn"), index, turns.length),
    }));
    signals.push({
        source: "question",
        text: String(questionText || "").trim(),
        weight: 1,
    });
    return signals.filter((item) => item.text);
}

function weightTextSignalSource(source, index, total) {
    const normalized = String(source || "turn").trim().toLowerCase();
    const recencyBoost = index >= total - 2 ? 0.18 : index >= total - 5 ? 0.08 : 0;
    if (normalized.includes("user")) return 0.84 + recencyBoost;
    if (normalized.includes("tool")) return 0.9 + recencyBoost;
    if (normalized.includes("subagent")) return 0.88 + recencyBoost;
    if (normalized.includes("assistant")) return 0.76 + recencyBoost;
    if (normalized.includes("feedback")) return 0.92 + recencyBoost;
    return 0.68 + recencyBoost;
}

function selectVerticalTriggerCardsFromSignals(textSignals, verticalTriggerCards, relationSearchPlans, limit) {
    const cards =
        Array.isArray(verticalTriggerCards) && verticalTriggerCards.length > 0
            ? verticalTriggerCards
            : deriveVerticalCardsFromPlans(relationSearchPlans || []);
    const signals = Array.isArray(textSignals) ? textSignals : [];
    return cards
        .map((card) => {
            const cardTerms = uniqueStrings([
                ...(card.anchorLabels || []),
                ...(card.signalTerms || []),
                ...((card.edgeFamilyHints || []).map((hint) => hint.id) || []),
            ]);
            const cardText = normalizeText(cardTerms.join(" "));
            const cardTokens = new Set(tokenize(cardText));
            let score = 0;
            for (const signal of signals) {
                const signalText = normalizeText(signal.text);
                const signalTokens = new Set(tokenize(signalText));
                const overlap = tokenOverlapRatio(
                    Array.from(signalTokens),
                    Array.from(cardTokens)
                );
                if (overlap <= 0) continue;
                score += overlap * Number(signal.weight || 0.5);
            }
            return { card, score };
        })
        .filter((entry) => entry.score >= 0.08)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((entry) => entry.card);
}

function deriveVerticalCardsFromPlans(relationSearchPlans) {
    const verticalHintIds = new Set([
        "state_supersedes_state",
        "state_refines_state",
        "state_changed_by_event",
        "state_opened_by_block",
        "state_closed_by_block",
        "state_invalidated_under_regime",
        "state_reactivated_under_regime",
        "state_valid_in_phase",
        "state_valid_in_timewindow",
        "correction_propagates_to_line",
        "evolves_to",
        "supersedes",
        "before",
        "after",
        "resolved_by",
        "contradicts",
        "conflicts_with",
    ]);
    return (relationSearchPlans || [])
        .filter((plan) =>
            (plan.edgeFamilyHints || []).some((hint) => verticalHintIds.has(hint.id))
        )
        .map((plan) => ({
            id: `derived_${plan.id}`,
            family: "generic_vertical",
            anchorLabels: plan.anchorLabels || [],
            signalTerms: uniqueStrings([
                ...(plan.queryTerms || []),
                ...((plan.edgeFamilyHints || []).map((hint) => hint.id) || []),
            ]),
            edgeFamilyHints: plan.edgeFamilyHints || [],
            hintBundleIds: plan.hintBundleIds || [],
            hintSpanIds: plan.hintSpanIds || [],
            preferredSlices: ["trajectory"],
        }));
}

function analyzeVerticalParticipation({ bundles, graphNodes, graphEdges }) {
    const selectedNodeIds = new Set(
        bundles.flatMap((bundle) => bundle.nodeIds || [])
    );
    const nodesById = new Map((graphNodes || []).map((node) => [node.id, node]));
    const verticalEdgeTypes = new Set([
        "state_supersedes_state",
        "state_refines_state",
        "state_changed_by_event",
        "state_opened_by_block",
        "state_closed_by_block",
        "state_invalidated_under_regime",
        "state_reactivated_under_regime",
        "state_valid_in_phase",
        "state_valid_in_timewindow",
        "correction_propagates_to_line",
    ]);
    const stateNodeIds = Array.from(selectedNodeIds).filter((nodeId) => {
        const memoryType = String(nodesById.get(nodeId)?.memoryType || "");
        return memoryType.endsWith("_state") || memoryType === "session_state" || memoryType === "topic_state";
    });
    const touchedVerticalTypes = new Set();
    let verticalEdgeCount = 0;
    for (const edge of graphEdges || []) {
        if (!selectedNodeIds.has(edge.src) && !selectedNodeIds.has(edge.dst)) {
            continue;
        }
        if (!verticalEdgeTypes.has(edge.type)) {
            continue;
        }
        verticalEdgeCount += 1;
        touchedVerticalTypes.add(edge.type);
    }
    return {
        stateNodeCount: stateNodeIds.length,
        verticalEdgeCount,
        verticalEdgeTypes: Array.from(touchedVerticalTypes).sort(),
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

function uniqueById(items) {
    const seen = new Set();
    const output = [];
    for (const item of items || []) {
        const id = String(item?.bundleId || item?.id || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        output.push(item);
    }
    return output;
}

function resolveBundleHint(bundleId, bundleById, bundleByNodeId) {
    const direct = bundleById.get(bundleId);
    if (direct) return [direct];
    if (String(bundleId || "").startsWith("seed_")) {
        const nodeId = String(bundleId || "").slice(5);
        return bundleByNodeId.get(nodeId) || [];
    }
    return [];
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
