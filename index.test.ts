/**
 * pi-sandbox — Unit tests for Phase 3: Core infrastructure
 *
 * Tests: resolveHome, deepMerge, loadConfig, sandboxExec, sandboxExecStream,
 * resolveSshSocket, createSandboxedReadOps, createSandboxedWriteOps,
 * createSandboxedEditOps, createSandboxedBashOps
 */

import { EventEmitter } from "node:events";
import os from "node:os";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted so vitest can hoist them above imports
// ---------------------------------------------------------------------------

const {
  mockWrapWithSandbox,
  mockSpawn,
  mockExistsSync,
  mockReadFileSync,
  mockRealpathSync,
  mockGetAgentDir,
} = vi.hoisted(() => ({
  mockWrapWithSandbox: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockRealpathSync: vi.fn(),
  mockGetAgentDir: vi.fn(() => "/mock/agent/dir"),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    wrapWithSandbox: mockWrapWithSandbox,
  },
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  realpathSync: mockRealpathSync,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: mockGetAgentDir,
}));

// ---------------------------------------------------------------------------
// Helper: create a fake ChildProcess-like EventEmitter
// ---------------------------------------------------------------------------

interface FakeChildProcess extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChildProcess(pid = 12345): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// ---------------------------------------------------------------------------
// Imports from module under test
// ---------------------------------------------------------------------------

import {
  resolveHome,
  deepMerge,
  loadConfig,
  sandboxExec,
  sandboxExecStream,
  resolveSshSocket,
  createSpawnHook,
  createSandboxedReadOps,
  createSandboxedWriteOps,
  createSandboxedEditOps,
  createSandboxedBashOps,
  DEFAULT_CONFIG,
} from "./index.js";

// ---------------------------------------------------------------------------
// resolveHome
// ---------------------------------------------------------------------------

