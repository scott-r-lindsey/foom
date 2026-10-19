import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stagePlugin } from "../../../../src/main/agents/plugin-staging";
import { observerAssets } from "../../../../src/main/agents/providers/v2-observers";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";
import type { V2HookState } from "../../../../src/shared/v2-hooks";
import fixture from "../../../fixtures/agent-plugins-v2/agy.json";
import launchFixture from "../../../fixtures/agent-plugin-v2.json";
import { windowsObserver } from "../../../helpers/observer-process";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { UNREACHABLE_PROXY } from "../../../helpers/unreachable-proxy";

it("generic detached observers allocate order before transport and return a neutral result", {
  timeout: nativeDeadline(15000),
}, async () => {
  const model = parseAgentManifest(JSON.stringify({ ...fixture, id: "fixture-native" })).model;
  const channel = model.hooks?.channels[0];
  if (!channel) throw Error("Missing channel");
  const directory = await mkdtemp(join(tmpdir(), "foom-v2-native-"));
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((signal) => signals.push(signal));
  const state: V2HookState = {};
  const launch = receiver.register("terminal", model.id, {
    channels: new Map([[channel.id, channel]]),
    state,
  });
  const supervisors: Promise<Error | null>[] = [];
  const failures: Error[] = [];
  try {
    const staged = await stagePlugin(model, directory, { hooksEnabled: false });
    await staged.verify();
    expect((await stagePlugin(model, directory, { hooksEnabled: true })).directory).toBe(
      staged.directory,
    );
    const observerDirectory = join(staged.directory, "observers", channel.id);
    const order = join(directory, "order");
    await writeFile(order, "0");
    const windows = process.platform === "win32";
    const system = process.env["SystemRoot"] ?? "C:\\Windows";
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
      ),
      ...launch.env,
      [`FOOM_CHANNEL_${channel.id.replaceAll("-", "_")}`]: channel.id,
      [`FOOM_ORDER_${channel.id.replaceAll("-", "_")}`]: order,
      PATH: windows
        ? [join(system, "System32"), join(system, "System32/WindowsPowerShell/v1.0")].join(";")
        : "/usr/bin:/bin",
      ...(windows ? { SystemRoot: system, TEMP: directory, TMP: directory } : {}),
      ...UNREACHABLE_PROXY,
    };
    const run = async (event: string, payload: unknown) => {
      if (windows) {
        const observer = windowsObserver(observerDirectory, env, event, JSON.stringify(payload));
        supervisors.push(observer.closed);
        return observer.result;
      }
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(
          "sh",
          ["./observer.sh", event],
          { cwd: observerDirectory, env, timeout: nativeDeadline(5000) },
          (error: Error | null, stdout: string, stderr: string) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
          },
        );
        child.stdin?.end(JSON.stringify(payload));
      });
    };
    expect(await run("PreInvocation", { conversationId: "id" })).toMatchObject({
      stdout: windows ? "{}\r\n" : "{}\n",
      stderr: "",
    });
    await expect.poll(() => signals.length).toBe(1);
    expect(
      await run("Stop", {
        conversationId: "id",
        terminationReason: "NO_TOOL_CALL",
        fullyIdle: true,
      }),
    ).toMatchObject({ stdout: windows ? "{}\r\n" : "{}\n", stderr: "" });
    await expect.poll(() => signals.length).toBe(2);
    expect(signals.map((signal) => signal.action)).toEqual(["working", "classify"]);
    expect(state.channels?.get(channel.id)?.sequence).toBe(2);
    const extra = join(staged.directory, "extra.json");
    await writeFile(extra, "{}");
    await expect(staged.verify()).rejects.toThrow("changed");
    await rm(extra);
    const script = join(observerDirectory, windows ? "observer.ps1" : "observer.sh");
    const original = await readFile(script, "utf8");
    await writeFile(script, "changed");
    await expect(staged.verify()).rejects.toThrow("changed");
    await writeFile(script, original);
    await staged.verify();
    const outside = join(directory, "outside");
    await writeFile(outside, original);
    await rm(script);
    await symlink(outside, script);
    await expect(staged.verify()).rejects.toThrow();
  } finally {
    launch.revoke();
    await receiver.close();
    failures.push(...(await Promise.all(supervisors)).filter((error) => error !== null));
    await rm(directory, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, "Observer cleanup failed");
});
it.each(["stdin", "argv-last"] as const)(
  "generic foreground %s observer delivers reduced evidence without executing payload text",
  { timeout: nativeDeadline(15000) },
  async (transport) => {
    const model = parseAgentManifest(
      JSON.stringify({
        ...launchFixture,
        id: "fixture-native-foreground",
        execution: { completion: "attached", completionChannels: ["lifecycle"] },
        hooks: {
          channels: [
            {
              id: "lifecycle",
              when: { all: [] },
              observer: {
                transport,
                placement: "launch",
                version: 1,
                response: "silent",
                delivery: "foreground",
                timeoutMs: 1000,
              },
              arguments: [],
              mapping: {
                session: { source: "payload", path: ["id"] },
                event: { source: "payload", path: ["event"] },
                cases: [{ id: "Stop", event: "Stop", action: "classify" }],
              },
            },
          ],
        },
      }),
    ).model;
    const channel = model.hooks?.channels[0];
    if (!channel) throw Error("Missing channel");
    const root = await mkdtemp(join(tmpdir(), "foom-v2-foreground-"));
    const signals: HookSignal[] = [];
    const receiver = await HookReceiver.listen((signal) => signals.push(signal));
    const launch = receiver.register("terminal", model.id, {
      channels: new Map([[channel.id, channel]]),
      state: {},
    });
    const windows = process.platform === "win32";
    try {
      const script = join(root, windows ? "observer.ps1" : "observer.sh");
      const source = observerAssets(channel, windows)[windows ? "observer.ps1" : "observer.sh"];
      if (source === undefined) throw Error("Missing observer source");
      await writeFile(script, source);
      const payload = JSON.stringify({
        id: "conversation",
        event: "Stop",
        text: "'\"; $(exit 99) `exit 99` 雪",
      });
      const system = process.env["SystemRoot"] ?? "C:\\Windows";
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
        ),
        ...launch.env,
        FOOM_CHANNEL_lifecycle: "lifecycle",
        PATH: windows ? join(system, "System32/WindowsPowerShell/v1.0") : "/usr/bin:/bin",
        ...UNREACHABLE_PROXY,
      };
      const args = windows
        ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
        : [script];
      if (transport === "argv-last") args.push(payload);
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(
          windows ? "powershell.exe" : "sh",
          args,
          { env, timeout: nativeDeadline(5000) },
          (error: Error | null, stdout: string, stderr: string) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
          },
        );
        child.stdin?.end(transport === "stdin" ? payload : "");
      });
      expect(result).toEqual({ stdout: "", stderr: "" });
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ conversationId: "conversation", action: "classify" });
      expect(JSON.stringify(signals)).not.toContain("exit 99");
    } finally {
      launch.revoke();
      await receiver.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("migrates exact legacy installed-observer health into protected storage on the native OS", {
  timeout: nativeDeadline(15000),
}, async () => {
  const { createHash } = await import("node:crypto");
  const { mkdir, link } = await import("node:fs/promises");
  const { installedHealth } = await import(
    "../../../../src/main/agents/providers/installed-observers"
  );
  const { agentProvider } = await import("../../../../src/main/agents/providers/registry");
  const { verifyPrivate } = await import("../../../../src/node-common/private-files");
  const { userInfo } = await import("node:os");
  const { codexHookArguments, codexObserverCommand } = await import(
    "../../../helpers/legacy-codex"
  );
  const model = agentProvider("codex").model;

  const profile = await mkdtemp(join(tmpdir(), "foom-legacy-health-"));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(codexHookArguments(codexObserverCommand())))
    .digest("hex");
  const oldFile = join(profile, "codex-hook-health.json");
  const original = JSON.stringify({ fingerprint, state: "trusted" });
  try {
    // This deliberately reproduces the old writer: no explicit Windows DACL.
    await writeFile(oldFile, original, { mode: 0o600 });
    if (process.platform === "win32") await expect(verifyPrivate(oldFile, false)).rejects.toThrow();
    expect((await installedHealth(model, profile)).get()).toBe("trusted");
    expect(await readFile(oldFile, "utf8")).toBe(original);
    const migrated = join(profile, `foom-observers-${String(userInfo().uid)}`, "codex-health.json");
    await verifyPrivate(migrated, false);
    expect(JSON.parse(await readFile(migrated, "utf8"))).toEqual({ fingerprint, state: "trusted" });
    const linked = join(profile, "linked");
    await mkdir(linked);
    await link(oldFile, join(linked, "codex-hook-health.json"));
    expect((await installedHealth(model, linked)).get()).toBe("not-reviewed");
    if (process.platform === "win32") {
      const wide = join(profile, "wide");
      await mkdir(wide);
      const unsafe = join(wide, "codex-hook-health.json");
      await writeFile(unsafe, original);
      await new Promise<void>((resolve, reject) => {
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$p=$env:FOOM_LEGACY_TEST_FILE; $a=[System.IO.File]::GetAccessControl($p); $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); [System.IO.File]::SetAccessControl($p,$a)",
          ],
          { env: { ...process.env, FOOM_LEGACY_TEST_FILE: unsafe }, timeout: 5000 },
          (error) => {
            if (error) reject(new Error("Fixture ACL setup failed", { cause: error }));
            else resolve();
          },
        );
      });
      expect((await installedHealth(model, wide)).get()).toBe("not-reviewed");
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
