/**
 * pi-sandbox — macOS-native sandbox extension for pi
 *
 * Provides OS-level filesystem and network sandboxing for agent tools using
 * the @anthropic-ai/sandbox-runtime library (sandbox-exec on macOS).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import { join, dirname } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  getAgentDir,
  type BashOperations,
  type BashSpawnHook,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled: boolean;
  sshAuthSock: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Expand a leading ~ in a path to the user's home directory. */
export function resolveHome(path: string): string {
  if (path === "~") return os.homedir();
  if (path.startsWith("~/")) return join(os.homedir(), path.slice(2));
  return path;
}

/**
 * Deep-merge two SandboxConfig objects.
 * - Scalar fields (`enabled`, `sshAuthSock`, `ignoreViolations`,
 *   `enableWeakerNestedSandbox`) are overwritten if present in overrides.
 * - Arrays within `network` and `filesystem` sub-objects are **concatenated**
 *   (project arrays are appended to base arrays, not replaced).
 */
export function deepMerge(
  base: SandboxConfig,
  overrides: Partial<SandboxConfig> | undefined,
): SandboxConfig {
  if (!overrides) return { ...base };

  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.sshAuthSock !== undefined) result.sshAuthSock = overrides.sshAuthSock;

  // Concatenate arrays inside network
  if (overrides.network) {
    result.network = { ...base.network, ...overrides.network };
    for (const key of ["allowedDomains", "deniedDomains", "allowUnixSockets"] as const) {
      const baseArr = (base.network as any)?.[key] as string[] | undefined;
      const overArr = (overrides.network as any)?.[key] as string[] | undefined;
      if (baseArr && overArr) {
        (result.network as any)[key] = [...baseArr, ...overArr];
      }
    }
    // Scalars in network: allowAllUnixSockets, allowLocalBinding, httpProxyPort, socksProxyPort
  }

  // Concatenate arrays inside filesystem
  if (overrides.filesystem) {
    result.filesystem = { ...base.filesystem, ...overrides.filesystem };
    for (const key of ["denyRead", "allowWrite", "denyWrite"] as const) {
      const baseArr = base.filesystem[key];
      const overArr = overrides.filesystem[key];
      if (baseArr && overArr) {
        (result.filesystem as any)[key] = [...baseArr, ...overArr];
      }
    }
    // allowGitConfig is a scalar
  }

  // Extension fields that SandboxRuntimeConfig supports
  const extOverrides = overrides as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
  };
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
  };

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations;
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  sshAuthSock: "",
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function readJsonFile(path: string): Partial<SandboxConfig> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<SandboxConfig>;
  } catch (e) {
    console.error(`Warning: Could not parse ${path}: ${e}`);
    return {};
  }
}

/** Expand ~ in all filesystem string arrays inside a config. */
function expandConfigPaths(config: SandboxConfig): SandboxConfig {
  const expand = (arr: string[]) => arr.map(resolveHome);
  const fs = config.filesystem;
  if (fs) {
    fs.denyRead = expand(fs.denyRead);
    fs.allowWrite = expand(fs.allowWrite);
    fs.denyWrite = expand(fs.denyWrite);
  }
  return config;
}

/** Deduplicate string arrays within network and filesystem. */
function dedupConfigArrays(config: SandboxConfig): SandboxConfig {
  const dedup = (arr: string[]) => [...new Set(arr)];
  if (config.network) {
    if (config.network.allowedDomains) config.network.allowedDomains = dedup(config.network.allowedDomains);
    if (config.network.deniedDomains) config.network.deniedDomains = dedup(config.network.deniedDomains);
    if (config.network.allowUnixSockets) config.network.allowUnixSockets = dedup(config.network.allowUnixSockets);
  }
  if (config.filesystem) {
    config.filesystem.denyRead = dedup(config.filesystem.denyRead);
    config.filesystem.allowWrite = dedup(config.filesystem.allowWrite);
    config.filesystem.denyWrite = dedup(config.filesystem.denyWrite);
  }
  return config;
}

export function loadConfig(cwd: string): SandboxConfig {
  const globalConfigPath = join(getAgentDir(), "extensions", "pi-sandbox.json");
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};

  if (existsSync(globalConfigPath)) {
    globalConfig = readJsonFile(globalConfigPath);
  }
  if (existsSync(projectConfigPath)) {
    projectConfig = readJsonFile(projectConfigPath);
  }

  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
  return dedupConfigArrays(expandConfigPaths(merged));
}

// ---------------------------------------------------------------------------
// sandboxExec — shared helper for sandboxed command execution
// ---------------------------------------------------------------------------

