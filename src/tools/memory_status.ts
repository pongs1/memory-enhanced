import * as fs from "node:fs";
import * as path from "node:path";
import {
    resolveWorkspace,
    paths,
    readEvents,
    readFileOr,
} from "../utils.js";

/**
 * Execute memory_status: health check and statistics.
 * No parameters needed.
 */
export async function executeMemoryStatus(
    _toolCallId: string,
    params: any,
    ctx?: { workspaceDir?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const p = paths(workspace);
    const checks: string[] = [];
    let pass = 0;
    let fail = 0;
    let warn = 0;

    checks.push("=== Memory System Status ===", "");

    // --- Directory checks ---
    checks.push("Directories:");
    const dirs = [
        ["memory/knowledge", p.knowledgeDir],
        ["memory/skills/verified", p.skillsVerified],
        ["memory/skills/drafts", p.skillsDrafts],
        [".memory/active", p.activeDir],
        [".memory/events", p.eventsDir],
        [".memory/archive", p.archiveDir],
    ] as const;

    for (const [label, dir] of dirs) {
        if (fs.existsSync(dir)) {
            checks.push(`  ✅ ${label}`);
            pass++;
        } else {
            checks.push(`  ❌ ${label} MISSING`);
            fail++;
        }
    }

    // --- File checks ---
    checks.push("", "Core files:");
    const files = [
        [".memory/active/scratchpad.md", p.scratchpad],
        [".memory/active/focus_stack.json", p.focusStack],
        ["memory/skills/_registry.json", p.skillsRegistry],
        ["MEMORY.md", p.memoryMd],
    ] as const;

    for (const [label, file] of files) {
        if (fs.existsSync(file)) {
            checks.push(`  ✅ ${label}`);
            pass++;
        } else {
            checks.push(`  ❌ ${label} MISSING`);
            fail++;
        }
    }

    // --- MEMORY.md size ---
    checks.push("", "MEMORY.md:");
    if (fs.existsSync(p.memoryMd)) {
        const content = readFileOr(p.memoryMd);
        const chars = content.length;
        checks.push(`  📏 ${chars} chars (target: <5000, limit: 20000)`);
        if (chars > 15000) {
            checks.push(`  ⚠️ Very large — will cause frequent compaction`);
            warn++;
        } else if (chars > 5000) {
            checks.push(`  ⚠️ Above target — consider consolidation`);
            warn++;
        }
    }

    // --- Event stats ---
    checks.push("", "Events:");
    let totalEvents = 0;
    let unconsolidated = 0;
    let jsonlFileCount = 0;

    if (fs.existsSync(p.eventsDir)) {
        const jsonlFiles = fs
            .readdirSync(p.eventsDir)
            .filter((f: string) => f.endsWith(".jsonl"));
        jsonlFileCount = jsonlFiles.length;

        for (const file of jsonlFiles) {
            const events = readEvents(path.join(p.eventsDir, file));
            totalEvents += events.length;
            unconsolidated += events.filter((e) => !e.consolidated).length;
        }
    }

    checks.push(`  📄 ${jsonlFileCount} event files, ${totalEvents} total events`);
    if (unconsolidated > 0) {
        checks.push(
            `  ⚠️ ${unconsolidated} unconsolidated events — run knowledge distillation`
        );
        warn++;
    }

    // --- Knowledge stats ---
    checks.push("", "Knowledge:");
    let knowledgeFiles = 0;
    let knowledgeEntries = 0;

    if (fs.existsSync(p.knowledgeDir)) {
        const mdFiles = fs
            .readdirSync(p.knowledgeDir)
            .filter((f: string) => f.endsWith(".md"));
        knowledgeFiles = mdFiles.length;

        for (const file of mdFiles) {
            const content = readFileOr(path.join(p.knowledgeDir, file));
            knowledgeEntries += content.split("\n").filter((l: string) => l.trim().startsWith("## ")).length;
        }
    }

    checks.push(
        `  📚 ${knowledgeFiles} domain files, ${knowledgeEntries} entries`
    );

    // --- Skills stats ---
    checks.push("", "Skills:");
    let verifiedSkills = 0;
    let draftSkills = 0;

    if (fs.existsSync(p.skillsVerified)) {
        verifiedSkills = fs
            .readdirSync(p.skillsVerified)
            .filter((d: string) =>
                fs.existsSync(path.join(p.skillsVerified, d, "SKILL.md"))
            ).length;
    }
    if (fs.existsSync(p.skillsDrafts)) {
        draftSkills = fs
            .readdirSync(p.skillsDrafts)
            .filter((d: string) =>
                fs.existsSync(path.join(p.skillsDrafts, d, "SKILL.md"))
            ).length;
    }

    checks.push(
        `  🔧 ${verifiedSkills} verified, ${draftSkills} drafts`
    );

    // --- Archive stats ---
    checks.push("", "Archive:");
    let archivedFiles = 0;

    if (fs.existsSync(p.archiveDir)) {
        archivedFiles = fs
            .readdirSync(p.archiveDir)
            .filter((f: string) => f.endsWith(".jsonl")).length;
    }

    checks.push(`  🗄️ ${archivedFiles} archived event files`);

    // --- Summary ---
    checks.push("");
    checks.push("==============================");
    checks.push(`  ✅ ${pass} passed  ⚠️ ${warn} warnings  ❌ ${fail} failed`);

    if (fail === 0 && warn === 0) {
        checks.push("  🎉 All healthy!");
    } else if (fail === 0) {
        checks.push("  ⚠️ Functional but needs attention");
    } else {
        checks.push("  🚨 Repair needed — see above");
    }

    return {
        content: [{ type: "text", text: checks.join("\n") }],
    };
}
