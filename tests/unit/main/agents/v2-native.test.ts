import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observerAssets } from "../../../../src/main/agents/providers/v2-observers";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";
import type { V2HookState } from "../../../../src/shared/v2-hooks";
import fixture from "../../../fixtures/agent-plugins-v2/agy.json";
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
    for (const [name, source] of Object.entries(
      observerAssets(channel, process.platform === "win32"),
    ))
      await writeFile(join(directory, name), source);
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
        const observer = windowsObserver(directory, env, event, JSON.stringify(payload));
        supervisors.push(observer.closed);
        return observer.result;
      }
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(
          "sh",
          ["./observer.sh", event],
          { cwd: directory, env, timeout: nativeDeadline(5000) },
          (error: Error | null, stdout: string, stderr: string) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
          },
        );
        child.stdin?.end(JSON.stringify(payload));
      });
    };
    expect(await run("PreInvocation", { conversationId: "id" })).toMatchObject({
      stdout: "{}\n",
      stderr: "",
    });
    await expect.poll(() => signals.length).toBe(1);
    expect(
      await run("Stop", {
        conversationId: "id",
        terminationReason: "NO_TOOL_CALL",
        fullyIdle: true,
      }),
    ).toMatchObject({ stdout: "{}\n", stderr: "" });
    await expect.poll(() => signals.length).toBe(2);
    expect(signals.map((signal) => signal.action)).toEqual(["working", "classify"]);
    expect(state.channels?.get(channel.id)?.sequence).toBe(2);
  } finally {
    launch.revoke();
    await receiver.close();
    failures.push(...(await Promise.all(supervisors)).filter((error) => error !== null));
    await rm(directory, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, "Observer cleanup failed");
});
