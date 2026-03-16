#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { executeMemorySearchArchive } from "../dist/tools/memory_search_archive.js";
import { v8StorePaths } from "../dist/v8/paths_v8.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TMP_ROOT = path.join(ROOT, ".tmp", "archive-search-smoke");

const CASES = [
    {
        id: "alias_bridge_multihop",
        description:
            "Tests whether plan-guided BM25+vector search can bridge an alias rename and recover an older fact that no longer shares the current surface form.",
        query: "Atlas originally used what database?",
        planId: "plan_alias_bridge",
        narratives: [
            {
                recordId: "narr_day1_bluefinch",
                fileName: "day1_bluefinch.md",
                text:
                    "### assistant (2026-03-01 09:00)\n" +
                    "Blue Finch keeps the notes stack on SQLite so deployment stays single-binary.\n" +
                    "The team explicitly rejected Postgres for the first release.\n",
                spans: [
                    {
                        id: "es_bluefinch_sqlite",
                        text: "Blue Finch keeps the notes stack on SQLite so deployment stays single-binary.",
                    },
                ],
            },
            {
                recordId: "narr_day2_alias",
                fileName: "day2_alias.md",
                text:
                    "### assistant (2026-03-02 11:15)\n" +
                    "We renamed Blue Finch to Atlas for the investor deck.\n" +
                    "Atlas is the same project, only the external name changed.\n",
                spans: [
                    {
                        id: "es_alias_rename",
                        text: "We renamed Blue Finch to Atlas for the investor deck.",
                    },
                ],
            },
            {
                recordId: "narr_day3_issue",
                fileName: "day3_issue.md",
                text:
                    "### assistant (2026-03-03 18:20)\n" +
                    "Atlas migration tests keep failing because an old SQLite lock file survives the restart.\n",
                spans: [
                    {
                        id: "es_atlas_lockfile",
                        text: "Atlas migration tests keep failing because an old SQLite lock file survives the restart.",
                    },
                ],
            },
        ],
        plan: {
            queryTerms: ["Atlas", "Blue Finch", "rename", "database", "SQLite"],
            hintSpanIds: ["es_alias_rename"],
            selectedShardIds: ["narr_day1_bluefinch", "narr_day2_alias", "narr_day3_issue"],
        },
        expectedGuidedSpanIds: ["es_bluefinch_sqlite", "es_alias_rename"],
    },
    {
        id: "relationship_state_change",
        description:
            "Tests whether guided search can recover both the current state and the earlier state transition for a relationship trajectory.",
        query: "What is Nia's relationship with Sol now, and what did it used to be?",
        planId: "plan_relationship_state_change",
        narratives: [
            {
                recordId: "narr_week1_partners",
                fileName: "week1_partners.md",
                text:
                    "### assistant (2026-02-10 10:00)\n" +
                    "At the start of the semester, Nia and Sol were lab partners on SolarSim.\n",
                spans: [
                    {
                        id: "es_nia_sol_partners",
                        text: "At the start of the semester, Nia and Sol were lab partners on SolarSim.",
                    },
                ],
            },
            {
                recordId: "narr_week6_break",
                fileName: "week6_break.md",
                text:
                    "### assistant (2026-03-20 14:30)\n" +
                    "After Sol published Nia's draft without credit, the partnership collapsed.\n",
                spans: [
                    {
                        id: "es_partnership_collapsed",
                        text: "After Sol published Nia's draft without credit, the partnership collapsed.",
                    },
                ],
            },
            {
                recordId: "narr_week10_rivals",
                fileName: "week10_rivals.md",
                text:
                    "### assistant (2026-04-15 16:45)\n" +
                    "By finals week, Nia described Sol as a rival and refused to collaborate.\n",
                spans: [
                    {
                        id: "es_nia_sol_rivals",
                        text: "By finals week, Nia described Sol as a rival and refused to collaborate.",
                    },
                ],
            },
        ],
        plan: {
            queryTerms: ["Nia", "Sol", "relationship", "partners", "partnership collapsed", "rival"],
            hintSpanIds: ["es_nia_sol_rivals"],
            selectedShardIds: ["narr_week1_partners", "narr_week6_break", "narr_week10_rivals"],
        },
        expectedGuidedSpanIds: ["es_nia_sol_partners", "es_nia_sol_rivals"],
    },
];

