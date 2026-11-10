const { colorQueryFixture, oscColor } = require("./color-query-fixture.js");
const { evidencePath } = require("../helpers/evidence.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
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

test("remote host fixture checks preflight failures and enrolls an incomplete code folder", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await remoteFixture(context);
  const { remoteHome } = fixture;
  const { page } = await remoteApp(context, fixture);
  for (const [host, row, reason] of [
    ["fixture-unreachable", "ssh", "unreachable"],
    ["fixture-unsupported", "platform", "unsupported"],
    ["fixture-no-artifact", "artifact", "artifact-unavailable"],
    ...(process.platform === "linux" ? [["fixture-old-libc", "platform", "libc-too-old"]] : []),
  ]) {
    const checked = await page.evaluate(
      ({ host, codeFolder }) =>
        window.desktop.hosts({ action: "draft-preflight", host, codeFolder }),
      { host, codeFolder: path.join(remoteHome, "code") },
    );
    assert.deepEqual(checked.preflight[row], { state: "fail", reason });
    if (row !== "ssh") assert.deepEqual(checked.preflight.ssh, { state: "pass" });
    if (row === "artifact") assert.deepEqual(checked.preflight.platform, { state: "pass" });
    const { output, ...observations } = checked;
    assert.ok(!JSON.stringify(observations).includes("private fixture"));
    assert.equal(output.host, host);
    assert.equal(output.running, false);
    assert.equal(output.failed, reason !== "artifact-unavailable");
    assert.ok(output.text.length <= 65536);
    if (row === "ssh") assert.match(output.text, /private fixture SSH output/u);
  }
  const offline = await page.evaluate(() =>
    window.desktop.hosts({ action: "add", host: "fixture-unreachable", codeFolder: "~/pending" }),
  );
  assert.equal(offline.hosts[0].codeFolder, "~/pending");
  assert.equal(offline.hosts[0].result.reason, "unreachable");
  await page.evaluate(() =>
    window.desktop.hosts({ action: "remove", host: "fixture-unreachable" }),
  );
  const preflight = await page.evaluate(
    (codeFolder) =>
      window.desktop.hosts({ action: "draft-preflight", host: "fixture-cloud", codeFolder }),
    path.join(remoteHome, "code"),
  );
  assert.deepEqual(preflight.preflight.ssh, { state: "pass" });
  assert.deepEqual(preflight.preflight.platform, { state: "pass" });
  assert.deepEqual(preflight.preflight.artifact, { state: "pass" });
  assert.deepEqual(preflight.preflight.result.facts.folder, {
    state: "fail",
    reason: "folder-missing",
  });
  assert.ok(preflight.preflight.result.facts.requirements);
  assert.deepEqual(
    preflight.preflight.result.facts.tools.map(({ id, state }) => ({ id, state })),
    [
      { id: "git", state: "missing" },
      { id: "gh", state: "missing" },
    ],
  );
  assert.ok(preflight.preflight.result.facts.agents.every(({ state }) => state === "missing"));
  await assert.rejects(stat(path.join(remoteHome, "code")), { code: "ENOENT" });
  const enrolled = await page.evaluate(
    (codeFolder) => window.desktop.hosts({ action: "add", host: "fixture-cloud", codeFolder }),
    path.join(remoteHome, "code"),
  );
  assert.equal(enrolled.result.ok, true);
  assert.deepEqual(enrolled.hosts[0].result.facts.folder, {
    state: "fail",
    reason: "folder-missing",
  });
  await assert.rejects(stat(path.join(remoteHome, "code")), { code: "ENOENT" });
  await openSettingsScreen(page);
  await page
    .getByRole("region", { name: "Settings" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await page.getByRole("button", { name: "Expand fixture-cloud", exact: true }).click();
  await page.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(page.getByText("Code folder does not exist")).toBeVisible();
  await page.screenshot({ path: evidencePath("1005-incomplete-host.png") });
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Pass · Valid", { exact: true })).toBeVisible();
  assert.ok((await stat(path.join(remoteHome, "code"))).isDirectory());
  await page.keyboard.press("Escape");
  fixture.phase("host preflight and enrollment");
});

test("remote shell fixture copies links and confirms external browser navigation", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await remoteFixture(context);
  const { app, page } = await remoteApp(context, fixture);
  await remoteShell(page, fixture.phase);
  // Links from fixture SSH output use the local clipboard and stubbed local browser.
  const remoteUrl = "https://remote.example.test/oauth?state=fixture";
  await app.evaluate(({ shell }) => {
    globalThis.remoteOpenedLinks = [];
    shell.openExternal = async (url) => {
      globalThis.remoteOpenedLinks.push(url);
    };
  });
  await page.evaluate(() => {
    const captureLimit = 64 * 1024;
    window.remoteLinkCapture = { data: "", bytes: 0, chunks: 0, overflow: false };
    window.stopRemoteLinkChunks = window.desktop.onData((_id, _token, data) => {
      const capture = window.remoteLinkCapture;
      capture.chunks += 1;
      const bytes = new TextEncoder().encode(data).byteLength;
      if (capture.overflow || capture.bytes + bytes > captureLimit) {
        capture.overflow = true;
        return;
      }
      capture.data += data;
      capture.bytes += bytes;
    });
  });
  const remoteLink = page.getByRole("link", { name: remoteUrl, exact: true });
  // Reproduce the old readiness false positive: the unfinished command echo
  // already contains an exact plain URL, before any OSC 8 output exists.
  const prefix = String.raw`printf '\033]8;;${remoteUrl}`;
  const suffix = String.raw`\007Remote sign in\033]8;;\007\n'; printf 'REMOTE_LINK_%s\n' READY`;
  await page.keyboard.type(prefix);
  await expect(remoteLink).toHaveCount(1);
  assert.equal(
    await page.evaluate(() => window.remoteLinkCapture.data.includes("\x1b]8;;")),
    false,
  );
  await page.keyboard.type(suffix);
  await page.keyboard.press("Enter");
  // Native typing completion does not drain the remote PTY echo/output. The
  // marker cannot occur in the echoed printf format and is rendered after OSC 8.
  await expect(page.locator(".xterm-rows")).toContainText("REMOTE_LINK_READY");
  await expect(remoteLink).toHaveCount(1);
  const echoedTarget = String.raw`${remoteUrl}\007Remote`;
  await expect(page.getByRole("link", { name: echoedTarget, exact: true })).toHaveCount(1);
  const capture = await page.evaluate((remoteUrl) => {
    window.stopRemoteLinkChunks();
    const capture = window.remoteLinkCapture;
    // Keep raw bytes only in bounded memory; diagnostics contain metadata alone.
    const metadata = {
      capturedBytes: capture.bytes,
      chunkCount: capture.chunks,
      overflow: capture.overflow,
      containsExpectedOsc: capture.data.includes(
        `\x1b]8;;${remoteUrl}\x07Remote sign in\x1b]8;;\x07`,
      ),
    };
    capture.data = "";
    return metadata;
  }, remoteUrl);
  await writeFile(evidencePath("remote-link-readiness.json"), JSON.stringify(capture, null, 2));
  // Interactive shells can redraw edited input; raw PTY echo need not be a
  // contiguous copy of the command. The executed printf's OSC bytes are exact.
  assert.equal(capture.overflow, false);
  assert.equal(capture.containsExpectedOsc, true);
  const segment = remoteLink.locator(":scope > span").first();
  await expect(segment).toBeVisible();
  const previousGrid = await page.locator(".terminal-links").getAttribute("data-grid");
  assert.ok(previousGrid);
  await segment.evaluate((element) => {
    window.remoteLinkBeforeResize = element;
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(1000, 740);
  });
  await expect(page.locator(".terminal-links")).not.toHaveAttribute("data-grid", previousGrid);
  assert.equal(await page.evaluate(() => window.remoteLinkBeforeResize.isConnected), false);
  await expect(segment).toBeVisible();
  // Segments are pointer-transparent decoration. Resolve their current geometry
  // for each trusted native gesture; the actual hit still goes to xterm.
  await segment.click({ button: "right", force: true });
  const linkMenu = page.getByRole("menu", { name: "Terminal menu", exact: true });
  await linkMenu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), remoteUrl);
  await segment.click({ force: true });
  const linkConfirmation = await confirmationPage(app);
  await expect(linkConfirmation.getByRole("heading", { name: "Open this link?" })).toBeVisible();
  await linkConfirmation.getByRole("button", { name: "Open in browser", exact: true }).click();
  await expect.poll(() => app.evaluate(() => globalThis.remoteOpenedLinks)).toEqual([remoteUrl]);
  fixture.phase("link copy and external-open confirmation");
});

