import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import type * as Fs from "node:fs/promises";
import type * as HookPreparation from "../../../../src/main/agents/providers/v2-hook-launch";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prepareHookLaunch } from "../../../../src/main/agents/providers/hook-launch";
import { prepareV2Hooks } from "../../../../src/main/agents/providers/v2-hook-launch";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof Fs>()) }));
vi.mock("../../../../src/main/agents/providers/v2-hook-launch", async (original) => {
  const actual = await original<typeof HookPreparation>();
  return { ...actual, prepareV2Hooks: vi.fn(actual.prepareV2Hooks) };
});

let scratch: string;
async function launchDirectories(): Promise<string[]> {
  return (await readdir(scratch)).filter((name) => !name.startsWith("foom-observers-"));
}
const revoke = vi.fn();
const receiver = {
  register: vi.fn((_key: string, _agent: string) => ({
    env: { FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "u" },
    revoke,
  })),
};

beforeEach(async () => {
  // An apostrophe in the path checks that the shell command quotes it as data.
  scratch = await mkdtemp(join(tmpdir(), "foom it's-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  replaceConfigProviders([]);
  try {
    // No launch files may remain after disposal or failed preparation.
    await vi.waitFor(async () => {
      expect(await launchDirectories()).toEqual([]);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("writes a private POSIX adapter and quotes its path for the hook shell", async () => {
  const bind = vi.fn();
  const hooks = await prepareHookLaunch(receiver, "claude", bind, "linux", scratch);
  try {
    const [directory] = await launchDirectories();
    if (!directory) throw new Error("Missing launch directory");
    const script = join(await realpath(scratch), directory, "control", "lifecycle", "observer.sh");
    expect(hooks.v2?.values["observerArgv:lifecycle"]).toEqual(["sh", script]);
    expect(hooks.v2?.values["observerCommand:lifecycle"]).toBe(
      `sh '${script.replaceAll("'", `'\\''`)}'`,
    );
    expect(hooks.env).toMatchObject({
      FOOM_SESSION: "s",
      FOOM_TOKEN: "t",
      FOOM_HOOK_URL: "u",
      FOOM_CHANNEL_lifecycle: "lifecycle",
    });
    expect(await readFile(script, "utf8")).toContain("curl");
    if (process.platform !== "win32") {
      expect((await stat(join(scratch, directory))).mode & 0o777).toBe(0o700);
      expect((await stat(script)).mode & 0o777).toBe(0o600);
    }
    const key = receiver.register.mock.calls[0]?.[0];
    expect(key).toMatch(/^[0-9a-f-]{36}$/u);

    hooks.bind?.("terminal-1");
    expect(bind).toHaveBeenCalledWith(key, "terminal-1");
    hooks.dispose();
    expect(existsSync(join(scratch, directory))).toBe(false);
    hooks.dispose();
    hooks.bind?.("terminal-2");
    expect(revoke).toHaveBeenCalledOnce();
    expect(bind).toHaveBeenLastCalledWith(key, undefined);
    expect(bind).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect(await launchDirectories()).toEqual([]);
    });
  } finally {
    hooks.dispose();
  }
});

test("uses PowerShell on Windows", async () => {
  const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const hooks = await prepareHookLaunch(receiver, "codex", vi.fn(), "win32", scratch, execute);
  try {
    const argv = hooks.v2?.values["observerArgv:notify"];
    if (!Array.isArray(argv)) throw new Error("Missing notify observer");
    const script = argv.at(-1) ?? "";
    expect(argv.slice(0, -1)).toEqual([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
    expect(hooks.v2?.values["observerCommand:notify"]).toBe(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`,
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "powershell.exe",
      [...argv.slice(1), "--foom-probe"],
      { timeout: 8000, maxBuffer: 65536 },
    );
    expect(await readFile(script, "utf8")).toContain("--foom-probe");
  } finally {
    hooks.dispose();
  }
});

test.each(["interpreter missing", "enforced policy rejects script", "probe timed out"])(
  "rejects hook preparation and cleans up when %s",
  async (reason) => {
    const execute = vi.fn().mockRejectedValue(new Error(reason));
    await expect(
      prepareHookLaunch(receiver, "claude", vi.fn(), "win32", scratch, execute),
    ).rejects.toThrow("PowerShell hook script could not run");
    expect(receiver.register).not.toHaveBeenCalled();
    expect(await launchDirectories()).toEqual([]);
  },
);

test("removes the directory and revokes credentials if registration fails", async () => {
  receiver.register.mockImplementationOnce(() => {
    throw new Error("Receiver is closed");
  });
  await expect(prepareHookLaunch(receiver, "claude", vi.fn(), "linux", scratch)).rejects.toThrow(
    "Receiver is closed",
  );
  expect(await launchDirectories()).toEqual([]);
  expect(revoke).not.toHaveBeenCalled();
});

test("defaults to the system temporary directory", async () => {
  // Path selection needs no native ACL/PowerShell subprocesses. Other cases in
  // this file retain real private files and the Windows policy/transport checks.
  const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const hooks = {
    env: {},
    observerCommand: "",
    observerArgv: [],
    dispose: vi.fn(),
    disposeAndWait: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  vi.mocked(prepareV2Hooks).mockResolvedValueOnce(hooks);
  const bind = vi.fn();
  expect(await prepareHookLaunch(receiver, "claude", bind, undefined, undefined, execute)).toBe(
    hooks,
  );
  expect(prepareV2Hooks).toHaveBeenCalledExactlyOnceWith(
    receiver,
    agentProvider("claude").model,
    bind,
    process.platform === "win32",
    tmpdir(),
    undefined,
    execute,
    true,
  );
  expect(receiver.register).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test.skipIf(process.platform === "win32")(
  "the written adapter delivers a Claude hook to the real receiver",
  async () => {
    const signals: HookSignal[] = [];
    const real = await HookReceiver.listen((signal) => {
      signals.push(signal);
    });
    try {
      const hooks = await prepareHookLaunch(real, "claude", vi.fn(), process.platform, scratch);
      const model = agentProvider("claude").model;
      for (const channel of model.hooks?.channels ?? [])
        hooks.v2?.channels.set(channel.id, channel);
      const payload = JSON.stringify({ session_id: "abc", hook_event_name: "PermissionRequest" });
      const child = execFile("sh", ["-c", String(hooks.v2?.values["observerCommand:lifecycle"])], {
        env: { ...process.env, ...hooks.env },
      });
      child.stdin?.end(payload);
      await new Promise((resolve) => child.once("exit", resolve));
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        action: "needs_input",
        signal: "plugin:claude:PermissionRequest",
      });
      expect(signals[0]?.terminalId).toMatch(/^[0-9a-f-]{36}$/u);
      hooks.dispose();
    } finally {
      await real.close();
    }
  },
);

function runCommand(file: string, args: readonly string[], env: NodeJS.ProcessEnv, input = "") {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { env, timeout: 8000, windowsVerbatimArguments: file === "cmd.exe" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`Hook invocation failed: ${stderr}`, { cause: error }));
        else if (stderr) reject(new Error(stderr));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

test.skipIf(process.platform !== "win32").each(["claude", "codex"] as const)(
  "generated %s invocation delivers under an inherited Restricted process policy",
  async (agent) => {
    vi.stubEnv("PSExecutionPolicyPreference", "Restricted");
    const signals: HookSignal[] = [];
    const real = await HookReceiver.listen((signal) => signals.push(signal));
    try {
      const hooks = await prepareHookLaunch(real, agent, vi.fn(), "win32", scratch);
      try {
        expect(signals).toMatchObject([]); // Startup probe must not send an event.
        for (const channel of agentProvider(agent).model.hooks?.channels ?? [])
          hooks.v2?.channels.set(channel.id, channel);
        const argv =
          hooks.v2?.values[agent === "claude" ? "observerArgv:lifecycle" : "observerArgv:notify"];
        const [file, ...args] = Array.isArray(argv) ? argv : hooks.observerArgv;
        if (!file) throw new Error("Missing hook executable");
        // Restricted can block Get-ExecutionPolicy's own module import. Prove
        // the inherited policy by executing this file without its override.
        const withoutOverride = args.filter(
          (arg) => arg !== "-ExecutionPolicy" && arg !== "Bypass",
        );
        await expect(
          runCommand(file, [...withoutOverride, "--foom-probe"], process.env),
        ).rejects.toThrow("running scripts is disabled");
        const payload = JSON.stringify(
          agent === "claude"
            ? { session_id: "abc", hook_event_name: "PermissionRequest" }
            : { type: "agent-turn-complete", "thread-id": "abc", "turn-id": "turn" },
        );
        const env = { ...process.env, ...hooks.env };
        if (agent === "claude") {
          expect(
            await runCommand(
              "cmd.exe",
              [
                "/d",
                "/s",
                "/c",
                String(hooks.v2?.values["observerCommand:lifecycle"] ?? hooks.observerCommand),
              ],
              env,
              payload,
            ),
          ).toBe("");
        } else {
          expect(await runCommand(file, [...args, payload], env)).toBe("");
        }
        expect(signals).toMatchObject([
          expect.objectContaining({
            action: agent === "claude" ? "needs_input" : "classify",
            signal:
              agent === "claude"
                ? "plugin:claude:PermissionRequest"
                : "plugin:codex:agent-turn-complete",
          }),
        ]);
      } finally {
        hooks.dispose();
      }
    } finally {
      await real.close();
    }
  },
  30000,
);

test("Antigravity binds and revokes credentials with only a private ordering counter", async () => {
  const bind = vi.fn();
  const hooks = await prepareHookLaunch(receiver, "agy", bind, "linux", scratch);
  const order = hooks.env["FOOM_HOOK_ORDER"];
  if (!order) throw new Error("Missing ordering path");
  expect(await readFile(order, "utf8")).toBe("0");
  expect(hooks.observerCommand).toBe("");
  expect(hooks.observerArgv).toEqual([]);
  expect(receiver.register).toHaveBeenCalledWith(expect.any(String), "agy", {
    channels: hooks.v2?.channels,
    state: hooks.v2?.state,
  });
  hooks.bind?.("terminal-1");
  expect(bind).toHaveBeenLastCalledWith(receiver.register.mock.calls[0]?.[0], "terminal-1");
  hooks.dispose();
  hooks.dispose();
  hooks.bind?.("terminal-2");
  expect(revoke).toHaveBeenCalledOnce();
  expect(bind).toHaveBeenCalledTimes(2);
  expect(bind).toHaveBeenLastCalledWith(receiver.register.mock.calls[0]?.[0], undefined);
});
