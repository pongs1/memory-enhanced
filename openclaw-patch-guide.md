# OpenClaw Core Patch Guide for Memory V8 Stream Hooks

To let the memory system inspect the raw LLM stream in real time, OpenClaw needs a native `wrap_stream_fn` hook.

Since OpenClaw uses a strict Typescript HookRunner (`src/plugins/hooks.ts`), this must be added structurally in core.

## 0. Recommended Workflow: Managed Overlay, Not Permanent Hand Edits

If you are running OpenClaw from a source checkout, the default workflow is now:

```bash
pnpm openclaw:overlay:check -- --openclaw-dir /home/pongs/openclaw
pnpm openclaw:overlay:adopt -- --openclaw-dir /home/pongs/openclaw   # if this checkout is already hand-patched
pnpm openclaw:overlay:apply -- --openclaw-dir /home/pongs/openclaw
```

For future source updates:

```bash
pnpm openclaw:overlay:update -- --openclaw-dir /home/pongs/openclaw
```

Why this exists:

- `openclaw update` requires a clean git worktree
- hand-edited `types.ts` / `hooks.ts` / `attempt.ts` keep the checkout dirty
- an in-repo plugin clone like `~/openclaw/extensions/memory-enhanced` is also seen as an untracked blocker unless excluded

The overlay script shipped with this repo solves that by:

1. backing up clean versions of the managed core files into `.openclaw-overlay/`
2. applying the memory-enhanced 3.1 bridge on demand
3. restoring clean core files before update
4. reapplying the patch, rebuilding, and restarting after update

For existing environments that already have the live-interrupt bridge hand-edited into core,
run `pnpm openclaw:overlay:adopt -- --openclaw-dir /home/pongs/openclaw` once first. That command
does not rewrite the current patched files. It only records clean backups from `HEAD`, writes the
overlay manifest, and adds `.git/info/exclude` if the plugin lives under `~/openclaw/extensions/`.

The manual patch blocks below are still important, but they are now the **reference/fallback path** when the overlay script needs to be debugged or refreshed for a newer OpenClaw source layout.

Important limits before you patch:

- `wrap_stream_fn` by itself is a **read-stream hook**, not a magic interrupt channel.
- `@mariozechner/pi-ai` does **not** accept custom stream events such as `type: "steer"`.
- `activeSession.steer(...)` is a real queueing API, but it is **not** a true mid-token injection primitive. By default it is consumed after the current tool/turn boundary.

So this guide is split into two layers:

1. Base patch: enable `wrap_stream_fn` so the plugin can observe stream deltas.
2. Optional advanced bridge: expose a verified `liveInterrupt(...)` callback from your own OpenClaw fork if you want true mid-stream checkpoint/recovery.

If you are debugging or refreshing the overlay script, apply the base patch below to your OpenClaw source code in WSL.

## 1. Modify `src/plugins/types.ts`

**Location:** `\\wsl.localhost\Ubuntu-24.04\home\pongs\openclaw\src\plugins\types.ts`

**A. Add to `PluginHookName` (Around Line 327)**:
```typescript
  | "gateway_start"
  | "gateway_stop"
  | "wrap_stream_fn";  // <-- Add this line
```

**B. Define the Event and Result Types (Around Line 370, below `PluginHookBeforeAgentStartResult`)**:
```typescript
// wrap_stream_fn hook
export type PluginHookWrapStreamFnEvent = {
  streamFn: any; // The original stream generator
};

export type PluginHookWrapStreamFnResult = {
  streamFn?: any; // The hijacked/wrapped stream generator
};
```

**C. Optional advanced bridge: extend `PluginHookAgentContext`**

If your fork supports true interrupt-and-resume, add an optional callback to the agent hook context:

```typescript
liveInterrupt?: (
  text: string,
  meta?: { reason?: string },
) => Promise<boolean> | boolean;
```

This callback should return `true` only if your fork really interrupted the active stream and will resume using the injected instruction.

