const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
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
  await expect(page.locator(".agent-global-row [role=alert]")).toHaveText(
    "Unable to update settings.",
  );
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
  await expect(page.locator(".agent-global-row [role=alert]")).toHaveText(
    "Unable to update settings.",
  );
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
  await expect(page.locator(".agent-global-row [role=alert]")).toHaveCount(0);
  await input.blur();
  await expect(page.locator(".agent-global-row [role=alert]")).toHaveCount(0);
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
  await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(2);
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
  await expect(
    page.getByRole("button", { name: "Re-check This computer", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/pi-agent-settings.png", animations: "disabled" });
});

test("one-click local agent installers stay in Settings and refuse untrusted selectors", {
  timeout: deadline(45_000),
  skip: process.platform === "win32",
}, async (context) => {
  const { writeFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-install-1071-"));
  removeAfterApps(context, root);
  // The production click/IPC/session path runs a fixture helper, never a vendor download.
  await writeFile(
    path.join(root, "foom"),
    '#!/bin/sh\nset -u\n: "$HOME" "$USER" "$LOGNAME" "$SHELL" "$PATH" "$TMPDIR" "$LANG"\n[ "$FOOM_SETTINGS_INSTALL" = "1" ] || exit 98\n[ -z "${INSTALL_FIXTURE_SECRET_1071-}" ] || exit 99\nprintf "Download https://claude.ai/install.sh\\nFixture installer: waiting for input\\n"\nread answer\nexit 7\n',
    { mode: 0o755 },
  );
  const app = await launchApp(context, { fixture: "empty-board" });
  await app.evaluate(
    (_electron, { modulePath, directory }) => {
      const load = process.getBuiltinModule("node:module").createRequire(modulePath);
      const { Workspace } = load(modulePath);
      const original = Workspace.prototype.startLocalAgentInstall;
      Workspace.prototype.startLocalAgentInstall = async function (id) {
        const config = this.owner.deps.config;
        const previous = config.cliDirectory;
        config.cliDirectory = directory;
        try {
          return await original.call(this, id);
        } finally {
          config.cliDirectory = previous;
        }
      };
    },
    { modulePath: path.resolve("build/main/workspace/workspace.js"), directory: root },
  );
  const page = await boardPage(app);
  await page.evaluate(() =>
    window.desktop.saveEnvironment({
      scope: "all",
      previous: null,
      name: "INSTALL_FIXTURE_SECRET_1071",
      value: "never-forward",
      secret: false,
    }),
  );
  for (const value of ["unknown", "claude;id", { id: "claude", url: "https://untrusted.test" }]) {
    const refused = await page.evaluate(
      (id) =>
        window.desktop.localAgentInstall(id).then(
          () => false,
          () => true,
        ),
      value,
    );
    assert.equal(refused, true);
  }
  await page.evaluate(() =>
    window.desktop.saveSetup({ agents: { claude: false, codex: true, agy: true } }),
  );
  assert.equal(
    await page.evaluate(() =>
      window.desktop.localAgentInstall("claude").then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  await page.evaluate(() =>
    window.desktop.saveSetup({ agents: { claude: true, codex: true, agy: true } }),
  );
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await page.getByRole("tab", { name: "Machines", exact: true }).click();
  const card = page.getByRole("region", { name: "Claude Code", exact: true });
  await expect(card.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
  await card.getByRole("button", { name: "Install", exact: true }).click();
  await expect(card.getByRole("region", { name: "Install terminal" })).toBeVisible();
  await expect(card.locator(".xterm-screen")).toContainText("Fixture installer");
  const rows = (await page.evaluate(() => window.desktop.workspace())).terminals;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipe, true);
  assert.equal(rows[0].agent, "shell");
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
      mode,
    );
    await expect
      .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
      .toBe(mode === "dark");
    await page
      .getByRole("region", { name: "Settings", exact: true })
      .screenshot({ path: evidencePath(`1071/local-install-${mode}.png`) });
  }
  await page.getByRole("region", { name: "Settings", exact: true }).press("Escape");
  await expect(page.getByRole("dialog", { name: "Stop the install?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep open", exact: true }).click();
  await page.evaluate((id) => window.desktop.input(id, "finish\r"), rows[0].id);
  await expect(card.getByText("Failed · exit code 7", { exact: true })).toBeVisible();
  await assertAccessible(page);
  await page.getByRole("region", { name: "Settings", exact: true }).press("Escape");
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.workspace())).terminals.length)
    .toBe(0);
});

