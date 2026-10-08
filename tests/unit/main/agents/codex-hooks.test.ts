import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  CODEX_EVENTS,
  codexHookArguments,
  codexObserverCommand,
  codexObserverSource,
} from "../../../../src/main/agents/codex-hooks";
import { CodexHookStatus } from "../../../../src/main/agents/codex-hook-status";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "foom observer's $test-"));
  scratch.push(path);
  return path;
}
function run(command: string, env: NodeJS.ProcessEnv, input?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = execFile(
      windows ? "cmd.exe" : "sh",
      windows ? ["/d", "/s", "/c", command] : ["-c", command],
      { env, timeout: 5000, windowsVerbatimArguments: windows },
      (error, stdout, stderr) => {
        if (error) reject(new Error("Observer invocation failed", { cause: error }));
        else resolve({ stdout, stderr });
      },
    );
    // Leave stdin open to verify the inert observer never waits for it.
    if (input !== undefined) child.stdin?.end(input);
  });
}

test("definitions are stable across launches, use unpacked resources, and contain no launch data", () => {
  const first = codexHookArguments(codexObserverCommand());
  expect(first).toEqual(codexHookArguments(codexObserverCommand()));
  expect(first).toHaveLength(CODEX_EVENTS.length * 2);
  expect(first.join(" ")).not.toMatch(/FOOM_|token|session-flags|http:|foom-hooks-/u);
  expect(codexObserverCommand("linux")).toContain("codex-v1.sh");
  expect(codexObserverCommand("linux", "/opt/Foom it's/observers")).toContain("'\\''");
  const windows = codexObserverCommand("win32", "C:/Foom it's $safe/observers");
  expect(Buffer.from(windows.split(" ").at(-1) ?? "", "base64").toString("utf16le")).toContain(
    "it''s $safe",
  );
});

test.each(["FOOM_HOOK_URL", "FOOM_SESSION", "FOOM_TOKEN"])(
  "observer is silent and inert without %s even with open stdin",
  async (missing) => {
    const path = await directory();
    const platform = process.platform === "win32" ? "win32" : "posix";
    await writeFile(
      join(path, platform === "win32" ? "codex-v1.ps1" : "codex-v1.sh"),
      codexObserverSource(platform),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
      FOOM_SESSION: "test",
      FOOM_TOKEN: "test",
    };
    env[missing] = undefined;
    expect(await run(codexObserverCommand(process.platform, path), env)).toEqual({
      stdout: "",
      stderr: "",
    });
  },
);

test("native observer delivers stdin without output or decisions, and tolerates a stopped receiver", async () => {
  const path = await directory();
  const platform = process.platform === "win32" ? "win32" : "posix";
  await writeFile(
    join(path, platform === "win32" ? "codex-v1.ps1" : "codex-v1.sh"),
    codexObserverSource(platform),
  );
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((event) => signals.push(event));
  try {
    const launch = receiver.register("terminal", "codex");
    const env = { ...process.env, ...launch.env };
    const command = codexObserverCommand(process.platform, path);
    const payload = JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "conversation",
      turn_id: "turn",
      tool_name: "Bash",
      tool_input: { command: "not executable" },
      transcript_path: "/never-read",
    });
    expect(await run(command, env, payload)).toEqual({ stdout: "", stderr: "" });
    expect(signals).toEqual([
      {
        terminalId: "terminal",
        conversationId: "conversation",
        action: "needs_input",
        signal: "codex:PermissionRequest",
      },
    ]);
    await receiver.close();
    expect(await run(command, env, payload)).toEqual({ stdout: "", stderr: "" });
  } finally {
    await receiver.close();
  }
});

test("Foom health persists independently, invalidates changed commands, and serializes updates", async () => {
  const file = join(await directory(), "health.json");
  const status = new CodexHookStatus(file, "observer-v1");
  await status.load();
  expect(status.get()).toBe("not-reviewed");
  status.set("trusted");
  status.set("declined");
  status.set("trusted");
  await status.flush();
  const reopened = new CodexHookStatus(file, "observer-v1");
  await reopened.load();
  expect(reopened.get()).toBe("trusted");
  expect(await readFile(file, "utf8")).not.toMatch(/trusted_hash|token|command/u);
  const update = new CodexHookStatus(file, "observer-v2");
  await update.load();
  expect(update.get()).toBe("outdated");
  update.set("outdated");
  await update.flush();
});

test.each(["{", "null", "{}", '{"fingerprint":0}', '{"fingerprint":0,"state":"invented"}'])(
  "health loading fails safely for %s",
  async (data) => {
    const file = join(await directory(), "health.json");
    await writeFile(file, data);
    const status = new CodexHookStatus(file);
    await status.load();
    expect(status.get()).not.toBe("trusted");
  },
);

test("health remains usable without persistence or when writes fail", async () => {
  const memory = new CodexHookStatus();
  await memory.load();
  memory.set("trusted");
  memory.set("trusted");
  await memory.flush();
  expect(memory.get()).toBe("trusted");
  const file = join(await directory(), "directory");
  await mkdir(file);
  const status = new CodexHookStatus(file);
  status.set("declined");
  await status.flush();
  expect(status.get()).toBe("declined");
});

test.each(["declined", "outdated", "not-reviewed"] as const)(
  "restores %s health and rejects unknown states for the same definition",
  async (state) => {
    const file = join(await directory(), "health.json");
    const status = new CodexHookStatus(file);
    status.set("trusted");
    status.set(state);
    await status.flush();
    const reopened = new CodexHookStatus(file);
    await reopened.load();
    expect(reopened.get()).toBe(state);
    const raw = await readFile(file, "utf8");
    await writeFile(file, raw.replace(state, "invented"));
    const corrupt = new CodexHookStatus(file);
    await corrupt.load();
    expect(corrupt.get()).toBe("not-reviewed");
  },
);

test("an older terminal cannot overwrite health established by a later launch", () => {
  const status = new CodexHookStatus();
  const first = status.begin();
  status.set("trusted", first);
  const latest = status.begin();
  status.set("declined", latest);
  status.set("trusted", first);
  expect(status.get()).toBe("declined");
});