test("remote shell fixture uploads a pinned headless host and replays the same PTY after SSH loss", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await remoteFixture(context);
  const { manifest, remoteHome, colorProbe, daemon, pidFile } = fixture;
  const { app, page } = await remoteApp(context, fixture);
  const { id, tail } = await remoteShell(page, fixture.phase);
  // OSC 52 crosses SSH only as live fixture output; clipboard remains hub-owned.
  await page.evaluate(() => window.desktop.saveSetup({ terminalClipboardWrites: true }));
  await page.keyboard.type("printf '\\033]52;c;cmVtb3RlIGNsaXBib2FyZA==\\007\\n'");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("remote clipboard");
  await app.evaluate(({ clipboard }) => clipboard.writeText("remote replay sentinel"));
  const pid = await preparePersistentShell(page, fixture, tail);
  const colorRecord = `${fixture.colorRecord}.${pid}`;
  // Retain a snapshot above the view high-water mark. The remote owner must
  // account for reset bytes too, or the first replay ACK would be rejected and
  // subsequent output would stay paused.
  await page.keyboard.type(
    "i=0; while [ \"$i\" -lt 5000 ]; do printf '%079d\\n' 0; i=$((i+1)); done; printf 'LARGE_REPLAY_%s\\n' READY",
  );
  await page.keyboard.press("Enter");
  // Rendering is the producer barrier. Check the SSH ownership trace below as
  // well: an unsolicited reconnect before the deliberate loss must still fail.
  await expect(page.locator(".xterm-rows")).toContainText("LARGE_REPLAY_READY");
  fixture.phase("large replay preparation");
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
  assert.equal((await stat(installed)).mode & 0o777, 0o700);
  const owners = await fixture.sshOwners(id);
  assert.equal(owners.length, 1, "SSH must remain connected before the deliberate loss");
  const firstSsh = owners[0];
  assert.ok(firstSsh);
  // A later management connection must not change which SSH owns this PTY.
  await page.evaluate(
    (codeFolder) =>
      window.desktop.hosts({
        action: "draft-preflight",
        host: "fixture-cloud",
        codeFolder,
      }),
    path.join(remoteHome, "code"),
  );
  const sshPids = (await readFile(pidFile, "utf8")).trim().split("\n");
  assert.notEqual(Number(sshPids.at(-1)), firstSsh);
  assert.deepEqual(await fixture.sshOwners(id), [firstSsh]);
  fixture.phase("artifact verification and management connection");
  const priorTokens = await page.evaluate(() => window.remoteReplayTokens.size);
  assert.ok(priorTokens > 0);
  appendFileSync(
    fixture.traceFile,
    `${JSON.stringify({ at: Date.now(), kind: "intentional-loss", id, pid: firstSsh })}\n`,
  );
  process.kill(firstSsh, "SIGTERM");
  await expect.poll(() => fixture.sshOwners(id)).toHaveLength(2);
  await expect
    .poll(() => page.evaluate(() => window.remoteReplayTokens.size))
    .toBeGreaterThan(priorTokens);
  fixture.phase("SSH loss and reconnect");
  // Snapshot/live output is rendered through the existing sandboxed tile bridge.
  await expect(page.locator(".xterm-rows")).toContainText("LARGE_REPLAY_READY");
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    "remote replay sentinel",
  );

  await page.keyboard.type('printf \'RECONNECTED:%s:%s\\n\' "$persist" "$$"');
  await page.keyboard.press("Enter");
  await expect.poll(tail).toContain(`RECONNECTED:STILL_ALIVE:${pid}`);
  await page.keyboard.type("printf 'REATTACHED_MASK:'; umask");
  await page.keyboard.press("Enter");
  await expect.poll(tail).toMatch(/REATTACHED_MASK:0*27(?:\n|\r|$)/);
  await page.keyboard.type(`'${colorProbe}'`);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => JSON.parse(await readFile(colorRecord, "utf8")))
    .toContain(oscColor(11, "#123456"));
  assert.equal(daemon.exitCode, null);
  fixture.phase("SSH loss, replay and live input");
  await page.screenshot({ path: evidencePath("remote-host.png") });
});