**D. Add to `PluginHookHandlerMap` (Around Line 758, before the end of the type)**:
```typescript
  gateway_stop: (
    event: PluginHookGatewayStopEvent,
    ctx: PluginHookGatewayContext,
  ) => Promise<void> | void;
  // <-- Add the block below -->
  wrap_stream_fn: (
    event: PluginHookWrapStreamFnEvent,
    ctx: PluginHookAgentContext,
  ) => Promise<PluginHookWrapStreamFnResult | void> | PluginHookWrapStreamFnResult | void;
};
```

---

## 2. Modify `src/plugins/hooks.ts`

**Location:** `\\wsl.localhost\Ubuntu-24.04\home\pongs\openclaw\src\plugins\hooks.ts`

**A. Update Imports (Line 52)**:
Add standard exports from `./types.js` to the import list and the re-export list.
```typescript
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
  PluginHookWrapStreamFnEvent,    // <-- Add this
  PluginHookWrapStreamFnResult,   // <-- Add this
} from "./types.js";
```

**B. Update Re-exports (Line 96)**:
```typescript
  PluginHookGatewayContext,
  PluginHookGatewayStartEvent,
  PluginHookGatewayStopEvent,
  PluginHookWrapStreamFnEvent,    // <-- Add this
  PluginHookWrapStreamFnResult,   // <-- Add this
};
```

**C. Implement `runWrapStreamFn` inside `createHookRunner` (Around Line 322, inside `createHookRunner(registry, options)` after `runBeforeAgentStart`)**:
```typescript
  /**
   * Run wrap_stream_fn hook.
   * Allows plugins to intercept and hijack the raw text delta stream.
   */
  async function runWrapStreamFn(
    event: PluginHookWrapStreamFnEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookWrapStreamFnResult | undefined> {
    return runModifyingHook<"wrap_stream_fn", PluginHookWrapStreamFnResult>(
      "wrap_stream_fn",
      event,
      ctx,
      (acc, next) => ({
        streamFn: next.streamFn ?? acc?.streamFn,
      }),
    );
  }
```

**D. Return it from `createHookRunner` (Around Line 745, in the returned object)**:
```typescript
  return {
    // Agent hooks
    runBeforeModelResolve,
    runBeforePromptBuild,
    runBeforeAgentStart,
    runWrapStreamFn,  // <-- Add this line
    runLlmInput,
// ...
```

---

## 3. Modify `src/agents/pi-embedded-runner/run/attempt.ts`

**File:** `\\wsl.localhost\Ubuntu-24.04\home\pongs\openclaw\src\agents\pi-embedded-runner\run\attempt.ts`

**Location:** Around line 1070. Look for the block where `anthropicPayloadLogger.wrapStreamFn` is applied (right before `try { const prior = await sanitizeSessionHistory(...) }`).

**Add the following code block right after the `anthropicPayloadLogger` block:**

```typescript
      if (anthropicPayloadLogger) {
        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(
          activeSession.agent.streamFn,
        );
      }

      // ==========================================
      // [START] MEMORY V7 SAR PATCH
      // ==========================================
      if (hookRunner?.hasHooks("wrap_stream_fn")) {
        try {
          const wrapEvent = { streamFn: activeSession.agent.streamFn };
          const hookCtx = {
            agentId: sessionAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            workspaceDir: params.workspaceDir,
            messageProvider: params.messageProvider ?? undefined,
            // Optional advanced bridge.
            // Only expose this if your fork has a verified interrupt-and-resume path.
            // Do NOT fake this by yielding custom stream events or by calling
            // activeSession.steer(...) alone.
            liveInterrupt: undefined,
          };

          const wrapResult = await hookRunner.runWrapStreamFn(wrapEvent, hookCtx);
          
          if (wrapResult?.streamFn) {
             activeSession.agent.streamFn = wrapResult.streamFn;
          }
        } catch (e) {
           log.warn(`Memory V7 wrap_stream_fn hook failed: ${String(e)}`);
        }
      }
      // ==========================================
      // [END] MEMORY V7 SAR PATCH
      // ==========================================

      try {
        const prior = await sanitizeSessionHistory({
// ...
```

## 4. Rebuild OpenClaw

After saving these three files (`types.ts`, `hooks.ts`, `attempt.ts`), remember to rebuild your OpenClaw instance in WSL so the new TypeScript typings and interfaces compile:

