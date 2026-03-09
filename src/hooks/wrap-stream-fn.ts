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
    recentOutput: string;
    lastDriftScore: number;
    liveInterruptWarned: boolean;
}

interface StreamCheckpointConfig {
    outputCheckpointChars: number;
    outputCheckpointCooldownChars: number;
    outputCheckpointBoundarySlackChars: number;
    outputCheckpointMaxInterrupts: number;
    outputCheckpointDriftThreshold: number;
    outputCheckpointTailChars: number;
}

interface CheckpointCandidate {
    prompt: string;
    driftScore: number;
}

interface LiveInterruptContext {
    liveInterrupt?: (text: string, meta?: { reason?: string }) => Promise<boolean> | boolean;
}

function getCheckpointConfig(pluginConfig: any): StreamCheckpointConfig {
    return {
        outputCheckpointChars: pluginConfig?.outputCheckpointChars ?? 1600,
        outputCheckpointCooldownChars: pluginConfig?.outputCheckpointCooldownChars ?? 1000,
        outputCheckpointBoundarySlackChars: pluginConfig?.outputCheckpointBoundarySlackChars ?? 320,
        outputCheckpointMaxInterrupts: pluginConfig?.outputCheckpointMaxInterrupts ?? 2,
        outputCheckpointDriftThreshold: pluginConfig?.outputCheckpointDriftThreshold ?? 0.84,
        outputCheckpointTailChars: pluginConfig?.outputCheckpointTailChars ?? 1400,
    };
}

