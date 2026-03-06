import { Type, type Static } from "@sinclair/typebox";
import {
    resolveWorkspace,
    paths,
    readJson,
    writeJson,
    readFileOr,
    appendScratchpad,
    nowISO,
    type FocusStack
} from "../utils.js";
import * as fs from "node:fs";

const ScratchpadAction = Type.Union([
    Type.Literal("append"),
    Type.Literal("refill")
], { description: "Action to perform on the scratchpad" });

export const MemoryScratchpadParams = Type.Object({
    action: ScratchpadAction,
    section: Type.Optional(Type.String({ description: "Section header (e.g. 'Reasoning', 'Verification') for 'append'" })),
    content: Type.Optional(Type.String({ description: "Content to append for 'append'" }))
});

export type MemoryScratchpadInput = Static<typeof MemoryScratchpadParams>;

export async function executeMemoryScratchpad(
    _toolCallId: string,
    params: MemoryScratchpadInput,
    ctx?: { workspaceDir?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    const p = paths(workspace);

    switch (params.action) {
        case "append":
            if (!params.section || !params.content) {
                return { content: [{ type: "text" as const, text: "Error: Action 'append' requires 'section' and 'content'." }] };
            }
            appendScratchpad(workspace, params.section, params.content);
            return { content: [{ type: "text" as const, text: `Appended note to scratchpad.md [${params.section}].` }] };

        case "refill":
            return handleRefill(workspace);

        default:
            return { content: [{ type: "text" as const, text: `Error: Unknown action: ${params.action}` }] };
    }
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

    const space = 7 - stack.current_path.length - 1; // 1 for focus
    const available = Math.max(0, space - stack.pending_siblings.length);

    if (available <= 0) {
        return { content: [{ type: "text" as const, text: "Focus stack is already at or near limit (7). Cannot refill yet." }] };
    }

    const toRefill = items.splice(0, available);
    stack.pending_siblings.push(...toRefill);
    stack.last_updated = nowISO();
    writeJson(p.focusStack, stack);

    // Update scratchpad
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
