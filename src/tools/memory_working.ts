import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import {
    resolveWorkspace,
    paths,
    readJson,
    writeJson,
    readFileOr,
    appendScratchpad,
    nowISO,
    ensureDir,
    type FocusStack
} from "../utils.js";
import { executeMemoryRecord } from "./memory_record.js";

const WorkingAction = Type.Union([
    Type.Literal("status"),
    Type.Literal("plan"),
    Type.Literal("push"),
    Type.Literal("complete"),
    Type.Literal("overflow"),
    Type.Literal("scratchpad_append"),
    Type.Literal("scratchpad_refill")
], { description: "Action to perform on the working memory" });

export const MemoryWorkingParams = Type.Object({
    action: WorkingAction,
    goal: Type.Optional(Type.String({ description: "Primary project goal (for 'plan')" })),
    path: Type.Optional(Type.Array(Type.String(), { description: "Breadcrumbs/path (for 'plan')" })),
    focus: Type.Optional(Type.String({ description: "Current focus item (for 'plan' or 'complete')" })),
    siblings: Type.Optional(Type.Array(Type.String(), { description: "Pending tasks (for 'plan' or 'push')" })),
    insight: Type.Optional(Type.String({ description: "Optional insight to record to memory (for 'complete')" })),
    next_focus: Type.Optional(Type.String({ description: "The next item to focus on (for 'complete')" })),
    section: Type.Optional(Type.String({ description: "Section header (e.g. 'Reasoning', 'Verification') for 'scratchpad_append' or 'overflow'" })),
    content: Type.Optional(Type.String({ description: "Content to append for 'scratchpad_append'" }))
});

export type MemoryWorkingInput = Static<typeof MemoryWorkingParams>;

