import { AssociativeScanner } from "../stream/associative-scanner.js";
import {
    isIdleTask,
    loadWorkingMemoryState,
    touchWorkingMemoryState,
    type WorkingMemoryState,
} from "../utils.js";

// A global registry for active scanners per session
const scanners = new Map<string, AssociativeScanner>();
const outputWatchdogs = new Map<string, OutputWatchdogState>();

interface OutputWatchdogState {
    charsStreamed: number;
    lastCheckpointAt: number;
    interruptsUsed: number;
}

interface StreamCheckpointConfig {
    outputCheckpointChars: number;
    outputCheckpointCooldownChars: number;
    outputCheckpointBoundarySlackChars: number;
    outputCheckpointMaxInterrupts: number;
}

function getCheckpointConfig(pluginConfig: any): StreamCheckpointConfig {
    return {
        outputCheckpointChars: pluginConfig?.outputCheckpointChars ?? 1600,
        outputCheckpointCooldownChars: pluginConfig?.outputCheckpointCooldownChars ?? 1000,
        outputCheckpointBoundarySlackChars: pluginConfig?.outputCheckpointBoundarySlackChars ?? 320,
        outputCheckpointMaxInterrupts: pluginConfig?.outputCheckpointMaxInterrupts ?? 2,
    };
}

function getOutputWatchdog(sessionId: string): OutputWatchdogState {
    if (!outputWatchdogs.has(sessionId)) {
        outputWatchdogs.set(sessionId, {
            charsStreamed: 0,
            lastCheckpointAt: 0,
            interruptsUsed: 0,
        });
    }
    return outputWatchdogs.get(sessionId)!;
}