describe("resolveHome", () => {
  test("expands ~ to os.homedir()", () => {
    expect(resolveHome("~/foo/bar")).toBe(os.homedir() + "/foo/bar");
  });

  test("expands ~ at start only", () => {
    expect(resolveHome("~/foo/~bar")).toBe(os.homedir() + "/foo/~bar");
  });

  test("returns path unchanged if no leading ~", () => {
    expect(resolveHome("/absolute/path")).toBe("/absolute/path");
    expect(resolveHome("./relative/path")).toBe("./relative/path");
    expect(resolveHome("path")).toBe("path");
  });

  test("handles ~ alone", () => {
    expect(resolveHome("~")).toBe(os.homedir());
  });
});

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe("deepMerge", () => {
  const base = {
    enabled: true,
    sshAuthSock: "~/.1password/agent.sock",
    network: {
      allowedDomains: ["npmjs.org", "github.com"],
      deniedDomains: ["evil.com"],
    },
    filesystem: {
      denyRead: ["~/.ssh"],
      allowWrite: [".", "/tmp"],
      denyWrite: [".env"],
    },
  };

  test("returns copy of base when overrides is empty", () => {
    const result = deepMerge(base, {});
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  test("handles undefined overrides", () => {
    const result = deepMerge(base, undefined as any);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  test("overrides scalar enabled", () => {
    const result = deepMerge(base, { enabled: false });
    expect(result.enabled).toBe(false);
  });

  test("overrides scalar sshAuthSock", () => {
    const result = deepMerge(base, { sshAuthSock: "/custom/sock" });
    expect(result.sshAuthSock).toBe("/custom/sock");
  });

  test("concatenates network.allowedDomains", () => {
    const result = deepMerge(base, { network: { allowedDomains: ["pypi.org"] } });
    expect(result.network.allowedDomains).toEqual(["npmjs.org", "github.com", "pypi.org"]);
  });

  test("concatenates network.deniedDomains", () => {
    const result = deepMerge(base, { network: { deniedDomains: ["worse.com"] } });
    expect(result.network.deniedDomains).toEqual(["evil.com", "worse.com"]);
  });

  test("concatenates filesystem.denyRead", () => {
    const result = deepMerge(base, { filesystem: { denyRead: ["~/.aws"] } });
    expect(result.filesystem.denyRead).toEqual(["~/.ssh", "~/.aws"]);
  });

  test("concatenates filesystem.allowWrite", () => {
    const result = deepMerge(base, { filesystem: { allowWrite: ["~/Downloads"] } });
    expect(result.filesystem.allowWrite).toEqual([".", "/tmp", "~/Downloads"]);
  });

  test("concatenates filesystem.denyWrite", () => {
    const result = deepMerge(base, { filesystem: { denyWrite: ["*.pem"] } });
    expect(result.filesystem.denyWrite).toEqual([".env", "*.pem"]);
  });

  test("does not mutate base config", () => {
    const baseAllowed = [...base.network.allowedDomains];
    deepMerge(base, { network: { allowedDomains: ["new.com"] } });
    expect(base.network.allowedDomains).toEqual(baseAllowed);
  });

  test("partial overrides preserve untouched fields", () => {
    const result = deepMerge(base, { network: { allowedDomains: ["pypi.org"] } });
    expect(result.filesystem.allowWrite).toEqual(base.filesystem.allowWrite);
    expect(result.network.deniedDomains).toEqual(base.network.deniedDomains);
  });

  test("overrides ignoreViolations when present", () => {
    const full = { ...base, ignoreViolations: { curl: ["/tmp"] } } as any;
    const result = deepMerge(full, { ignoreViolations: { curl: ["/var/tmp"] } } as any);
    expect(result.ignoreViolations).toEqual({ curl: ["/var/tmp"] });
  });

  test("overrides enableWeakerNestedSandbox when present", () => {
    const full = { ...base, enableWeakerNestedSandbox: false } as any;
    const result = deepMerge(full, { enableWeakerNestedSandbox: true } as any);
    expect(result.enableWeakerNestedSandbox).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentDir.mockReturnValue("/mock/agent/dir");
  });

  test("returns DEFAULT_CONFIG when no config files exist", () => {
    mockExistsSync.mockReturnValue(false);
    const result = loadConfig("/some/cwd");
    expect(result.enabled).toBe(true);
    expect(result.network.allowedDomains).toEqual(DEFAULT_CONFIG.network.allowedDomains);
  });

  test("merges global config over defaults", () => {
    mockExistsSync.mockImplementation((p: string) =>
      p.includes("pi-sandbox.json"),
    );
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ enabled: false, network: { allowedDomains: ["private.registry"] } }),
    );
    const result = loadConfig("/some/cwd");
    expect(result.enabled).toBe(false);
    // global domains are concatenated after defaults
    expect(result.network.allowedDomains).toContain("npmjs.org");
    expect(result.network.allowedDomains).toContain("private.registry");
  });

  test("merges project config over global + defaults", () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.includes("pi-sandbox.json")) return true;
      if (p.includes("sandbox.json")) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((p: string) => {
      if (p.includes("pi-sandbox.json")) {
        return JSON.stringify({ network: { allowedDomains: ["global.registry"] } });
      }
      return JSON.stringify({ filesystem: { allowWrite: ["~/project-tmp"] } });
    });
    const result = loadConfig("/some/cwd");
    // defaults + global + project concatenated
    expect(result.network.allowedDomains).toContain("npmjs.org");
    expect(result.network.allowedDomains).toContain("global.registry");
    expect(result.filesystem.allowWrite).toContain(".");
    expect(result.filesystem.allowWrite).toContain("/tmp");
    // project path is expanded from ~
    expect(result.filesystem.allowWrite).toContain(os.homedir() + "/project-tmp");
  });

  test("expands ~ paths in filesystem arrays", () => {
    mockExistsSync.mockReturnValue(false);
    const baseDirs = DEFAULT_CONFIG.filesystem.denyRead;
    // All ~/.ssh etc should be expanded
    const result = loadConfig("/cwd");
    for (const p of result.filesystem.denyRead) {
      expect(p).not.toContain("~");
    }
    expect(result.filesystem.denyRead).toContain(os.homedir() + "/.ssh");
  });

  test("deduplicates arrays after merge", () => {
    mockExistsSync.mockImplementation((p: string) => p.includes("sandbox.json"));
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        filesystem: {
          allowWrite: [".", "/tmp"], // duplicates of defaults
        },
      }),
    );
    const result = loadConfig("/cwd");
    const allowWrite = result.filesystem.allowWrite;
    // Should have no duplicates
    expect(allowWrite.length).toBe(new Set(allowWrite).size);
    expect(allowWrite.filter((p: string) => p === ".")).toHaveLength(1);
  });

  test("handles malformed JSON gracefully", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not json {{{");
    // Should not throw
    expect(() => loadConfig("/cwd")).not.toThrow();
    const result = loadConfig("/cwd");
    expect(result.enabled).toBe(true); // falls back to defaults
  });
});

