import * as fs from "node:fs";
import { AssociativeScanner } from "../stream/associative-scanner.js";
import {
    hasMeaningfulTaskOverlap,
    isIdleTask,
    summarizeUserRequestForTask,
    loadWorkingMemoryState,
    syncLatestUserRequest,
    type WorkingMemoryState,
} from "../utils.js";
import { v8StorePaths } from "../v8/paths_v8.js";
import { assembleRecallPrompts, loadRecallAssemblyContext } from "../v8/recall.js";
import { recordSessionRecalls } from "../v8/feedback-runtime.js";
import { V8GraphScanner } from "../v8/scanner.js";
import type {
    V8ControlAnchors,
    V8SceneSignal,
    V8ScannerConfig,
} from "../v8/types_v8.js";

// A global registry for active scanners per session
const scanners = new Map<string, AssociativeScanner>();
const v8Scanners = new Map<string, V8GraphScanner>();
const outputWatchdogs = new Map<string, OutputWatchdogState>();

interface OutputWatchdogState {
    charsStreamed: number;
    lastCheckpointAt: number;
    interruptsUsed: number;
    overrideInterruptsUsed: number;
    lastOverrideCheckAt: number;
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

interface OverrideCandidate {
    prompt: string;
}

type AssociativeRecallKind = "critical" | "decision" | "background";

interface AssociativeRecallCandidate {
    prompt: string;
    kind: AssociativeRecallKind;
}

interface LiveInterruptContext {
    liveInterrupt?: (text: string, meta?: { reason?: string }) => Promise<boolean> | boolean;
}

function isV8GraphRecallEnabled(pluginConfig: any, workspace: string): boolean {
    if (!pluginConfig?.enableV8GraphRecall) {
        return false;
    }
    const store = v8StorePaths(workspace);
    return fs.existsSync(store.graphNodes);
}

function buildControlAnchors(workingState: WorkingMemoryState): V8ControlAnchors {
    return {
        goal: workingState.project_goal || "",
        activeTask: workingState.active_task || "",
        latestUserRequest: workingState.last_user_request || "",
    };
}

function pushSceneSignal(
    signals: V8SceneSignal[],
    source: V8SceneSignal["source"],
    text: string,
    weight?: number
) {
    const normalized = text.trim();
    if (!normalized) {
        return;
    }
    signals.push({ source, text: normalized, weight });
}

function buildSceneSignals(
    workingState: WorkingMemoryState,
    extras: V8SceneSignal[] = []
): V8SceneSignal[] {
    const signals: V8SceneSignal[] = [];
    pushSceneSignal(signals, "control", workingState.project_goal || "", 1.05);
    pushSceneSignal(signals, "control", workingState.active_task || "", 1.15);
    pushSceneSignal(signals, "control", workingState.last_user_request || "", 1.2);
    return [...signals, ...extras];
}

function summarizeObservationValue(value: any, maxChars = 320): string {
    if (!value) {
        return "";
    }

    if (typeof value === "string") {
        const stripped = stripUntrustedObservation(value);
        return stripped.replace(/\s+/g, " ").trim().slice(0, maxChars);
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => summarizeObservationValue(item, Math.max(60, Math.floor(maxChars / 3))))
            .filter(Boolean)
            .join(" ")
            .slice(0, maxChars);
    }

    if (typeof value === "object") {
        if (typeof value.text === "string") {
            return summarizeObservationValue(value.text, maxChars);
        }
        if (typeof value.content === "string") {
            return summarizeObservationValue(value.content, maxChars);
        }
        try {
            return JSON.stringify(value).replace(/\s+/g, " ").slice(0, maxChars);
        } catch {
            return "";
        }
    }

    return String(value).slice(0, maxChars);
}

function stripUntrustedObservation(text: string): string {
    if (!text) return text;
    return text
        .replace(
            /SECURITY NOTICE:[\s\S]*?(?=<<<EXTERNAL_UNTRUSTED_CONTENT|$)/g,
            ""
        )
        .replace(
            /<<<EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[\s\S]*?>>>/g,
            ""
        );
}

