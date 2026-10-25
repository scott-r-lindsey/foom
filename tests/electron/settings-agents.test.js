const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
  stopSession,
} = require("./harness.js");

test("Environment settings reach a launched shell; main refuses reserved names", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.waitForFunction(() => typeof window.desktop?.saveEnvironment === "function");
  const refused = await page.evaluate(() =>
    window.desktop
      .saveEnvironment({
        scope: "all",
        previous: null,
        name: "FOOM_CONTROL_TOKEN",
        value: "x",
        secret: false,
      })
      .then(
        () => "saved",
        (error) => String(error),
      ),
  );
  assert.match(refused, /foom-error:operation-failed/);
  const state = await page.evaluate(async () => {
    const save = (scope, name, value) =>
      window.desktop.saveEnvironment({ scope, previous: null, name, value, secret: false });
    await save("all", "HTTPS_PROXY", "http://127.0.0.1:9");
    await save("all", "NO_PROXY", ".corp.example");
    await save("codex", "AGENT_ONLY_215", "codex");
    return window.desktop.environmentState();
  });
  assert.deepEqual(
    state.lists.all.map((row) => row.name),
    ["HTTPS_PROXY", "NO_PROXY"],
  );
  const id = await page.evaluate(async () => {
    const terminal = await window.desktop.create(80, 24);
    window.environmentExited = false;
    window.desktop.onExit((exited) => {
      if (exited === terminal.id) window.environmentExited = true;
    });
    return terminal.id;
  });
  const command =
    process.platform === "win32"
      ? 'Write-Output ("ENV_" + "READ:" + $env:HTTPS_PROXY + "|" + $env:NO_PROXY + "|" + $env:AGENT_ONLY_215 + "|")'
      : 'printf \'ENV_%s:%s|%s|%s|\\n\' READ "$HTTPS_PROXY" "$NO_PROXY" "$AGENT_ONLY_215"';
  await page.evaluate(({ id, command }) => window.desktop.input(id, command + "; exit\r"), {
    id,
    command,
  });
  await page.waitForFunction(() => window.environmentExited);
  const line = (await page.evaluate((id) => window.desktop.tail(id, 40), id)).find((entry) =>
    entry.startsWith("ENV_READ:"),
  );
  assert.equal(line, "ENV_READ:http://127.0.0.1:9|.corp.example,localhost,127.0.0.1,::1||");
});

test("Settings persists literal agent defaults and discloses bypass once per agent", {
  timeout: deadline(60_000),
}, async (context) => {
  const { copyFile, chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-default-args-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const output = path.join(root, "argv.json");
  await Promise.all([bin, home, repo].map((directory) => mkdir(directory)));
  // A real Node executable is a cross-platform fixture agent. Its unrecognized version
  // falls back to output evaluation; --eval records execArgv plus positional argv.
  const executable = path.join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: repo },
  );
  const profile = path.join(root, "profile");
  const app = await launchApp(context, {
    fixture: "agent",
    args: [`--user-data-dir=${profile}`],
    env: { HOME: home, PATH: bin, TEST_ARGV: output },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const input = page.getByLabel("Claude Code default arguments");
  await expect(input).toBeVisible();
  await input.fill("--settings={}");
  await input.blur();
  await expect(page.locator(".agent-card [role=alert]")).toHaveText("Unable to update settings.");
  const args = [
    "--eval",
    'require("node:fs").writeFileSync(process.env.TEST_ARGV, JSON.stringify([...process.execArgv, ...process.argv.slice(1)])); setInterval(() => {}, 1000)',
    "value with spaces",
    "'literal quotes'",
    "$(not-a-command); &",
    "--dangerously-skip-permissions",
  ];
  await input.fill(`${args.join("\r\n")}\r\n\r\n`);
  await input.blur();
  const disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Save bypass defaults for Claude Code?",
  );
  await expect(disclosure.getByRole("alertdialog")).toContainText(
    "A worktree is not a sandbox. With these arguments, the agent can act as you anywhere on the machine.",
  );
  await expect(disclosure.getByRole("button", { name: "Cancel" })).toBeFocused();
  const disclosureScan = await new AxeBuilder({ page: disclosure }).setLegacyMode().analyze();
  assert.deepEqual(disclosureScan.violations, []);
  await disclosure.keyboard.press("Enter");
  await expect(page.locator(".agent-card [role=alert]")).toHaveText("Unable to update settings.");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.claude,
    [],
  );
  await input.focus();
  await input.blur();
  await disclosure.getByRole("button", { name: "Save bypass defaults", exact: true }).click();
  // Errors clear and the disclosure closes before saving finishes. The field stays
  // disabled until saveSetup settles, including both config and profile writes.
  await expect(input).toBeEnabled();
  await expect(page.locator(".agent-card [role=alert]")).toHaveCount(0);
  await input.blur();
  await expect(page.locator(".agent-card [role=alert]")).toHaveCount(0);
  await expect(disclosure.getByRole("alertdialog")).toHaveCount(0);
  const persisted = JSON.parse(
    await readFile(path.join(profile, "settings.json"), "utf8"),
  ).settings;
  assert.equal(persisted.agentArguments, undefined);
  const configArguments = JSON.parse(
    await readFile(path.join(home, ".foom/config/settings.json"), "utf8"),
  ).agentArguments;
  assert.deepEqual(configArguments.claude, args);
  assert.equal(persisted.agentBypassAcknowledged.claude, true);
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await page.evaluate(
    (repo) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "claude",
      }),
    repository.path,
  );
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(output, "utf8"));
      } catch {
        return null;
      }
    })
    .toEqual(args);
  await expect(page.locator(".session-bypass")).toHaveText("◇ Bypass");
  await page.evaluate(() =>
    window.desktop.saveSetup({ agentArguments: { claude: [], codex: [], agy: [] } }),
  );
  await expect(page.locator(".session-bypass")).toHaveText("◇ Bypass");
});

