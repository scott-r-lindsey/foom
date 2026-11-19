const { evidencePath } = require("../helpers/evidence.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, unlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  confirmationPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

test("an agent configures Foom in the config folder with validation and approval", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const { DEFAULT_SOUND } = require("../../build/shared/sounds.js");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-env-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  const palette = interfaceThemes["eclipse-dark"];
  const good = { kind: "theme", name: "Agent", base: palette.base, colors: palette.colors };
  const bad = { ...good, colors: { ...palette.colors, accent: "not a color" } };
  // The fake agent edits files when keys arrive, like an agent following AGENTS.md.
  await writeFile(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log("  --settings <file-or-json>  Load settings"); process.exit(0); }
const theme = (value) => writeFileSync("themes/agent.json", JSON.stringify(value));
writeFileSync(${JSON.stringify(path.join(root, "agent-cwd.txt"))}, process.cwd());
process.stdout.write("FOOM_CONFIG_AGENT_READY\\r\\n");
process.stdin.setRawMode(true);
process.stdin.on("data", (key) => {
  const input = key.toString();
  if (input === "t" || input === "g") theme(${JSON.stringify(good)});
  if (input === "i") theme(${JSON.stringify(bad)});
  if (input === "s") {
    const settings = JSON.parse(readFileSync("settings.json", "utf8"));
    settings.sound = { ...${JSON.stringify(DEFAULT_SOUND)}, alerts: false };
    writeFileSync("settings.json", JSON.stringify(settings));
  }
  if (input === "t" || input === "v") {
    const result = spawnSync("foom", ["config", "validate", "."], { encoding: "utf8" });
    process.stdout.write("validate exit=" + result.status + "\\r\\n");
  }
});
`,
  );
  await chmod(path.join(bin, "claude"), 0o755);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  const folder = path.join(home, ".foom", "config");
  const gear = page.locator(".config-gear");
  await expect(gear).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Foom config" })).toHaveCount(0);
  // 1. Launch a fake agent in Foom config from the footer panel.
  await page.locator(".config-gear").click();
  const panel = page.getByRole("dialog", { name: "Foom config details and commands" });
  await expect(panel).toContainText(folder);
  await panel.getByRole("menuitem", { name: "Via Claude Code", exact: true }).click();
  const id = await expect
    .poll(async () => {
      const snapshot = await page.evaluate(() => window.desktop.workspace());
      return snapshot.terminals.find((entry) => entry.config)?.id ?? null;
    })
    .not.toBeNull()
    .then(async () => {
      const snapshot = await page.evaluate(() => window.desktop.workspace());
      return snapshot.terminals.find((entry) => entry.config).id;
    });
  const tail = () =>
    page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id);
  // Long temporary paths wrap in the terminal, so the agent reports its cwd in a file.
  await expect.poll(tail).toContain("FOOM_CONFIG_AGENT_READY");
  assert.equal(
    await realpath(await readFile(path.join(root, "agent-cwd.txt"), "utf8")),
    await realpath(folder),
  );
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.equal(snapshot.terminals.find((entry) => entry.id === id).attention, "hooks");

  // 2. It writes a theme and validates the folder with the bundled CLI.
  await page.evaluate((id) => window.desktop.input(id, "t"), id);
  await expect.poll(tail).toContain("validate exit=0");
  await boardCommand(app, ",", process.platform !== "darwin");
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("button", { name: "Foom config", exact: true }).click();
  // Nothing needs the user, so the section lists nothing beyond the folder.
  await expect(page.getByRole("button", { name: "Open folder", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent changes" })).toHaveCount(0);
  const problems = page.getByRole("list", { name: "Rejected files" });
  await expect(problems).toHaveCount(0);
  await sections.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: /^Theme / }).click();
  await expect(page.getByRole("menuitemradio", { name: "Agent", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // 3. An invalid theme is rejected and the last good colors stay.
  await page.evaluate((id) => window.desktop.input(id, "i"), id);
  await sections.getByRole("button", { name: "Foom config", exact: true }).click();
  const rejected = problems.getByRole("listitem").filter({ hasText: "themes/agent.json" });
  await expect(rejected).toContainText("$.colors.accent: not-a-color");
  const catalog = await page.evaluate(() => window.desktop.listThemes());
  assert.equal(
    catalog.interface.find((entry) => entry.theme.name === "Agent").theme.colors.accent,
    palette.colors.accent,
  );

  // 4. Turning off the needs-you sound is held; Keep it on restores the file.
  await page.evaluate((id) => window.desktop.input(id, "s"), id);
  const banner = page.getByRole("region", { name: "Change waiting for approval" });
  await expect(banner).toContainText("An agent wants to turn off the needs-you sound");
  await expect(banner).toHaveCSS("border-top-color", /rgb/);
  await page.locator(".config-gear").click();
  await expect(page.locator(".config-dock")).toContainText("Needs you");
  await expect(gear).toHaveAttribute("aria-label", /needs you/);
  await expect(gear).toHaveAttribute("data-tone", "needs");
  // Both statuses remain readable inside the forced compact rail.
  const originalSize = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    const size = window.getContentBounds();
    window.setMinimumSize(1, 1);
    window.setContentSize(640, 720);
    return size;
  });
  const sidebar = page.locator(".sidebar-shell");
  await expect(sidebar).toHaveAttribute("data-compact", "true");
  await expect(page.locator(".config-dock")).toHaveCount(0);
  await expect(page.locator(".rail-needs")).toContainText("need you");
  await expect(gear).toHaveAttribute("aria-label", /needs you.*rejected/);
  await expect(page.locator(".board-list .board-row").filter({ hasText: "CC" })).toBeVisible();
  await page.screenshot({
    path: evidencePath("config-footer-compact.png"),
    animations: "disabled",
  });
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(size.width, size.height);
  }, originalSize);
  await expect(sidebar).toHaveAttribute("data-compact", "false");
  // Resizing dismisses the panel; reopen it to inspect its approval facts.
  await gear.click();

  await expect(panel).toContainText("Needs you");
  await page.keyboard.press("Escape");
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.sound.alerts,
    true,
  );
  await banner.getByRole("button", { name: "Keep it on" }).click();
  await expect(banner).toHaveCount(0);
  const restored = JSON.parse(await readFile(path.join(folder, "settings.json"), "utf8"));
  assert.notEqual(restored.sound?.alerts, false);

  // 5. A fixed theme clears its rejection; Foom never made the folder a git repository.
  await page.evaluate((id) => window.desktop.input(id, "g"), id);
  await expect
    .poll(() => readFile(path.join(folder, "themes/agent.json"), "utf8"))
    .toBe(JSON.stringify(good));
  await expect(rejected).toHaveCount(0);
  await assert.rejects(require("node:fs/promises").access(path.join(folder, ".git")));
  await assertAccessible(page);
});

test("config agents receive only the bundled manual and revoke the attachment on exit", {
  timeout: deadline(90_000),
}, async (context) => {
  const { installManualAgent } = require("./manual-agent.js");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-manual-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  const report = await installManualAgent(home, bin, true);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await page.locator(".config-gear").click();
  await page
    .getByRole("dialog", { name: "Foom config details and commands" })
    .getByRole("menuitem", { name: "Via Codex", exact: true })
    .click();
  let result;
  await expect
    .poll(async () => {
      try {
        result = JSON.parse(await readFile(report, "utf8"));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.tools, ["manual"]);
  assert.equal(result.instructions, "For questions about using Foom, call manual.");
  assert.ok(result.refused.includes("whoami"));
  assert.ok(result.refused.includes("handoff"));
  assert.ok(result.refused.includes("launch"));
  const index = JSON.parse(await readFile("build/manual/sections.json", "utf8"));
  assert.equal(result.text, index.find((section) => section.id === "shortcuts").text);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (entry) => entry.config,
        )?.exitCode,
    )
    .toBe(0);
  await expect
    .poll(async () => {
      try {
        await fetch(result.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${result.token}`, "Content-Type": "application/json" },
          body: "{}",
        });
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
});

