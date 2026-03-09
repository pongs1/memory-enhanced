#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..");
const stateRoot = path.join(repoDir, ".openclaw-overlay");
const overlayId = "memory-enhanced-openclaw-3.1";

const managedFiles = [
  "src/plugins/types.ts",
  "src/plugins/hooks.ts",
  "src/agents/pi-embedded-runner/run/attempt.ts",
];

function usage() {
  console.log(`Usage:
  node scripts/openclaw-overlay.mjs check --openclaw-dir /home/you/openclaw
  node scripts/openclaw-overlay.mjs adopt --openclaw-dir /home/you/openclaw
  node scripts/openclaw-overlay.mjs apply --openclaw-dir /home/you/openclaw
  node scripts/openclaw-overlay.mjs unapply --openclaw-dir /home/you/openclaw
  node scripts/openclaw-overlay.mjs update --openclaw-dir /home/you/openclaw

Commands:
  check    Inspect update blockers and patch state.
  adopt    Register an already hand-patched checkout with overlay backups and exclude rules.
  apply    Apply the memory-enhanced OpenClaw 3.1 overlay patch.
  unapply  Restore the original core files from local backups.
  update   Unapply -> openclaw update --no-restart -> reapply -> build -> restart.

Options:
  --openclaw-dir <path>   Target OpenClaw git checkout. Defaults to $OPENCLAW_GIT_DIR or ~/openclaw
  --plugin-dir <path>     memory-enhanced source path. Defaults to this repo directory.
  --skip-exclude          Do not add in-repo plugin paths to .git/info/exclude.
  --dry-run               Print planned actions without writing files.
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { help: true };
  }

  const options = {
    command,
    dryRun: false,
    skipExclude: false,
    openclawDir: process.env.OPENCLAW_GIT_DIR
      ? path.resolve(process.env.OPENCLAW_GIT_DIR)
      : path.join(os.homedir(), "openclaw"),
    pluginDir: repoDir,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--skip-exclude") {
      options.skipExclude = true;
      continue;
    }
    if (token === "--openclaw-dir") {
      options.openclawDir = path.resolve(rest[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (token === "--plugin-dir") {
      options.pluginDir = path.resolve(rest[i + 1] ?? "");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return options;
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function restoreEol(text, original) {
  return original.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fingerprintFor(dir) {
  return createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 12);
}

function statePaths(openclawDir) {
  const fingerprint = fingerprintFor(openclawDir);
  const root = path.join(stateRoot, fingerprint);
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    backupDir: path.join(root, "backup"),
  };
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function run(argv, cwd, extraEnv = {}, echo = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      stdio: "pipe",
      env: { ...process.env, ...extraEnv },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (echo) {
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (echo) {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runQuiet(argv, cwd) {
  const result = await run(argv, cwd, {}, false);
  return result;
}

async function resolveGitRoot(openclawDir) {
  const result = await runQuiet(["git", "-C", openclawDir, "rev-parse", "--show-toplevel"], openclawDir);
  if (result.code !== 0) {
    throw new Error(`Not a git checkout: ${openclawDir}`);
  }
  return result.stdout.trim();
}

async function readFile(target) {
  return await fs.readFile(target, "utf-8");
}

async function writeFile(target, content, dryRun) {
  if (dryRun) {
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf-8");
}

async function ensureManifest(openclawDir, pluginDir, dryRun) {
  const state = statePaths(openclawDir);
  const payload = {
    overlayId,
    openclawDir: path.resolve(openclawDir),
    pluginDir: path.resolve(pluginDir),
    updatedAt: new Date().toISOString(),
    managedFiles,
  };
  await writeFile(state.manifest, JSON.stringify(payload, null, 2) + "\n", dryRun);
}

async function readBackup(openclawDir, relPath) {
  const backupPath = path.join(statePaths(openclawDir).backupDir, relPath);
  if (!(await exists(backupPath))) {
    return null;
  }
  return await readFile(backupPath);
}

async function ensureBackup(openclawDir, gitRoot, relPath, dryRun) {
  const backupPath = path.join(statePaths(openclawDir).backupDir, relPath);
  if (await exists(backupPath)) {
    return;
  }

  const gitShow = await runQuiet(["git", "-C", gitRoot, "show", `HEAD:${relPath}`], gitRoot);
  let content;
  if (gitShow.code === 0) {
    content = gitShow.stdout;
  } else {
    content = await readFile(path.join(openclawDir, relPath));
  }

  await writeFile(backupPath, normalize(content), dryRun);
}

function replaceRequired(content, search, replacement, fileLabel) {
  if (!content.includes(search)) {
    throw new Error(`Patch anchor not found in ${fileLabel}`);
  }
  return content.replace(search, replacement);
}

function patchTypesTs(source) {
  let content = normalize(source);

  if (!content.includes('| "wrap_stream_fn";')) {
    content = replaceRequired(
      content,
      '  | "gateway_stop";\n',
      '  | "gateway_stop"\n  // [memory-enhanced overlay] wrap_stream_fn hook\n  | "wrap_stream_fn";\n',
      "src/plugins/types.ts",
    );
  }

  if (!content.includes("liveInterrupt?:")) {
    content = replaceRequired(
      content,
      "  messageProvider?: string;\n};",
      `  messageProvider?: string;\n  // [memory-enhanced overlay:start live_interrupt]\n  liveInterrupt?: (\n    text: string,\n    meta?: { reason?: string },\n  ) => Promise<boolean> | boolean;\n  // [memory-enhanced overlay:end live_interrupt]\n};`,
      "src/plugins/types.ts",
    );
  }

  if (!content.includes("PluginHookWrapStreamFnEvent")) {
    content = replaceRequired(
      content,
      "export type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult &\n  PluginHookBeforeModelResolveResult;\n",
      `export type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult &\n  PluginHookBeforeModelResolveResult;\n\n// [memory-enhanced overlay:start wrap_stream_fn types]\nexport type PluginHookWrapStreamFnEvent = {\n  streamFn: any;\n};\n\nexport type PluginHookWrapStreamFnResult = {\n  streamFn?: any;\n};\n// [memory-enhanced overlay:end wrap_stream_fn types]\n`,
      "src/plugins/types.ts",
    );
  }

  if (!content.includes("wrap_stream_fn: (")) {
    content = replaceRequired(
      content,
      `  gateway_stop: (\n    event: PluginHookGatewayStopEvent,\n    ctx: PluginHookGatewayContext,\n  ) => Promise<void> | void;\n};`,
      `  gateway_stop: (\n    event: PluginHookGatewayStopEvent,\n    ctx: PluginHookGatewayContext,\n  ) => Promise<void> | void;\n  // [memory-enhanced overlay:start wrap_stream_fn handler]\n  wrap_stream_fn: (\n    event: PluginHookWrapStreamFnEvent,\n    ctx: PluginHookAgentContext,\n  ) => Promise<PluginHookWrapStreamFnResult | void> | PluginHookWrapStreamFnResult | void;\n  // [memory-enhanced overlay:end wrap_stream_fn handler]\n};`,
      "src/plugins/types.ts",
    );
  }

  return content;
}

