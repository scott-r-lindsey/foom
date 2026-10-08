import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { agyPluginFiles } from "../../../../src/main/agents/agy-observer";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "foom agy's $observer-"));
  directories.push(dir);
  await mkdir(dir, { recursive: true });
  for (const [name, source] of Object.entries(agyPluginFiles(process.platform)))
    await writeFile(join(dir, name), source);
  await writeFile(join(dir, "order"), "0");
  return dir;
}
function run(dir: string, env: NodeJS.ProcessEnv, event: string, input?: string) {
  const windows = process.platform === "win32";
  const command = windows
    ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./observer.ps1 ${event}`
    : `sh ./observer.sh ${event}`;
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      windows ? "cmd.exe" : "sh",
      windows ? ["/d", "/s", "/c", command] : ["-c", command],
      {
        cwd: dir,
        env: { ...env, FOOM_HOOK_ORDER: join(dir, "order") },
        timeout: 5000,
        windowsVerbatimArguments: windows,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error("Observer failed", { cause: error }));
        else resolve({ stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

test("static plugin installs only observer events on both native shells", () => {
  for (const platform of ["linux", "win32"] as const) {
    const files = agyPluginFiles(platform);
    expect(files["hooks.json"]).not.toMatch(/PreToolUse|Permission|continue|FOOM_TOKEN/u);
    expect(files["hooks.json"]).toContain(
      platform === "win32" ? "powershell.exe" : "sh ./observer.sh",
    );
    expect(files["hooks.json"]).toContain('"timeout":3');
    expect(files["plugin.json"]).toContain('"foomObserverVersion":1');
  }
});

test.each(["FOOM_HOOK_URL", "FOOM_SESSION", "FOOM_TOKEN"])(
  "inert without %s even when stdin remains open",
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

test("native shell delivers literal untrusted stdin, permits stop, and survives a dead receiver", async () => {
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((signal) => signals.push(signal));
  try {
    const dir = await fixture();
    const launch = receiver.register("terminal", "agy");
    const env = { ...process.env, ...launch.env };
    for (const event of ["PreInvocation", "PostToolUse", "Stop"]) {
      const result = await run(
        dir,
        env,
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
      await vi.waitFor(
        () => {
          expect(signals.at(-1)?.signal).toBe(`agy:${event}`);
        },
        {
          timeout: 5000,
        },
      );
    }
    await receiver.close();
    expect(JSON.parse((await run(dir, env, "Stop", "{}")).stdout)).toEqual({});
  } finally {
    await receiver.close();
  }
});

test("observer exits before an unresponsive HTTP receiver finishes", async () => {
  let received: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    received = resolve;
  });
  let disconnected = false;
  const server = createServer((request) => {
    request.socket.on("close", () => {
      disconnected = true;
    });
    request.resume();
    received?.();
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
      '{"conversationId":"session"}',
    );
    expect(JSON.parse(result.stdout)).toEqual({});
    await requestSeen;
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
