import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import {
    resolveWorkspace,
    paths,
    readJson,
    writeJson,
    nowISO,
    ensureDir,
    type FocusStack
} from "../utils.js";
import { executeMemoryRecord } from "./memory_record.js";

const FocusAction = Type.Union([
    Type.Literal("status"),
    Type.Literal("plan"),
    Type.Literal("push"),
    Type.Literal("complete")
], { description: "Action to perform on the focus stack" });

export const MemoryFocusParams = Type.Object({
    action: FocusAction,
    goal: Type.Optional(Type.String({ description: "Primary project goal (for 'plan')" })),
    path: Type.Optional(Type.Array(Type.String(), { description: "Breadcrumbs/path (for 'plan')" })),
    focus: Type.Optional(Type.String({ description: "Current focus item (for 'plan' or 'complete')" })),
    siblings: Type.Optional(Type.Array(Type.String(), { description: "Pending tasks (for 'plan' or 'push')" })),
    insight: Type.Optional(Type.String({ description: "Optional insight to record to memory (for 'complete')" })),
    next_focus: Type.Optional(Type.String({ description: "The next item to focus on (for 'complete')" }))
});

export type MemoryFocusInput = Static<typeof MemoryFocusParams>;

export async function executeMemoryFocus(
    toolCallId: string,
    params: MemoryFocusInput,
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

            // Pop sibling or use next_focus
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

    // Build the 7-item view. Math: Path + 1 (Focus) + Siblings <= 7
    let pathLimit = Math.min(3, stack.current_path.length); // Max 3 path items to save space for future
    let remaining = 7 - 1 - pathLimit;
    let siblingsLimit = Math.min(remaining, stack.pending_siblings.length);

    // If we have fewer siblings than allowed, we can show more path
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

    // 1. Save unbounded backend
    writeJson(p.focusStack, stack);

    // 2. Generate and save truncated MD frontend
    const mdContent = generateMdFrontend(stack);
    fs.writeFileSync(p.focusStackMd, mdContent, "utf-8");

    // 3. Return full status to the LLM so it knows everything in the queue
    return {
        content: [{
            type: "text" as const,
            text: `${prefix}\n\n${renderStatus(stack)}`
        }]
    };
}