export function sandboxExec(
  command: string,
  signal?: AbortSignal,
  timeout?: number,
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

      const child: ChildProcess = spawn("bash", ["-c", wrappedCommand], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout * 1000);
      }

      const onAbort = () => kill();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
        } else if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
        } else if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString();
          reject(new Error(stderr || `exit code ${code}`));
        } else {
          resolve(Buffer.concat(stdoutChunks));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// sandboxExecStream — streaming variant for the bash tool
// ---------------------------------------------------------------------------

export function sandboxExecStream(
  command: string,
  cwd: string,
  onData: (data: Buffer) => void,
  signal?: AbortSignal,
  timeout?: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null }> {
  return new Promise(async (resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

      const child: ChildProcess = spawn("bash", ["-c", wrappedCommand], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });

      let timedOut = false;

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeout * 1000);
      }

      const onAbort = () => kill();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
        } else if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
        } else {
          resolve({ exitCode: code });
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// SSH agent spawn hook
// ---------------------------------------------------------------------------

/**
 * Build the full GIT_SSH_COMMAND value for sandboxed SSH/git operations.
 * Includes SOCKS proxy, host-key bypass (needed because ~/.ssh is denied),
 * and 1Password IdentityAgent.
 */
export function buildGitSshCommand(socksProxyPort: number, sshAuthSock: string): string {
  return [
    "ssh",
    `-o 'ProxyCommand=nc -X 5 -x localhost:${socksProxyPort} %h %p'`,
    "-o StrictHostKeyChecking=no",
    "-o UserKnownHostsFile=/dev/null",
    "-o CheckHostIP=no",
    "-o GlobalKnownHostsFile=/dev/null",
    `-o 'IdentityAgent=${sshAuthSock}'`,
  ].join(" ");
}

/**
 * Create a spawnHook that injects SSH_AUTH_SOCK, HOME, and GIT_SSH_COMMAND
 * into every sandboxed spawn.
 *
 * GIT_SSH_COMMAND is injected via a command prefix (`export GIT_SSH_COMMAND=...`)
 * rather than through the env object because the sandbox runtime's
 * `wrapWithSandbox()` hardcodes its own GIT_SSH_COMMAND via an `env` command
 * wrapper. Env vars set through Node's spawn options are overridden by that
 * wrapper. By exporting inside the command, we override the sandbox's value
 * at the shell level.
 */
export function createSpawnHook(sshAuthSock: string, socksProxyPort?: number): BashSpawnHook {
  return ({ command, cwd, env }) => {
    const extraEnv: Record<string, string> = {
      SSH_AUTH_SOCK: sshAuthSock,
      HOME: process.env.HOME ?? "",
    };
    let finalCommand = command;
    if (socksProxyPort !== undefined) {
      const gitSshCmd = buildGitSshCommand(socksProxyPort, sshAuthSock);
      // Prefix the command with an export so it overrides the sandbox's
      // hardcoded GIT_SSH_COMMAND from the `env` wrapper.
      finalCommand = `export GIT_SSH_COMMAND=${JSON.stringify(gitSshCmd)}; ${command}`;
    }
    return {
      command: finalCommand,
      cwd,
      env: { ...env, ...extraEnv },
    };
  };
}

// ---------------------------------------------------------------------------
// SSH socket resolution
// ---------------------------------------------------------------------------

export function resolveSshSocket(
  config: SandboxConfig,
): { sshAuthSock: string; config: SandboxConfig } {
  let sshAuthSock = process.env.SSH_AUTH_SOCK || resolveHome(config.sshAuthSock);

  // Auto-detect 1Password agent for zero-config convenience
  if (!sshAuthSock) {
    const onePasswordSock = resolveHome("~/.1password/agent.sock");
    if (existsSync(onePasswordSock)) {
      sshAuthSock = onePasswordSock;
    }
  }

  const updatedConfig = { ...config };

  if (!sshAuthSock) return { sshAuthSock: "", config: updatedConfig };

  // Resolve symlink — sandbox-exec won't follow symlinks in its rules
  if (existsSync(sshAuthSock)) {
    try {
      const realSock = realpathSync(sshAuthSock);

      // Add both symlink dir and real path dir to filesystem allowWrite
      const extraPaths = [dirname(sshAuthSock), dirname(realSock)];
      const existingWrite = updatedConfig.filesystem?.allowWrite ?? [];
      updatedConfig.filesystem = {
        ...updatedConfig.filesystem,
        allowWrite: [...new Set([...existingWrite, ...extraPaths])],
      };

      // Add both symlink and resolved socket paths to network allowUnixSockets
      const existingSockets = updatedConfig.network?.allowUnixSockets ?? [];
      updatedConfig.network = {
        ...updatedConfig.network,
        allowUnixSockets: [...new Set([...existingSockets, sshAuthSock, realSock])],
      };
    } catch {
      // symlink resolution failed — still add the unresolved path dir and socket
      const extraPath = dirname(sshAuthSock);
      const existingWrite = updatedConfig.filesystem?.allowWrite ?? [];
      updatedConfig.filesystem = {
        ...updatedConfig.filesystem,
        allowWrite: [...new Set([...existingWrite, extraPath])],
      };

      const existingSockets = updatedConfig.network?.allowUnixSockets ?? [];
      updatedConfig.network = {
        ...updatedConfig.network,
        allowUnixSockets: [...new Set([...existingSockets, sshAuthSock])],
      };
    }
  }

  return { sshAuthSock, config: updatedConfig };
}

// ---------------------------------------------------------------------------
// Sandboxed operation factories
// ---------------------------------------------------------------------------

export function createSandboxedReadOps(): ReadOperations {
  return {
    async readFile(absolutePath: string): Promise<Buffer> {
      return sandboxExec(`cat ${JSON.stringify(absolutePath)}`);
    },
    async access(absolutePath: string): Promise<void> {
      await sandboxExec(`test -r ${JSON.stringify(absolutePath)}`);
    },
    async detectImageMimeType(absolutePath: string): Promise<string | null | undefined> {
      const stdout = await sandboxExec(
        `file --mime-type -b ${JSON.stringify(absolutePath)}`,
      );
      const mime = stdout.toString().trim();
      if (!mime || mime === "cannot open") return null;
      return mime;
    },
  };
}

export function createSandboxedWriteOps(): WriteOperations {
  return {
    async writeFile(absolutePath: string, content: string): Promise<void> {
      const b64 = Buffer.from(content, "utf-8").toString("base64");
      await sandboxExec(
        `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(absolutePath)}`,
      );
    },
    async mkdir(dir: string): Promise<void> {
      await sandboxExec(`mkdir -p ${JSON.stringify(dir)}`);
    },
  };
}

export function createSandboxedEditOps(
  readOps?: ReadOperations,
  writeOps?: WriteOperations,
): EditOperations {
  const r = readOps ?? createSandboxedReadOps();
  const w = writeOps ?? createSandboxedWriteOps();
  return {
    readFile: r.readFile,
    access: r.access,
    writeFile: w.writeFile,
  };
}

export function createSandboxedBashOps(): BashOperations {
  return {
    async exec(
      command: string,
      cwd: string,
      { onData, signal, timeout, env }: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
        env?: NodeJS.ProcessEnv;
      },
    ): Promise<{ exitCode: number | null }> {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      return sandboxExecStream(
        `cd ${JSON.stringify(cwd)} && ${command}`,
        cwd,
        onData,
        signal,
        timeout,
        env,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function sandboxExtension(pi: ExtensionAPI) {
  // --- State ---
  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let sshAuthSock = "";
  let socksProxyPort: number | undefined;

  // --- Local tool instances (for delegation when sandbox is off) ---
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  // --- Tool registration ---
  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxInitialized) return localRead.execute(id, params, signal, onUpdate);
      const tool = createReadTool(localCwd, { operations: createSandboxedReadOps() });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxInitialized) return localWrite.execute(id, params, signal, onUpdate);
      const tool = createWriteTool(localCwd, { operations: createSandboxedWriteOps() });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxInitialized) return localEdit.execute(id, params, signal, onUpdate);
      const tool = createEditTool(localCwd, { operations: createSandboxedEditOps() });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxInitialized) return localBash.execute(id, params, signal, onUpdate);

      const tool = createBashTool(localCwd, {
        operations: createSandboxedBashOps(),
        spawnHook: createSpawnHook(sshAuthSock, socksProxyPort),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // --- user_bash interceptor ---
  pi.on("user_bash", () => {
    if (!sandboxInitialized) return;
    return { operations: createSandboxedBashOps() };
  });

  // --- session_start ---
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }

    if (process.platform !== "darwin") {
      sandboxEnabled = false;
      ctx.ui.notify(`Sandbox not supported on ${process.platform}`, "warning");
      return;
    }

    try {
      const { sshAuthSock: sock, config: updatedConfig } = resolveSshSocket(config);
      sshAuthSock = sock;

      await SandboxManager.initialize(updatedConfig);

      // Capture SOCKS proxy port for SSH/git tunnelling
      socksProxyPort = SandboxManager.getSocksProxyPort();

      sandboxEnabled = true;
      sandboxInitialized = true;

      const networkCount = updatedConfig.network?.allowedDomains?.length ?? 0;
      const writeCount = updatedConfig.filesystem?.allowWrite?.length ?? 0;
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
      );
      ctx.ui.notify("Sandbox initialized", "info");
    } catch (err) {
      sandboxEnabled = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  });

  // --- session_shutdown ---
  pi.on("session_shutdown", async () => {
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // --- /sandbox command ---
  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }

      const config = loadConfig(ctx.cwd);
      const lines = [
        "Sandbox Configuration:",
        "",
        "Network:",
        `  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        `  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        "",
        "Filesystem:",
        `  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        "",
        `SSH Agent: ${sshAuthSock || "(not configured)"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