test("an exited agy config tile closes in place with a saved conversation", {
  timeout: deadline(60_000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-close-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const plugin = path.join(home, ".gemini/config/plugins/foom");
  await mkdir(bin);
  await mkdir(plugin, { recursive: true });
  await writeFile(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "foom", foomObserverVersion: 2 }),
  );
  await writeFile(
    path.join(bin, "agy"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.3.3"); process.exit(0); }
if (args[0] === "--help") { console.log("--conversation <id>"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "list") { console.log(JSON.stringify({ imports: [{ name: "foom" }] })); process.exit(0); }
process.stdout.write("CONFIG_AGENT_READY\\r\\n");
process.stdin.setRawMode(true);
process.stdin.once("data", () => {
  const request = require("node:http").request(process.env.FOOM_HOOK_URL, {
    method: "POST",
    headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "X-Foom-Event": "Stop", "X-Foom-Sequence": "1", "Content-Type": "application/json" },
  }, response => {
    response.resume();
    response.on("end", () => process.exit(response.statusCode === 204 ? 0 : 1));
  });
  request.on("error", () => process.exit(1));
  request.end(JSON.stringify({ conversationId: "config-conversation", fullyIdle: true, terminationReason: "NO_TOOL_CALL" }));
});
`,
  );
  await chmod(path.join(bin, "agy"), 0o755);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await page.locator(".config-gear").click();
  await page
    .getByRole("dialog", { name: "Foom config details and commands" })
    .getByRole("menuitem", { name: "Via Antigravity", exact: true })
    .click();
  const terminal = async () =>
    (await page.evaluate(() => window.desktop.workspace())).terminals.find((row) => row.config);
  await expect.poll(terminal).toMatchObject({ agent: "agy", exited: false });
  const id = (await terminal()).id;
  await expect
    .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id))
    .toContain("CONFIG_AGENT_READY");
  const tile = page.locator('.terminal-tile[data-kind="agent"]');
  await expect(tile.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
  await page.evaluate((id) => window.desktop.input(id, "q"), id);
  await expect
    .poll(terminal)
    .toMatchObject({ exited: true, exitCode: 0, conversationId: "config-conversation" });
  await expect(tile.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await tile.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(terminal).toBeUndefined();
  await expect(tile).toHaveCount(0);
  await expect(page.locator(".config-dock")).toHaveCount(0);
});

for (const helpExit of [0, 2]) {
  test(`an agy config session greets with stderr help and help exit ${helpExit}`, {
    timeout: deadline(90_000),
    skip: process.platform === "win32" && "The fake agent is a POSIX script",
  }, async (context) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-agy-greeting-")));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    const report = path.join(root, "args.json");
    await mkdir(bin);
    await mkdir(home);
    await writeFile(
      path.join(bin, "agy"),
      `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.3.3"); process.exit(0); }
if (args[0] === "--help") { console.error("--prompt-interactive <prompt>"); process.exit(${helpExit}); }
if (args[0] === "plugin") { console.log("No imported plugins."); process.exit(0); }
writeFileSync(${JSON.stringify(report)}, JSON.stringify(args));
const index = args.indexOf("--prompt-interactive");
if (index >= 0 && args[index + 1].includes("greet")) {
  console.log("FAKE_AGY_GREETING: What would you like to change?");
}
process.stdin.resume();
`,
      { mode: 0o700 },
    );
    const app = await launchApp(context, {
      fixture: "agent",
      home,
      env: { HOME: home, PATH: bin },
    });
    const page = await boardPage(app);
    await page.locator(".config-gear").click();
    await page
      .getByRole("dialog", { name: "Foom config details and commands" })
      .getByRole("menuitem", { name: "Via Antigravity", exact: true })
      .click();
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.desktop.workspace());
        const id = snapshot.terminals.find((entry) => entry.config)?.id;
        return id
          ? page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id)
          : "";
      })
      .toContain("FAKE_AGY_GREETING");
    const args = JSON.parse(await readFile(report, "utf8"));
    assert.ok(args[args.indexOf("--prompt-interactive") + 1].includes("greet"));
    assert.ok(!args.includes("--conversation"));
  });
}

test("fresh profiles adopt shared config without resetting a running profile", {
  timeout: deadline(60_000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-adoption-")));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const profileA = path.join(root, "a");
  const profileB = path.join(root, "b");
  const a = await launchApp(context, {
    fixture: "empty-board",
    home,
    args: [`--user-data-dir=${profileA}`],
  });
  const pageA = await boardPage(a);
  await pageA.evaluate(() =>
    window.desktop.saveSetup({
      interfaceTheme: "eclipse-dark",
      terminalFontSize: 19,
      hooks: false,
    }),
  );
  const file = path.join(home, ".foom", "config", "settings.json");
  const before = await readFile(file);
  // A v1 profile and window placement must not overwrite an adopted file either.
  await mkdir(profileB, { recursive: true });
  await writeFile(
    path.join(profileB, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: { interfaceTheme: "eclipse-light", interfaceScale: 110, checkForUpdates: false },
    }),
  );
  const b = await launchApp(context, {
    fixture: "first-run",
    home,
    args: [`--user-data-dir=${profileB}`],
  });
  const pageB = await boardPage(b);
  await pageB.getByRole("button", { name: "Start preflight" }).waitFor();
  assert.deepEqual(await readFile(file), before);
  assert.equal(
    (await pageB.evaluate(() => window.desktop.setupState())).settings.interfaceTheme,
    "follow",
  );
  assert.equal(
    (await pageA.evaluate(() => window.desktop.setupState())).settings.interfaceTheme,
    "eclipse-dark",
  );
  assert.equal(
    (await pageB.evaluate(() => window.desktop.configStatus())).pending.detail,
    "hooks: on → off",
  );
  // Wait for A's real scanner to process a later event before checking its theme.
  await writeFile(path.join(home, ".foom", "config", "themes", "barrier.json"), "{}");
  await expect
    .poll(async () =>
      (await pageA.evaluate(() => window.desktop.configStatus())).rejected.some(
        (entry) => entry.file === "themes/barrier.json",
      ),
    )
    .toBe(true);
  assert.equal(
    (await pageA.evaluate(() => window.desktop.setupState())).settings.interfaceTheme,
    "eclipse-dark",
  );
  assert.deepEqual(await readFile(file), before);
});

function foreignSettingsLock() {
  return JSON.stringify({
    hostname: require("node:os").hostname() + ".foreign.example",
    pid: 1,
    start: null,
    timestamp: 0,
    token: "foreign-fixture-owner",
  });
}

test("a persistent foreign Settings lock opens the board and defers config saves until release", {
  timeout: deadline(45_000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-foreign-lock-")));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const folder = path.join(home, ".foom", "config");
  const profile = path.join(root, "profile");
  const file = path.join(folder, "settings.json");
  const lock = path.join(folder, ".foom-settings.lock");
  const settings = '{"kind":"settings","terminalFontSize":19}';
  const foreign = foreignSettingsLock();
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const palette = interfaceThemes["eclipse-light"];
  await mkdir(path.join(folder, "themes"), { recursive: true });
  await writeFile(
    path.join(folder, "themes", "review.json"),
    JSON.stringify({
      kind: "theme",
      name: "Awaiting Review",
      base: palette.base,
      colors: { ...palette.colors, attention: palette.colors.ink },
    }),
  );
  await writeFile(file, settings);
  await writeFile(lock, foreign);
  const profileSettings = path.join(profile, "settings.json");
  await mkdir(profile);
  await writeFile(
    profileSettings,
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        interfaceScale: 110,
        interfaceTheme: "user:review.json",
        checkForUpdates: false,
      },
    }),
  );

  const app = await launchApp(context, {
    fixture: "empty-board",
    home,
    args: [`--user-data-dir=${profile}`],
  });
  const page = await boardPage(app);
  await boardCommand(app, ",", process.platform !== "darwin");
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("button", { name: "Foom config", exact: true }).click();
  const busy = page.getByText("Settings are busy; try again.", { exact: true });
  await expect(busy).toBeVisible();
  const during = await page.evaluate(async () => ({
    appearance: (await window.desktop.setupState()).settings.interfaceTheme,
    catalog: (await window.desktop.listThemes()).interface,
  }));
  assert.equal(during.appearance, "follow");
  assert.deepEqual(during.catalog, []);
  await assert.rejects(
    page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 120 })),
    /foom-error:settings-busy/,
  );
  const profileOnly = await page.evaluate(() =>
    window.desktop.saveSetup({ middleClickPaste: true }),
  );
  assert.equal(profileOnly.settings.middleClickPaste, true);
  assert.equal(await readFile(file, "utf8"), settings);
  assert.equal(await readFile(lock, "utf8"), foreign);
  const savedProfile = JSON.parse(await readFile(profileSettings, "utf8"));
  assert.equal(savedProfile.version, 1);
  assert.equal(savedProfile.settings.interfaceScale, 110);
  assert.equal(savedProfile.settings.interfaceTheme, "user:review.json");
  assert.equal(savedProfile.settings.middleClickPaste, true);

  await unlink(lock);
  await expect(busy).toHaveCount(0);
  const result = await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 120 }));
  assert.equal(result.settings.interfaceScale, 120);
  assert.equal(result.settings.terminalFontSize, 19);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    kind: "settings",
    terminalFontSize: 19,
    interfaceScale: 120,
  });
  assert.equal(JSON.parse(await readFile(profileSettings, "utf8")).version, 2);
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.listThemes())).interface)
    .toMatchObject([{ id: "user:review.json", theme: { name: "Awaiting Review" } }]);
  assert.equal(result.settings.interfaceTheme, "follow");
});

for (const restoreSessions of [false, true]) {
  test(`a busy Settings lock waits to restore saved shells with restoreSessions=${restoreSessions}`, {
    timeout: deadline(45_000),
  }, async (context) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-lock-restore-")));
    removeAfterApps(context, root);
    const home = path.join(root, "home");
    const folder = path.join(home, ".foom", "config");
    const profile = path.join(root, "profile");
    await mkdir(folder, { recursive: true });
    await mkdir(profile);
    const lock = path.join(folder, ".foom-settings.lock");
    const configText = JSON.stringify({ kind: "settings", restoreSessions });
    const { createHash } = require("node:crypto");
    await writeFile(path.join(folder, "settings.json"), configText);
    await writeFile(lock, foreignSettingsLock());
    await writeFile(
      path.join(profile, "settings.json"),
      JSON.stringify({
        version: 2,
        settings: { setupComplete: true, checkForUpdates: false },
        configText,
        configDigest: createHash("sha256").update(configText).digest("hex"),
      }),
    );
    await writeFile(
      path.join(profile, "sessions.json"),
      JSON.stringify([
        {
          id: "saved-config-shell",
          agent: "shell",
          repository: folder,
          worktree: folder,
          branch: null,
          config: true,
          running: true,
        },
        {
          id: "saved-home-shell",
          agent: "shell",
          repository: home,
          worktree: home,
          branch: null,
          home: true,
          running: true,
        },
      ]),
    );

    const app = await launchApp(context, {
      fixture: "restored",
      home,
      args: [`--user-data-dir=${profile}`],
    });
    const page = await boardPage(app);
    const rows = () =>
      page.evaluate(async () =>
        (await window.desktop.workspace()).terminals.map(({ id, dormant, exited }) => ({
          id,
          state: dormant ? "dormant" : exited ? "exited" : "running",
        })),
      );
    const matches = (running) =>
      expect.arrayContaining(
        ["saved-config-shell", "saved-home-shell"].map((id) => ({
          id,
          state: running ? "running" : "dormant",
        })),
      );
    assert.equal(
      (await page.evaluate(() => window.desktop.setupState())).settings.restoreSessions,
      restoreSessions,
    );
    assert.match(
      (await page.evaluate(() => window.desktop.configStatus())).error,
      /Settings are busy/,
    );
    await expect.poll(rows).toEqual(matches(false));
    await unlink(lock);
    await expect
      .poll(async () => (await page.evaluate(() => window.desktop.configStatus())).error)
      .toBeUndefined();
    await expect.poll(rows).toEqual(matches(restoreSessions));
    assert.equal((await rows()).length, 2);
  });
}

async function launchWithDeferredShell(
  context,
  restoreSessions,
  config,
  { savedCount = 1, copilot = false } = {},
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-deferred-shell-")));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const folder = path.join(home, ".foom", "config");
  const profile = path.join(root, "profile");
  const lock = path.join(folder, ".foom-settings.lock");
  await mkdir(folder, { recursive: true });
  await mkdir(profile);
  const bin = path.join(root, "bin");
  const marker = path.join(root, "copilot-launched");
  if (copilot) {
    await mkdir(bin);
    await writeFile(
      path.join(bin, "copilot"),
      `#!/usr/bin/env node
const option = process.argv[2];
if (option === "--version") console.log("GitHub Copilot CLI 1.0.103.");
else if (option === "--help") console.log("--plugin-dir --additional-mcp-config --interactive --session-id --resume");
else require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");
`,
      { mode: 0o755 },
    );
  }
  await writeFile(lock, foreignSettingsLock());
  await writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        checkForUpdates: false,
        restoreSessions,
        ...(copilot ? { agents: { copilot: true }, hooks: false } : {}),
      },
    }),
  );
  const id = "saved-shell";
  const directory = config ? folder : home;
  await writeFile(
    path.join(profile, "sessions.json"),
    JSON.stringify(
      Array.from({ length: savedCount }, (_, index) => ({
        id: index === 0 ? id : `${id}-${index}`,
        agent: copilot ? "copilot" : "shell",
        ...(copilot ? { conversationId: "12345678-1234-4234-8234-123456789abc" } : {}),
        repository: directory,
        worktree: directory,
        branch: null,
        ...(config ? { config: true } : { home: true }),
        running: true,
      })),
    ),
  );
  const app = await launchApp(context, {
    fixture: "restored",
    home,
    ...(copilot ? { env: { PATH: bin, COPILOT_ALLOW_ALL: "1" } } : {}),
    args: [`--user-data-dir=${profile}`],
  });
  const page = await boardPage(app);
  assert.match(
    (await page.evaluate(() => window.desktop.configStatus())).error,
    /Settings are busy/,
  );
  return { app, page, id, lock, marker, profile };
}

async function deferredRestoreAtQuit(context, savedCount) {
  const { app, page, id, lock } = await launchWithDeferredShell(context, true, true, {
    savedCount,
  });
  const home = await page.evaluate(() => window.desktop.sidebarCommand({ kind: "home-shell" }));
  const rows = () => page.evaluate(async () => (await window.desktop.workspace()).terminals);
  await expect
    .poll(async () => (await rows()).find((row) => row.id === home.terminalId)?.dormant)
    .toBeUndefined();
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { ThemeLibrary } = load("./build/main/themes/library.js");
    const { Workspace } = load("./build/main/workspace/workspace.js");
    const initialize = ThemeLibrary.prototype.initialize;
    ThemeLibrary.prototype.initialize = async function () {
      await initialize.call(this);
      // Allow the startup continuation to reach its quit check after theme initialization.
      setImmediate(() => {
        globalThis.deferredRestoreReachedQuit = true;
      });
    };
    const restartSaved = Workspace.prototype.restartSaved;
    Workspace.prototype.restartSaved = function () {
      globalThis.deferredRestoreStarted = true;
      return restartSaved.call(this);
    };
    app.quit();
  });
  const confirmation = await confirmationPage(app);
  const card = confirmation.getByRole("alertdialog");
  await expect(card).toHaveAccessibleName("Quit with 1 terminal running?");
  await unlink(lock);
  await expect.poll(() => app.evaluate(() => globalThis.deferredRestoreReachedQuit)).toBe(true);
  assert.equal(await app.evaluate(() => globalThis.deferredRestoreStarted), undefined);
  const sessions = await rows();
  assert.equal(sessions.find((row) => row.id === id)?.dormant, true);
  assert.deepEqual(
    sessions.filter((row) => !row.dormant && !row.exited).map((row) => row.id),
    [home.terminalId],
  );
  await expect(card).toHaveAccessibleName("Quit with 1 terminal running?");
  return { app, confirmation, id, rows };
}

test("deferred config restore skips a saved shell while quit confirmation is pending", {
  timeout: deadline(45_000),
}, async (context) => {
  const { app, confirmation } = await deferredRestoreAtQuit(context);
  await quitAndWait(app, () =>
    confirmation.getByRole("button", { name: "Stop all and quit", exact: true }).click(),
  );
});

test("canceling quit resumes deferred config restore", {
  timeout: deadline(45_000),
}, async (context) => {
  const { confirmation, id, rows } = await deferredRestoreAtQuit(context);
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .poll(async () => (await rows()).filter((row) => !row.dormant && !row.exited).length)
    .toBe(2);
  assert.equal((await rows()).find((row) => row.id === id)?.dormant, undefined);
});

test("a second quit counts all shells from an in-flight startup restore", {
  timeout: deadline(45_000),
}, async (context) => {
  const savedCount = 4;
  const { app, confirmation, rows } = await deferredRestoreAtQuit(context, savedCount);
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { SessionOwner } = load("./build/main/workspace/session-owner.js");
    const restartSavedEntry = SessionOwner.prototype.restartSavedEntry;
    const gate = new Promise((resolve) => {
      globalThis.releaseSavedShells = resolve;
    });
    let launches = 0;
    SessionOwner.prototype.restartSavedEntry = async function (entry) {
      // Shells share the config worktree, so the second launch follows the first.
      if (++launches === 2) {
        globalThis.savedShellsPaused = true;
        await gate;
      }
      return restartSavedEntry.call(this, entry);
    };
  });
  try {
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => app.evaluate(() => globalThis.savedShellsPaused)).toBe(true);
    assert.equal((await rows()).filter((row) => !row.dormant && !row.exited).length, 2);
    await app.evaluate(({ app }) => app.quit());
  } finally {
    await app.evaluate(() => globalThis.releaseSavedShells());
  }
  const second = await confirmationPage(app);
  await expect
    .poll(async () => (await rows()).filter((row) => !row.dormant && !row.exited).length)
    .toBe(savedCount + 1);
  await expect(second.getByRole("alertdialog")).toHaveAccessibleName(
    `Quit with ${savedCount + 1} terminals running?`,
  );
  await quitAndWait(app, () =>
    second.getByRole("button", { name: "Stop all and quit", exact: true }).click(),
  );
});

test("disabled startup restore exposes Restart shell while the Settings lock is busy", {
  timeout: deadline(45_000),
}, async (context) => {
  const { page, id, lock } = await launchWithDeferredShell(context, false, false);
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.equal(snapshot.terminals.find((row) => row.id === id)?.exited, true);
  const row = page.locator(".board-row[data-kind='shell'][data-exited='true']");
  await row.locator(".row-actions").click();
  await page.getByRole("menuitem", { name: "Restart shell", exact: true }).click();
  await expect
    .poll(async () => {
      const { terminals } = await page.evaluate(() => window.desktop.workspace());
      return terminals.some((row) => row.id !== id && row.home && !row.dormant && !row.exited);
    })
    .toBe(true);
  assert.equal(await readFile(lock, "utf8"), foreignSettingsLock());
});

for (const approvalOpen of [false, true]) {
  test(`quit declines a restored Copilot bypass approval ${approvalOpen ? "already open" : "not yet open"}`, {
    timeout: deadline(45_000),
    skip: process.platform === "win32" && "The Copilot fixture is a POSIX executable",
  }, async (context) => {
    const { app, page, id, lock, marker } = await launchWithDeferredShell(context, true, true, {
      copilot: true,
    });
    await page.evaluate(() => window.desktop.sidebarCommand({ kind: "home-shell" }));
    await app.evaluate(({ app }, pause) => {
      const load = process
        .getBuiltinModule("node:module")
        .createRequire(app.getAppPath() + "/package.json");
      const { SessionOwner } = load("./build/main/workspace/session-owner.js");
      const restartSavedEntry = SessionOwner.prototype.restartSavedEntry;
      const gate = new Promise((resolve) => {
        globalThis.releaseCopilotRestore = resolve;
      });
      SessionOwner.prototype.restartSavedEntry = async function (entry) {
        if (pause) {
          globalThis.copilotRestorePaused = true;
          await gate;
        }
        return restartSavedEntry.call(this, entry);
      };
    }, !approvalOpen);
    try {
      await unlink(lock);
      if (approvalOpen) {
        const approval = await confirmationPage(app);
        await expect(approval.getByRole("alertdialog")).toHaveAccessibleName(
          "Launch GitHub Copilot with bypass?",
        );
      } else {
        await expect.poll(() => app.evaluate(() => globalThis.copilotRestorePaused)).toBe(true);
      }
      await app.evaluate(({ app }) => app.quit());
    } finally {
      await app.evaluate(() => globalThis.releaseCopilotRestore());
    }
    const confirmation = await confirmationPage(app);
    await expect(confirmation.getByRole("alertdialog")).toHaveAccessibleName(
      "Quit with 1 terminal running?",
    );
    const { terminals } = await page.evaluate(() => window.desktop.workspace());
    assert.equal(terminals.find((row) => row.id === id)?.exited, true);
    await quitAndWait(app, () =>
      confirmation.getByRole("button", { name: "Stop all and quit", exact: true }).click(),
    );
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
}

test("canceling quit after a restore timeout resumes all saved shells", {
  timeout: deadline(45_000),
}, async (context) => {
  const { app, page, id, lock } = await launchWithDeferredShell(context, true, true, {
    savedCount: 4,
  });
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "home-shell" }));
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { SessionOwner } = load("./build/main/workspace/session-owner.js");
    const restartSavedEntry = SessionOwner.prototype.restartSavedEntry;
    const gate = new Promise((resolve) => {
      globalThis.releaseRestore = resolve;
    });
    SessionOwner.prototype.restartSavedEntry = async function (entry) {
      if (!globalThis.restoreLaunchStalled) {
        globalThis.restoreLaunchStalled = true;
        await gate;
      }
      return restartSavedEntry.call(this, entry);
    };
  });
  const rows = () => page.evaluate(async () => (await window.desktop.workspace()).terminals);
  try {
    await unlink(lock);
    await expect.poll(() => app.evaluate(() => globalThis.restoreLaunchStalled)).toBe(true);
    await app.evaluate(({ app }) => app.quit());
    const confirmation = await confirmationPage(app);
    const card = confirmation.getByRole("alertdialog");
    await expect(card).toHaveAccessibleName("Quit with 1 terminal running?");
    const queued = (await rows()).filter((row) => row.id.startsWith(`${id}-`));
    assert.equal(queued.length, 3);
    assert.ok(queued.every((row) => row.dormant && row.exited));
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toBeHidden();
  } finally {
    await app.evaluate(() => globalThis.releaseRestore());
  }
  await expect
    .poll(async () => (await rows()).filter((row) => !row.dormant && !row.exited).length)
    .toBe(5);
});

test("quit finishes while a startup restore launch remains stalled", {
  timeout: deadline(45_000),
}, async (context) => {
  const { app, page, id, lock, profile } = await launchWithDeferredShell(context, true, true, {
    savedCount: 4,
  });
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "home-shell" }));
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { SessionOwner } = load("./build/main/workspace/session-owner.js");
    SessionOwner.prototype.restartSavedEntry = function () {
      globalThis.restoreLaunchStalled = true;
      return new Promise(() => {});
    };
  });
  await unlink(lock);
  await expect.poll(() => app.evaluate(() => globalThis.restoreLaunchStalled)).toBe(true);
  await app.evaluate(({ app }) => app.quit());
  const confirmation = await confirmationPage(app);
  await expect(confirmation.getByRole("alertdialog")).toHaveAccessibleName(
    "Quit with 1 terminal running?",
  );
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "close", id }), `${id}-3`);
  await quitAndWait(app, () =>
    confirmation.getByRole("button", { name: "Stop all and quit", exact: true }).click(),
  );
  const saved = JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8")).filter(
    (row) => row.id.startsWith(id),
  );
  assert.equal(saved.length, 3);
  assert.ok(saved.every((row) => row.running === true));
});

test("start:fresh state isolation keeps config and worktrees inside its temporary profile", async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-fresh-state-")));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const profile = path.join(root, "profile");
  const shared = path.join(home, ".foom");
  await mkdir(path.join(shared, "config"), { recursive: true });
  const sentinel = '{ "kind": "settings", "interfaceTheme": "eclipse-light" }\n';
  await writeFile(path.join(shared, "config", "settings.json"), sentinel);
  const app = await launchApp(context, {
    fixture: "empty-board",
    home,
    args: [`--user-data-dir=${profile}`, "--foom-isolated-state"],
  });
  const page = await boardPage(app);
  const status = await page.evaluate(() => window.desktop.configStatus());
  assert.equal(status.folder, path.join(profile, ".foom", "config"));
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).worktreeRoot,
    path.join(profile, ".foom", "worktrees"),
  );
  await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "eclipse-dark" }));
  assert.equal(
    JSON.parse(await readFile(path.join(profile, ".foom", "config", "settings.json"), "utf8"))
      .interfaceTheme,
    "eclipse-dark",
  );
  assert.equal(await readFile(path.join(shared, "config", "settings.json"), "utf8"), sentinel);
  const { readdir } = require("node:fs/promises");
  assert.deepEqual(await readdir(shared), ["config"]);
});