function extractToolSceneSignals(event: any): V8SceneSignal[] {
    const signals: V8SceneSignal[] = [];
    const toolName = typeof event?.toolName === "string" ? event.toolName : "";
    if (toolName && toolName !== "memory_working") {
        pushSceneSignal(signals, "tool", `tool:${toolName}`, 0.82);
    }

    const observation = summarizeObservationValue(
        event?.output ||
        event?.result ||
        event?.response ||
        event?.content ||
        event?.text ||
        event?.body,
        360
    );
    if (observation) {
        pushSceneSignal(signals, "tool", observation, 0.92);
    }

    return signals;
}

function getLegacyScanner(sessionId: string, workspace: string): AssociativeScanner {
    if (!scanners.has(sessionId)) {
        scanners.set(sessionId, new AssociativeScanner(workspace));
    }
    return scanners.get(sessionId)!;
}

function getV8Scanner(
    sessionId: string,
    workspace: string,
    config?: Partial<V8ScannerConfig>
): V8GraphScanner {
    if (!v8Scanners.has(sessionId)) {
        v8Scanners.set(sessionId, new V8GraphScanner(workspace, config));
    }
    return v8Scanners.get(sessionId)!;
}

function combineRecallPrompts(prompts: Array<{ prompt: string }>): string {
    return prompts
        .map((item) => item.prompt.trim())
        .filter(Boolean)
        .join("\n\n");
}

