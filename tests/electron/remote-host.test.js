const { evidencePath } = require("../helpers/evidence.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
  openSettingsScreen,
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
  // Keep the canonical socket path below the daemon's 100-byte limit even
  // under macOS's long temp prefix plus the parent-owned test-run directory.
  // This suite has one remote HOME; its run root isolates it from other runs.
  const remoteHome = path.join(await realpath(tmpdir()), "rh");
  const bin = path.join(root, "bin");
  await mkdir(remoteHome, { mode: 0o700 });
  removeAfterApps(context, remoteHome);
  await mkdir(bin, { mode: 0o700 });
  // Only explicitly required tools. No inherited PATH, real ssh, SSH material,
  // agent CLI, network, system install, or user shell startup files.
  for (const tool of [
    "sh",
    "uname",
    "gzip",
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
  const artifact = path.resolve("build/remote-host/foom-host");
  const manifest = JSON.parse(await readFile("build/remote-host/manifest.json", "utf8"));
  // The runner prepares the verified precompressed production catalog before cases.
  const pidFile = path.join(root, "ssh-pids");
  const sshLog = path.resolve("test-results/remote-ssh-fixture.log");
  await writeFile(sshLog, "");
  // A fixture executable accepts the daemon's login flags without loading
  // system/user login profiles or changing the controlled PATH.
  const shell = path.join(bin, "remote-shell");
  await writeFile(shell, "#!/bin/sh\nexec /bin/sh -i\n", { mode: 0o700 });
  const ssh = path.join(bin, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const split = args.indexOf('--');
if (split < 0 || args[split + 1] !== 'fixture-cloud') process.exit(2);
if (args.at(-1) === 'uname -s; uname -m') { process.stdout.write(require('node:os').type() + '\\n' + (process.arch === 'x64' ? 'x86_64' : process.platform === 'darwin' ? 'arm64' : 'aarch64') + '\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
appendFileSync(${JSON.stringify(sshLog)}, 'fixture ssh started\\n');
const child = spawn('/bin/sh', ['-c', 'exec ' + args.slice(split + 2).join(' ')], { env: { HOME: ${JSON.stringify(remoteHome)}, PATH: ${JSON.stringify(bin)}, SHELL: ${JSON.stringify(shell)}, LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    env: { HOME: remoteHome, PATH: bin, SHELL: shell, LANG: "C" },
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
  const socket = path.join(remoteHome, ".foom-host/host-v2.sock");
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
    args: ["--remote-shell-spike=fixture-cloud"],
  });
  // Teardown always closes the hub before the explicitly owned fixture daemon.
  cleanup.apps.push(cleanup.apps.shift());
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), manifest.version);
  const page = await boardPage(app);
  const profilePath = await app.evaluate(({ app }) => app.getPath("userData"));
  const profileTag = JSON.parse(
    await readFile(path.join(profilePath, "settings.json"), "utf8"),
  ).remoteProfile;
  assert.match(profileTag, /^[a-f0-9]{32}$/u);
  const enrolled = await page.evaluate(
    (codeFolder) => window.desktop.hosts({ action: "add", host: "fixture-cloud", codeFolder }),
    path.join(remoteHome, "code"),
  );
  assert.equal(enrolled.result.ok, true);
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
  const sshPids = (await readFile(pidFile, "utf8")).trim().split("\n");
  const firstSsh = Number(sshPids.at(-1));
  process.kill(firstSsh, "SIGTERM");
  await expect
    .poll(async () => (await readFile(pidFile, "utf8")).trim().split("\n").length)
    .toBe(sshPids.length + 1);
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
  await page.screenshot({ path: evidencePath("remote-host.png") });
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await (await confirmationPage(app)).getByRole("button", { name: "Stop all and quit" }).click();
  });
  // Hub quit disconnects without terminating the daemon or its shell.
  assert.equal(daemon.exitCode, null);
  const retained = await hostChannel(
    socket,
    manifest.sha256,
    id,
    cleanup,
    80,
    24,
    true,
    profileTag,
  );
  try {
    await retained.ask({
      type: "write",
      data: 'printf \'AFTER_HUB_QUIT:%s:%s\\n\' "$persist" "$$"\r',
    });
    await expect
      .poll(async () => (await retained.ask({ type: "tail", lines: 40 })).lines.join("\n"))
      .toContain(`AFTER_HUB_QUIT:STILL_ALIVE:${pid}`);
  } finally {
    retained.close();
  }
  const recovered = await hostChannel(
    socket,
    manifest.sha256,
    "lost-profile-write",
    cleanup,
    80,
    24,
    false,
    profileTag,
  );
  await recovered.ask({ type: "write", data: "printf 'RECOVERED_SCREEN\\n'\r" });
  await expect
    .poll(async () => (await recovered.ask({ type: "tail", lines: 40 })).lines.join("\n"))
    .toContain("RECOVERED_SCREEN");
  recovered.close();
  const foreign = await hostChannel(socket, manifest.sha256, "legacy-foreign", cleanup);
  foreign.close();
  const restarted = await launchApp(context, {
    fixture: "empty-board",
    env: { PATH: bin, SSH_AUTH_SOCK: "" },
    args: [`--user-data-dir=${profilePath}`, "--remote-shell-spike=fixture-cloud"],
  });
  const restored = await boardPage(restarted);
  await expect
    .poll(async () =>
      (await restored.evaluate(() => window.desktop.workspace())).terminals
        .filter((row) => !row.dormant && !row.exited)
        .map((row) => row.id)
        .sort(),
    )
    .toEqual([id, "lost-profile-write"].sort());
  const recoveredRow = (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
    (row) => row.id === "lost-profile-write",
  );
  assert.equal(recoveredRow.orchestration, undefined);
  await expect(restored.locator(".terminal-tile[data-kind='shell']")).toHaveCount(2);
  await expect
    .poll(() => restored.evaluate(() => window.desktop.tail("lost-profile-write", 40)))
    .toContain("RECOVERED_SCREEN");
  await openSettingsScreen(restored);
  await restored
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await expect(restored.getByText("Other profiles or untagged: 1", { exact: true })).toBeVisible();
  for (const theme of ["eclipse-light", "eclipse-dark"]) {
    await restored.evaluate(
      (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
      theme,
    );
    await restored.screenshot({ path: evidencePath(`757-hosts-${theme}.png`) });
  }
  await restored.getByRole("button", { name: "End…", exact: true }).click();
  const endDialog = await confirmationPage(restarted);
  await expect(endDialog.getByRole("heading", { name: "End remote sessions?" })).toBeVisible();
  await endDialog.screenshot({ path: evidencePath("757-end-confirmation.png") });
  await endDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(restored.getByText("Other profiles or untagged: 1", { exact: true })).toBeVisible();
  await restored.getByRole("button", { name: "End…", exact: true }).click();
  await (await confirmationPage(restarted))
    .getByRole("button", { name: "End sessions", exact: true })
    .click();
  await expect(restored.getByText("Other profiles or untagged: 0", { exact: true })).toBeVisible();
  const ended = await hostChannel(socket, manifest.sha256, "legacy-foreign", cleanup, 80, 24, true);
  assert.equal(ended.opened.state, "gone");
  ended.close();
  await quitAndWait(restarted, async () => {
    await restarted.evaluate(({ app }) => app.quit());
    await (await confirmationPage(restarted))
      .getByRole("button", { name: "Stop all and quit" })
      .click();
  });
  await wideReplay(root, socket, manifest.sha256, cleanup);
  const gone = await hostChannel(socket, manifest.sha256, "never-created", cleanup, 80, 24, true);
  assert.equal(gone.opened.state, "gone");
  gone.close();
});

async function hostChannel(
  socket,
  build,
  id,
  cleanup,
  cols = 80,
  rows = 24,
  reattach = false,
  profile = "f".repeat(32),
) {
  const { RemoteFrames, RemoteMessages, remoteFrame, remoteResponse } =
    require("../../build/shared/remote-host-protocol.js");
  const channel = createConnection(socket);
  cleanup.apps.unshift(async () => {
    channel.destroy();
  });
  const pending = new Map();
  const events = new EventEmitter();
  const reader = new RemoteFrames();
  const messages = new RemoteMessages();
  const failed = () => {
    for (const request of pending.values())
      request.reject(new Error("Remote fixture channel closed"));
    pending.clear();
  };
  channel.on("error", failed);
  channel.once("close", failed);
  channel.on("data", (bytes) =>
    reader.push(bytes, (wire) => {
      assert.ok(remoteResponse(wire));
      const message = messages.push(wire);
      if (!message) return;
      if (message.type === "data") events.emit("data", message);
      const key = message.type === "hello" ? 0 : message.request;
      const request = pending.get(key);
      if (request) {
        pending.delete(key);
        if (message.type === "error") request.reject(new Error("Remote fixture request failed"));
        else request.resolve(message);
      }
    }),
  );
  await once(channel, "connect");
  const greeted = new Promise((resolve, reject) => pending.set(0, { resolve, reject }));
  channel.write(remoteFrame({ type: "hello", build }));
  assert.equal((await greeted).build, build);
  let request = 100;
  const ask = (message) =>
    new Promise((resolve, reject) => {
      const number = ++request;
      pending.set(number, { resolve, reject });
      channel.write(remoteFrame({ ...message, id, request: number }));
    });
  const opened = await ask({ type: "open", cols, rows, reattach, ...(profile ? { profile } : {}) });
  return { ask, events, opened, close: () => channel.destroy() };
}

async function wideReplay(root, socket, build, cleanup) {
  const { Terminal } = require("@xterm/headless");
  const { SerializeAddon } = require("@xterm/addon-serialize");
  const { MAX_REMOTE_MESSAGE } = require("../../build/shared/remote-host-protocol.js");
  const options = { cols: 400, rows: 24, scrollback: 10000, allowProposedApi: true };
  const reference = new Terminal(options);
  const view = new Terminal(options);
  const addon = new SerializeAddon();
  reference.loadAddon(addon);
  const line = "\x1b[31mA\x1b[32mB".repeat(200) + "\r\n";
  const write = (terminal, data) =>
    new Promise((resolve) => {
      terminal.write(data, resolve);
    });
  const visible = (terminal) =>
    Array.from({ length: 24 }, (_, y) =>
      terminal.buffer.active.getLine(terminal.buffer.active.baseY + y)?.translateToString(true),
    );
  let peer;
  try {
    // This native-host integration case uses real serialization without V8 unit
    // coverage instrumentation; neither fixture generation nor replay is mocked.
    await write(reference, line.repeat(10000));
    assert.ok(JSON.stringify(addon.serialize()).length > MAX_REMOTE_MESSAGE);
    const generator = path.join(root, "wide-output.cjs");
    const pidFile = path.join(root, "wide-shell-pid");
    await writeFile(
      generator,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.ppid));\n` +
        `process.stdout.write(${JSON.stringify("\x1bc")} + ${JSON.stringify(line)}.repeat(10000) + ${JSON.stringify("\x1b]0;WIDE_READY\x07")});\n`,
    );
    peer = await hostChannel(socket, build, "wide", cleanup, 400, 24);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, generator].map(quote).join(" ");
    await peer.ask({ type: "write", data: `PS1=''; widePersist=WIDE_ALIVE; ${command}\r` });
    let expected;
    await expect
      .poll(async () => {
        expected = await peer.ask({ type: "screen" });
        return expected.title;
      })
      .toBe("WIDE_READY");
    assert.deepEqual(expected.lines, visible(reference));
    const pid = (await readFile(pidFile, "utf8")).trim();
    peer.close();
    peer = await hostChannel(socket, build, "wide", cleanup, 400, 24, true);
    const replayed = once(peer.events, "data");
    const [[replay]] = await Promise.all([
      replayed,
      peer.ask({ type: "attach", view: "wide-view" }),
    ]);
    assert.ok(JSON.stringify(replay).length <= MAX_REMOTE_MESSAGE);
    await write(view, replay.data);
    assert.deepEqual(visible(view), expected.lines);
    assert.equal(view.buffer.normal.baseY, 0);
    assert.equal(view.buffer.active.cursorX, reference.buffer.active.cursorX);
    assert.equal(view.buffer.active.cursorY, reference.buffer.active.cursorY);
    const colors = (terminal) =>
      Array.from({ length: 23 }, (_, y) => {
        const row = terminal.buffer.active.getLine(terminal.buffer.active.baseY + y);
        return Array.from({ length: 400 }, (_, x) => row.getCell(x).getFgColor());
      });
    assert.deepEqual(colors(view), colors(reference));
    await peer.ask({ type: "acknowledge", token: replay.token, count: replay.data.length });
    const retained = await peer.ask({ type: "tail", lines: 10000 });
    assert.equal(retained.lines.length, 10000);
    assert.ok(retained.lines.every((row) => row === "AB".repeat(200)));
    await peer.ask({ type: "write", data: 'printf \'WIDE_AFTER:%s:%s\\n\' "$widePersist" "$$"\r' });
    await expect
      .poll(async () => (await peer.ask({ type: "tail", lines: 4 })).lines.join("\n"))
      .toContain(`WIDE_AFTER:WIDE_ALIVE:${pid}`);
  } finally {
    peer?.close();
    reference.dispose();
    view.dispose();
  }
}
