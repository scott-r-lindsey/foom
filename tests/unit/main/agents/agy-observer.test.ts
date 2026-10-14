import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterAll, expect, test, vi } from "vitest";
import { agyPluginFiles } from "../../../../src/main/agents/agy-observer";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";
import { windowsObserver } from "../../../helpers/observer-process";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { UNREACHABLE_PROXY } from "../../../helpers/unreachable-proxy";

const directories: string[] = [];
const supervisors: Promise<Error | null>[] = [];
// A job owns every Windows worker from birth, including workers whose command
// line is already unavailable during exit. Join supervisors before deleting cwd.
afterAll(async () => {
  const started = performance.now();
  const failures = (await Promise.all(supervisors)).filter((error) => error !== null);
  if (failures.length > 0) throw new AggregateError(failures, "Observer cleanup failed");
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
  console.info(`Observer cleanup total: ${String(Math.round(performance.now() - started))}ms`);
}, nativeDeadline(15000));
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "foom agy's $observer-"));
  directories.push(dir);
  await mkdir(dir, { recursive: true });
  for (const [name, source] of Object.entries(agyPluginFiles(process.platform)))
    await writeFile(join(dir, name), source);
  await writeFile(join(dir, "order"), "0");
  return dir;
}
async function run(dir: string, env: NodeJS.ProcessEnv, event: string, input?: string) {
  const observerEnv = { ...env, FOOM_HOOK_ORDER: join(dir, "order") };
  let result: { stdout: string; stderr: string; elapsed: number };
  if (process.platform === "win32") {
    const observer = windowsObserver(dir, observerEnv, event, input);
    supervisors.push(observer.closed);
    const parent = await observer.result;
    result = parent;
    console.info(
      `Observer ${event} supervisor observation: ${String(Math.round(parent.observedElapsed))}ms`,
    );
  } else {
    const started = performance.now();
    result = await new Promise<{ stdout: string; stderr: string; elapsed: number }>(
      (resolve, reject) => {
        const child = execFile(
          "sh",
          ["./observer.sh", event],
          {
            cwd: dir,
            env: observerEnv,
            timeout: nativeDeadline(5000),
          },
          (error, stdout, stderr) => {
            if (error) reject(new Error("Observer failed", { cause: error }));
            else resolve({ stdout, stderr, elapsed: performance.now() - started });
          },
        );
        if (input !== undefined) child.stdin?.end(input);
      },
    );
  }
  console.info(`Observer ${event} parent exit: ${String(Math.round(result.elapsed))}ms`);
  // This product deadline is intentionally NOT platform-scaled.
  expect(result.elapsed).toBeLessThan(3000);
  return { stdout: result.stdout, stderr: result.stderr };
}

test("static plugin installs only observer events on both native shells", () => {
  for (const platform of ["linux", "win32"] as const) {
    const files = agyPluginFiles(platform);
    expect(files["hooks.json"]).not.toMatch(/PreToolUse|Permission|continue|FOOM_TOKEN/u);
    expect(files["hooks.json"]).toContain(
      platform === "win32" ? "powershell.exe" : "sh ./observer.sh",
    );
    expect(files["hooks.json"]).toContain('"timeout":3');
    expect(files["plugin.json"]).toContain('"foomObserverVersion":2');
  }
});

test.each(["FOOM_HOOK_URL", "FOOM_SESSION", "FOOM_TOKEN"])(
  "inert without %s even when stdin remains open",
  { timeout: nativeDeadline(15000) },
  async (missing) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
      FOOM_SESSION: "session",
      FOOM_TOKEN: "token",
    };
    env[missing] = undefined;
    expect(await run(await fixture(), env, "Stop")).toEqual({
      stdout: process.platform === "win32" ? "{}\r\n" : "{}\n",
      stderr: "",
    });
  },
);

test.each(["PreInvocation", "PostToolUse", "Stop"])(
  "native shell delivers literal untrusted %s data and returns an empty result",
  { timeout: nativeDeadline(15000) },
  async (event) => {
    const signals: HookSignal[] = [];
    const receiver = await HookReceiver.listen((signal) => signals.push(signal));
    try {
      const dir = await fixture();
      // Exercise persisted sequence advancement across a decimal-width change.
      await writeFile(join(dir, "order"), "9");
      const launch = receiver.register("terminal", "agy");
      const result = await run(
        dir,
        { ...process.env, ...UNREACHABLE_PROXY, ...launch.env },
        event,
        JSON.stringify({
          conversationId: "session",
          terminationReason: "model_stop",
          fullyIdle: true,
          output: "$(touch no) `no` é 🌑",
        }),
      );
      expect(JSON.parse(result.stdout)).toEqual({});
      expect(result.stderr).toBe("");
      expect(await readFile(join(dir, "order"), "utf8")).toBe("10");
      await vi.waitFor(
        () => {
          expect(signals.at(-1)?.signal).toBe(`agy:${event}`);
        },
        {
          timeout: nativeDeadline(3000),
        },
      );
    } finally {
      await receiver.close();
    }
  },
);

