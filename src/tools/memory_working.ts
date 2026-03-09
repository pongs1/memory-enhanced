import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs";
import {
    DEFAULT_ACTIVE_TASK,
    appendScratchpad,
    isIdleTask,
    loadWorkingMemoryState,
    normalizeUserRequest,
    nowISO,
    paths,
    readFileOr,
    type WorkingMemoryState,
    resolveWorkspace,
    writeWorkingMemoryState,
} from "../utils.js";
import { executeMemoryRecord } from "./memory_record.js";

const MAX_NEXT_TASKS = 5;
const MAX_DONE_RECENT = 5;
const MAX_TASK_CHARS = 120;
const MAX_GOAL_CHARS = 400;

const WorkingAction = Type.Union(
    [
        Type.Literal("status"),
        Type.Literal("plan"),
        Type.Literal("push"),
        Type.Literal("complete"),
        Type.Literal("overflow"),
        Type.Literal("defer"),
        Type.Literal("reprioritize"),
        Type.Literal("scratchpad_append"),
        Type.Literal("scratchpad_refill"),
    ],
    { description: "Action to perform on the working memory ledger" }
);

export const MemoryWorkingParams = Type.Object({
    action: WorkingAction,
    goal: Type.Optional(Type.String({ description: "Primary project goal (for 'plan')" })),
    path: Type.Optional(
        Type.Array(Type.String(), {
            description: "Optional context breadcrumbs to keep with the task ledger",
        })
    ),
    focus: Type.Optional(
        Type.String({
            description: "Active task target (for 'plan', 'reprioritize', or 'defer')",
        })
    ),
    siblings: Type.Optional(
        Type.Array(Type.String(), {
            description: "Queued next tasks (for 'plan', 'push', or 'reprioritize')",
        })
    ),
    insight: Type.Optional(
        Type.String({ description: "Optional insight to record to memory (for 'complete')" })
    ),
    next_focus: Type.Optional(
        Type.String({
            description: "Explicit next active task after completion (for 'complete')",
        })
    ),
    section: Type.Optional(
        Type.String({
            description: "Scratchpad section header for 'scratchpad_append'",
        })
    ),
    content: Type.Optional(
        Type.String({
            description: "Scratchpad content to append for 'scratchpad_append'",
        })
    ),
});

export type MemoryWorkingInput = Static<typeof MemoryWorkingParams>;