function getOutputWatchdog(sessionId: string): OutputWatchdogState {
    if (!outputWatchdogs.has(sessionId)) {
        outputWatchdogs.set(sessionId, {
            charsStreamed: 0,
            lastCheckpointAt: 0,
            interruptsUsed: 0,
            recentOutput: "",
            lastDriftScore: 0,
            liveInterruptWarned: false,
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

function updateRecentOutput(
    watchdog: OutputWatchdogState,
    delta: string,
    maxChars: number
) {
    if (maxChars <= 0) return;

    const merged = watchdog.recentOutput + delta;
    watchdog.recentOutput =
        merged.length > maxChars ? merged.slice(-maxChars) : merged;
}

function calculateTokenOverlap(sourceText: string, referenceText: string): number {
    const sourceTokens = new Set(normalizeForOverlap(sourceText));
    const referenceTokens = [...new Set(normalizeForOverlap(referenceText))];

    if (sourceTokens.size === 0 || referenceTokens.length === 0) {
        return 0;
    }

    let matches = 0;
    for (const token of referenceTokens) {
        if (sourceTokens.has(token)) {
            matches += 1;
        }
    }

    return matches / referenceTokens.length;
}

function calculateDriftScore(
    workingState: WorkingMemoryState,
    recentOutput: string
): number {
    const requestScore = workingState.last_user_request
        ? calculateTokenOverlap(recentOutput, workingState.last_user_request)
        : 0;
    const activeScore = !isIdleTask(workingState.active_task)
        ? calculateTokenOverlap(recentOutput, workingState.active_task)
        : 0;
    const goalScore = workingState.project_goal
        ? calculateTokenOverlap(recentOutput, workingState.project_goal)
        : 0;

    let alignmentScore = Math.max(requestScore, activeScore * 0.9, goalScore * 0.6);

    if (
        workingState.last_user_request &&
        !isIdleTask(workingState.active_task) &&
        !hasMeaningfulTaskOverlap(workingState.active_task, workingState.last_user_request) &&
        activeScore > requestScore + 0.15
    ) {
        alignmentScore = Math.max(0, alignmentScore - 0.12);
    }

    return Math.max(0, Math.min(1, 1 - alignmentScore));
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
    watchdog: OutputWatchdogState,
    driftScore: number
): string {
    const driftPercent = Math.round(driftScore * 100);
    const driftSignal =
        workingState.last_user_request &&
            !isIdleTask(workingState.active_task) &&
            !hasMeaningfulTaskOverlap(workingState.active_task, workingState.last_user_request)
            ? `\n- Potential drift signal: the current active task may be stale relative to the latest user request.`
            : "";

    return `\n\n[WORKING MEMORY CHECKPOINT]\nYou have already produced approximately ${watchdog.charsStreamed} characters in this reply. Pause your current momentum and self-audit before continuing.\n\nCurrent ledger:\n- Goal: ${workingState.project_goal}\n- Active task: ${workingState.active_task}\n- Latest user request: ${workingState.last_user_request || "(missing)"}\n- Drift estimate: ${driftPercent}%${driftSignal}\n\nMandatory self-check:\n1. Are you still directly answering the latest user request?\n2. Have you drifted into stale backlog, repetition, or over-explaining?\n3. If drifted, correct course immediately and continue from the user's priority.\n4. If the real task changed, treat the latest user request as authoritative and update the working-memory ledger after this response.\n\nRules:\n- Continue the answer without mentioning this checkpoint.\n- Prefer concise correction over repeating earlier material.\n- Preserve any useful progress already made; do not restart from scratch unless the answer is clearly off-track.\n`;
}

function maybeBuildCheckpointPrompt(
    workspace: string,
    delta: string,
    watchdog: OutputWatchdogState,
    config: StreamCheckpointConfig
) : CheckpointCandidate | null {
    if (config.outputCheckpointChars <= 0) return null;
    if (watchdog.interruptsUsed >= config.outputCheckpointMaxInterrupts) return null;

    const charsSinceCheckpoint = watchdog.charsStreamed - watchdog.lastCheckpointAt;
    if (charsSinceCheckpoint < config.outputCheckpointChars) return null;

    const crossedHardLimit =
        charsSinceCheckpoint >=
        config.outputCheckpointChars + config.outputCheckpointBoundarySlackChars;
    if (!crossedHardLimit && !isCheckpointBoundary(delta)) return null;

    const workingState = maybeRefreshWorkingState(workspace);
    const driftScore = calculateDriftScore(workingState, watchdog.recentOutput);
    watchdog.lastDriftScore = driftScore;

    if (!crossedHardLimit && driftScore < config.outputCheckpointDriftThreshold) {
        return null;
    }

    return {
        prompt: buildCheckpointPrompt(workingState, watchdog, driftScore),
        driftScore,
    };
}

function markCheckpointAttempt(
    watchdog: OutputWatchdogState,
    config: StreamCheckpointConfig
) {
    watchdog.interruptsUsed += 1;
    watchdog.lastCheckpointAt =
        watchdog.charsStreamed -
        Math.max(0, config.outputCheckpointChars - config.outputCheckpointCooldownChars);
}

function hasLiveInterrupt(ctx: any): ctx is LiveInterruptContext & {
    liveInterrupt: NonNullable<LiveInterruptContext["liveInterrupt"]>;
} {
    return typeof ctx?.liveInterrupt === "function";
}

async function requestLiveInterrupt(
    ctx: any,
    prompt: string,
    reason: string
): Promise<boolean> {
    if (!hasLiveInterrupt(ctx)) {
        return false;
    }

    return !!(await ctx.liveInterrupt(prompt, { reason }));
}

function warnMissingLiveInterrupt(
    sid: string,
    watchdog: OutputWatchdogState
) {
    if (watchdog.liveInterruptWarned) {
        return;
    }

    watchdog.liveInterruptWarned = true;
    console.warn(
        `[memory-enhanced] session ${sid} requested live stream interruption, ` +
        `but the current OpenClaw core only exposes wrap_stream_fn read access. ` +
        `Install the liveInterrupt bridge from openclaw-patch-guide.md to enable ` +
        `mid-stream recall/checkpoint steering.`
    );
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
                    if (!delta) {
                        continue;
                    }

                    watchdog.charsStreamed += delta.length;
                    updateRecentOutput(
                        watchdog,
                        delta,
                        checkpointConfig.outputCheckpointTailChars
                    );

                    const triggerFile = await scanner.processChunk(delta);
                    if (triggerFile) {
                        const memoryContent = scanner.getMemoryContent(triggerFile);
                        const interruptPrompt = `\n\n[SUBCONSCIOUS RECALL TRIGGERED] Your recent thoughts strongly activated a latent memory regarding "${triggerFile}".\n\nMemory contents:\n${memoryContent}\n\nPlease immediately integrate this into your current thought process and continue.\n`;

                        const didInterrupt = await requestLiveInterrupt(
                            ctx,
                            interruptPrompt,
                            "memory-enhanced associative recall"
                        );
                        if (didInterrupt) {
                            return;
                        }

                        warnMissingLiveInterrupt(sid, watchdog);
                    }

                    const checkpoint = maybeBuildCheckpointPrompt(
                        workspace,
                        delta,
                        watchdog,
                        checkpointConfig
                    );
                    if (checkpoint) {
                        const didInterrupt = await requestLiveInterrupt(
                            ctx,
                            checkpoint.prompt,
                            "memory-enhanced output checkpoint"
                        );

                        markCheckpointAttempt(watchdog, checkpointConfig);

                        if (didInterrupt) {
                            return;
                        }

                        warnMissingLiveInterrupt(sid, watchdog);
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