// ---------------------------------------------------------------------------
// sandboxExec
// ---------------------------------------------------------------------------

describe("sandboxExec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWrapWithSandbox.mockResolvedValue("sandbox-exec --profile /tmp/sb.profile bash -c 'my command'");
  });

  test("calls SandboxManager.wrapWithSandbox before spawn", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 0));

    await sandboxExec("my command");

    expect(mockWrapWithSandbox).toHaveBeenCalledWith("my command");
    expect(mockSpawn).toHaveBeenCalledWith("bash", ["-c", "sandbox-exec --profile /tmp/sb.profile bash -c 'my command'"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  test("resolves with stdout Buffer on success", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("hello "));
      child.stdout.emit("data", Buffer.from("world"));
      child.emit("close", 0);
    });

    const result = await sandboxExec("echo hello");
    expect(result.toString()).toBe("hello world");
  });

  test("rejects on non-zero exit code with stderr", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("permission denied"));
      child.emit("close", 1);
    });

    await expect(sandboxExec("cat /etc/shadow")).rejects.toThrow("permission denied");
  });

  test("rejects on non-zero exit code without stderr", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 2));

    await expect(sandboxExec("false")).rejects.toThrow("exit code 2");
  });

  test("kills process group on timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);

    const promise = sandboxExec("sleep 999", undefined, 5);
    // Let microtasks settle, advance timers, then emit close
    await vi.advanceTimersByTimeAsync(5000);
    child.emit("close", null);

    await expect(promise).rejects.toThrow("timeout:5");
    expect(child.kill).toHaveBeenCalled();

    vi.useRealTimers();
  });

  test("handles AbortSignal abort", async () => {
    const controller = new AbortController();
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);

    const promise = sandboxExec("sleep 999", controller.signal);
    setImmediate(() => {
      controller.abort();
      // abort triggers kill, then process emits close
      setImmediate(() => child.emit("close", null));
    });

    await expect(promise).rejects.toThrow("aborted");
  });

  test("rejects on spawn error", async () => {
    mockSpawn.mockImplementation(() => {
      const child = fakeChildProcess();
      setImmediate(() => child.emit("error", new Error("ENOENT")));
      return child;
    });

    await expect(sandboxExec("nonexistent")).rejects.toThrow("ENOENT");
  });

  test("rejects when wrapWithSandbox fails", async () => {
    mockWrapWithSandbox.mockRejectedValue(new Error("sandbox-exec not found"));

    await expect(sandboxExec("ls")).rejects.toThrow("sandbox-exec not found");
  });
});

// ---------------------------------------------------------------------------
// sandboxExecStream
// ---------------------------------------------------------------------------

