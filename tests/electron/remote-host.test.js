const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once, EventEmitter } = require("node:events");
const { createConnection } = require("node:net");
const { createHash } = require("node:crypto");
const {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  boardPage,
  confirmationPage,
  fixtureCleanup,
  launchApp,
  removeAfterApps,
  quitAndWait,
} = require("./harness.js");
const { auditProcesses } = require("./process-audit.js");

test("remote shell fixture uploads a pinned headless host and replays the same PTY after SSH loss", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "frh-")));
  removeAfterApps(context, root);
  const cleanup = fixtureCleanup(context);
  cleanup.audit ??= await auditProcesses(context);
  const remoteHome = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(remoteHome, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  // Only explicitly required tools. No inherited PATH, real ssh, SSH material,
  // agent CLI, network, system install, or user shell startup files.
  for (const tool of [
    "sh",
    "head",
    "mkdir",
    "chmod",
    "mv",
    "mktemp",
    "sha256sum",
    "shasum",
    "cut",
    "wc",
    "tr",
    "rm",
    "ls",
    "sleep",
  ]) {
    for (const directory of ["/usr/bin", "/bin"]) {
      try {
        await stat(path.join(directory, tool));
        await symlink(path.join(directory, tool), path.join(bin, tool));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  execFileSync(process.execPath, ["scripts/build-remote-host.mjs"], {
    cwd: path.join(__dirname, "../.."),
    stdio: "pipe",
    timeout: deadline(20000),
  });
  const artifact = path.resolve("build/remote-host/foom-host");
  const manifest = JSON.parse(await readFile("build/remote-host/manifest.json", "utf8"));
  const pidFile = path.join(root, "ssh-pids");
  const sshLog = path.resolve("test-results/remote-ssh-fixture.log");
  await writeFile(sshLog, "");
  const ssh = path.join(bin, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const split = args.indexOf('--');
if (split < 0 || args[split + 1] !== 'fixture-cloud') process.exit(2);
appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
appendFileSync(${JSON.stringify(sshLog)}, 'fixture ssh started\\n');
const child = spawn('/bin/sh', ['-c', 'exec ' + args.slice(split + 2).join(' ')], { env: { HOME: ${JSON.stringify(remoteHome)}, PATH: ${JSON.stringify(bin)}, LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
let diagnosticBytes = 0;
child.stderr.on('data', bytes => { const part = bytes.subarray(0, Math.max(0, 8192 - diagnosticBytes)); diagnosticBytes += part.length; appendFileSync(${JSON.stringify(sshLog)}, part); });
child.on('close', code => { appendFileSync(${JSON.stringify(sshLog)}, 'fixture ssh exit ' + String(code) + '\\n'); process.exit(code ?? 1); });
`,
    { mode: 0o700 },
  );
  await chmod(ssh, 0o700);
  const started = performance.now();
  const daemon = spawn(artifact, ["--daemon"], {
    env: { HOME: remoteHome, PATH: bin, LANG: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.audit.add(daemon.pid);
  let stderr = "";
  daemon.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-8192);
  });
  cleanup.apps.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close");
      daemon.kill("SIGTERM");
      await closed;
    }
  });
  const socket = path.join(remoteHome, ".foom-host/host.sock");
  await expect
    .poll(async () => {
      try {
        return (await stat(socket)).isSocket();
      } catch {
        return false;
      }
    })
    .toBe(true);
  const startupMs = performance.now() - started;
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(socket))).mode & 0o777, 0o700);
  assert.equal(stderr, "");
  const app = await launchApp(context, {
    fixture: "empty-board",
    env: { PATH: bin, SSH_AUTH_SOCK: "" },
    args: ["--remote-shell-spike=fixture-cloud", `--remote-host-artifact=${artifact}`],
  });
  // Teardown always closes the hub before the explicitly owned fixture daemon.
  cleanup.apps.push(cleanup.apps.shift());
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), manifest.version);
  const page = await boardPage(app);
  await page.evaluate(() => {
    window.remoteReplayTokens = new Set();
    window.stopRemoteReplay = window.desktop.onData((_id, token) =>
      window.remoteReplayTokens.add(token),
    );
  });
  // Await the launch capability's completion before asserting its UI. Bootstrap
  // transfers a full runtime and is an asynchronous operation, unlike a local PTY.
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "home-shell" }));
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".terminal-tile[data-kind='shell']")).toHaveCount(1);
  let id;
  await expect
    .poll(async () => {
      id = (await page.evaluate(() => window.desktop.workspace())).terminals[0]?.id;
      return Boolean(id);
    })
    .toBe(true);
  const tail = () =>
    page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id);
  await expect.poll(tail).toMatch(/[$#>]\s*$/);
  // A shell variable and PID prove process continuity, not merely replayed text.
  await page.keyboard.type(
    'persist=STILL_ALIVE; printf \'REMOTE_READY:%s:%s\\n\' "$persist" "$$"; pwd',
  );
  await page.keyboard.press("Enter");
  await expect.poll(tail).toContain("REMOTE_READY:STILL_ALIVE:");
  await expect.poll(async () => (await tail()).replaceAll("\n", "")).toContain(remoteHome);
  const before = await tail();
  const pid = before.match(/REMOTE_READY:STILL_ALIVE:(\d+)/)?.[1];
  assert.ok(pid);
  // Retain a snapshot above the view high-water mark. The remote owner must
  // account for reset bytes too, or the first replay ACK would be rejected and
  // subsequent output would stay paused.
  await page.keyboard.type(
    "i=0; while [ \"$i\" -lt 5000 ]; do printf '%079d\\n' 0; i=$((i+1)); done; printf 'LARGE_REPLAY_READY\\n'",
  );
  await page.keyboard.press("Enter");
  await expect.poll(tail).toMatch(/(?:^|\n)LARGE_REPLAY_READY(?:\n|$)/);
  const installed = path.join(
    remoteHome,
    ".foom-host",
    manifest.version,
    manifest.sha256,
    "foom-host",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(installed))
      .digest("hex"),
    manifest.sha256,
  );
  const priorTokens = await page.evaluate(() => window.remoteReplayTokens.size);
  assert.ok(priorTokens > 0);
  const firstSsh = Number((await readFile(pidFile, "utf8")).trim().split("\n")[0]);
  process.kill(firstSsh, "SIGTERM");
  await expect
    .poll(async () => (await readFile(pidFile, "utf8")).trim().split("\n").length)
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => window.remoteReplayTokens.size))
    .toBeGreaterThan(priorTokens);
  // Snapshot/live output is rendered through the existing sandboxed tile bridge.
  await expect(page.locator(".xterm-rows")).toContainText("LARGE_REPLAY_READY");
  await page.keyboard.type('printf \'RECONNECTED:%s:%s\\n\' "$persist" "$$"');
  await page.keyboard.press("Enter");
  await expect.poll(tail).toContain(`RECONNECTED:STILL_ALIVE:${pid}`);
  assert.equal(daemon.exitCode, null);
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/remote-host-measurements.json",
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        bytes: manifest.size,
        startupMs,
        node: process.versions.node,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: "test-results/remote-host.png" });
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await (await confirmationPage(app)).getByRole("button", { name: "Stop all and quit" }).click();
  });
  // Hub quit disconnects without terminating the daemon or its shell.
  assert.equal(daemon.exitCode, null);
  const {
    RemoteFrames,
    remoteFrame,
    remoteResponse,
  } = require("../../build/shared/remote-host-protocol.js");
  const channel = createConnection(socket);
  const pending = new Map();
  const bus = new EventEmitter();
  const reader = new RemoteFrames();
  channel.on("data", (bytes) =>
    reader.push(bytes, (message) => {
      assert.ok(remoteResponse(message));
      if (message.type === "hello") bus.emit("hello");
      else if (message.type === "result" || message.type === "error") {
        pending.get(message.request)?.(message);
        pending.delete(message.request);
      }
    }),
  );
  try {
    await once(channel, "connect");
    const greeted = once(bus, "hello");
    channel.write(remoteFrame({ type: "hello", build: manifest.sha256 }));
    await greeted;
    let request = 100;
    const ask = (message) =>
      new Promise((resolve) => {
        const number = ++request;
        pending.set(number, resolve);
        channel.write(remoteFrame({ ...message, id, request: number }));
      });
    await ask({ type: "open", cols: 80, rows: 24 });
    await ask({ type: "write", data: 'printf \'AFTER_HUB_QUIT:%s:%s\\n\' "$persist" "$$"\r' });
    await expect
      .poll(async () => (await ask({ type: "tail", lines: 40 })).lines.join("\n"))
      .toContain(`AFTER_HUB_QUIT:STILL_ALIVE:${pid}`);
  } finally {
    channel.destroy();
  }
});
