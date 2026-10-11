import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { afterAll, expect, test, vi } from "vitest";
import { agyPluginFiles } from "../../../../src/main/agents/agy-observer";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import type { HookSignal } from "../../../../src/shared/hooks";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { UNREACHABLE_PROXY } from "../../../helpers/unreachable-proxy";

const directories: string[] = [];
// Keep fixtures until every observer parent has closed. One inventory query for
// the file avoids repeatedly cold-starting CIM; workers are still waited by handle.
afterAll(async () => {
  const started = performance.now();
  if (process.platform === "win32" && directories.length > 0) {
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference = 'Stop'
try {
  $directories = @($env:FOOM_OBSERVER_TEST_DIRECTORIES | ConvertFrom-Json)
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $workers = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
    $command = $_.CommandLine
    $command -and @($directories | Where-Object { $command.Contains($_) }).Count -gt 0
  })
  Write-Output ("Observer cleanup query: " + $timer.ElapsedMilliseconds + "ms")
  foreach ($entry in $workers) {
    $worker = $null
    try { $worker = [System.Diagnostics.Process]::GetProcessById($entry.ProcessId) }
    catch [System.ArgumentException] { continue }
    try {
      if (!$worker.WaitForExit(${String(nativeDeadline(5000))})) { throw 'Observer worker did not exit' }
    } finally { $worker.Dispose() }
  }
} catch { [Console]::Error.WriteLine($_); exit 1 }
`,
      ],
      {
        env: {
          ...process.env,
          FOOM_OBSERVER_TEST_DIRECTORIES: JSON.stringify(directories.map((dir) => basename(dir))),
        },
        timeout: nativeDeadline(10000),
      },
    ).then(({ stdout }) => {
      console.info(stdout.trim());
    });
  }
  // No retries: query, wait, or deletion failures must fail the suite.
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
function run(dir: string, env: NodeJS.ProcessEnv, event: string, input?: string) {
  const windows = process.platform === "win32";
  const started = performance.now();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      windows ? "powershell.exe" : "sh",
      windows
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "./observer.ps1",
            event,
          ]
        : ["./observer.sh", event],
      {
        cwd: dir,
        env: { ...env, FOOM_HOOK_ORDER: join(dir, "order") },
        timeout: nativeDeadline(5000),
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error("Observer failed", { cause: error }));
        else {
          const elapsed = performance.now() - started;
          console.info(`Observer ${event} parent exit: ${String(Math.round(elapsed))}ms`);
          // The real hook deadline is intentionally NOT platform-scaled.
          if (elapsed >= 3000)
            reject(
              new Error(
                `Observer exceeded the 3s product hook deadline: ${String(Math.round(elapsed))}ms`,
              ),
            );
          else resolve({ stdout, stderr });
        }
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
    expect(files["plugin.json"]).toContain('"foomObserverVersion":2');
  }
});

test.each(["FOOM_HOOK_URL", "FOOM_SESSION", "FOOM_TOKEN"])(
  "inert without %s even when stdin remains open",
  { timeout: nativeDeadline(10000) },
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
  { timeout: nativeDeadline(10000) },
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