test("remote shell fixture restores profile sessions and palettes after hub restart", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await remoteFixture(context);
  const { bin, remoteHome, cleanup, manifest, socket, closeDaemon, colorProbe, daemon } = fixture;
  const { app, page, profilePath, profileTag, hubHome } = await remoteApp(context, fixture);
  // Enrollment is a precondition here; its failure/UI coverage has its own case.
  await mkdir(path.join(remoteHome, "code"), { mode: 0o700 });
  await page.evaluate(
    (codeFolder) =>
      window.desktop.hosts({
        action: "add",
        host: "fixture-cloud",
        codeFolder,
      }),
    path.join(remoteHome, "code"),
  );
  const { id, tail } = await remoteShell(page, fixture.phase);
  // Keep the saved terminal palette different from the interface/native default.
  await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "eclipse-light" }));
  const pid = await preparePersistentShell(page, fixture, tail);
  const colorRecord = `${fixture.colorRecord}.${pid}`;
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
  fixture.phase("hub quit and retained PTY");
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
  const recoveredPid = await hostShellPid(recovered, "RECOVERED_SCREEN");
  recovered.close();
  fixture.phase("recovery preparation");
  const restarted = await launchApp(context, {
    fixture: "restored",
    home: hubHome,
    env: { PATH: bin, SSH_AUTH_SOCK: "" },
    args: [`--user-data-dir=${profilePath}`, "--remote-shell-spike=fixture-cloud"],
  }).finally(() => {
    cleanup.apps.splice(cleanup.apps.indexOf(closeDaemon), 1);
    cleanup.apps.push(closeDaemon);
  });
  const restored = await boardPage(restarted);
  const restoredSettings = await restored.evaluate(
    async () => (await window.desktop.setupState()).settings,
  );
  assert.equal(restoredSettings.terminalTheme, "foom-dark");
  assert.equal(restoredSettings.interfaceTheme, "eclipse-light");
  // Refreshing unchanged saved settings must not erase retained application colours.
  await restored.evaluate(() => window.desktop.saveSetup({ terminalTheme: "foom-dark" }));
  await expect
    .poll(async () =>
      (await restored.evaluate(() => window.desktop.workspace())).terminals
        .filter((row) => !row.dormant && !row.exited)
        .map((row) => row.id)
        .sort(),
    )
    .toEqual([id, "lost-profile-write"].sort());
  await expect(
    restored
      .locator(".terminal-tile")
      .filter({ hasText: "AFTER_HUB_QUIT:STILL_ALIVE:" })
      .locator(".xterm-helper-textarea"),
  ).toBeEditable();
  await writeFile(colorRecord, JSON.stringify("pending"));
  await restored.evaluate(({ id, command }) => window.desktop.input(id, command), {
    id,
    command: `'${colorProbe}'\r`,
  });
  // This other live PTY has a different startup palette. Its reply used to
  // overwrite the first shell's shared record and impersonate its result.
  const recoveredColors = `${fixture.colorRecord}.${recoveredPid}`;
  await writeFile(recoveredColors, JSON.stringify("pending"));
  await restored.evaluate(({ command }) => window.desktop.input("lost-profile-write", command), {
    command: `'${colorProbe}'\r`,
  });
  await expect
    .poll(async () => JSON.parse(await readFile(recoveredColors, "utf8")))
    .toContain(
      oscColor(
        11,
        require("../../build/shared/terminal-themes.js").terminalThemes["foom-light"].background,
      ),
    );
  await expect
    .poll(async () => JSON.parse(await readFile(colorRecord, "utf8")))
    .toContain(oscColor(11, "#123456"));
  const recoveredRow = (await restored.evaluate(() => window.desktop.workspace())).terminals.find(
    (row) => row.id === "lost-profile-write",
  );
  assert.equal(recoveredRow.orchestration, undefined);
  await expect(restored.locator(".terminal-tile[data-kind='shell']")).toHaveCount(2);
  await expect
    .poll(async () =>
      (await restored.evaluate(() => window.desktop.tail("lost-profile-write", 40))).join("\n"),
    )
    .toContain("RECOVERED_SCREEN");
  fixture.phase("hub restart and session replay");
  await quitAndWait(restarted, async () => {
    await restarted.evaluate(({ app }) => app.quit());
    await (await confirmationPage(restarted))
      .getByRole("button", { name: "Stop all and quit" })
      .click();
  });
  assert.equal(daemon.exitCode, null);
});