function patchHooksTs(source) {
  let content = normalize(source);

  if (!content.includes("PluginHookWrapStreamFnEvent")) {
    content = replaceRequired(
      content,
      `  PluginHookBeforeMessageWriteEvent,\n  PluginHookBeforeMessageWriteResult,\n} from "./types.js";`,
      `  PluginHookBeforeMessageWriteEvent,\n  PluginHookBeforeMessageWriteResult,\n  PluginHookWrapStreamFnEvent,\n  PluginHookWrapStreamFnResult,\n} from "./types.js";`,
      "src/plugins/hooks.ts",
    );
  }

  if (!content.includes("PluginHookWrapStreamFnResult,")) {
    content = replaceRequired(
      content,
      `  PluginHookGatewayContext,\n  PluginHookGatewayStartEvent,\n  PluginHookGatewayStopEvent,\n};`,
      `  PluginHookGatewayContext,\n  PluginHookGatewayStartEvent,\n  PluginHookGatewayStopEvent,\n  PluginHookWrapStreamFnEvent,\n  PluginHookWrapStreamFnResult,\n};`,
      "src/plugins/hooks.ts",
    );
  }

  if (!content.includes("async function runWrapStreamFn(")) {
    const anchor = `  async function runBeforeAgentStart(\n    event: PluginHookBeforeAgentStartEvent,\n    ctx: PluginHookAgentContext,\n  ): Promise<PluginHookBeforeAgentStartResult | undefined> {\n    return runModifyingHook<"before_agent_start", PluginHookBeforeAgentStartResult>(\n      "before_agent_start",\n      event,\n      ctx,\n      (acc, next) => ({\n        ...mergeBeforePromptBuild(acc, next),\n        ...mergeBeforeModelResolve(acc, next),\n      }),\n    );\n  }\n`;
    const insertion = `${anchor}\n  // [memory-enhanced overlay:start runWrapStreamFn]\n  async function runWrapStreamFn(\n    event: PluginHookWrapStreamFnEvent,\n    ctx: PluginHookAgentContext,\n  ): Promise<PluginHookWrapStreamFnResult | undefined> {\n    return runModifyingHook<"wrap_stream_fn", PluginHookWrapStreamFnResult>(\n      "wrap_stream_fn",\n      event,\n      ctx,\n      (acc, next) => ({\n        streamFn: next.streamFn ?? acc?.streamFn,\n      }),\n    );\n  }\n  // [memory-enhanced overlay:end runWrapStreamFn]\n`;
    content = replaceRequired(content, anchor, insertion, "src/plugins/hooks.ts");
  }

  if (!content.includes("    runWrapStreamFn,")) {
    content = replaceRequired(
      content,
      "    runBeforeAgentStart,\n",
      "    runBeforeAgentStart,\n    runWrapStreamFn,\n",
      "src/plugins/hooks.ts",
    );
  }

  return content;
}