export async function executeMemoryWorking(
    toolCallId: string,
    params: MemoryWorkingInput,
    ctx?: { workspaceDir?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const p = paths(workspace);

    const fallback: FocusStack = {
        project_goal: "Not set",
        current_path: [],
        current_focus: "None",
        pending_siblings: [],
        last_updated: nowISO()
    };

    let stack = readJson<FocusStack>(p.focusStack, fallback);

    switch (params.action) {
        case "status":
            return { content: [{ type: "text" as const, text: renderStatus(stack) }] };

        case "plan":
            if (!params.goal || !params.focus) {
                return { content: [{ type: "text" as const, text: "Error: Action 'plan' requires 'goal' and 'focus'." }] };
            }
            stack = {
                project_goal: params.goal,
                current_path: params.path ?? [],
                current_focus: params.focus,
                pending_siblings: params.siblings ?? [],
                last_updated: nowISO()
            };
            return validateAndSave(workspace, stack);

        case "push":
            if (!params.siblings || params.siblings.length === 0) {
                return { content: [{ type: "text" as const, text: "Error: Action 'push' requires 'siblings' array." }] };
            }
            stack.pending_siblings.push(...params.siblings);
            stack.last_updated = nowISO();
            return validateAndSave(workspace, stack);

        case "complete":
            // Log insight if provided
            if (params.insight) {
                await executeMemoryRecord(toolCallId, {
                    content: params.insight,
                    type: "insight",
                    importance: 0.6
                }, ctx);
            }

            const completed = stack.current_focus;
            if (params.next_focus) {
                stack.current_focus = params.next_focus;
            } else if (stack.pending_siblings.length > 0) {
                stack.current_focus = stack.pending_siblings.shift()!;
            } else {
                stack.current_focus = "Done (Pending new goal)";
            }

            stack.last_updated = nowISO();
            return validateAndSave(workspace, stack, `Completed: ${completed}`);

        case "overflow":
            const itemsToOverflow = stack.pending_siblings.splice(0);
            if (itemsToOverflow.length === 0) {
                return { content: [{ type: "text" as const, text: "No pending siblings to overflow." }] };
            }
            const sectionName = params.section || "Pending Items (Overflow)";
            const overflowContent = itemsToOverflow.map(item => `- ${item}`).join("\n");
            appendScratchpad(workspace, sectionName, `\n${overflowContent}`);
            stack.last_updated = nowISO();
            validateAndSave(workspace, stack, `Overflowed ${itemsToOverflow.length} items to scratchpad.md under [${sectionName}].`);
            return { content: [{ type: "text" as const, text: `Overflowed ${itemsToOverflow.length} items to scratchpad.md under [${sectionName}].` }] };

        case "scratchpad_append":
            if (!params.section || !params.content) {
                return { content: [{ type: "text" as const, text: "Error: Action 'scratchpad_append' requires 'section' and 'content'." }] };
            }
            appendScratchpad(workspace, params.section, params.content);
            return { content: [{ type: "text" as const, text: `Appended note to scratchpad.md [${params.section}].` }] };

        case "scratchpad_refill":
            return handleRefill(workspace);

        default:
            return { content: [{ type: "text" as const, text: `Error: Unknown action: ${params.action}` }] };
    }
}

function renderStatus(stack: FocusStack): string {
    const lines = [
        "## Current Focus Stack",
        "",
        `**Project Goal:** ${stack.project_goal}`,
        `**Last Updated:** ${stack.last_updated}`,
        "",
        "**Path:**",
        ...stack.current_path.map(p => `  └─ ${p}`),
        "",
        `**🚀 FOCUS:** ${stack.current_focus}`,
        "",
        "**Upcoming:**",
        ...stack.pending_siblings.map(s => `  - ${s}`),
    ];

    const totalCount = stack.current_path.length + 1 + stack.pending_siblings.length;
    lines.push("", `*Backend Queue: ${totalCount} items (Auto-truncating to 7 for MD frontend)*`);

    return lines.join("\n");
}

function generateMdFrontend(stack: FocusStack): string {
    const lines = [
        `**Project Goal:** ${stack.project_goal}`,
        `**Last Updated:** ${stack.last_updated}`,
        ""
    ];

    let pathLimit = Math.min(3, stack.current_path.length);
    let remaining = 7 - 1 - pathLimit;
    let siblingsLimit = Math.min(remaining, stack.pending_siblings.length);

    if (siblingsLimit < remaining) {
        pathLimit = Math.min(stack.current_path.length, pathLimit + remaining - siblingsLimit);
    }

    if (stack.current_path.length > 0) {
        lines.push("**Path:**");
        const displayPath = stack.current_path.slice(-pathLimit);
        if (pathLimit < stack.current_path.length) {
            lines.push(`  └─ ... (${stack.current_path.length - pathLimit} earlier steps hidden)`);
        }
        displayPath.forEach(p => lines.push(`  └─ ${p}`));
        lines.push("");
    }

    lines.push(`**🚀 FOCUS:** ${stack.current_focus}`);

    if (stack.pending_siblings.length > 0) {
        lines.push("");
        lines.push("**Upcoming:**");
        const displaySiblings = stack.pending_siblings.slice(0, siblingsLimit);
        displaySiblings.forEach(s => lines.push(`  - ${s}`));

        if (siblingsLimit < stack.pending_siblings.length) {
            lines.push(`  - ... (${stack.pending_siblings.length - siblingsLimit} later steps pending in backend queue)`);
        }
    }

    return lines.join("\n");
}

function validateAndSave(workspace: string, stack: FocusStack, prefix = "Focus updated."): { content: Array<{ type: "text"; text: string }> } {
    const p = paths(workspace);
    ensureDir(p.activeDir);

    writeJson(p.focusStack, stack);

    const mdContent = generateMdFrontend(stack);
    fs.writeFileSync(p.focusStackMd, mdContent, "utf-8");

    return {
        content: [{
            type: "text" as const,
            text: `${prefix}\n\n${renderStatus(stack)}`
        }]
    };
}

async function handleRefill(workspace: string): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const p = paths(workspace);
    const content = readFileOr(p.scratchpad);
    const overflowHeader = "## Pending Items (Overflow)";

    if (!content.includes(overflowHeader)) {
        return { content: [{ type: "text" as const, text: "No overflow section found in scratchpad.md." }] };
    }

    const sections = content.split("## ");
    const overflowIdx = sections.findIndex(s => s.startsWith("Pending Items (Overflow)"));
    if (overflowIdx === -1) return { content: [{ type: "text" as const, text: "No overflow section found." }] };

    const overflowText = sections[overflowIdx].replace("Pending Items (Overflow)", "").trim();
    if (!overflowText) return { content: [{ type: "text" as const, text: "Overflow section is empty." }] };

    const items = overflowText.split("\n").map(line => line.replace(/^[-*]\s*(\[\d{2}:\d{2}\])?\s*/, "").trim()).filter(Boolean);

    const stack = readJson<FocusStack>(p.focusStack, {
        project_goal: "Restored",
        current_path: [],
        current_focus: "Refilling...",
        pending_siblings: [],
        last_updated: nowISO()
    });

    const space = 7 - stack.current_path.length - 1;
    const available = Math.max(0, space - stack.pending_siblings.length);

    if (available <= 0) {
        return { content: [{ type: "text" as const, text: "Focus stack is already at or near limit (7). Cannot refill yet." }] };
    }

    const toRefill = items.splice(0, available);
    stack.pending_siblings.push(...toRefill);
    stack.last_updated = nowISO();
    writeJson(p.focusStack, stack);

    if (items.length > 0) {
        sections[overflowIdx] = `Pending Items (Overflow)\n${items.join("\n")}`;
    } else {
        sections.splice(overflowIdx, 1);
    }

    fs.writeFileSync(p.scratchpad, sections.join("## ").trim() + "\n", "utf-8");

    return {
        content: [{
            type: "text" as const,
            text: `Refilled ${toRefill.length} items from scratchpad to focus stack. ${items.length} items remain in overflow.`
        }]
    };
}
