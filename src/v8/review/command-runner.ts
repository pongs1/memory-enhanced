import { spawn, spawnSync } from "node:child_process";

export interface CommandChainOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface CommandChainResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

export interface CommandChainAsyncResult extends CommandChainResult {}

const activeChildPids = new Set<number>();
let cleanupInstalled = false;
let cleanupRunning = false;

export function runCommandChain(
  command: string,
  options: CommandChainOptions = {},
): CommandChainResult {
  const normalizedCommand = String(command || "").trim();
  const encoding = "utf-8" as const;
  const timeout = options.timeoutMs ?? 30 * 60 * 1000;
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  const env = options.env ?? process.env;
  const cwd = options.cwd;

  if (normalizedCommand.startsWith("wsl-bash:")) {
    const bashBody = normalizedCommand.slice("wsl-bash:".length).trim();
    const injectedEnv = buildWslExportPrefix(env);
    return runWslSync(["-d", "Ubuntu-24.04", "--", "bash", "-lc", `${injectedEnv}${bashBody}`], {
      cwd,
      env,
      encoding,
      timeout,
      maxBuffer,
    });
  }

  if (process.platform === "win32") {
    const result = spawnSync(normalizedCommand, {
      shell: true,
      cwd,
      env,
      encoding,
      timeout,
      maxBuffer,
    });
    return {
      status: result.status ?? null,
      signal: result.signal ?? null,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.error ?? null,
    };
  }

  const result = spawnSync("/bin/sh", ["-lc", normalizedCommand], {
    cwd,
    env,
    encoding,
    timeout,
    maxBuffer,
  });
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ?? null,
  };
}

export async function runCommandChainAsync(
  command: string,
  options: CommandChainOptions = {},
): Promise<CommandChainAsyncResult> {
  const normalizedCommand = String(command || "").trim();
  const timeout = options.timeoutMs ?? 30 * 60 * 1000;
  const env = options.env ?? process.env;
  const cwd = options.cwd;

  if (normalizedCommand.startsWith("wsl-bash:")) {
    const bashBody = normalizedCommand.slice("wsl-bash:".length).trim();
    const injectedEnv = buildWslExportPrefix(env);
    return spawnWslAsync(["-d", "Ubuntu-24.04", "--", "bash", "-lc", `${injectedEnv}${bashBody}`], {
      cwd,
      env,
      timeout,
    });
  }

  if (process.platform === "win32") {
    return spawnAsync(normalizedCommand, [], {
      cwd,
      env,
      timeout,
      shell: true,
    });
  }

  return spawnAsync("/bin/sh", ["-lc", normalizedCommand], {
    cwd,
    env,
    timeout,
  });
}

function buildWslExportPrefix(env: NodeJS.ProcessEnv): string {
  const keys = Object.keys(env).filter((key) =>
    /^(V8_|OPENAI_COMPAT_|SILICONFLOW_|OPENCLAW_)/.test(key),
  );
  if (keys.length === 0) return "";
  return (
    keys
      .map((key) => `export ${key}='${escapeBashSingleQuotes(String(env[key] ?? ""))}'`)
      .join("; ") + "; "
  );
}

function installCleanupHandlers(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const cleanup = () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      for (const pid of Array.from(activeChildPids)) {
        killProcessTreeSync(pid);
      }
    } finally {
      cleanupRunning = false;
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("exit", cleanup);
}

function registerActiveChild(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  installCleanupHandlers();
  activeChildPids.add(pid);
}

function unregisterActiveChild(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  activeChildPids.delete(pid);
}

function killProcessTreeSync(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore cleanup failures; stale processes are best-effort cleanup only.
  }
}

function runWslSync(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    encoding: BufferEncoding;
    timeout: number;
    maxBuffer: number;
  },
): CommandChainResult {
  const commands = ["wsl.exe", "wsl"];
  let last: CommandChainResult | null = null;
  for (const command of commands) {
    const result = spawnSync(command, args, options);
    last = {
      status: result.status ?? null,
      signal: result.signal ?? null,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.error ?? null,
    };
    if (!last.error && last.status !== null) {
      return last;
    }
  }
  return last || { status: null, signal: null, stdout: "", stderr: "", error: null };
}

async function spawnWslAsync(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  },
): Promise<CommandChainAsyncResult> {
  const commands = ["wsl.exe", "wsl"];
  let last: CommandChainAsyncResult | null = null;
  for (const command of commands) {
    const result = await spawnAsync(command, args, options);
    last = result;
    if (!result.error && result.status !== null) {
      return result;
    }
  }
  return last || { status: null, signal: null, stdout: "", stderr: "", error: null };
}

function escapeBashSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\"'\"'`);
}

function spawnAsync(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    shell?: boolean;
  },
): Promise<CommandChainAsyncResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timeoutHandle: NodeJS.Timeout | null = null;
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell,
        stdio: ["ignore", "pipe", "pipe"],
      });
      registerActiveChild(child.pid);
    } catch (error) {
      resolve({
        status: null,
        signal: null,
        stdout,
        stderr,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const finish = (result: CommandChainAsyncResult) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      unregisterActiveChild(child?.pid);
      resolve(result);
    };

    if (options.timeout && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        if (child.pid) {
          killProcessTreeSync(child.pid);
        } else {
          child.kill();
        }
        finish({
          status: null,
          signal: null,
          stdout,
          stderr,
          error: new Error(`Command timed out after ${options.timeout}ms`),
        });
      }, options.timeout);
    }

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({
        status: null,
        signal: null,
        stdout,
        stderr,
        error,
      });
    });
    child.on("close", (status, signal) => {
      finish({
        status: typeof status === "number" ? status : null,
        signal: signal ?? null,
        stdout,
        stderr,
        error: null,
      });
    });
  });
}