function patchAttemptTs(source) {
  let content = normalize(source);

  if (
    content.includes("[START] MEMORY V7 SAR PATCH") &&
    !content.includes("[memory-enhanced overlay:start wrap_stream_fn bridge]")
  ) {
    throw new Error(
      "Legacy manual wrap_stream_fn patch detected in attempt.ts. " +
        "Run the overlay update flow (or restore clean core files) before applying the managed overlay.",
    );
  }

  if (!content.includes("[memory-enhanced overlay:start wrap_stream_fn bridge]")) {
    const anchor = `      if (anthropicPayloadLogger) {\n        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(\n          activeSession.agent.streamFn,\n        );\n      }\n\n`;
    const addition = `      if (anthropicPayloadLogger) {\n        activeSession.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(\n          activeSession.agent.streamFn,\n        );\n      }\n\n      // [memory-enhanced overlay:start wrap_stream_fn bridge]\n      type PendingLiveInterrupt = { text: string; reason?: string } | null;\n\n      let pendingLiveInterrupt: PendingLiveInterrupt = null;\n      let liveInterruptResumeCount = 0;\n      const maxLiveInterruptResumes = 2;\n      let requestLiveInterrupt:\n        | ((text: string, meta?: { reason?: string }) => Promise<boolean>)\n        | undefined;\n\n      if (hookRunner?.hasHooks("wrap_stream_fn")) {\n        try {\n          const wrapEvent = { streamFn: activeSession.agent.streamFn };\n          const hookCtx = {\n            agentId: sessionAgentId,\n            sessionKey: params.sessionKey,\n            sessionId: params.sessionId,\n            workspaceDir: params.workspaceDir,\n            messageProvider: params.messageProvider ?? undefined,\n            liveInterrupt: async (text: string, meta?: { reason?: string }) => {\n              if (!requestLiveInterrupt) {\n                return false;\n              }\n              return requestLiveInterrupt(text, meta);\n            },\n          };\n\n          const wrapResult = await hookRunner.runWrapStreamFn(wrapEvent, hookCtx);\n\n          if (wrapResult?.streamFn) {\n            activeSession.agent.streamFn = wrapResult.streamFn;\n          }\n        } catch (e) {\n          log.warn(\`Memory V8 wrap_stream_fn hook failed: \${String(e)}\`);\n        }\n      }\n      // [memory-enhanced overlay:end wrap_stream_fn bridge]\n\n`;
    content = replaceRequired(content, anchor, addition, "src/agents/pi-embedded-runner/run/attempt.ts");
  }

  if (!content.includes("[memory-enhanced overlay:start liveInterrupt callback]")) {
    const anchor = `      const abortable = <T>(promise: Promise<T>): Promise<T> => {\n        const signal = runAbortController.signal;\n        if (signal.aborted) {\n          return Promise.reject(makeAbortError(signal));\n        }\n        return new Promise<T>((resolve, reject) => {\n          const onAbort = () => {\n            signal.removeEventListener("abort", onAbort);\n            reject(makeAbortError(signal));\n          };\n          signal.addEventListener("abort", onAbort, { once: true });\n          promise.then(\n            (value) => {\n              signal.removeEventListener("abort", onAbort);\n              resolve(value);\n            },\n            (err) => {\n              signal.removeEventListener("abort", onAbort);\n              reject(err);\n            },\n          );\n        });\n      };\n\n`;
    const addition = `${anchor}      // [memory-enhanced overlay:start liveInterrupt callback]\n      requestLiveInterrupt = async (text: string, meta?: { reason?: string }) => {\n        const payload = text.trim();\n        if (!payload || pendingLiveInterrupt) {\n          return false;\n        }\n        if (timedOut || params.abortSignal?.aborted) {\n          return false;\n        }\n        if (!activeSession.isStreaming || activeSession.isCompacting) {\n          return false;\n        }\n\n        pendingLiveInterrupt = {\n          text: payload,\n          reason: meta?.reason,\n        };\n\n        await activeSession.steer(payload);\n        void activeSession.abort();\n        return true;\n      };\n      // [memory-enhanced overlay:end liveInterrupt callback]\n\n`;
    content = replaceRequired(content, anchor, addition, "src/agents/pi-embedded-runner/run/attempt.ts");
  }

  if (!content.includes("[memory-enhanced overlay:start liveInterrupt resume loop]")) {
    const anchor = `          // Only pass images option if there are actually images to pass\n          // This avoids potential issues with models that don't expect the images parameter\n          if (imageResult.images.length > 0) {\n            await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));\n          } else {\n            await abortable(activeSession.prompt(effectivePrompt));\n          }\n`;
    const replacement = `          // Only pass images option if there are actually images to pass\n          // This avoids potential issues with models that don't expect the images parameter\n          // [memory-enhanced overlay:start liveInterrupt resume loop]\n          let shouldResumeFromLiveInterrupt = false;\n\n          while (true) {\n            try {\n              if (shouldResumeFromLiveInterrupt) {\n                await abortable(activeSession.agent.continue());\n              } else if (imageResult.images.length > 0) {\n                await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));\n              } else {\n                await abortable(activeSession.prompt(effectivePrompt));\n              }\n\n              break;\n            } catch (err) {\n              const resumeFromLiveInterrupt =\n                pendingLiveInterrupt !== null && isRunnerAbortError(err);\n\n              if (resumeFromLiveInterrupt && liveInterruptResumeCount < maxLiveInterruptResumes) {\n                const interrupt = pendingLiveInterrupt;\n                pendingLiveInterrupt = null;\n                liveInterruptResumeCount += 1;\n                shouldResumeFromLiveInterrupt = true;\n\n                log.debug(\n                  \`live interrupt resume: runId=\${params.runId} sessionId=\${params.sessionId} \` +\n                    \`reason=\${interrupt?.reason ?? "unknown"} count=\${liveInterruptResumeCount}\`,\n                );\n\n                continue;\n              }\n\n              promptError = err;\n              promptErrorSource = "prompt";\n              break;\n            }\n          }\n          // [memory-enhanced overlay:end liveInterrupt resume loop]\n`;
    content = replaceRequired(content, anchor, replacement, "src/agents/pi-embedded-runner/run/attempt.ts");
  }

  return content;
}

