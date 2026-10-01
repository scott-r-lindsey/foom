import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prepareHookLaunch } from "../../../../src/main/agents/hook-launch";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";

let scratch: string;
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
  await rm(scratch, { recursive: true, force: true });
});

test("writes a private POSIX adapter and quotes its path for the hook shell", async () => {
  const bind = vi.fn();
  const hooks = await prepareHookLaunch(receiver, "claude", bind, "linux", scratch);
  const [directory] = await readdir(scratch);
  if (!directory) throw new Error("Missing launch directory");
  const script = join(scratch, directory, "claude.sh");
  expect(hooks.codexCommand).toEqual(["sh", script]);
  expect(hooks.claudeCommand).toBe(`sh '${script.replaceAll("'", `'\\''`)}'`);
  expect(hooks.env).toEqual({ FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "u" });
  expect(await readFile(script, "utf8")).toContain("curl");
  if (process.platform !== "win32") {
    expect((await stat(join(scratch, directory))).mode & 0o777).toBe(0o700);
    expect((await stat(script)).mode & 0o777).toBe(0o700);
  }
  const key = receiver.register.mock.calls[0]?.[0];
  expect(key).toMatch(/^[0-9a-f-]{36}$/u);

  hooks.bind?.("terminal-1");
  expect(bind).toHaveBeenCalledWith(key, "terminal-1");
  hooks.dispose();
  hooks.dispose();
  hooks.bind?.("terminal-2");
  expect(revoke).toHaveBeenCalledOnce();
  expect(bind).toHaveBeenLastCalledWith(key, undefined);
  expect(bind).toHaveBeenCalledTimes(2);
  await vi.waitFor(async () => {
    expect(await readdir(scratch)).toEqual([]);
  });
});

test("uses PowerShell on Windows", async () => {
  const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const hooks = await prepareHookLaunch(receiver, "codex", vi.fn(), "win32", scratch, execute);
  const [directory] = await readdir(scratch);
  if (!directory) throw new Error("Missing launch directory");
  const script = join(scratch, directory, "codex.ps1");
  expect(hooks.codexCommand).toEqual([
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
  ]);
  expect(hooks.claudeCommand).toBe(
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}"`,
  );
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    "powershell.exe",
    [...hooks.codexCommand.slice(1), "--foom-probe"],
    { timeout: 8000, maxBuffer: 65536 },
  );
  expect(await readFile(script, "utf8")).toContain("--foom-probe");
  hooks.dispose();
});

test.each(["interpreter missing", "enforced policy rejects script", "probe timed out"])(
  "rejects hook preparation and cleans up when %s",
  async (reason) => {
    const execute = vi.fn().mockRejectedValue(new Error(reason));
    await expect(
      prepareHookLaunch(receiver, "claude", vi.fn(), "win32", scratch, execute),
    ).rejects.toThrow("PowerShell hook script could not run");
    expect(receiver.register).not.toHaveBeenCalled();
    expect(await readdir(scratch)).toEqual([]);
  },
);

test("removes the directory and revokes credentials if registration fails", async () => {
  receiver.register.mockImplementationOnce(() => {
    throw new Error("Receiver is closed");
  });
  await expect(prepareHookLaunch(receiver, "claude", vi.fn(), "linux", scratch)).rejects.toThrow(
    "Receiver is closed",
  );
  expect(await readdir(scratch)).toEqual([]);
  expect(revoke).not.toHaveBeenCalled();
});

test("defaults to the system temporary directory", async () => {
  const hooks = await prepareHookLaunch(receiver, "claude", vi.fn());
  expect(hooks.codexCommand.at(-1)?.startsWith(tmpdir())).toBe(true);
  hooks.dispose();
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
      const payload = JSON.stringify({ session_id: "abc", hook_event_name: "PermissionRequest" });
      const child = execFile("sh", ["-c", hooks.claudeCommand], {
        env: { ...process.env, ...hooks.env },
      });
      child.stdin?.end(payload);
      await new Promise((resolve) => child.once("exit", resolve));
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        action: "needs_input",
        signal: "claude:PermissionRequest",
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
        expect(signals).toEqual([]); // Startup probe must not send an event.
        const [file, ...args] = hooks.codexCommand;
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
            await runCommand("cmd.exe", ["/d", "/s", "/c", hooks.claudeCommand], env, payload),
          ).toBe("");
        } else {
          expect(await runCommand(file, [...args, payload], env)).toBe("");
        }
        expect(signals).toEqual([
          expect.objectContaining({
            action: agent === "claude" ? "needs_input" : "classify",
            signal: agent === "claude" ? "claude:PermissionRequest" : "codex:agent-turn-complete",
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