```bash
cd /home/pongs/openclaw
npm run build # (Or whatever pnpm/build command you use)
openclaw gateway restart
```

## 5. What This Enables

After the base patch:

- The plugin can observe `text_delta` / `thinking_delta` in real time.
- SAR pre-activation and stream-time analysis work.
- The plugin can compute drift signals for long outputs.

What it does **not** automatically enable:

- Fake stream events such as `type: "steer"` are still invalid.
- True mid-stream checkpoint steering still requires your fork to implement `liveInterrupt(...)`.

`memory-enhanced` will automatically detect `ctx.liveInterrupt(...)` if your fork provides it. If absent, it will disable live interrupt behavior instead of pretending it works.

## 6. OpenClaw 3.1 Landing Points

If you are patching the older OpenClaw 3.1 codebase, the relevant control paths already exist, but they are split across several files:

- `src/agents/pi-embedded-runner/runs.ts`
  - `queueEmbeddedPiMessage(sessionId, text)`
  - `abortEmbeddedPiRun(sessionId)`
  - This is the public embedded-run registry, but it is **not** enough by itself for plugin-driven live stream interruption.

- `src/auto-reply/reply/get-reply-run.ts`
  - `messages.queue.mode = "interrupt"` clears the command lane and aborts the active embedded run.
  - This proves OpenClaw already has an "abort current run, prefer newest work" control path.

- `src/auto-reply/reply/commands-session-abort.ts`
  - `/stop` composes queue cleanup plus `abortEmbeddedPiRun(...)` plus persisted cutoff metadata.

- `src/auto-reply/reply/abort-cutoff.ts`
  - Stores `abortCutoffMessageSid` / `abortCutoffTimestamp`.

- `src/auto-reply/reply/get-reply-inline-actions.ts`
  - Consumes that cutoff and skips stale queued messages at or before the cutoff boundary.

These pieces are real and useful, but they do **not** automatically give plugins a clean `liveInterrupt(...)` API.

### 3.1 Recommendation

For OpenClaw 3.1, the best place to add a plugin-facing `liveInterrupt(...)` bridge is:

- primary landing point: `src/agents/pi-embedded-runner/run/attempt.ts`
- supporting public registry (optional): `src/agents/pi-embedded-runner/runs.ts`

Why `attempt.ts` is the real landing point:

- The plugin hook runs inside the active attempt and already has access to `activeSession`.
- `queueEmbeddedPiMessage(...)` only queues work onto the current session.
- `abortEmbeddedPiRun(...)` only stops the current run.
- `activeSession.steer(...) + abort()` still does **not** automatically resume a new turn.

In OpenClaw 3.1, true plugin-driven live interruption therefore needs a small attempt-local control loop:

1. Plugin calls `ctx.liveInterrupt(text, meta?)`.
2. Core stores a pending live-interrupt request for the current attempt.
3. Core queues the steer text onto `activeSession`.
4. Core aborts the current run.
5. Before attempt finalization, core detects the pending live interrupt and immediately resumes the session using the queued steer instead of letting the attempt end.

### Important Constraint in 3.1

Do **not** implement plugin live interrupt by:

- yielding fake stream events like `{ type: "steer" }`
- calling `queueEmbeddedPiMessage(...)` alone
- calling `activeSession.steer(...)` alone
- calling `activeSession.steer(...) + abort()` without a resume branch

Those paths either operate only at queue boundaries or abort the run without restarting it.

### Minimal 3.1 Shape

For a 3.1 fork, the bridge should look roughly like this.

This section is only the architecture sketch. The exact 3.1-safe patch is in Section 7 below.

```typescript
type PendingLiveInterrupt =
  | { text: string; reason?: string }
  | null;
```

Inside `attempt.ts`, maintain one pending interrupt for the active attempt and expose:

```typescript
liveInterrupt: async (text, meta) => {
  pendingLiveInterrupt = { text, reason: meta?.reason };
  await activeSession.steer(text);
  void activeSession.abort();
  return true;
}
```