function patchContent(relPath, source) {
  if (relPath === "src/plugins/types.ts") {
    return patchTypesTs(source);
  }
  if (relPath === "src/plugins/hooks.ts") {
    return patchHooksTs(source);
  }
  if (relPath === "src/agents/pi-embedded-runner/run/attempt.ts") {
    return patchAttemptTs(source);
  }
  throw new Error(`Unhandled patch target: ${relPath}`);
}

async function ensureExclude(openclawDir, pluginDir, dryRun) {
  const gitRoot = await resolveGitRoot(openclawDir);
  if (!isInside(gitRoot, pluginDir)) {
    return { added: false, reason: "plugin-outside-git-root" };
  }

  const rel = path.relative(gitRoot, pluginDir).replace(/\\/g, "/");
  const entry = `/${rel}`;
  const excludePath = path.join(gitRoot, ".git", "info", "exclude");
  const current = (await exists(excludePath)) ? await readFile(excludePath) : "";
  const lines = normalize(current)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.includes(entry)) {
    return { added: false, reason: "already-excluded", entry };
  }

  const next = `${current.replace(/\s*$/, "")}\n# ${overlayId}\n${entry}\n`;
  await writeFile(excludePath, next, dryRun);
  return { added: true, entry };
}

async function applyOverlay({ openclawDir, pluginDir, dryRun, skipExclude }) {
  const gitRoot = await resolveGitRoot(openclawDir);

  if (!skipExclude) {
    const exclude = await ensureExclude(openclawDir, pluginDir, dryRun);
    if (exclude.added) {
      console.log(`[overlay] added .git/info/exclude entry: ${exclude.entry}`);
    }
  }

  for (const relPath of managedFiles) {
    await ensureBackup(openclawDir, gitRoot, relPath, dryRun);
    const targetPath = path.join(openclawDir, relPath);
    const original = await readFile(targetPath);
    const patched = patchContent(relPath, original);
    if (normalize(original) !== patched) {
      await writeFile(targetPath, restoreEol(patched, original), dryRun);
      console.log(`[overlay] patched ${relPath}`);
    } else {
      console.log(`[overlay] already patched ${relPath}`);
    }
  }

  await ensureManifest(openclawDir, pluginDir, dryRun);
}

