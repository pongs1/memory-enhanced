import { Type, type Static } from "@sinclair/typebox";
import {
    resolveWorkspace,
    paths,
    readJson,
    writeJson,
    nowISO,
    appendScratchpad,
    type FocusStack
} from "../utils.js";
import { executeMemoryRecord } from "./memory_record.js";

const FocusAction = Type.Union([
    Type.Literal("status"),
    Type.Literal("plan"),
    Type.Literal("push"),
    Type.Literal("complete"),
    Type.Literal("overflow")
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
    params: MemoryFocusInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace();
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
            return renderStatus(stack);

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
                });
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

        case "overflow":
            const total = stack.current_path.length + stack.pending_siblings.length;
            if (total <= 7) {
                return { content: [{ type: "text" as const, text: "Queue is within limits (7 chunks). No overflow needed." }] };
            }
            const keep = 7 - stack.current_path.length - 1; // leave room for focus
            const moved = stack.pending_siblings.splice(Math.max(0, keep));

            if (moved.length > 0) {
                appendScratchpad(workspace, "Pending Items (Overflow)", moved.join("\n"));
            }

            stack.last_updated = nowISO();
            writeJson(p.focusStack, stack);
            return { content: [{ type: "text" as const, text: `Moved ${moved.length} items to scratchpad.md overflow section.` }] };

        default:
            return { content: [{ type: "text" as const, text: `Error: Unknown action: ${params.action}` }] };
    }
}

function renderStatus(stack: FocusStack): { content: Array<{ type: "text"; text: string }> } {
    const totalCount = stack.current_path.length + (stack.current_focus ? 1 : 0) + stack.pending_siblings.length;
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
        "",
        `*Working Memory usage: ${totalCount}/7 chunks*`
    ];

    if (totalCount >= 7) {
        lines.push("", "⚠️ **WARNING: Working memory limit reached.** Consider calling `memory_focus action=\"overflow\"` to move items to scratchpad.md.");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function validateAndSave(workspace: string, stack: FocusStack, prefix = "Focus updated."): { content: Array<{ type: "text"; text: string }> } {
    const totalCount = stack.current_path.length + 1 + stack.pending_siblings.length;
    const p = paths(workspace);
    writeJson(p.focusStack, stack);

    if (totalCount > 7) {
        return {
            content: [{
                type: "text" as const,
                text: `${prefix}\n\n[Working Memory Limit Exceeded] You are tracking ${totalCount} chunks (limit 7). \nPROMPT: You MUST call \`memory_focus action=\"overflow\"\` immediately to move excess pending tasks to scratchpad.md, or you risk context dilution.`
            }]
        };
    }

    return renderStatus(stack);
}