function isCheckpointBoundary(delta: string): boolean {
    return /(\n\n|\n|```|[。！？!?](?:\s|$)|\.(?:\s|$)|:(?:\s|$))/.test(delta);
}

function normalizeForOverlap(text: string): string[] {
    const englishWords = text
        .toLowerCase()
        .match(/[a-z0-9_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    return [...englishWords, ...cjkChunks.map((chunk) => chunk.trim())];
}

function hasMeaningfulTaskOverlap(activeTask: string, lastUserRequest: string): boolean {
    const activeTokens = new Set(normalizeForOverlap(activeTask));
    const requestTokens = normalizeForOverlap(lastUserRequest);

    if (activeTokens.size === 0 || requestTokens.length === 0) {
        return false;
    }

    return requestTokens.some((token) => activeTokens.has(token));
}

function maybeRefreshWorkingState(workspace: string): WorkingMemoryState {
    const workingState = loadWorkingMemoryState(workspace);

    if (workingState.last_user_request && isIdleTask(workingState.active_task)) {
        return touchWorkingMemoryState(workspace, {
            active_task: workingState.last_user_request,
        });
    }

    return workingState;
}

function buildCheckpointPrompt(
    workingState: WorkingMemoryState,
    watchdog: OutputWatchdogState
): string {
    const driftSignal =
        workingState.last_user_request &&
            !isIdleTask(workingState.active_task) &&
            !hasMeaningfulTaskOverlap(workingState.active_task, workingState.last_user_request)
            ? `\n- Potential drift signal: the current active task may be stale relative to the latest user request.`
            : "";

    return `\n\n[WORKING MEMORY CHECKPOINT]\nYou have already produced approximately ${watchdog.charsStreamed} characters in this reply. Pause your current momentum and self-audit before continuing.\n\nCurrent ledger:\n- Goal: ${workingState.project_goal}\n- Active task: ${workingState.active_task}\n- Latest user request: ${workingState.last_user_request || "(missing)"}${driftSignal}\n\nMandatory self-check:\n1. Are you still directly answering the latest user request?\n2. Have you drifted into stale backlog, repetition, or over-explaining?\n3. If drifted, correct course immediately and continue from the user's priority.\n4. If the real task changed, treat the latest user request as authoritative and update the working-memory ledger after this response.\n\nRules:\n- Continue the answer without mentioning this checkpoint.\n- Prefer concise correction over repeating earlier material.\n- Preserve any useful progress already made; do not restart from scratch unless the answer is clearly off-track.\n`;
}

function maybeBuildCheckpointPrompt(
    workspace: string,
    delta: string,
    watchdog: OutputWatchdogState,
    config: StreamCheckpointConfig
): string | null {
    if (config.outputCheckpointChars <= 0) return null;
    if (watchdog.interruptsUsed >= config.outputCheckpointMaxInterrupts) return null;

    const charsSinceCheckpoint = watchdog.charsStreamed - watchdog.lastCheckpointAt;
    if (charsSinceCheckpoint < config.outputCheckpointChars) return null;

    const crossedHardLimit =
        charsSinceCheckpoint >=
        config.outputCheckpointChars + config.outputCheckpointBoundarySlackChars;
    if (!crossedHardLimit && !isCheckpointBoundary(delta)) return null;

    const workingState = maybeRefreshWorkingState(workspace);
    watchdog.interruptsUsed += 1;
    watchdog.lastCheckpointAt =
        watchdog.charsStreamed -
        Math.max(0, config.outputCheckpointChars - config.outputCheckpointCooldownChars);

    return buildCheckpointPrompt(workingState, watchdog);
}

export function registerStreamWrapper(api: any, pluginConfig: any) {
    // We assume the user's OpenClaw modification exposes a "wrap_stream_fn" hook
    // that allows us to wrap the raw provider stream function.
    api.on("wrap_stream_fn", async (event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const checkpointConfig = getCheckpointConfig(pluginConfig);

        // Ensure a scanner exists for this session
        if (!scanners.has(sid)) {
            scanners.set(sid, new AssociativeScanner(workspace));
        }
        const scanner = scanners.get(sid)!;
        const watchdog = getOutputWatchdog(sid);

        const originalStreamFn = event.streamFn;

        // Return the wrapped stream function
        event.streamFn = async function* (model: any, context: any, options: any) {
            const stream = originalStreamFn(model, context, options);

            for await (const chunk of stream) {
                // Yield the chunk normally
                yield chunk;

                // Only intercept deltas
                if (chunk.type === "text_delta" || chunk.type === "thinking_delta") {
                    const delta = typeof chunk.delta === "string" ? chunk.delta : "";
                    watchdog.charsStreamed += delta.length;

                    const triggerFile = await scanner.processChunk(delta);
                    if (triggerFile) {
                        const memoryContent = scanner.getMemoryContent(triggerFile);
                        const interruptPrompt = `\n\n[SUBCONSCIOUS RECALL TRIGGERED] Your recent thoughts strongly activated a latent memory regarding "${triggerFile}".\n\nMemory contents:\n${memoryContent}\n\nPlease immediately integrate this into your current thought process and continue.\n`;

                        yield {
                            type: "steer",
                            content: interruptPrompt,
                        };
                        break;
                    }

                    const checkpointPrompt = maybeBuildCheckpointPrompt(
                        workspace,
                        delta,
                        watchdog,
                        checkpointConfig
                    );
                    if (checkpointPrompt) {
                        yield {
                            type: "steer",
                            content: checkpointPrompt,
                        };
                        break;
                    }
                }
            }
        };
    });

    // Hook into llm_input to catch the user prompt BEFORE generation starts
    api.on("llm_input", async (event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();

        if (!scanners.has(sid)) {
            scanners.set(sid, new AssociativeScanner(workspace));
        }
        const scanner = scanners.get(sid)!;

        // Extract the latest user message
        const messages = event.historyMessages || [];
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");

        let promptText = event.prompt || "";
        if (lastUserMsg) {
            if (typeof lastUserMsg.content === "string") {
                promptText += " " + lastUserMsg.content;
            } else if (Array.isArray(lastUserMsg.content)) {
                promptText += " " + lastUserMsg.content.map((c: any) => c.text || "").join(" ");
            }
        }

        if (promptText) {
            // Pre-excite the network with the user's stimulus!
            await scanner.preExcite(promptText);
        }
    });

    api.on("agent_end", async (_event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        outputWatchdogs.delete(sid);
    });
}
