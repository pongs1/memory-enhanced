# OpenClaw Core Patch Guide for Memory V8 Stream Hooks

To let the memory system inspect the raw LLM stream in real time, OpenClaw needs a native `wrap_stream_fn` hook.

Since OpenClaw uses a strict Typescript HookRunner (`src/plugins/hooks.ts`), this must be added structurally in core.

Important limits before you patch:

- `wrap_stream_fn` by itself is a **read-stream hook**, not a magic interrupt channel.
- `@mariozechner/pi-ai` does **not** accept custom stream events such as `type: "steer"`.
- `activeSession.steer(...)` is a real queueing API, but it is **not** a true mid-token injection primitive. By default it is consumed after the current tool/turn boundary.

So this guide is split into two layers:

1. Base patch: enable `wrap_stream_fn` so the plugin can observe stream deltas.
2. Optional advanced bridge: expose a verified `liveInterrupt(...)` callback from your own OpenClaw fork if you want true mid-stream checkpoint/recovery.

Please apply the base patch below to your OpenClaw source code in WSL.

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

For a 3.1 fork, the bridge should look roughly like this:

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
  abortRun(false);
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