async function unapplyOverlay({ openclawDir, dryRun }) {
  for (const relPath of managedFiles) {
    const backup = await readBackup(openclawDir, relPath);
    if (!backup) {
      console.log(`[overlay] no backup for ${relPath}; skipping`);
      continue;
    }
    const targetPath = path.join(openclawDir, relPath);
    const current = await readFile(targetPath);
    await writeFile(targetPath, restoreEol(backup, current), dryRun);
    console.log(`[overlay] restored ${relPath}`);
  }
}

async function readGitStatus(openclawDir) {
  const result = await runQuiet(
    ["git", "-C", openclawDir, "status", "--porcelain", "--", ":!dist/control-ui/"],
    openclawDir,
  );
  if (result.code !== 0) {
    throw new Error("Failed to inspect git status");
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

async function checkOverlay({ openclawDir, pluginDir }) {
  const gitRoot = await resolveGitRoot(openclawDir);
  const statusLines = await readGitStatus(openclawDir);
  const state = statePaths(openclawDir);
  const hasManifest = await exists(state.manifest);
  const pluginInside = isInside(gitRoot, pluginDir);
  const relPlugin = pluginInside ? path.relative(gitRoot, pluginDir).replace(/\\/g, "/") : null;

  console.log(`[overlay] openclaw dir: ${openclawDir}`);
  console.log(`[overlay] git root: ${gitRoot}`);
  console.log(`[overlay] plugin dir: ${pluginDir}`);
  console.log(`[overlay] backup state: ${hasManifest ? state.root : "missing"}`);

  if (pluginInside) {
    console.log(`[overlay] plugin is inside the OpenClaw git checkout: /${relPlugin}`);
  }

  if (statusLines.length === 0) {
    console.log("[overlay] git status: clean");
  } else {
    console.log("[overlay] git status blockers:");
    for (const line of statusLines) {
      console.log(`  ${line}`);
    }
  }

  const missingBackups = [];
  for (const relPath of managedFiles) {
    if (!(await exists(path.join(state.backupDir, relPath)))) {
      missingBackups.push(relPath);
    }
  }
  if (missingBackups.length > 0) {
    console.log("[overlay] missing backups:");
    for (const relPath of missingBackups) {
      console.log(`  ${relPath}`);
    }
  }
}

async function adoptOverlay({ openclawDir, pluginDir, dryRun, skipExclude }) {
  const gitRoot = await resolveGitRoot(openclawDir);

  if (!skipExclude) {
    const exclude = await ensureExclude(openclawDir, pluginDir, dryRun);
    if (exclude.added) {
      console.log(`[overlay] added .git/info/exclude entry: ${exclude.entry}`);
    }
  }

  for (const relPath of managedFiles) {
    await ensureBackup(openclawDir, gitRoot, relPath, dryRun);
    console.log(`[overlay] adopted backup for ${relPath}`);
  }

  await ensureManifest(openclawDir, pluginDir, dryRun);
  console.log("[overlay] adopted current checkout without rewriting managed core files");
}

function detectBuildCommand(openclawDir) {
  return exists(path.join(openclawDir, "pnpm-lock.yaml")).then((hasPnpm) =>
    hasPnpm ? ["pnpm", "build"] : ["npm", "run", "build"],
  );
}

async function updateOverlay({ openclawDir, pluginDir, dryRun, skipExclude }) {
  const gitRoot = await resolveGitRoot(openclawDir);

  for (const relPath of managedFiles) {
    await ensureBackup(openclawDir, gitRoot, relPath, dryRun);
  }
  await ensureManifest(openclawDir, pluginDir, dryRun);

  if (!skipExclude) {
    const exclude = await ensureExclude(openclawDir, pluginDir, dryRun);
    if (exclude.added) {
      console.log(`[overlay] added .git/info/exclude entry: ${exclude.entry}`);
    }
  }

  console.log("[overlay] restoring pristine core files before update");
  await unapplyOverlay({ openclawDir, dryRun });

  if (dryRun) {
    console.log("[overlay] dry-run: skipping openclaw update");
    return;
  }

  console.log("[overlay] running openclaw update --no-restart");
  const updateResult = await run(
    [process.execPath, path.join(openclawDir, "openclaw.mjs"), "update", "--no-restart"],
    openclawDir,
  );
  if (updateResult.code !== 0) {
    throw new Error("openclaw update failed");
  }

  console.log("[overlay] reapplying memory-enhanced overlay");
  await applyOverlay({ openclawDir, pluginDir, dryRun: false, skipExclude });

  console.log("[overlay] rebuilding OpenClaw after patch reapply");
  const buildCommand = await detectBuildCommand(openclawDir);
  const buildResult = await run(buildCommand, openclawDir);
  if (buildResult.code !== 0) {
    throw new Error(`${buildCommand.join(" ")} failed`);
  }

  console.log("[overlay] restarting gateway");
  const restartResult = await run(
    [process.execPath, path.join(openclawDir, "openclaw.mjs"), "gateway", "restart"],
    openclawDir,
  );
  if (restartResult.code !== 0) {
    throw new Error("openclaw gateway restart failed");
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    usage();
    return;
  }

  const { command, openclawDir, pluginDir, dryRun, skipExclude } = parsed;

  if (!openclawDir) {
    throw new Error("--openclaw-dir is required");
  }

  if (command === "check") {
    await checkOverlay({ openclawDir, pluginDir });
    return;
  }
  if (command === "adopt") {
    await adoptOverlay({ openclawDir, pluginDir, dryRun, skipExclude });
    return;
  }
  if (command === "apply") {
    await applyOverlay({ openclawDir, pluginDir, dryRun, skipExclude });
    return;
  }
  if (command === "unapply") {
    await unapplyOverlay({ openclawDir, dryRun });
    return;
  }
  if (command === "update") {
    await updateOverlay({ openclawDir, pluginDir, dryRun, skipExclude });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[overlay] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