for (const agent of ["claude", "codex", "agy", "copilot", "opencode", "pi"])
  test(`bundled ${agent} installer receives account environment locally and on registered hosts`, {
    timeout: deadline(30000),
    skip: process.platform === "win32",
  }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "foom-installer-env-"));
    removeAfterApps(context, root);
    const shell = path.join(root, "fixture-login-shell");
    await writeFile(shell, `#!/bin/sh\nprintf '\\000FOOM_PATH\\000%s\\000' '${root}'\n`, {
      mode: 0o755,
    });
    const body = `#!/bin/sh
set -eu
: "$HOME" "$USER" "$LOGNAME" "$SHELL" "$PATH" "$TMPDIR" "$LANG" "$XDG_CONFIG_HOME"
[ "$HOME" = '${root}' ]
[ "$PATH" = '${root}' ]
[ "$XDG_CONFIG_HOME" = '${root}/config' ]
[ -z "\${FOOM_TOKEN+x}" ]
[ -z "\${foom_token+x}" ]
[ -z "\${FOOM_SETTINGS_INSTALL+x}" ]
[ -z "\${ANTHROPIC_API_KEY+x}" ]
[ -z "\${CODEX_API_KEY+x}" ]
[ -z "\${GITHUB_TOKEN+x}" ]
/bin/mkdir -p "$HOME/.local"
echo FIXTURE_ENV_READY
`;
    const bootstrap = path.join(root, "helper.cjs");
    await writeFile(
      bootstrap,
      `
const {createRequire}=require('node:module');
const load=createRequire(${JSON.stringify(path.resolve("build/main/main.js"))});
globalThis.fetch=async()=>new Response(${JSON.stringify(body)});
(async()=>{
 const agent=process.argv[3];
 if(process.argv[2]==='local') return load('../node-common/local-agent-install.js').installLocalAgent(agent);
 const {hostLoginEnvironment}=load('../terminal-host/remote/agent-discovery.js');
 const {requirements}=load('../terminal-host/remote/host-facts.js');
 const {bundledAgentData}=load('../shared/bundled-agent-data.js');
 const {selectHostRecipe}=load('../shared/registered-host-recipes.js');
 const home=${JSON.stringify(root)};
 const env=await hostLoginEnvironment(process.env.SHELL,home,undefined,true);
 const facts=await requirements(process.platform,home,home,env);
 const recipe=selectHostRecipe({tool:agent,action:'install',distro:facts.distro},facts,bundledAgentData.find(a=>a.id===agent).hostSetup);
 if(!recipe) throw Error('Fixture recipe unavailable');
 const digest=require('node:crypto').createHash('sha256').update(JSON.stringify(recipe.steps)).digest('hex');
 return load('../terminal-host/remote/host-recipe.js').runHostRecipe([agent,'install',facts.distro,digest],home);
})().then(code=>process.exit(code),error=>{console.error(error);process.exit(1)});
`,
    );
    const app = await launchApp(context, { fixture: "empty-board" });
    for (const mode of ["local", "host"]) {
      const result = await app.evaluate(
        async (_electron, fixture) => {
          const { spawn } = process.getBuiltinModule("node:child_process");
          const child = spawn(process.execPath, [fixture.bootstrap, fixture.mode, fixture.agent], {
            cwd: fixture.root,
            env: {
              ...(fixture.mode === "local" ? { HOME: fixture.root } : {}),
              SHELL: fixture.shell,
              PATH: fixture.root,
              TMPDIR: fixture.root,
              XDG_CONFIG_HOME: `${fixture.root}/config`,
              FOOM_SETTINGS_INSTALL: "1",
              FOOM_TOKEN: "fixture-secret",
              foom_token: "fixture-secret",
              ANTHROPIC_API_KEY: "fixture-secret",
              CODEX_API_KEY: "fixture-secret",
              GITHUB_TOKEN: "fixture-secret",
              ELECTRON_RUN_AS_NODE: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (bytes) => {
            output += bytes;
          });
          child.stderr.on("data", (bytes) => {
            output += bytes;
          });
          const code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
          });
          return { code, output };
        },
        { bootstrap, mode, agent, root, shell },
      );
      assert.equal(result.code, 0, `${agent}:${mode}: ${result.output}`);
      assert.match(result.output, /FIXTURE_ENV_READY/u);
    }
  });