export async function executeMemoryWorking(
    toolCallId: string,
    params: MemoryWorkingInput,
    ctx?: { workspaceDir?: string }
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const workspace = resolveWorkspace(ctx?.workspaceDir);
    let state = loadWorkingMemoryState(workspace);

    switch (params.action) {
        case "status":
            return { content: [{ type: "text" as const, text: renderStatus(state) }] };

        case "plan":
            {
                const sanitizedGoal = sanitizeGoalText(params.goal);
                const sanitizedFocus = sanitizeTaskText(params.focus);
                if (!sanitizedGoal || !sanitizedFocus) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    "Error: Action 'plan' requires a concise plain-text 'goal' and 'focus'. " +
                                    "Do not pass timestamps, injected prompt blocks, or markdown labels.",
                            },
                        ],
                    };
                }

                state = writeWorkingMemoryState(workspace, {
                    ...state,
                    project_goal: sanitizedGoal,
                    context_path: sanitizeTaskList(params.path),
                    active_task: sanitizedFocus,
                    next_tasks: sanitizeTaskList(params.siblings),
                    deferred_tasks:
                        sanitizedGoal === state.project_goal ? state.deferred_tasks : [],
                    done_recent: sanitizedGoal === state.project_goal ? state.done_recent : [],
                    last_updated: nowISO(),
                });

                return {
                    content: [{ type: "text" as const, text: withPrefix("Task ledger reset.", state) }],
                };
            }

        case "push":
            if (!params.siblings || params.siblings.length === 0) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Action 'push' requires 'siblings' array.",
                        },
                    ],
                };
            }

            state = writeWorkingMemoryState(workspace, {
                ...state,
                next_tasks: dedupeTasks([...state.next_tasks, ...sanitizeTaskList(params.siblings)], state.active_task),
                last_updated: nowISO(),
            });

            return {
                content: [{ type: "text" as const, text: withPrefix("Queued additional tasks.", state) }],
            };

        case "complete":
            if (params.insight) {
                await executeMemoryRecord(
                    toolCallId,
                    {
                        content: params.insight,
                        type: "insight",
                        importance: 0.6,
                    },
                    ctx
                );
            }

            state = completeActiveTask(workspace, state, params.next_focus);
            return {
                content: [{ type: "text" as const, text: withPrefix("Active task completed.", state) }],
            };

        case "overflow":
            return {
                content: [
                    {
                        type: "text" as const,
                        text: overflowQueuedTasks(workspace, state),
                    },
                ],
            };

        case "defer":
            return {
                content: [
                    {
                        type: "text" as const,
                        text: deferTask(workspace, state, params.focus),
                    },
                ],
            };

        case "reprioritize":
            if (!sanitizeTaskText(params.focus)) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text:
                                "Error: Action 'reprioritize' requires a concise plain-text 'focus'. " +
                                "Do not pass timestamps, injected prompt blocks, or markdown labels.",
                        },
                    ],
                };
            }

            state = reprioritizeTasks(workspace, state, params.focus, params.siblings);
            return {
                content: [{ type: "text" as const, text: withPrefix("Reprioritized task ledger.", state) }],
            };

        case "scratchpad_append":
            if (!params.section || !params.content) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Action 'scratchpad_append' requires 'section' and 'content'.",
                        },
                    ],
                };
            }

            appendScratchpad(workspace, params.section, params.content);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Appended note to scratchpad.md [${params.section}].`,
                    },
                ],
            };

        case "scratchpad_refill":
            return handleRefill(workspace, state);

        default:
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Error: Unknown action: ${params.action}`,
                    },
                ],
            };
    }
}

function renderStatus(state: WorkingMemoryState): string {
    const lines = [
        "## Working Memory Ledger",
        "",
        `**Goal:** ${state.project_goal}`,
        `**Last Updated:** ${state.last_updated}`,
    ];

    if (state.context_path.length > 0) {
        lines.push(`**Context:** ${state.context_path.join(" / ")}`);
    }

    lines.push("", `**Active:** ${state.active_task}`);

    lines.push("", "**Next:**");
    if (state.next_tasks.length === 0) {
        lines.push("- (none queued)");
    } else {
        state.next_tasks.forEach((task) => lines.push(`- ${task}`));
    }

    lines.push("", "**Deferred:**");
    if (state.deferred_tasks.length === 0) {
        lines.push("- (none deferred)");
    } else {
        state.deferred_tasks.forEach((task) => lines.push(`- ${task}`));
    }

    lines.push("", "**Done Recently:**");
    if (state.done_recent.length === 0) {
        lines.push("- (nothing completed recently)");
    } else {
        [...state.done_recent].reverse().forEach((task) => lines.push(`- ${task}`));
    }

    if (state.last_user_request) {
        lines.push("", `**Last User Request:** ${state.last_user_request}`);
    }

    return lines.join("\n");
}

function withPrefix(prefix: string, state: WorkingMemoryState): string {
    return `${prefix}\n\n${renderStatus(state)}`;
}

function sanitizeTaskList(input?: string[]): string[] {
    if (!input) return [];
    return dedupeTasks(
        input
            .map((entry) => sanitizeTaskText(entry))
            .filter(Boolean)
    );
}

