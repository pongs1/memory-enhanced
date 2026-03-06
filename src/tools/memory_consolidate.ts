import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
    resolveWorkspace,
    paths,
    today,
    readEvents,
    writeEvents,
    readFileOr,
    readJson,
    ensureDir,
    type MemoryEvent,
} from "../utils.js";
import { applyDecay, ageInDays } from "../decay.js";

/** Parameter schema for memory_consolidate tool. */
export const MemoryConsolidateParams = Type.Object({
    scope: Type.Optional(
        Type.Union(
            [
                Type.Literal("session"),
                Type.Literal("day"),
                Type.Literal("full"),
            ],
            {
                default: "session",
                description:
                    "session: today only, day: past 7 days, full: all event files",
            }
        )
    ),
    dry_run: Type.Optional(
        Type.Boolean({
            default: false,
            description: "Preview changes without writing",
        })
    ),
});

export type MemoryConsolidateInput = Static<typeof MemoryConsolidateParams>;

interface ConsolidationReport {
    eventsScanned: number;
    unconsolidated: number;
    decayed: number;
    archived: number;
    memoryMdChars: number;
    memoryMdRegenerated: boolean;
}

/**
 * Execute memory_consolidate: structural consolidation cycle.
 *
 * What this tool does (zero LLM tokens):
 *   1. Apply decay formula to consolidated events
 *   2. Archive events with decay_score < threshold
 *   3. Regenerate MEMORY.md from knowledge files
 *
 * What this tool does NOT do (requires LLM):
 *   - Extract knowledge from events (LLM reads events, writes knowledge/*.md)
 *   - Create skill templates (LLM pattern recognition)
 *
 * The intended workflow:
 *   1. LLM reads unconsolidated events and distills knowledge
 *   2. LLM marks events as consolidated (via memory_record or direct edit)
 *   3. LLM calls memory_consolidate to run structural steps
 */