test("local and registered-host vendor helpers clean private files and descendants after exit and default PTY hangup", {
  timeout: deadline(60000),
  skip: process.platform === "win32",
}, async (context) => {
  const { writeFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-installer-hangup-"));
  removeAfterApps(context, root);
  const shell = path.join(root, "fixture-login-shell");
  await writeFile(shell, `#!/bin/sh\nprintf '\\000FOOM_PATH\\000%s\\000' '${root}'\n`, {
    mode: 0o755,
  });
  const descendant = path.join(root, "descendant.cjs");
  await writeFile(
    descendant,
    [
      "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});",
      "console.log('DESCENDANT_READY:'+process.pid);setInterval(()=>{},1000);",
    ].join("\n"),
  );
  const bootstrap = path.join(root, "helper.cjs");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const body = `#!/bin/sh\ntrap '' HUP INT TERM\necho FIXTURE_SCRIPT:$0\necho FIXTURE_GROUP:$PPID\necho FIXTURE_INTERPRETER:$$\n${quote(process.execPath)} ${quote(descendant)} &\nread answer\nprintf 'FIXTURE_INPUT:%s\\n' "$answer"\n`;
  await writeFile(
    bootstrap,
    `
const {createRequire}=require('node:module');
const load=createRequire(${JSON.stringify(path.resolve("build/main/main.js"))});
const originalKill=process.kill.bind(process);
process.kill=(pid,signal)=>{
 if(pid<0) throw Error('Helper must not signal numeric process groups');
 return originalKill(pid,signal);
};
const bodies=${JSON.stringify({ hangup: `${body}wait\n`, 0: `${body}exit 0\n`, watcher: `${body}exit 0\n`, "watcher-stop": `${body}wait\n`, 7: `${body}exit 7\n` })};
globalThis.fetch=async()=>new Response(bodies[process.argv[3]]);
(async()=>{
 if(process.argv[2]==='local') return load('../node-common/local-agent-install.js').installLocalAgent('claude');
 const {hostLoginEnvironment}=load('../terminal-host/remote/agent-discovery.js');
 const {requirements}=load('../terminal-host/remote/host-facts.js');
 const {bundledAgentData}=load('../shared/bundled-agent-data.js');
 const {selectHostRecipe}=load('../shared/registered-host-recipes.js');
 const env=await hostLoginEnvironment(process.env.SHELL,${JSON.stringify(root)},undefined,true);
 const facts=await requirements(process.platform,${JSON.stringify(root)},${JSON.stringify(root)},env);
 const recipe=selectHostRecipe({tool:'claude',action:'install',distro:facts.distro},facts,bundledAgentData.find(a=>a.id==='claude').hostSetup);
 if(!recipe) throw Error('Fixture recipe unavailable');
 const digest=require('node:crypto').createHash('sha256').update(JSON.stringify(recipe.steps)).digest('hex');
 return load('../terminal-host/remote/host-recipe.js').runHostRecipe(['claude','install',facts.distro,digest],${JSON.stringify(root)});
})().then(code=>process.exit(code),error=>{console.error(error);process.exit(1)});
`,
  );
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  for (const [mode, completion] of [
    ["local", "hangup"],
    ["host", "hangup"],
    ["local", 0],
    ["host", 0],
    ["local", 7],
    ["host", 7],
    ["local", "watcher"],
    ["host", "watcher"],
    ["local", "watcher-stop"],
    ["host", "watcher-stop"],
  ]) {
    context.diagnostic(`Installer fixture ${mode}:${completion}`);
    const result = await app.evaluate(
      async (_electron, fixture) => {
        const load = process.getBuiltinModule("node:module").createRequire(fixture.modulePath);
        const fs = load("node:fs/promises");
        const { dirname } = load("node:path");
        const { execFileSync } = load("node:child_process");
        const pty = load("node-pty").spawn(
          process.execPath,
          [fixture.bootstrap, fixture.mode, String(fixture.completion)],
          {
            cwd: fixture.root,
            env: {
              HOME: fixture.root,
              TMPDIR: fixture.root,
              PATH: fixture.root,
              SHELL: fixture.shell,
              FOOM_SETTINGS_INSTALL: "1",
              ELECTRON_RUN_AS_NODE: "1",
            },
          },
        );
        let output = "";
        let killed = false;
        let replied = false;
        let forcedStop;
        const exit = await new Promise((resolve) => {
          pty.onExit((exit) => {
            clearTimeout(forcedStop);
            resolve(exit);
          });
          pty.onData((data) => {
            output += data;
            if (!replied && /DESCENDANT_READY:\d+\r?\n/u.test(output)) {
              replied = true;
              if (fixture.completion === "watcher" || fixture.completion === "watcher-stop") {
                const group = Number(/FIXTURE_GROUP:(\d+)/u.exec(output)?.[1]);
                const interpreter = Number(/FIXTURE_INTERPRETER:(\d+)/u.exec(output)?.[1]);
                const descendant = Number(/DESCENDANT_READY:(\d+)/u.exec(output)?.[1]);
                const watchers = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
                  encoding: "utf8",
                })
                  .trim()
                  .split("\n")
                  .map((line) => line.trim().split(/\s+/u).map(Number))
                  .filter(
                    ([pid, pgid]) =>
                      pgid === group && ![group, interpreter, descendant].includes(pid),
                  );
                if (watchers.length !== 1) throw Error("Missing fixture watcher");
                process.kill(watchers[0][0], "SIGKILL");
              }
              pty.write("fixture-input\r");
            }
            if (
              ["hangup", "watcher-stop"].includes(fixture.completion) &&
              !killed &&
              output.includes("FIXTURE_INPUT:fixture-input")
            ) {
              killed = true;
              pty.kill(); // node-pty defaults to SIGHUP, as TerminalManager.terminate does.
              if (fixture.completion === "watcher-stop") {
                // Mirror TerminalManager's one-second force-kill fallback so a
                // regression remains observable without leaking a hung fixture.
                forcedStop = setTimeout(() => pty.kill("SIGKILL"), 1000);
              }
            }
          });
        });
        const script = /FIXTURE_SCRIPT:([^\r\n]+)/u.exec(output)?.[1];
        const pid = /DESCENDANT_READY:(\d+)/u.exec(output)?.[1];
        if (!script || !pid) throw new Error(`Fixture failed before hangup: ${output}`);
        let directoryExists = true;
        try {
          await fs.access(dirname(script));
        } catch {
          directoryExists = false;
        }
        let descendantState = "";
        try {
          descendantState = execFileSync("/bin/ps", ["-o", "stat=", "-p", pid], {
            encoding: "utf8",
          }).trim();
        } catch {
          /* exited processes have no ps row */
        }
        // Preserve the failing observation but never leak the fixture worker on regression.
        if (descendantState && !descendantState.startsWith("Z")) {
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {
            /* already exited */
          }
        }
        return {
          exit,
          directoryExists,
          descendantState,
        };
      },
      { modulePath: path.resolve("build/main/main.js"), root, bootstrap, shell, mode, completion },
    );
    assert.equal(
      result.exit.exitCode,
      ["hangup", "watcher-stop"].includes(completion)
        ? 129
        : completion === "watcher"
          ? 0
          : completion,
      `${mode}:${completion}`,
    );
    assert.equal(result.directoryExists, false, mode);
    assert.ok(
      !result.descendantState || result.descendantState.startsWith("Z"),
      `${mode}: ${result.descendantState}`,
    );
  }
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
});