test("sidebar config agent menu launches a new config session in each window", {
  timeout: deadline(60_000),
}, async (context) => {
  const { chmod, copyFile } = require("node:fs/promises");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-menu-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await Promise.all([bin, home].map((directory) => mkdir(directory)));
  const executable = path.join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const first = await boardPage(app);
  await first.evaluate(() =>
    window.desktop.saveSetup({
      agents: { claude: true, codex: false, agy: false },
      agentArguments: {
        claude: [
          "--eval",
          "console.log('CONFIG_MENU_READY '+JSON.stringify(process.argv.slice(1)));process.stdin.resume()",
        ],
        codex: [],
        agy: [],
      },
    }),
  );
  await openSettingsScreen(first);
  await expect(first.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await first.locator(".config-gear").click();
  await expect(first.getByRole("menuitem", { name: "Via Codex" })).toHaveCount(0);
  if (process.env.FOOM_UI_SCREENSHOTS)
    await first.screenshot({
      path: evidencePath(path.join(evidencePath("ui_screenshots"), "sidebar-config-via-agent.png")),
      animations: "disabled",
    });
  await first.getByRole("menuitem", { name: "Via Claude Code" }).focus();
  await first.getByRole("menuitem", { name: "Via Claude Code" }).press("Enter");
  await expect(first.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  let id;
  await expect
    .poll(async () => {
      const sessions = (await first.evaluate(() => window.desktop.workspace())).terminals;
      id = sessions.find((session) => session.config)?.id;
      return id;
    })
    .toBeTruthy();
  await expect
    .poll(async () =>
      first.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id),
    )
    .toContain("CONFIG_MENU_READY");
  assert.equal(
    (await first.evaluate(() => window.desktop.workspace())).terminals[0].worktree,
    path.join(home, ".foom", "config"),
  );
  const greetingTail = await first.evaluate(
    async (id) => (await window.desktop.tail(id, 40)).join(""),
    id,
  );
  assert.match(greetingTail, /CONFIG_MENU_READY \["Read AGENTS\.md, then greet the user/);
  assert.match(greetingTail, /Ask what they would like to change\."\]/);
  await first.screenshot({
    path: evidencePath("sidebar-config-launched.png"),
    animations: "disabled",
  });
  await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(() => app.windows().filter((page) => page.url() === "app://bundle/index.html").length)
    .toBe(2);
  const second = app
    .windows()
    .find((page) => page !== first && page.url() === "app://bundle/index.html");
  await expect(second.getByRole("button", { name: "Foom menu" })).toBeVisible();
  const menu = await second.evaluate(() => window.desktop.appMenu.commands());
  assert.ok(!JSON.stringify(menu).includes("via-"));
  await second.locator(".config-gear").click();
  await second.getByRole("menuitem", { name: "Via Claude Code" }).click();
  await expect(second.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  assert.equal(
    (await first.evaluate(() => window.desktop.workspace())).terminals.filter(
      (session) => session.config,
    ).length,
    2,
  );
  const configIds = (await second.evaluate(() => window.desktop.workspace())).terminals
    .filter((session) => session.config)
    .map((session) => session.id);
  assert.equal(new Set(configIds).size, 2);
  for (const configId of configIds) {
    await expect
      .poll(() =>
        second.evaluate(async (id) => (await window.desktop.tail(id, 40)).join(""), configId),
      )
      .toMatch(/CONFIG_MENU_READY \["Read AGENTS\.md, then greet the user/);
  }
  await first.evaluate(() =>
    window.desktop.saveSetup({ agents: { claude: false, codex: false, agy: false } }),
  );
  await assert.rejects(
    second.evaluate(() => window.desktop.appMenu.execute("via-claude")),
    /foom-error:operation-failed/,
  );
  // Stop both agents through their owning boards before the shared app teardown.
  await stopSession(first, id);
  const secondId = configIds.find((configId) => configId !== id);
  assert.ok(secondId);
  await stopSession(second, secondId);
});

test("footer config gear opens Settings and launches two independent docked Shells", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  const gear = page.locator(".config-gear");
  const dock = page.locator(".config-dock");
  await expect(dock).toHaveCount(0);
  await gear.press("Enter");
  const panel = page.getByRole("dialog", { name: "Foom config details and commands" });
  await expect(gear).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByRole("menuitem").first()).toContainText("Settings");
  await panel.getByRole("menuitem", { name: /^Shell/ }).click();
  const session = dock.locator(".board-row").first();
  await expect(session).toBeVisible();
  await session.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await gear.click();
  await expect(panel.getByRole("menuitem", { name: /^Shell/ })).not.toContainText("running");
  await panel.getByRole("menuitem", { name: /^Shell/ }).click();
  await expect(dock.locator(".board-row")).toHaveCount(2);
  await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  const shells = (await page.evaluate(() => window.desktop.workspace())).terminals.filter(
    (row) => row.config,
  );
  assert.equal(shells.length, 2);
  assert.notEqual(shells[0].id, shells[1].id);
  for (const shell of shells) {
    assert.equal(shell.kind, "shell");
    assert.equal(shell.worktree, shells[0].worktree);
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), shell.id),
      )
      .toMatch(process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/);
  }
  await gear.click();
  await panel.getByRole("menuitem", { name: /^Settings/ }).click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await assertAccessible(page);
});

test("Pi Settings card discloses project trust bypass and keeps MCP roles unavailable", async (context) => {
  const { copyFile, chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-pi-settings-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await Promise.all([bin, home].map((directory) => mkdir(directory)));
  const executable = path.join(bin, process.platform === "win32" ? "pi.exe" : "pi");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const input = page.getByLabel("Pi default arguments");
  await expect(input).toBeVisible();
  const scan = await page.evaluate(() => window.desktop.scanAgents(true));
  const pi = scan.agents.find((agent) => agent.id === "pi");
  assert.equal(pi.name, "Pi");
  assert.equal(pi.resume, true);
  assert.equal(pi.hooks, false);
  assert.equal(pi.mcp, false);
  assert.equal(pi.restoreControl, false);
  await input.fill("--approve");
  await input.blur();
  const disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Save bypass defaults for Pi?",
  );
  await disclosure.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.pi ?? [],
    [],
  );
  await input.fill("-a");
  await input.blur();
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Save bypass defaults for Pi?",
  );
  await disclosure.getByRole("button", { name: "Save bypass defaults", exact: true }).click();
  await expect(input).toBeEnabled();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.setupState())).settings.agentBypassAcknowledged
          .pi,
    )
    .toBe(true);
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.pi,
    ["-a"],
  );
  await expect(page.getByRole("button", { name: "Scan again", exact: true })).toBeEnabled();
  await page.screenshot({ path: "test-results/pi-agent-settings.png", animations: "disabled" });
});