async function main() {
    const wanted = parseWantedCases(process.argv.slice(2));
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const summary = [];
    const selected = wanted.length
        ? CASES.filter((smokeCase) => wanted.includes(smokeCase.id))
        : CASES;
    for (const smokeCase of selected) {
        const result = await runCase(smokeCase);
        summary.push(result);
        console.log(`[${result.status}] ${smokeCase.id}`);
    }
    fs.writeFileSync(
        path.join(TMP_ROOT, "summary.json"),
        JSON.stringify(summary, null, 2),
        "utf-8"
    );
}

function parseWantedCases(argv) {
    const wanted = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--case" && argv[i + 1]) {
            wanted.push(argv[i + 1]);
            i += 1;
        }
    }
    return wanted;
}

async function runCase(smokeCase) {
    const workspace = path.join(TMP_ROOT, smokeCase.id);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    const store = v8StorePaths(workspace);
    mkdirp(store.rootDir);
    mkdirp(store.runtimeDir);
    mkdirp(path.dirname(store.evidenceSpans));

    const allSpans = [];
    const narrativeDir = path.join(workspace, ".memory", "raw", "observations", "assembled");
    mkdirp(narrativeDir);
    for (const narrative of smokeCase.narratives) {
        const narrativePath = path.join(narrativeDir, narrative.fileName);
        fs.writeFileSync(narrativePath, narrative.text, "utf-8");
        for (const span of narrative.spans) {
            const idx = narrative.text.indexOf(span.text);
            if (idx < 0) {
                throw new Error(`Span text not found in ${narrative.fileName}: ${span.text}`);
            }
            allSpans.push({
                id: span.id,
                narrativeRecordId: narrative.recordId,
                narrativeRef: narrativePath,
                unitId: `unit_${span.id}`,
                charStart: idx,
                charEnd: idx + span.text.length,
                text: span.text,
                speaker: "assistant",
                timestamp: extractTimestamp(narrative.text),
                sourceClass: "conversation",
                sourceType: "session_message",
                score: 1,
            });
        }
    }

    writeJsonl(store.evidenceSpans, allSpans);
    writeJsonl(store.relationSearchPlans, [
        {
            id: smokeCase.planId,
            lane: "focused",
            queryTerms: smokeCase.plan.queryTerms,
            hintSpanIds: smokeCase.plan.hintSpanIds,
        },
    ]);
    writeJsonl(store.narrativeShardSelections, [
        {
            id: `nss_${smokeCase.id}`,
            planId: smokeCase.planId,
            lane: "focused",
            selectedShardHints: smokeCase.plan.selectedShardIds.map((id) => ({
                id,
                score: 1,
            })),
        },
    ]);

    const raw = await executeMemorySearchArchive(
        "smoke_raw",
        { query: smokeCase.query, mode: "hybrid", top_k: 5, window_chars: 220 },
        { workspaceDir: workspace }
    );
    const guided = await executeMemorySearchArchive(
        "smoke_guided",
        {
            query: smokeCase.query,
            mode: "hybrid",
            top_k: 5,
            window_chars: 220,
            plan_id: smokeCase.planId,
        },
        { workspaceDir: workspace }
    );

    const rawText = raw.content[0]?.text || "";
    const guidedText = guided.content[0]?.text || "";
    fs.writeFileSync(path.join(workspace, "raw.txt"), rawText, "utf-8");
    fs.writeFileSync(path.join(workspace, "guided.txt"), guidedText, "utf-8");

    const rawHitIds = parseSpanIds(rawText);
    const guidedHitIds = parseSpanIds(guidedText);
    const guidedCoverage = smokeCase.expectedGuidedSpanIds.filter((id) => guidedHitIds.includes(id));
    const rawCoverage = smokeCase.expectedGuidedSpanIds.filter((id) => rawHitIds.includes(id));
    const status = guidedCoverage.length >= rawCoverage.length && guidedCoverage.length > 0 ? "ok" : "check";

    return {
        caseId: smokeCase.id,
        description: smokeCase.description,
        query: smokeCase.query,
        workspace: path.relative(ROOT, workspace),
        rawHitIds,
        guidedHitIds,
        expectedGuidedSpanIds: smokeCase.expectedGuidedSpanIds,
        rawCoverage,
        guidedCoverage,
        status,
    };
}

function parseSpanIds(text) {
    return [...text.matchAll(/span_id=([^\s]+)/g)].map((match) => match[1]);
}

function extractTimestamp(text) {
    const match = text.match(/\(([^)]+)\)/);
    return match ? match[1] : null;
}

function writeJsonl(filePath, rows) {
    mkdirp(path.dirname(filePath));
    const content = rows.map((row) => JSON.stringify(row)).join("\n");
    fs.writeFileSync(filePath, content ? `${content}\n` : "", "utf-8");
}

function mkdirp(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