for (const victim of ["supervisor", "helper"]) {
  test(`local and registered-host installers stop their whole group after ${victim} SIGKILL`, {
    timeout: deadline(60000),
    skip: process.platform === "win32",
  }, async (context) => {
    const { writeFile, rm } = require("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "foom-installer-loss-"));
    removeAfterApps(context, root);
    const shell = path.join(root, "fixture-login-shell");
    await writeFile(shell, `#!/bin/sh\nprintf '\\000FOOM_PATH\\000%s\\000' '${root}'\n`, {
      mode: 0o755,
    });
    const bootstrap = path.join(root, "helper.cjs");
    const body = `#!/bin/sh
trap '' HUP INT TERM
if ( : <&4 ) 2>/dev/null; then exit 99; fi
if ( : >&3 ) 2>/dev/null; then exit 98; fi
echo FIXTURE_SCRIPT:$0
echo FIXTURE_GROUP:$PPID
echo FIXTURE_INTERPRETER:$$
/bin/sleep 300 &
echo FIXTURE_SLEEP:$!
wait
`;
    await writeFile(
      bootstrap,
      `
const {createRequire}=require('node:module');
const load=createRequire(${JSON.stringify(path.resolve("build/main/main.js"))});
globalThis.fetch=async()=>new Response(${JSON.stringify(body)});
(async()=>{
 if(process.argv[2]==='local') return load('../node-common/local-agent-install.js').installLocalAgent('claude');
 const {hostLoginEnvironment}=load('../terminal-host/remote/agent-discovery.js');
 const {requirements}=load('../terminal-host/remote/host-facts.js');
 const {bundledAgentData}=load('../shared/bundled-agent-data.js');
 const {selectHostRecipe}=load('../shared/registered-host-recipes.js');
 const env=await hostLoginEnvironment(process.env.SHELL,${JSON.stringify(root)},undefined,true);
 const facts=await requirements(process.platform,${JSON.stringify(root)},${JSON.stringify(root)},env);
 const recipe=selectHostRecipe({tool:'claude',action:'install',distro:facts.distro},facts,bundledAgentData.find(a=>a.id==='claude').hostSetup);
 const digest=require('node:crypto').createHash('sha256').update(JSON.stringify(recipe.steps)).digest('hex');
 return load('../terminal-host/remote/host-recipe.js').runHostRecipe(['claude','install',facts.distro,digest],${JSON.stringify(root)});
})().then(code=>process.exit(code),error=>{console.error(error);process.exit(1)});
`,
    );
    const app = await launchApp(context, { fixture: "empty-board" });
    for (const mode of ["local", "host"]) {
      const result = await app.evaluate(
        async (_electron, fixture) => {
          const { spawn } = process.getBuiltinModule("node:child_process");
          const helper = spawn(process.execPath, [fixture.bootstrap, fixture.mode], {
            cwd: fixture.root,
            env: {
              HOME: fixture.root,
              TMPDIR: fixture.root,
              PATH: fixture.root,
              SHELL: fixture.shell,
              FOOM_SETTINGS_INSTALL: "1",
              ELECTRON_RUN_AS_NODE: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          let killed = false;
          helper.stdout.on("data", (data) => {
            output += data.toString();
            const group = /FIXTURE_GROUP:(\d+)/u.exec(output)?.[1];
            if (!killed && group && /FIXTURE_SLEEP:\d+\n/u.test(output)) {
              killed = true;
              process.kill(fixture.victim === "helper" ? helper.pid : Number(group), "SIGKILL");
            }
          });
          const exit = await new Promise((resolve) =>
            helper.once("exit", (code, signal) => resolve({ code, signal })),
          );
          helper.stdout.destroy();
          helper.stderr.destroy();
          const group = Number(/FIXTURE_GROUP:(\d+)/u.exec(output)?.[1]);
          const script = /FIXTURE_SCRIPT:([^\r\n]+)/u.exec(output)?.[1];
          if (!group || !script) throw Error(`Fixture failed before kill: ${output}`);
          return { group, script, exit };
        },
        { root, shell, bootstrap, mode, victim },
      );
      try {
        await expect
          .poll(() =>
            app.evaluate((group) => {
              const { execFileSync } = process.getBuiltinModule("node:child_process");
              return execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" })
                .trim()
                .split("\n")
                .map((line) => line.trim().split(/\s+/u))
                .filter((row) => Number(row[1]) === group && !row[2].startsWith("Z"));
            }, result.group),
          )
          .toEqual([]);
        const directory = path.dirname(result.script);
        const present = await require("node:fs/promises")
          .access(directory)
          .then(
            () => true,
            () => false,
          );
        assert.equal(present, victim === "helper", `${mode}:${victim}: temp cleanup`);
        if (victim === "helper") assert.equal(result.exit.signal, "SIGKILL");
        else assert.equal(result.exit.code, 1);
      } finally {
        // Preserve failures, but never leak the intentionally hung fixture on regression.
        await app.evaluate((group) => {
          const { execFileSync } = process.getBuiltinModule("node:child_process");
          for (const line of execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
            encoding: "utf8",
          })
            .trim()
            .split("\n")) {
            const [pid, pgid, state] = line.trim().split(/\s+/u);
            if (Number(pgid) === group && !state.startsWith("Z")) {
              try {
                process.kill(Number(pid), "SIGKILL");
              } catch {
                /* already exited */
              }
            }
          }
        }, result.group);
        await rm(path.dirname(result.script), { recursive: true, force: true });
      }
    }
  });
}
