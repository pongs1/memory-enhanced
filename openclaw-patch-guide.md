# OpenClaw Core Patch Guide for Memory V7 (SAR Architecture)

To enable the Subconscious Associative Recall (SAR) engine to intercept and read the LLM stream in real-time, we must natively add the `wrap_stream_fn` hook into the OpenClaw plugin architecture.

Since OpenClaw uses a strict Typescript HookRunner (`src/plugins/hooks.ts`), we cannot randomly emit events. We must structurally patch 3 files in your WSL OpenClaw core.

Please apply the following changes to your OpenClaw source code in WSL.

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

**C. Add to `PluginHookHandlerMap` (Around Line 758, before the end of the type)**:
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
            agentId: hookAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            workspaceDir: params.workspaceDir,
            messageProvider: params.messageProvider ?? undefined,
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

Once this is patched, your local `memory-enhanced` plugin will instantly gain root-level access to the Token generation stream!