Then replace the one-shot prompt execution with an attempt-local loop that:

- runs the initial prompt once
- if the run was aborted because of a pending live interrupt, resumes immediately
- only exits the attempt when no live interrupt is pending

The key idea is:

- `runs.ts` exposes global "abort / queue" primitives
- `abort-cutoff.ts` and `/stop` already solve stale queued inbound work
- but **plugin live interruption must be completed inside `attempt.ts`**, because only that layer can abort and then resume the same streaming attempt cleanly

## 7. Minimal OpenClaw 3.1 `liveInterrupt(...)` Bridge

If you are staying on OpenClaw 3.1, this is the smallest patch that turns the existing `wrap_stream_fn` hook into a real interrupt-and-resume bridge.

This section assumes you already completed:

- Section 1 (`PluginHookAgentContext.liveInterrupt`)
- Section 2 (`runWrapStreamFn`)
- Section 3 (base `wrap_stream_fn` wiring in `attempt.ts`)

### What the patch must do

When the plugin requests a live interrupt:

1. Queue the checkpoint/recall text onto the active session via `activeSession.steer(...)`.
2. Abort only the **current streaming pass**.
3. Resume the **same attempt** immediately with `activeSession.agent.continue()`.
4. Leave the outer attempt alive so `agent_end`, usage accounting, and final cleanup still behave normally.

### Important: do **not** reuse `abortRun()`

In OpenClaw 3.1, `abortRun()` sets the whole attempt to `aborted = true` and aborts the shared `runAbortController`. That is correct for `/stop`, external timeout, and queue interrupt mode. It is the wrong primitive for plugin checkpoint steering.

For plugin-driven `liveInterrupt(...)`, you want to abort the active stream without killing the parent attempt.

### A. Add attempt-local interrupt state

In `src/agents/pi-embedded-runner/run/attempt.ts`, add the following locals **right before** the existing `if (hookRunner?.hasHooks("wrap_stream_fn")) {` block:

```typescript
      type PendingLiveInterrupt = { text: string; reason?: string } | null;

      let pendingLiveInterrupt: PendingLiveInterrupt = null;
      let liveInterruptResumeCount = 0;
      const maxLiveInterruptResumes = 2;
      let requestLiveInterrupt:
        | ((text: string, meta?: { reason?: string }) => Promise<boolean>)
        | undefined;
```

This solves the ordering problem in 3.1: the stream wrapper is registered before `abortRun()` and `abortable(...)` are defined, so the hook context needs a function reference that can be filled in later.

### B. Replace `liveInterrupt: undefined` with a delegating callback

In the `hookCtx` object from Section 3, replace the placeholder with:

```typescript
            liveInterrupt: async (text, meta) => {
              if (!requestLiveInterrupt) {
                return false;
              }
              return requestLiveInterrupt(text, meta);
            },
```

This keeps the base patch safe on forks that have not finished the advanced bridge yet.

### C. Define the real interrupt callback after `abortRun()` exists

In `attempt.ts`, add this block **right after** the existing `abortable(...)` helper:

```typescript
      requestLiveInterrupt = async (text, meta) => {
        const payload = text.trim();
        if (!payload || pendingLiveInterrupt) {
          return false;
        }
        if (timedOut || params.abortSignal?.aborted) {
          return false;
        }
        if (!activeSession.isStreaming || activeSession.isCompacting) {
          return false;
        }

        pendingLiveInterrupt = {
          text: payload,
          reason: meta?.reason,
        };

        await activeSession.steer(payload);

        // Intentionally do NOT call abortRun().
        // We only want to stop the current streaming pass, not mark the
        // whole attempt as aborted.
        void activeSession.abort();

        return true;
      };
```

Why this shape is correct on 3.1:

- `activeSession.steer(...)` is a real queueing API.
- `activeSession.abort()` aborts the current agent operation and waits for idle.
- `activeSession.agent.continue()` can then consume queued steering messages on the next pass.
- The shared attempt state stays alive, so usage, compaction wait, `llm_output`, and `agent_end` still run once at the real end of the attempt.

### D. Replace the one-shot prompt call with a resume loop