test("remote host fixture confirms foreign-session cleanup and copies host details", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await remoteFixture(context);
  const { remoteHome, socket, manifest, cleanup } = fixture;
  const { app: restarted, page: restored } = await remoteApp(context, fixture);
  await mkdir(path.join(remoteHome, "code"), { mode: 0o700 });
  const enrolled = await restored.evaluate(
    (codeFolder) =>
      window.desktop.hosts({
        action: "add",
        host: "fixture-cloud",
        codeFolder,
      }),
    path.join(remoteHome, "code"),
  );
  assert.equal(enrolled.result.ok, true);
  const { id } = await remoteShell(restored, fixture.phase);
  const foreign = await hostChannel(socket, manifest.sha256, "legacy-foreign", cleanup);
  foreign.close();
  fixture.phase("registered host and foreign session ready");
  await openSettingsScreen(restored);
  await restored
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Hosts", exact: true })
    .click();
  await restored.getByRole("button", { name: "Expand fixture-cloud", exact: true }).click();
  await restored.getByRole("button", { name: "Check capabilities", exact: true }).click();
  await expect(
    restored.getByRole("button", { name: "Check capabilities", exact: true }),
  ).toBeEnabled();
  await restored.locator(".host-details > summary").click();
  await expect(restored.getByText("Other profiles or untagged: 1", { exact: true })).toBeVisible();
  await restored.getByRole("button", { name: "Copy host alias", exact: true }).click();
  await expect
    .poll(() => restarted.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("fixture-cloud");
  const codeCopy = restored.getByRole("button", { name: "Copy code folder", exact: true });
  await codeCopy.click();
  await expect
    .poll(() => restarted.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe(path.join(remoteHome, "code"));
  await restored.screenshot({
    path: evidencePath("960-settings-hosts.png"),
    animations: "disabled",
  });
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
  assert.ok(
    (await restored.evaluate(() => window.desktop.workspace())).terminals.some(
      (row) => row.id === id && !row.exited,
    ),
  );
  await quitAndWait(restarted, async () => {
    await restarted.evaluate(({ app }) => app.quit());
    await (await confirmationPage(restarted))
      .getByRole("button", { name: "Stop all and quit" })
      .click();
  });
  fixture.phase("Settings and foreign-session cleanup");
});

test("remote host fixture supplies startup palettes and refuses absent session reattachment", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await remoteFixture(context);
  const { socket, manifest, cleanup } = fixture;
  // No hub/theme-update round trip: first-action queries must use open's
  // palette even when the acknowledgement has not reached any hub yet.
  const { terminalThemes } = require("../../build/shared/terminal-themes.js");
  for (const name of ["foom-dark", "foom-light"]) {
    const theme = terminalThemes[name];
    const peer = await hostChannel(
      socket,
      manifest.sha256,
      `startup-${name}`,
      cleanup,
      80,
      24,
      false,
      "f".repeat(32),
      { dark: name === "foom-dark", theme },
    );
    const pid = await hostShellPid(peer);
    const colorRecord = `${fixture.colorRecord}.${pid}`;
    await expect
      .poll(async () => JSON.parse(await readFile(colorRecord, "utf8")))
      .toContain(oscColor(11, theme.background));
    const colors = JSON.parse(await readFile(colorRecord, "utf8"));
    assert.ok(colors.includes(oscColor(10, theme.foreground)));
    await peer.ask({ type: "kill" });
    peer.close();
  }
  const gone = await hostChannel(socket, manifest.sha256, "never-created", cleanup, 80, 24, true);
  assert.equal(gone.opened.state, "gone");
  gone.close();
  fixture.phase("startup palettes and absent-session reattach");
});