function sanitizeTaskText(input?: string, maxChars = MAX_TASK_CHARS): string {
    if (!input) return "";
    const normalized = normalizeUserRequest(input, maxChars);
    if (!normalized) return "";
    if (/^(Task Ledger|Working Memory Rule|Latest User Request|Last User Request)$/i.test(normalized)) {
        return "";
    }
    return normalized;
}

function sanitizeGoalText(input?: string): string {
    if (!input) return "";
    return normalizeUserRequest(input, MAX_GOAL_CHARS);
}

function dedupeTasks(tasks: string[], activeTask?: string): string[] {
    const seen = new Set<string>();
    const cleaned: string[] = [];

    for (const task of tasks) {
        const normalized = task.trim();
        if (!normalized || normalized === activeTask || seen.has(normalized)) continue;
        seen.add(normalized);
        cleaned.push(normalized);
    }

    return cleaned;
}

function trimDoneRecent(tasks: string[]): string[] {
    return tasks.slice(-MAX_DONE_RECENT);
}

function completeActiveTask(
    workspace: string,
    state: WorkingMemoryState,
    nextFocus?: string
): WorkingMemoryState {
    const completed = state.active_task;
    const doneRecent =
        completed && !isIdleTask(completed)
            ? trimDoneRecent([...state.done_recent, completed])
            : state.done_recent;

    const queue = [...state.next_tasks];
    const explicitNext = sanitizeTaskText(nextFocus);

    let activeTask = DEFAULT_ACTIVE_TASK;
    if (explicitNext) {
        activeTask = explicitNext;
    } else if (queue.length > 0) {
        activeTask = queue.shift()!;
    }

    const nextTasks = dedupeTasks(queue, activeTask);

    return writeWorkingMemoryState(workspace, {
        ...state,
        active_task: activeTask,
        next_tasks: nextTasks,
        deferred_tasks: state.deferred_tasks.filter((task) => task !== activeTask),
        done_recent: doneRecent,
        last_updated: nowISO(),
    });
}

function overflowQueuedTasks(workspace: string, state: WorkingMemoryState): string {
    if (state.next_tasks.length <= MAX_NEXT_TASKS) {
        return "No overflow: queued tasks already fit within the active working set.";
    }

    const kept = state.next_tasks.slice(0, MAX_NEXT_TASKS);
    const parked = state.next_tasks.slice(MAX_NEXT_TASKS);
    const nextState = writeWorkingMemoryState(workspace, {
        ...state,
        next_tasks: kept,
        deferred_tasks: dedupeTasks([...state.deferred_tasks, ...parked], state.active_task),
        last_updated: nowISO(),
    });

    return withPrefix(`Moved ${parked.length} queued task(s) into Deferred.`, nextState);
}

function deferTask(workspace: string, state: WorkingMemoryState, requestedTask?: string): string {
    const target = sanitizeTaskText(requestedTask) || state.active_task;

    if (!target || isIdleTask(target)) {
        return "No active task to defer.";
    }

    if (target === state.active_task) {
        const queue = [...state.next_tasks];
        const nextActive = queue.shift() ?? DEFAULT_ACTIVE_TASK;
        const nextState = writeWorkingMemoryState(workspace, {
            ...state,
            active_task: nextActive,
            next_tasks: dedupeTasks(queue, nextActive),
            deferred_tasks: dedupeTasks([...state.deferred_tasks, target], nextActive),
            last_updated: nowISO(),
        });
        return withPrefix(`Deferred active task: ${target}`, nextState);
    }

    if (!state.next_tasks.includes(target)) {
        return `Task not found in active queue: ${target}`;
    }

    const nextState = writeWorkingMemoryState(workspace, {
        ...state,
        next_tasks: state.next_tasks.filter((task) => task !== target),
        deferred_tasks: dedupeTasks([...state.deferred_tasks, target], state.active_task),
        last_updated: nowISO(),
    });

    return withPrefix(`Deferred queued task: ${target}`, nextState);
}

