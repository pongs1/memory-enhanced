# OpenClaw Core Patch Guide for Memory V7 (SAR Architecture)

To enable the Subconscious Associative Recall (SAR) engine to intercept and read the LLM stream in real-time, we must add a small hook into the OpenClaw core. This patch instructs the `pi-embedded-runner` to expose the generative stream to our plugin.

Please apply the following changes to your OpenClaw source code in WSL.

## 1. Modify `src/agents/pi-embedded-runner/run/attempt.ts`

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
      // Expose the raw stream function to plugins
      // ==========================================
      if (hookRunner) {
        try {
          // Create an event object that plugins can mutate
          const wrapEvent = { 
            streamFn: activeSession.agent.streamFn 
          };
          
          const hookCtx = {
            agentId: hookAgentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            workspaceDir: params.workspaceDir,
            messageProvider: params.messageProvider ?? undefined,
          };

          // Use the internal event emitter or hook interface
          // Note: Since 'wrap_stream_fn' is custom, we cast to any or use a raw emit if available.
          // In OpenClaw's Plugin API, `hookRunner.pluginApi.emit` or equivalent triggers all `api.on` listeners.
          const anyRunner = hookRunner as any;
          if (typeof anyRunner.emit === "function") {
             await anyRunner.emit("wrap_stream_fn", wrapEvent, hookCtx);
          } else if (anyRunner.plugins) {
             // Iterate through active plugins manually if emit isn't exposed
             for (const plugin of anyRunner.plugins) {
                 if (typeof plugin.api?.emit === "function") {
                     await plugin.api.emit("wrap_stream_fn", wrapEvent, hookCtx);
                 }
             }
          }
          
          // Re-assign the streamFn if a plugin wrapped it
          if (typeof wrapEvent.streamFn === "function") {
             activeSession.agent.streamFn = wrapEvent.streamFn;
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
          messages: activeSession.messages,
// ...
```

## 2. Note on the `llm_input` Hook (Pre-Excitation)

You do **not** need to modify OpenClaw to support the `llm_input` hook! This hook is already built natively into OpenClaw and runs right before the LLM prompt is executed (around line 1390 in `attempt.ts`). Our `memory-enhanced` plugin will automatically listen to it to fetch the user's stimulus prompt and solve the Cold-Start Amnesia problem.

## 3. Rebuild OpenClaw

After saving `attempt.ts`, remember to rebuild/restart your OpenClaw instance in WSL so the changes take effect:

```bash
cd /home/pongs/openclaw
npm run build # (Or whatever pnpm/build command you use)
```

Once this is patched, your local `memory-enhanced` plugin will instantly gain root-level access to the Token generation stream!