describe("sandboxExecStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWrapWithSandbox.mockResolvedValue("wrapped-cmd");
  });

  test("streams stdout data via onData callback and resolves with exitCode", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const onData = vi.fn();

    const promise = sandboxExecStream("echo hi", "/cwd", onData);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("output\n"));
      child.emit("close", 0);
    });

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(onData).toHaveBeenCalledWith(Buffer.from("output\n"));
  });

  test("streams stderr data via onData callback", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const onData = vi.fn();

    const promise = sandboxExecStream("ls /nope", "/cwd", onData);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("No such file\n"));
      child.emit("close", 1);
    });

    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(onData).toHaveBeenCalledWith(Buffer.from("No such file\n"));
  });

  test("rejects with timeout error on timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);

    const promise = sandboxExecStream("sleep 99", "/cwd", vi.fn(), undefined, 3);
    await vi.advanceTimersByTimeAsync(3000);
    child.emit("close", null);

    await expect(promise).rejects.toThrow("timeout:3");
    vi.useRealTimers();
  });

  test("rejects on spawn error", async () => {
    mockSpawn.mockImplementation(() => {
      const child = fakeChildProcess();
      setImmediate(() => child.emit("error", new Error("ENOENT")));
      return child;
    });

    await expect(sandboxExecStream("cmd", "/cwd", vi.fn())).rejects.toThrow("ENOENT");
  });

  test("rejects when wrapWithSandbox fails", async () => {
    mockWrapWithSandbox.mockRejectedValue(new Error("init failed"));

    await expect(sandboxExecStream("cmd", "/cwd", vi.fn())).rejects.toThrow("init failed");
  });
});

// ---------------------------------------------------------------------------
// resolveSshSocket
// ---------------------------------------------------------------------------

describe("resolveSshSocket", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const baseConfig = {
    enabled: true,
    sshAuthSock: "~/.1password/agent.sock",
    filesystem: {
      denyRead: ["~/.ssh"],
      allowWrite: [".", "/tmp"],
      denyWrite: [".env"],
    },
  } as any;

  test("uses SSH_AUTH_SOCK env var when set", () => {
    process.env.SSH_AUTH_SOCK = "/run/user/1000/agent.sock";
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockReturnValue("/run/user/1000/agent.sock");

    const { sshAuthSock } = resolveSshSocket(baseConfig);
    expect(sshAuthSock).toBe("/run/user/1000/agent.sock");
  });

  test("falls back to config.sshAuthSock when env var is unset", () => {
    delete process.env.SSH_AUTH_SOCK;
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockReturnValue(os.homedir() + "/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock");

    const { sshAuthSock } = resolveSshSocket(baseConfig);
    expect(sshAuthSock).toBe(os.homedir() + "/.1password/agent.sock"); // after ~ expansion
  });

  test("resolves symlink and adds both dirs to allowWrite and sockets to allowUnixSockets", () => {
    process.env.SSH_AUTH_SOCK = "~/.1password/agent.sock";
    delete process.env.SSH_AUTH_SOCK;

    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockReturnValue(
      os.homedir() + "/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
    );

    const { config } = resolveSshSocket(baseConfig);

    // filesystem allowWrite
    expect(config.filesystem.allowWrite).toContain(os.homedir() + "/.1password");
    expect(config.filesystem.allowWrite).toContain(
      os.homedir() + "/Library/Group Containers/2BUA8C4S2C.com.1password/t",
    );

    // network allowUnixSockets
    expect(config.network.allowUnixSockets).toContain(os.homedir() + "/.1password/agent.sock");
    expect(config.network.allowUnixSockets).toContain(
      os.homedir() + "/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
    );
  });

  test("handles missing socket by still adding unresolved path dir and socket", () => {
    delete process.env.SSH_AUTH_SOCK;
    mockExistsSync.mockReturnValue(true);
    mockRealpathSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { config } = resolveSshSocket(baseConfig);
    expect(config.filesystem.allowWrite).toContain(os.homedir() + "/.1password");
    expect(config.network.allowUnixSockets).toContain(os.homedir() + "/.1password/agent.sock");
  });

  test("handles socket that does not exist", () => {
    delete process.env.SSH_AUTH_SOCK;
    mockExistsSync.mockReturnValue(false);

    const { sshAuthSock, config } = resolveSshSocket(baseConfig);
    expect(sshAuthSock).toBe(os.homedir() + "/.1password/agent.sock");
    // No extra dirs added
    expect(config.filesystem.allowWrite).toEqual(baseConfig.filesystem.allowWrite);
  });
});