test("native shell returns an empty result after the receiver is gone", {
  timeout: nativeDeadline(10000),
}, async () => {
  const receiver = await HookReceiver.listen(() => undefined);
  const launch = receiver.register("terminal", "agy");
  await receiver.close();
  expect(
    JSON.parse(
      (
        await run(
          await fixture(),
          { ...process.env, ...UNREACHABLE_PROXY, ...launch.env },
          "Stop",
          "{}",
        )
      ).stdout,
    ),
  ).toEqual({});
});

test("observer exits before an unresponsive HTTP receiver finishes", {
  timeout: nativeDeadline(10000),
}, async () => {
  const payload = JSON.stringify({ conversationId: "session", output: "é 🌑 $(exit 99) `exit`" });
  let received: string | undefined;
  let disconnected = false;
  const server = createServer((request) => {
    request.socket.on("close", () => {
      disconnected = true;
    });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  try {
    const result = await run(
      await fixture(),
      {
        ...process.env,
        FOOM_HOOK_URL: `http://127.0.0.1:${String(address.port)}/hooks`,
        FOOM_SESSION: "session",
        FOOM_TOKEN: "token",
      },
      "PreInvocation",
      payload,
    );
    expect(JSON.parse(result.stdout)).toEqual({});
    await vi.waitFor(
      () => {
        expect(received).toBe(payload);
      },
      { timeout: nativeDeadline(3000) },
    );
    expect(disconnected).toBe(false);
    // The parent has returned while the server still has not sent any response.
    expect(result.stderr).toBe("");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

test.skipIf(process.platform !== "win32")(
  "parent lifetime includes shell startup but excludes delayed supervisor observation",
  { timeout: nativeDeadline(15000) },
  async () => {
    const dir = await fixture();
    // Keep the child alive long enough to verify that actual runtime is counted.
    await writeFile(
      join(dir, "observer.ps1"),
      "Start-Sleep -Milliseconds 200; [Console]::Out.WriteLine('{}')",
    );
    const observer = windowsObserver(dir, process.env, "Stop", "{}", 3200);
    supervisors.push(observer.closed);
    const result = await observer.result;
    expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.elapsed).toBeGreaterThanOrEqual(200);
    expect(result.elapsed).toBeLessThan(3000);
    expect(result.observedElapsed - result.elapsed).toBeGreaterThanOrEqual(3000);
    expect(await observer.closed).toBeNull();
  },
);

test.skipIf(process.platform !== "win32")(
  "supervisor waits for detached workers after publishing the parent result",
  { timeout: nativeDeadline(15000) },
  async () => {
    const dir = await fixture();
    await writeFile(
      join(dir, "send.ps1"),
      "Start-Sleep -Milliseconds 1500; [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'finished'), 'done')",
    );
    const observer = windowsObserver(
      dir,
      {
        ...process.env,
        FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
        FOOM_SESSION: "session",
        FOOM_TOKEN: "token",
        FOOM_HOOK_ORDER: join(dir, "order"),
      },
      "Stop",
      "{}",
    );
    supervisors.push(observer.closed);
    expect(JSON.parse((await observer.result).stdout)).toEqual({});
    await expect(readFile(join(dir, "finished"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await observer.closed).toBeNull();
    expect(await readFile(join(dir, "finished"), "utf8")).toBe("done");
  },
);

test.skipIf(process.platform !== "win32")(
  "supervisor failures reject the result and remain visible to cleanup",
  { timeout: nativeDeadline(15000) },
  async () => {
    const dir = await fixture();
    await writeFile(join(dir, "observer.ps1"), "exit 7");
    const observer = windowsObserver(dir, process.env, "Stop", "{}");
    await expect(observer.result).rejects.toThrow("Observer supervisor failed");
    expect(await observer.closed).toBeInstanceOf(Error);
  },
);