test("remote host fixture bounds oversized replay while retaining history and live PTY state", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const fixture = await remoteFixture(context);
  const { root, socket, manifest, cleanup } = fixture;
  await wideReplay(root, socket, manifest.sha256, cleanup);
  fixture.phase("oversized headless replay");
});

async function remoteResizeFixture(context) {
  const fixture = await remoteFixture(context);
  const { remoteHome } = fixture;
  const { app, page } = await remoteApp(context, fixture);
  const enrolled = await page.evaluate(
    (codeFolder) => window.desktop.hosts({ action: "add", host: "fixture-cloud", codeFolder }),
    remoteHome,
  );
  assert.equal(enrolled.result.ok, true);
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "home-shell" }));
  await page.locator(".board-row[data-kind='shell']").click();
  const id = (await page.evaluate(() => window.desktop.workspace())).terminals[0].id;
  return { ...fixture, app, page, id };
}

test("remote live raw PTY writes after resize without a stale reflow suffix", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, root, id } = await remoteResizeFixture(context);
  await require("./resize-fixture.js").liveRawResize(app, page, id, root);
});

test("remote exit delivery across shrink reconciles the attached cursor row", {
  skip: process.platform === "win32",
  timeout: deadline(60000),
}, async (context) => {
  const { app, page, root, id } = await remoteResizeFixture(context);
  const { exitResizeRace } = require("./resize-fixture.js");
  await exitResizeRace(app, page, id, root);
});