// ---------------------------------------------------------------------------
// createSandboxedReadOps
// ---------------------------------------------------------------------------

describe("createSandboxedReadOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("readFile calls sandboxExec with cat + quoted path", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("file contents"));
      child.emit("close", 0);
    });

    const ops = createSandboxedReadOps();
    const result = await ops.readFile("/some path/file.txt");
    expect(result.toString()).toBe("file contents");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith('cat "/some path/file.txt"');
  });

  test("access calls sandboxExec with test -r + quoted path", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 0));

    const ops = createSandboxedReadOps();
    await ops.access("/some/path");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith('test -r "/some/path"');
  });

  test("access rejects when file is not readable", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("Permission denied"));
      child.emit("close", 1);
    });

    const ops = createSandboxedReadOps();
    await expect(ops.access("/secret")).rejects.toThrow("Permission denied");
  });

  test("detectImageMimeType calls file --mime-type -b", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("image/png"));
      child.emit("close", 0);
    });

    const ops = createSandboxedReadOps();
    const mime = await ops.detectImageMimeType!("/img/photo.png");
    expect(mime).toBe("image/png");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith('file --mime-type -b "/img/photo.png"');
  });

  test("detectImageMimeType returns null for empty output", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(""));
      child.emit("close", 0);
    });

    const ops = createSandboxedReadOps();
    const mime = await ops.detectImageMimeType!("/img/broken.png");
    expect(mime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createSandboxedWriteOps
// ---------------------------------------------------------------------------

describe("createSandboxedWriteOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("writeFile base64-encodes content and pipes through base64 -d", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 0));

    const ops = createSandboxedWriteOps();
    await ops.writeFile("/out/file.txt", "hello world");

    const b64 = Buffer.from("hello world", "utf-8").toString("base64");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith(
      `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify("/out/file.txt")}`,
    );
  });

  test("writeFile handles special characters in path", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 0));

    const ops = createSandboxedWriteOps();
    await ops.writeFile("/path/with'spaces.txt", "data");

    expect(mockWrapWithSandbox).toHaveBeenCalledWith(
      expect.stringContaining(`"/path/with'spaces.txt"`),
    );
  });

  test("mkdir calls sandboxExec with mkdir -p", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 0));

    const ops = createSandboxedWriteOps();
    await ops.mkdir("/new/directory/path");

    expect(mockWrapWithSandbox).toHaveBeenCalledWith('mkdir -p "/new/directory/path"');
  });

  test("mkdir rejects on failure", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stderr.emit("data", Buffer.from("Permission denied"));
      child.emit("close", 1);
    });

    const ops = createSandboxedWriteOps();
    await expect(ops.mkdir("/no-access")).rejects.toThrow("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// createSandboxedEditOps
// ---------------------------------------------------------------------------

describe("createSandboxedEditOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("delegates readFile to read ops", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("edit content"));
      child.emit("close", 0);
    });

    const ops = createSandboxedEditOps();
    const result = await ops.readFile("/edit/path.txt");
    expect(result.toString()).toBe("edit content");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith('cat "/edit/path.txt"');
  });

  test("delegates access to read ops", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 0));

    const ops = createSandboxedEditOps();
    await ops.access("/edit/path.txt");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith('test -r "/edit/path.txt"');
  });

  test("delegates writeFile to write ops", async () => {
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    setImmediate(() => child.emit("close", 0));

    const ops = createSandboxedEditOps();
    await ops.writeFile("/edit/out.txt", "new content");

    const b64 = Buffer.from("new content", "utf-8").toString("base64");
    expect(mockWrapWithSandbox).toHaveBeenCalledWith(
      `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify("/edit/out.txt")}`,
    );
  });

  test("accepts custom read/write ops", async () => {
    const customRead = {
      readFile: vi.fn().mockResolvedValue(Buffer.from("custom")),
      access: vi.fn().mockResolvedValue(undefined),
    };
    const customWrite = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    };

    const ops = createSandboxedEditOps(customRead, customWrite);
    await ops.readFile("/f");
    expect(customRead.readFile).toHaveBeenCalledWith("/f");
    await ops.writeFile("/f", "x");
    expect(customWrite.writeFile).toHaveBeenCalledWith("/f", "x");
  });
});