Inside the big `try { ... }` block where `imageResult.images.length > 0` currently decides between:

- `await abortable(activeSession.prompt(...))`
- `await abortable(activeSession.prompt(effectivePrompt))`

replace that one-shot call with this loop:

```typescript
          let shouldResumeFromLiveInterrupt = false;

          while (true) {
            try {
              if (shouldResumeFromLiveInterrupt) {
                await abortable(activeSession.agent.continue());
              } else if (imageResult.images.length > 0) {
                await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
              } else {
                await abortable(activeSession.prompt(effectivePrompt));
              }

              break;
            } catch (err) {
              const resumeFromLiveInterrupt =
                pendingLiveInterrupt !== null && isRunnerAbortError(err);

              if (resumeFromLiveInterrupt && liveInterruptResumeCount < maxLiveInterruptResumes) {
                const interrupt = pendingLiveInterrupt;
                pendingLiveInterrupt = null;
                liveInterruptResumeCount += 1;
                shouldResumeFromLiveInterrupt = true;

                log.debug(
                  `live interrupt resume: runId=${params.runId} sessionId=${params.sessionId} ` +
                    `reason=${interrupt?.reason ?? "unknown"} count=${liveInterruptResumeCount}`,
                );

                continue;
              }

              promptError = err;
              promptErrorSource = "prompt";
              break;
            }
          }
```

This is the crucial 3.1 piece. Without this loop, `activeSession.steer(...) + activeSession.abort()` only stops the current generation. It does **not** resume the same attempt automatically.

### E. Why `activeSession.agent.continue()` is the correct resume primitive

On your 3.1 dependency stack:

- `AgentSession.steer(...)` in `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`
  - queues the text into `_steeringMessages`
  - forwards it to `this.agent.steer(...)`
- `Agent.continue()` in `node_modules/@mariozechner/pi-agent-core/dist/agent.js`
  - dequeues queued steering messages when the last message is an assistant message
  - resumes `_runLoop(...)` with `skipInitialSteeringPoll: true`

So the actual 3.1 resume chain is:

`wrap_stream_fn` -> `ctx.liveInterrupt(...)` -> `activeSession.steer(...)` -> `activeSession.abort()` -> `activeSession.agent.continue()`

### F. Expected behavior after patching

After this bridge is installed:

- long outputs can trigger a checkpoint without faking any custom stream event
- the current generation aborts once
- the same attempt resumes with the injected checkpoint text
- final `agent_end` still runs once for the completed answer

What should **not** happen anymore:

- fake `type: "steer"` events
- whole-attempt `aborted=true` just because a checkpoint fired
- output watchdogs that log drift but never actually alter the generation

### G. Quick verification on 3.1

Use a small watchdog threshold for the first test:

```jsonc
"outputCheckpointChars": 500,
"outputCheckpointCooldownChars": 300,
"outputCheckpointMaxInterrupts": 1,
"outputCheckpointDriftThreshold": 0.55
```

Then ask the agent for a deliberately long answer. A successful 3.1 bridge should show all of the following:

1. The reply starts normally.
2. The watchdog triggers once.
3. A `live interrupt resume` debug line appears in OpenClaw logs.
4. The answer continues without emitting any invalid custom stream event.
5. The final attempt is **not** marked as globally aborted unless the user or timeout actually aborted it.

## 8. Update-Safe Rules for Source Checkouts

These rules are non-optional if you want OpenClaw source updates to stop breaking your memory bridge:

1. Do not keep the 3 managed patch targets dirty forever:
   - `src/plugins/types.ts`
   - `src/plugins/hooks.ts`
   - `src/agents/pi-embedded-runner/run/attempt.ts`
2. Do not run `openclaw update` directly on a hand-patched checkout. Use `pnpm openclaw:overlay:update -- --openclaw-dir /home/pongs/openclaw`.
3. If `memory-enhanced` lives inside `~/openclaw/extensions/memory-enhanced`, add that path to `.git/info/exclude` or let the overlay script manage it for you.
4. The overlay only manages the memory bridge files. Extra dirty files like `pnpm-lock.yaml` will still block OpenClaw's update runner and must be handled separately.