async function remoteFixture(context) {
  let phaseStarted = performance.now();
  const phase = (name) => {
    const now = performance.now();
    context.diagnostic(`Remote phase: ${JSON.stringify({ name, ms: now - phaseStarted })}`);
    phaseStarted = now;
  };
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "frh-")));
  removeAfterApps(context, root);
  const cleanup = fixtureCleanup(context);
  cleanup.audit ??= await auditProcesses(context);
  // Keep the canonical socket path below the daemon's 100-byte limit even
  // under macOS's long temp prefix plus the parent-owned test-run directory.
  const remoteHome = await mkdtemp(path.join(await realpath("/tmp"), "rhh-"));
  const bin = path.join(root, "bin");
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
  const sshLog = path.resolve(
    `test-results/remote-ssh-${context.name.replaceAll(/[^a-z0-9]/gi, "-")}.log`,
  );
  await writeFile(sshLog, "");
  const traceFile = sshLog.replace(/\.log$/, ".jsonl");
  const daemonLog = sshLog.replace(/\.log$/, ".daemon.log");
  await writeFile(traceFile, "");
  await writeFile(daemonLog, "");
  // A fixture executable accepts the daemon's login flags without loading
  // system/user login profiles or changing the controlled PATH.
  const shell = path.join(bin, "remote-shell");
  const colorRecord = path.join(root, "shell-colors.json");
  const colorProbe = path.join(bin, "color-probe");
  await writeFile(
    colorProbe,
    `#!${process.execPath}
(async () => {
${colorQueryFixture(colorRecord, true)}
const values = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(colorRecord)} + '.' + process.ppid, 'utf8'));
require('node:fs').appendFileSync(${JSON.stringify(traceFile)}, JSON.stringify({ at: Date.now(), kind: 'color-reply', pid: process.pid, shellPid: process.ppid, colors: values.match(/rgb:[0-9a-f/]+/gi)?.slice(0, 4) }) + '\\n');
})().catch(() => process.exit(1));
`,
    { mode: 0o700 },
  );
  await writeFile(
    shell,
    `#!/bin/sh
if [ -t 0 ]; then "${colorProbe}"; fi
exec /bin/sh -i
`,
    { mode: 0o700 },
  );
  const ssh = path.join(bin, "ssh");
  await writeFile(
    ssh,
    `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const split = args.indexOf('--');
if (split < 0 || !['fixture-cloud', 'fixture-unreachable', 'fixture-unsupported', 'fixture-no-artifact', 'fixture-old-libc'].includes(args[split + 1])) process.exit(2);
const host = args[split + 1];
if (host === 'fixture-unreachable') { process.stderr.write('private fixture SSH output'); process.exit(255); }
if (host === 'fixture-unsupported') { process.stdout.write('Plan9\\nx86_64\\n'); process.exit(0); }
if (host === 'fixture-no-artifact') { process.stdout.write('Darwin\\n' + (process.platform === 'darwin' && process.arch === 'arm64' ? 'x86_64' : 'arm64') + '\\n'); process.exit(0); }
if (host === 'fixture-old-libc' && args.at(-1).includes('FOOM-LIBC-TOO-OLD')) { process.stdout.write('FOOM-LIBC-TOO-OLD\\n'); process.exit(1); }
if (args.at(-1) === 'uname -s; uname -m') { process.stdout.write(require('node:os').type() + '\\n' + (process.arch === 'x64' ? 'x86_64' : process.platform === 'darwin' ? 'arm64' : 'aarch64') + '\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
appendFileSync(${JSON.stringify(sshLog)}, 'fixture ssh started\\n');
const child = spawn('/bin/sh', ['-c', 'exec ' + args.slice(split + 2).join(' ')], { env: { HOME: ${JSON.stringify(remoteHome)}, PATH: ${JSON.stringify(bin)}, SHELL: ${JSON.stringify(shell)}, LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
const record = require(${JSON.stringify(path.resolve("tests/electron/remote-wire-fixture.js"))}).observeRemoteSsh(process.stdin, child.stdout, ${JSON.stringify(traceFile)}, ${JSON.stringify(manifest.gzipSize)});
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
let diagnosticBytes = 0;
child.stderr.on('data', bytes => { const part = bytes.subarray(0, Math.max(0, 8192 - diagnosticBytes)); diagnosticBytes += part.length; appendFileSync(${JSON.stringify(sshLog)}, part); });
child.on('close', (code, signal) => { record({ kind: 'exit', code, signal }); appendFileSync(${JSON.stringify(sshLog)}, 'fixture ssh exit ' + String(code) + '\\n'); process.exit(code ?? 1); });
`,
    { mode: 0o700 },
  );
  await chmod(ssh, 0o700);

  phase("fixture files and pinned artifact");
  const daemon = spawn(
    "/bin/sh",
    ["-c", 'umask 002; exec "$@"', "fixture-daemon", artifact, "--daemon"],
    {
      env: { HOME: remoteHome, PATH: bin, SHELL: shell, LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  cleanup.audit.add(daemon.pid);
  let stderr = "";
  let stderrBytes = 0;
  daemon.stderr.on("data", (bytes) => {
    const part = bytes.subarray(0, Math.max(0, 8192 - stderrBytes));
    stderrBytes += part.length;
    appendFileSync(daemonLog, part);
    stderr = (stderr + bytes).slice(-8192);
  });
  daemon.once("exit", (code, signal) =>
    appendFileSync(
      traceFile,
      `${JSON.stringify({ at: Date.now(), kind: "daemon-exit", pid: daemon.pid, code, signal })}\n`,
    ),
  );
  const closeDaemon = async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close");
      daemon.kill("SIGTERM");
      await closed;
    }
  };
  cleanup.apps.push(closeDaemon);
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
  phase("daemon startup");
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(socket))).mode & 0o777, 0o700);
  assert.equal(stderr, "");
  return {
    root,
    cleanup,
    remoteHome,
    bin,
    manifest,
    pidFile,
    shell,
    colorRecord,
    colorProbe,
    daemon,
    closeDaemon,
    socket,
    phase,
    traceFile,
    sshOwners: async (id) => [
      ...new Set(
        (await readFile(traceFile, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (row) =>
              row.kind === "response" &&
              row.type === "open-result" &&
              row.state === "live" &&
              row.id === id,
          )
          .map((row) => row.pid),
      ),
    ],
  };
}