// ---------------------------------------------------------------------------
// createSpawnHook
// ---------------------------------------------------------------------------

describe("createSpawnHook", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  test("injects SSH_AUTH_SOCK and HOME into env", () => {
    process.env.HOME = "/home/user";
    const hook = createSpawnHook("/tmp/agent.sock");
    const result = hook({
      command: "git push",
      cwd: "/project",
      env: { PATH: "/usr/bin" },
    });

    expect(result).toEqual({
      command: "git push",
      cwd: "/project",
      env: {
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        HOME: "/home/user",
      },
    });
  });

  test("preserves existing env vars while adding SSH ones", () => {
    process.env.HOME = "/home/other";
    const hook = createSpawnHook("/custom/ssh.sock");
    const result = hook({
      command: "make",
      cwd: "/build",
      env: { NODE_ENV: "production", HOME: "/existing/home" },
    });

    expect(result.env).toEqual({
      NODE_ENV: "production",
      HOME: "/home/other", // overridden by process.env.HOME
      SSH_AUTH_SOCK: "/custom/ssh.sock",
    });
  });

  test("uses empty string for HOME when not set", () => {
    delete process.env.HOME;
    const hook = createSpawnHook("/sock");
    const result = hook({ command: "ls", cwd: "/", env: {} });
    expect(result.env.HOME).toBe("");
  });

  test("passes through command and cwd unchanged", () => {
    const hook = createSpawnHook("/sock");
    const result = hook({ command: "npm test", cwd: "/app", env: {} });
    expect(result.command).toBe("npm test");
    expect(result.cwd).toBe("/app");
  });
});

// ---------------------------------------------------------------------------
// createSandboxedBashOps
// ---------------------------------------------------------------------------

describe("createSandboxedBashOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWrapWithSandbox.mockResolvedValue("wrapped");
    mockExistsSync.mockReturnValue(true);
  });

  test("exec streams via sandboxExecStream and resolves with exitCode", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const onData = vi.fn();

    const ops = createSandboxedBashOps();
    const promise = ops.exec("echo hi", "/cwd", { onData });
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("hi\n"));
      child.emit("close", 0);
    });

    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(onData).toHaveBeenCalledWith(Buffer.from("hi\n"));
  });

  test("exec throws when cwd does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const ops = createSandboxedBashOps();

    await expect(ops.exec("echo hi", "/nonexistent", { onData: vi.fn() })).rejects.toThrow(
      "Working directory does not exist",
    );
  });

  test("exec wraps command with cd to cwd", async () => {
    const child = fakeChildProcess();
    mockSpawn.mockReturnValue(child);
    const onData = vi.fn();

    const ops = createSandboxedBashOps();
    const promise = ops.exec("make build", "/project", { onData });
    setImmediate(() => child.emit("close", 0));
    await promise;

    expect(mockWrapWithSandbox).toHaveBeenCalledWith('cd "/project" && make build');
  });
});