export async function executeMemoryConsolidate(
    _toolCallId: string,
    params: MemoryConsolidateInput,
    ctx?: { workspaceDir?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const pluginConfig = (ctx as any)?.config;
    const p = paths(workspace);
    const halfLife = pluginConfig?.halfLifeDays ?? 30;
    const archiveThresh = pluginConfig?.archiveThreshold ?? 0.2;
    const scope = params.scope ?? "session";
    const dryRun = params.dry_run ?? false;
    const todayStr = today();
    const now = new Date();

    // Read the last active time from focus_stack to calculate active days
    const focusStackInfo = readJson<{ last_updated?: string }>(p.focusStack, {});
    const lastActiveStr = focusStackInfo.last_updated;
    // We only calculate decay up to the last known active session time
    // If the agent was offline for 3 months, ageInDays will only reflect time up to last active,
    // thereby solving the "forget everything if offline" issue. Let's use `now` if `last_updated`
    // is missing, but otherwise use the `last_updated` date as the reference point for decay.
    const referenceDate = lastActiveStr ? new Date(lastActiveStr) : now;

    const report: ConsolidationReport = {
        eventsScanned: 0,
        unconsolidated: 0,
        decayed: 0,
        archived: 0,
        memoryMdChars: 0,
        memoryMdRegenerated: false,
    };

    // --- 1. Collect event files based on scope ---
    const jsonlFiles = getJsonlFiles(p.eventsDir, scope, todayStr);

    // --- 2. Apply decay and archive ---
    for (const jsonlPath of jsonlFiles) {
        const events = readEvents(jsonlPath);
        if (events.length === 0) continue;

        report.eventsScanned += events.length;
        const kept: MemoryEvent[] = [];
        const archived: MemoryEvent[] = [];

        for (const evt of events) {
            if (!evt.consolidated) {
                report.unconsolidated++;
                kept.push(evt);
                continue;
            }

            // Apply decay to consolidated events using referenceDate (active time)
            const age = ageInDays(evt.timestamp, referenceDate);
            if (age > 0) {
                const newScore = applyDecay(evt.decay_score, age, halfLife);
                if (newScore < archiveThresh) {
                    archived.push(evt);
                    report.archived++;
                } else {
                    if (newScore !== evt.decay_score) {
                        evt.decay_score = newScore;
                        report.decayed++;
                    }
                    kept.push(evt);
                }
            } else {
                kept.push(evt);
            }
        }

        if (!dryRun && (archived.length > 0 || report.decayed > 0)) {
            // Write kept events back
            writeEvents(jsonlPath, kept);

            // Archive removed events
            if (archived.length > 0) {
                const archivePath = path.join(
                    p.archiveDir,
                    path.basename(jsonlPath)
                );
                ensureDir(p.archiveDir);
                const existing = readEvents(archivePath);
                writeEvents(archivePath, [...existing, ...archived]);
            }
        }
    }

    // --- 3. Regenerate MEMORY.md ---
    const memoryMdContent = generateMemoryMd(p.knowledgeDir);
    report.memoryMdChars = memoryMdContent.length;

    if (!dryRun) {
        fs.writeFileSync(p.memoryMd, memoryMdContent, "utf-8");
        report.memoryMdRegenerated = true;
    }

    // --- Format report ---
    const lines = [
        `Consolidation ${dryRun ? "(DRY RUN) " : ""}complete:`,
        `  Scope: ${scope}`,
        `  Events scanned: ${report.eventsScanned}`,
        `  Unconsolidated (need LLM distillation): ${report.unconsolidated}`,
        `  Decay applied: ${report.decayed}`,
        `  Archived (score < ${archiveThresh}): ${report.archived}`,
        `  MEMORY.md: ${report.memoryMdChars} chars ${report.memoryMdRegenerated ? "(regenerated)" : "(preview)"}`,
    ];

    if (report.unconsolidated > 0) {
        lines.push(
            "",
            `⚠️ ${report.unconsolidated} events are unconsolidated.`,
            `To distill them: read .memory/events/*.jsonl, extract durable knowledge`,
            `into memory/knowledge/*.md, then mark events as consolidated.`
        );
    }

    const maxChars = pluginConfig?.memoryMdMaxChars ?? 5000;
    if (report.memoryMdChars > maxChars) {
        lines.push(
            "",
            `⚠️ MEMORY.md is ${report.memoryMdChars} chars (target: <${maxChars}).`,
            `Consider consolidating knowledge files or archiving old entries.`
        );
    }

    return {
        content: [{ type: "text", text: lines.join("\n") }],
    };
}

// --- Internal helpers ---

function getJsonlFiles(
    eventsDir: string,
    scope: string,
    todayStr: string
): string[] {
    if (!fs.existsSync(eventsDir)) return [];

    const allFiles = fs
        .readdirSync(eventsDir)
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => path.join(eventsDir, f))
        .sort();

    if (scope === "session") {
        const todayFile = path.join(eventsDir, `${todayStr}.jsonl`);
        return allFiles.filter((f: string) => f === todayFile);
    }

    if (scope === "day") {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        return allFiles.filter((f: string) => {
            const basename = path.basename(f, ".jsonl");
            return basename >= cutoffStr;
        });
    }

    // scope === "full"
    return allFiles;
}

function generateMemoryMd(knowledgeDir: string): string {
    const lines = [
        `# Long-Term Memory`,
        `> **Core Project Context & User Knowledge**`,
        `> Auto-injected into your context window. Do not manually read these files unless necessary.`,
        ``
    ];

    if (!fs.existsSync(knowledgeDir)) {
        lines.push("(No knowledge files yet. Consolidation will populate this.)");
        return lines.join("\n");
    }

    const files = fs
        .readdirSync(knowledgeDir)
        .filter((f: string) => f.endsWith(".md"))
        .sort();

    for (const file of files) {
        const content = readFileOr(path.join(knowledgeDir, file));
        const entryCount = content.split("\n").filter((l: string) => l.trim().startsWith("## ")).length;

        // Strip the top level `# Title` if it exists, to avoid duplicate H1s
        const contentLines = content.split("\n");
        const bodyLines = contentLines.filter((l: string) => !l.startsWith("# "));
        const titleLine = contentLines.find((l: string) => l.startsWith("# ")) || `# ${file.replace(".md", "")}`;

        lines.push(`---`);
        lines.push(`${titleLine} (${entryCount} entries)`);
        lines.push(`Source: memory/knowledge/${file}`);
        lines.push(``);
        lines.push(bodyLines.join("\n").trim());
        lines.push(``);
    }

    return lines.join("\n");
}