async function remoteApp(context, fixture) {
  const { bin, cleanup, manifest } = fixture;
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
  fixture.phase("hub launch");
  const hubHome = await app.evaluate(({ app }) => app.getPath("home"));
  return { app, page, profilePath, profileTag, hubHome };
}

async function remoteShell(page, phase) {
  await page.evaluate(() => {
    window.remoteReplayTokens = new Set();
    window.remoteReplayId = undefined;
    window.stopRemoteReplay = window.desktop.onData((id, token) => {
      if (window.remoteReplayId === undefined || window.remoteReplayId === id)
        window.remoteReplayTokens.add(token);
    });
  });
  await page.evaluate(() => window.desktop.saveSetup({ terminalTheme: "foom-dark" }));
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
  await page.evaluate((id) => {
    window.remoteReplayId = id;
  }, id);
  const tail = () =>
    page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id);
  await expect.poll(tail).toMatch(/[$#>]\s*$/);
  phase("upload and shell bootstrap");
  return { id, tail };
}

async function preparePersistentShell(page, fixture, tail) {
  const { remoteHome, colorProbe } = fixture;
  // A shell variable and PID prove process continuity, not merely replayed text.
  await page.keyboard.type(
    'persist=STILL_ALIVE; printf \'REMOTE_READY:%s:%s\\n\' "$persist" "$$"; pwd',
  );
  await page.keyboard.press("Enter");
  await expect.poll(tail).toContain("REMOTE_READY:STILL_ALIVE:");
  const pid = (await tail()).match(/REMOTE_READY:STILL_ALIVE:(\d+)/)?.[1];
  assert.ok(pid);
  const colorRecord = `${fixture.colorRecord}.${pid}`;
  const darkColors = JSON.parse(await readFile(colorRecord, "utf8"));
  assert.ok(darkColors.includes(oscColor(10, "#f4efff")));
  assert.ok(darkColors.includes(oscColor(11, "#05040a")));
  await expect.poll(async () => (await tail()).replaceAll("\n", "")).toContain(remoteHome);
  await page.keyboard.type(
    "printf 'INITIAL_MASK:'; umask; : > terminal-file; mkdir terminal-dir; umask 027; printf 'MASK_FILES_READY\\n'",
  );
  await page.keyboard.press("Enter");
  await expect.poll(tail).toMatch(/INITIAL_MASK:0*2(?:\n|\r|$)/);
  await expect.poll(tail).toMatch(/(?:^|\n)MASK_FILES_READY(?:\n|$)/);
  assert.equal((await stat(path.join(remoteHome, "terminal-file"))).mode & 0o777, 0o664);
  assert.equal((await stat(path.join(remoteHome, "terminal-dir"))).mode & 0o777, 0o775);
  // Application-set background must survive transport and hub reattachment.
  await page.keyboard.type("printf '\\033]11;#123456\\007'");
  await page.keyboard.press("Enter");
  await page.keyboard.type(`'${colorProbe}'`);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => JSON.parse(await readFile(colorRecord, "utf8")))
    .toContain(oscColor(11, "#123456"));
  fixture.phase("persistent shell preparation");
  return pid;
}

async function hostShellPid(peer, marker = "FIXTURE_PID") {
  await peer.ask({ type: "write", data: `printf '${marker}:%s\\n' "$$"\r` });
  let pid;
  await expect
    .poll(async () => {
      const text = (await peer.ask({ type: "tail", lines: 40 })).lines.join("\n");
      pid = text.match(new RegExp(`(?:^|\\n)${marker}:(\\d+)(?:\\n|$)`))?.[1];
      return Boolean(pid);
    })
    .toBe(true);
  assert.ok(pid);
  return pid;
}

async function hostChannel(
  socket,
  build,
  id,
  cleanup,
  cols = 80,
  rows = 24,
  reattach = false,
  profile = "f".repeat(32),
  palette = {},
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
  const opened = await ask({
    type: "open",
    cols,
    rows,
    reattach,
    ...palette,
    ...(profile ? { profile } : {}),
  });
  if (!reattach && opened.state === "live")
    await expect
      .poll(async () => (await ask({ type: "tail", lines: 4 })).lines.join("\n"))
      .toMatch(/[$#>]\s*$/);
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