function selectRecallMode(promptText: string): "profile" | "trajectory" | "oblique" | "audit" {
    const normalized = (promptText || "").trim();
    if (!normalized) return "profile";

    const auditPattern =
        /审计|溯源|追溯|回溯|证据链|证据|核对|核查|验证|fact\s*check|compliance|audit|provenance|evidence|backtrace|trace|verify|validate/i;
    const trajectoryPattern =
        /之前|前面|前几章|前几步|一开始|最初|曾经|后来|之后|现在|改了|变成|演变|变化|从头到尾|全过程|完整脉络|timeline|history|earlier|before|previously|later|after|changed|became|evolved|evolution|lifecycle/i;
    const obliquePattern =
        /相关|联系|联想|侧面|旁支|隐含|类似|相似|横向|oblique|related|analog|analogy|adjacent|side/i;

    if (auditPattern.test(normalized)) return "audit";
    if (trajectoryPattern.test(normalized)) return "trajectory";
    if (obliquePattern.test(normalized)) return "oblique";
    return "profile";
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
            overrideInterruptsUsed: 0,
            lastOverrideCheckAt: 0,
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

function tokenizeOverlap(text: string): string[] {
    const englishWords = text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    const cjkChunks = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
    const cjkNgrams: string[] = [];

    for (const chunk of cjkChunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        if (trimmed.length <= 4) {
            cjkNgrams.push(trimmed);
            continue;
        }

        for (let size = 2; size <= Math.min(4, trimmed.length); size++) {
            for (let i = 0; i <= trimmed.length - size; i++) {
                cjkNgrams.push(trimmed.slice(i, i + size));
            }
        }
    }

    return [...englishWords, ...cjkNgrams];
}

function calculateTokenOverlap(sourceText: string, referenceText: string): number {
    const sourceTokens = new Set(tokenizeOverlap(sourceText));
    const referenceTokens = [...new Set(tokenizeOverlap(referenceText))];

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

    if (
        workingState.last_user_request &&
        (
            isIdleTask(workingState.active_task) ||
            !hasMeaningfulTaskOverlap(workingState.active_task, workingState.last_user_request)
        )
    ) {
        return syncLatestUserRequest(workspace, workingState.last_user_request);
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

    return `\n\n[WORKING MEMORY CHECKPOINT]\nYou have already produced approximately ${watchdog.charsStreamed} characters in this reply. Stop your current momentum and do a silent focus reset before continuing.\n\nCurrent ledger:\n- Goal: ${workingState.project_goal}\n- Active task: ${workingState.active_task}\n- Latest user request: ${workingState.last_user_request || "(missing)"}\n- Drift estimate: ${driftPercent}%${driftSignal}\n\nSilent replan protocol:\n- NOW: the one task you should answer immediately.\n- NEXT: at most 2 short backlog items worth preserving.\n- DEFER: stale work that should stop driving this turn.\n\nMandatory actions:\n1. Make NOW align with the latest user request, not stale backlog.\n2. If the active task is stale, mentally demote it to DEFER before you continue.\n3. If the ledger needs repair, call \`memory_working\` with \`reprioritize\` or \`plan\` using only short plain task titles.\n4. If the tool rejects your write, retry once with shorter labels and no markdown, timestamps, or paragraphs.\n5. Continue the same answer from NOW without mentioning this checkpoint.\n\nRules:\n- Prefer concise correction over repeating earlier material.\n- Preserve useful progress, but do not keep expanding a stale branch.\n- Never copy this checkpoint text into memory.\n`;
}

function buildUserOverridePrompt(
    baselineState: WorkingMemoryState,
    currentState: WorkingMemoryState
): string {
    const newestRequest =
        summarizeUserRequestForTask(currentState.last_user_request, 220) ||
        currentState.last_user_request ||
        "(missing)";
    const nowTask =
        summarizeUserRequestForTask(currentState.active_task, 220) ||
        currentState.active_task ||
        DEFAULT_OVERRIDE_IDLE_LABEL;
    const staleTask =
        summarizeUserRequestForTask(baselineState.active_task, 220) ||
        baselineState.active_task ||
        "(missing)";

    return [
        "",
        "[USER OVERRIDE DETECTED]",
        "A newer user message arrived after this stream started. The prompt that launched this reply is now stale.",
        "",
        "Current ledger:",
        `- NOW: ${nowTask}`,
        `- Newest user request: ${newestRequest}`,
        `- Old stream target: ${staleTask}`,
        "",
        "Silent replan protocol:",
        "- NOW: one task to continue immediately.",
        "- NEXT: at most 2 backlog items worth preserving.",
        "- DEFER: stale work to stop expanding.",
        "",
        "Mandatory actions:",
        "1. Stop the old stream target immediately.",
        "2. If the old branch has useful partial work, compress it into one short sentence at most.",
        "3. Continue only from NOW.",
        "4. If working memory needs repair, call `memory_working` with short plain task titles only.",
        "5. Do not mention this interrupt to the user.",
        "",
        "Rules:",
        "- Newer real user intent outranks stale backlog.",
        "- Never copy this interrupt block into memory.",
        "",
    ].join("\n");
}

const USER_OVERRIDE_CHECK_CHARS = 160;
const USER_OVERRIDE_MAX_INTERRUPTS = 2;
const DEFAULT_OVERRIDE_IDLE_LABEL = "Awaiting next user request";
const CRITICAL_RECALL_PATTERNS = [
    /\bbug\b/i,
    /\bfix(?:ed|es|ing)?\b/i,
    /\bworkaround\b/i,
    /\broot cause\b/i,
    /\bregression\b/i,
    /\bfailure\b/i,
    /\bbroken\b/i,
    /\bincident\b/i,
    /\bpostmortem\b/i,
    /\bknown issue\b/i,
    /\bverified workflow\b/i,
    /\bplaybook\b/i,
    /\brunbook\b/i,
    /\bresume point\b/i,
    /\bcheckpoint\b/i,
    /\bhandoff\b/i,
    /\brestart\b/i,
    /\brecover(?:y|ed|ing)?\b/i,
    /\bdo not\b/i,
    /\bmust not\b/i,
    /\brequired\b/i,
    /\bimportant\b/i,
    /\bcritical\b/i,
    /修复/,
    /bug/,
    /错误/,
    /报错/,
    /故障/,
    /问题原因/,
    /根因/,
    /回滚/,
    /恢复点/,
    /检查点/,
    /工作流/,
    /流程/,
    /字幕/,
    /交接/,
    /重启进度/,
    /不要改/,
    /不能改/,
    /必须/,
    /关键/,
    /重要/,
    /已验证/,
];
const DECISION_RECALL_PATTERNS = [
    /\bdecid(?:e|ed|es|ing|ion)\b/i,
    /\bprefer(?:ence|red|s)?\b/i,
    /\bconstraint\b/i,
    /\bpolicy\b/i,
    /\brule\b/i,
    /\bpriority\b/i,
    /\bdefault\b/i,
    /\badopt(?:ed|ing)?\b/i,
    /\bdeprecat(?:e|ed|ing)\b/i,
    /\bavoid\b/i,
    /\bmust\b/i,
    /\bshould\b/i,
    /\bnever\b/i,
    /\balways\b/i,
    /决定/,
    /偏好/,
    /约束/,
    /规则/,
    /优先/,
    /默认/,
    /采用/,
    /弃用/,
    /避免/,
    /不要/,
    /必须/,
    /应该/,
];

function maybeBuildUserOverridePrompt(
    workspace: string,
    watchdog: OutputWatchdogState,
    baselineState: WorkingMemoryState
): OverrideCandidate | null {
    if (watchdog.overrideInterruptsUsed >= USER_OVERRIDE_MAX_INTERRUPTS) {
        return null;
    }

    const charsSinceCheck = watchdog.charsStreamed - watchdog.lastOverrideCheckAt;
    if (charsSinceCheck < USER_OVERRIDE_CHECK_CHARS) {
        return null;
    }
    watchdog.lastOverrideCheckAt = watchdog.charsStreamed;

    const currentState = maybeRefreshWorkingState(workspace);
    const latestRequestChanged =
        !!currentState.last_user_request &&
        currentState.last_user_request !== baselineState.last_user_request;
    const activeTaskChanged =
        !!currentState.active_task &&
        !isIdleTask(currentState.active_task) &&
        currentState.active_task !== baselineState.active_task &&
        !hasMeaningfulTaskOverlap(currentState.active_task, baselineState.active_task);

    if (!latestRequestChanged && !activeTaskChanged) {
        return null;
    }

    if (!currentState.last_user_request || isIdleTask(currentState.active_task)) {
        return null;
    }

    if (
        baselineState.last_user_request &&
        currentState.last_user_request === baselineState.last_user_request &&
        baselineState.active_task &&
        hasMeaningfulTaskOverlap(currentState.active_task, baselineState.active_task)
    ) {
        return null;
    }

    return {
        prompt: buildUserOverridePrompt(baselineState, currentState),
    };
}

function summarizeAssociativeRecallContent(content: string, maxChars = 720): string {
    const lines = content
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.replace(/^[-*]\s*/, "").replace(/\s+/g, " ").trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return "";
    }

    const collected: string[] = [];
    let usedChars = 0;

    for (const line of lines) {
        const nextLine = line.slice(0, Math.max(0, maxChars - usedChars));
        if (!nextLine) {
            break;
        }

        const cost = nextLine.length + 3;
        if (usedChars + cost > maxChars && collected.length > 0) {
            break;
        }

        collected.push(`- ${nextLine}`);
        usedChars += cost;

        if (collected.length >= 6 || usedChars >= maxChars) {
            break;
        }
    }

    return collected.join("\n");
}

function classifyAssociativeRecall(filePath: string, content: string): AssociativeRecallKind {
    const sample = `${filePath}\n${content.slice(0, 1400)}`;
    if (CRITICAL_RECALL_PATTERNS.some((pattern) => pattern.test(sample))) {
        return "critical";
    }
    return DECISION_RECALL_PATTERNS.some((pattern) => pattern.test(sample))
        ? "decision"
        : "background";
}

function buildAssociativeRecallPrompt(
    workspace: string,
    filePath: string,
    memoryContent: string
): AssociativeRecallCandidate | null {
    const summarizedContent = summarizeAssociativeRecallContent(memoryContent);
    if (!summarizedContent) {
        return null;
    }

    const workingState = maybeRefreshWorkingState(workspace);
    const kind = classifyAssociativeRecall(filePath, memoryContent);
    const goal = workingState.project_goal || "(none)";
    const activeTask = workingState.active_task || DEFAULT_OVERRIDE_IDLE_LABEL;
    const latestUserRequest = workingState.last_user_request || "(missing)";

    if (kind === "critical") {
        return {
            kind,
            prompt: [
                "",
                "[CRITICAL MEMORY RECALL]",
                "A previously learned high-value memory was re-activated.",
                "Treat it as a proven fix, verified workflow, key user constraint, or restart checkpoint.",
                "Current goal remains unchanged unless this memory directly proves the current branch is wrong.",
                "",
                "Current anchors:",
                `- Goal: ${goal}`,
                `- Active task: ${activeTask}`,
                `- Latest user request: ${latestUserRequest}`,
                `- Recall source: ${filePath}`,
                `- Recall type: critical`,
                "",
                "Critical recall:",
                summarizedContent,
                "",
                "Mandatory actions:",
                "1. Pause the current branch and reconcile it against this recall.",
                "2. If the recall exposes a bug, invalid plan, or a better verified workflow, switch to the corrected path immediately.",
                "3. If the recall changes execution order or restart state, update `memory_working` with short plain task titles only.",
                "4. Keep the latest user request authoritative. Do not ignore it unless this recall is directly about fulfilling it correctly.",
                "5. Continue without mentioning this interrupt block.",
                "",
            ].join("\n"),
        };
    }

    if (kind === "decision") {
        return {
            kind,
            prompt: [
                "",
                "[MEMORY RECALL CANDIDATE]",
                "Current goal remains unchanged.",
                "Treat this as a possible prior decision or constraint, not as a new task.",
                "Use it only if it directly constrains the active task or the latest user request.",
                "Ignore it if it conflicts with the latest user request.",
                "Do not change task priority or rewrite working memory because of this note alone.",
                "",
                "Current anchors:",
                `- Goal: ${goal}`,
                `- Active task: ${activeTask}`,
                `- Latest user request: ${latestUserRequest}`,
                `- Recall source: ${filePath}`,
                `- Recall type: decision`,
                "",
                "Candidate recall:",
                summarizedContent,
                "",
                "Continue the same answer. Only apply this recall if it is directly relevant.",
                "",
            ].join("\n"),
        };
    }

    return {
        kind,
        prompt: [
            "",
            "[MEMORY RECALL CANDIDATE]",
            "Current goal remains unchanged.",
            "Treat this as optional background context only.",
            "Use it only if it directly helps the active task or the latest user request.",
            "Ignore it if it is weakly related or distracting.",
            "Do not change task priority, spawn replanning, or rewrite working memory because of this note alone.",
            "",
            "Current anchors:",
            `- Goal: ${goal}`,
            `- Active task: ${activeTask}`,
            `- Latest user request: ${latestUserRequest}`,
            `- Recall source: ${filePath}`,
            `- Recall type: background`,
            "",
            "Candidate recall:",
            summarizedContent,
            "",
            "Continue the same answer and keep the current objective primary.",
            "",
        ].join("\n"),
    };
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
    const v8ScannerConfig = (pluginConfig?.v8ScannerConfig || {}) as Partial<V8ScannerConfig>;
    // We assume the user's OpenClaw modification exposes a "wrap_stream_fn" hook
    // that allows us to wrap the raw provider stream function.
    api.on("wrap_stream_fn", async (event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        const checkpointConfig = getCheckpointConfig(pluginConfig);
        const watchdog = getOutputWatchdog(sid);
        const useV8GraphRecall = isV8GraphRecallEnabled(pluginConfig, workspace);
        const legacyScanner = useV8GraphRecall ? null : getLegacyScanner(sid, workspace);
            const v8Scanner = useV8GraphRecall
                ? getV8Scanner(sid, workspace, v8ScannerConfig)
                : null;

        const originalStreamFn = event.streamFn;

        // Return the wrapped stream function
        event.streamFn = async function* (model: any, context: any, options: any) {
            const baselineWorkingState = maybeRefreshWorkingState(workspace);
            const currentAnchors = buildControlAnchors(baselineWorkingState);
            if (useV8GraphRecall && v8Scanner) {
                v8Scanner.refreshScene(
                    buildSceneSignals(baselineWorkingState),
                    currentAnchors
                );
                v8Scanner.preExcite(
                    [
                        baselineWorkingState.project_goal,
                        baselineWorkingState.active_task,
                        baselineWorkingState.last_user_request,
                    ]
                        .filter(Boolean)
                        .join(" "),
                    currentAnchors
                );
            }
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

                    const override = maybeBuildUserOverridePrompt(
                        workspace,
                        watchdog,
                        baselineWorkingState
                    );
                    if (override) {
                        const didInterrupt = await requestLiveInterrupt(
                            ctx,
                            override.prompt,
                            "memory-enhanced user override"
                        );

                        watchdog.overrideInterruptsUsed += 1;

                        if (didInterrupt) {
                            return;
                        }

                        warnMissingLiveInterrupt(sid, watchdog);
                    }

                    if (useV8GraphRecall && v8Scanner) {
                        const anchors = buildControlAnchors(maybeRefreshWorkingState(workspace));
                        const v8Result = v8Scanner.processChunk(delta, anchors);
                        if (v8Result.activatedBundles.length > 0) {
                            const prompts = assembleRecallPrompts(
                                {
                                    workspace,
                                    bundles: v8Result.activatedBundles,
                                    goal: anchors.goal,
                                    activeTask: anchors.activeTask,
                                    latestUserRequest: anchors.latestUserRequest,
                                    mode: v8Scanner.getMode(),
                                },
                                loadRecallAssemblyContext(workspace)
                            );

                            const combinedPrompt = combineRecallPrompts(prompts);
                            if (combinedPrompt) {
                                const didInterrupt = await requestLiveInterrupt(
                                    ctx,
                                    combinedPrompt,
                                    "memory-enhanced v8 graph recall"
                                );
                                if (didInterrupt) {
                                    const recalledNodeIds = prompts.flatMap((prompt) => prompt.nodeIds);
                                    recordSessionRecalls(sid, recalledNodeIds);
                                    return;
                                }

                                warnMissingLiveInterrupt(sid, watchdog);
                            }
                        }
                    } else if (legacyScanner) {
                        const triggerFile = await legacyScanner.processChunk(delta);
                        if (triggerFile) {
                            const memoryContent = legacyScanner.getMemoryContent(triggerFile);
                            const recall = buildAssociativeRecallPrompt(
                                workspace,
                                triggerFile,
                                memoryContent
                            );
                            if (!recall) {
                                continue;
                            }

                            const didInterrupt = await requestLiveInterrupt(
                                ctx,
                                recall.prompt,
                                `memory-enhanced associative ${recall.kind} recall`
                            );
                            if (didInterrupt) {
                                return;
                            }

                            warnMissingLiveInterrupt(sid, watchdog);
                        }
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
        const useV8GraphRecall = isV8GraphRecallEnabled(pluginConfig, workspace);

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
            if (useV8GraphRecall) {
                const workingState = maybeRefreshWorkingState(workspace);
                const scanner = getV8Scanner(sid, workspace, v8ScannerConfig);
                const mode = selectRecallMode(promptText);
                scanner.setMode(mode);
                scanner.refreshScene(
                    buildSceneSignals(workingState, [
                        {
                            source: "prompt",
                            text: promptText,
                            weight: 1.0,
                        },
                    ]),
                    buildControlAnchors(workingState)
                );
                scanner.preExcite(promptText, buildControlAnchors(workingState));
            } else {
                const scanner = getLegacyScanner(sid, workspace);
                await scanner.preExcite(promptText);
            }
        }
    });

    api.on("after_tool_call", async (event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();
        if (!isV8GraphRecallEnabled(pluginConfig, workspace)) {
            return;
        }

        const scanner = getV8Scanner(sid, workspace);
        const workingState = maybeRefreshWorkingState(workspace);
        const toolSignals = extractToolSceneSignals(event);
        if (toolSignals.length === 0) {
            return;
        }

        scanner.refreshScene(
            buildSceneSignals(workingState, toolSignals),
            buildControlAnchors(workingState)
        );
    });

    api.on("agent_end", async (_event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        outputWatchdogs.delete(sid);
        scanners.delete(sid);
        v8Scanners.delete(sid);
    });
}