function reprioritizeTasks(
    workspace: string,
    state: WorkingMemoryState,
    focus: string,
    siblings?: string[]
): WorkingMemoryState {
    const target = sanitizeTaskText(focus);
    const previousActive = state.active_task;
    const extraNext = sanitizeTaskList(siblings);

    const nextTasks = dedupeTasks(
        [
            ...extraNext,
            ...(!isIdleTask(previousActive) && previousActive !== target ? [previousActive] : []),
            ...state.next_tasks.filter((task) => task !== target),
        ],
        target
    );

    const deferredTasks = state.deferred_tasks.filter((task) => task !== target);

    return writeWorkingMemoryState(workspace, {
        ...state,
        active_task: target,
        next_tasks: nextTasks,
        deferred_tasks: deferredTasks,
        last_updated: nowISO(),
    });
}

async function handleRefill(
    workspace: string,
    state: WorkingMemoryState
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const p = paths(workspace);
    const scratchpadContent = readFileOr(p.scratchpad);
    const overflowHeader = "## Pending Items (Overflow)";

    const freeSlots = Math.max(0, MAX_NEXT_TASKS - state.next_tasks.length);
    if (freeSlots <= 0) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: "Next queue is already full. Complete or defer work before refilling.",
                },
            ],
        };
    }

    if (scratchpadContent.includes(overflowHeader)) {
        const lines = scratchpadContent.split("\n");
        const startIndex = lines.findIndex((line) => line.trim() === overflowHeader);
        const extracted: string[] = [];

        if (startIndex !== -1) {
            for (let i = startIndex + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith("## ")) break;
                if (line.startsWith("- ")) {
                    extracted.push(line.replace(/^-\s*(\[\d{2}:\d{2}\]\s*)?/, "").trim());
                }
            }
        }

        const toRefill = extracted.filter(Boolean).slice(0, freeSlots);
        if (toRefill.length > 0) {
            const remaining = extracted.slice(toRefill.length);
            const rebuilt = rebuildScratchpadWithoutOverflow(lines, remaining);
            fs.writeFileSync(p.scratchpad, rebuilt, "utf-8");

            const nextState = writeWorkingMemoryState(workspace, {
                ...state,
                next_tasks: dedupeTasks([...state.next_tasks, ...toRefill], state.active_task),
                last_updated: nowISO(),
            });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: withPrefix(
                            `Refilled ${toRefill.length} task(s) from scratchpad overflow.`,
                            nextState
                        ),
                    },
                ],
            };
        }
    }

    if (state.deferred_tasks.length === 0) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: "No deferred or scratchpad overflow tasks available to refill.",
                },
            ],
        };
    }

    const toRestore = state.deferred_tasks.slice(0, freeSlots);
    const nextState = writeWorkingMemoryState(workspace, {
        ...state,
        next_tasks: dedupeTasks([...state.next_tasks, ...toRestore], state.active_task),
        deferred_tasks: state.deferred_tasks.slice(toRestore.length),
        last_updated: nowISO(),
    });

    return {
        content: [
            {
                type: "text" as const,
                text: withPrefix(`Restored ${toRestore.length} deferred task(s) into Next.`, nextState),
            },
        ],
    };
}

function rebuildScratchpadWithoutOverflow(lines: string[], remaining: string[]): string {
    const startIndex = lines.findIndex((line) => line.trim() === "## Pending Items (Overflow)");
    if (startIndex === -1) {
        return lines.join("\n").trimEnd() + "\n";
    }

    let endIndex = lines.length;
    for (let i = startIndex + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith("## ")) {
            endIndex = i;
            break;
        }
    }

    const nextLines = [...lines];
    if (remaining.length === 0) {
        nextLines.splice(startIndex, endIndex - startIndex);
    } else {
        const replacement = ["## Pending Items (Overflow)", ...remaining.map((task) => `- ${task}`)];
        nextLines.splice(startIndex, endIndex - startIndex, ...replacement);
    }

    return nextLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
