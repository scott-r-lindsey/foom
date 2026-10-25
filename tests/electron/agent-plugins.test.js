const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
} = require("./harness.js");

test("a manifest-only v2 fixture agent loads from the config folder, reloads edits and is withdrawn when invalid", {
  timeout: deadline(60_000),
}, async (context) => {
  const { chmod, copyFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-manifest-agent-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const output = path.join(root, "argv.json");
  const script = path.join(root, "fixture.js");
  await Promise.all([bin, home, repo].map((directory) => mkdir(directory)));
  const executable = path.join(
    bin,
    process.platform === "win32" ? "foom-test-agent.exe" : "foom-test-agent",
  );
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  await writeFile(
    script,
    `require("node:fs").writeFileSync(process.env.TEST_ARGV, JSON.stringify(process.argv.slice(2)));
require("node:fs").writeFileSync(process.env.TEST_ARGV + ".mcp", require("node:fs").readFileSync(process.env.AGENT_CONFIG));
require("node:fs").writeFileSync(process.env.TEST_ARGV + ".env", process.env.AGENT_CONFIG);
process.stdin.on('data', async () => {
  if (!process.env.FOOM_TOKEN) return;
  const payload = { session_id: 'fixture-hook-conversation', hook_event_name: 'PermissionRequest' };
  const request = require('node:http').request(process.env.FOOM_HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: process.env.FOOM_TOKEN, 'X-Foom-Session': process.env.FOOM_SESSION, 'X-Foom-Channel': 'lifecycle' } }, response => response.resume());
  request.end(JSON.stringify(payload));
});
process.stdin.resume();`,
  );
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
  const app = await launchApp(context, {
    fixture: "agent",
    env: { HOME: home, PATH: bin, TEST_ARGV: output, FIXTURE_BYPASS: "private-bypass-value" },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  const file = path.join(home, ".foom/config/agents/foom-test-agent.json");
  const v2 = JSON.parse(
    await readFile(path.join(__dirname, "../fixtures/agent-plugin-v2.json"), "utf8"),
  );
  const manifest = {
    ...v2,
    id: "foom-test-agent",
    name: "Fixture agent",
    badge: "FT",
    executables: ["foom-test-agent"],
    discovery: { facts: [] },
    launch: {
      ...v2.launch,
      order: [
        "arguments",
        "resume",
        "defaults",
        "display",
        "guidance",
        "mcp",
        "hooks",
        "tools",
        "prompt",
      ],
      arguments: { arguments: [script, "$(literal)", "--yolo"] },
      display: undefined,
      prompt: { arguments: ["--prompt", "{prompt}"] },
      environment: [
        {
          name: "AGENT_CONFIG",
          value: "{file:config/mcp.json}",
          when: { all: [{ field: "control", op: "eq", value: true }] },
        },
      ],
      mcp: {
        arguments: [],
        when: { all: [{ field: "control", op: "eq", value: true }] },
      },
    },
    execution: { ...v2.execution, completionChannels: ["lifecycle"] },
    hooks: {
      channels: [
        {
          id: "lifecycle",
          when: { all: [{ field: "hooksEnabled", op: "eq", value: true }] },
          observer: {
            transport: "stdin",
            placement: "launch",
            version: 1,
            response: "silent",
            delivery: "foreground",
            timeoutMs: 3000,
          },
          arguments: ["--settings", "{hookFile:hooks.json}"],
          mapping: {
            session: { source: "payload", path: ["session_id"] },
            event: { source: "payload", path: ["hook_event_name"] },
            cases: [
              {
                id: "PermissionRequest",
                event: "PermissionRequest",
                action: "needs_input",
              },
              { id: "Stop", event: "Stop", action: "classify" },
            ],
          },
        },
      ],
    },
    files: [
      {
        name: "hooks.json",
        scope: "launch",
        format: "json",
        content:
          '{"hooks":{"PermissionRequest":[{"type":"command","command":{observerCommand:lifecycle:json}}]}}',
        when: { all: [{ field: "hooksEnabled", op: "eq", value: true }] },
      },
      ...v2.files.map((file) => ({
        ...file,
        when: { all: [{ field: "control", op: "eq", value: true }] },
      })),
    ],
    conversation: { resumePin: "requested-on-paste", restoreControl: false },
    resumePaste: [{ command: "foom-test-agent", selector: "--resume" }],
  };
  const launch = () =>
    page.evaluate(
      (repository) =>
        window.desktop.sidebarCommand({
          kind: "launch",
          repository,
          worktree: repository,
          run: "foom-test-agent",
        }),
      repository.path,
    );
  require("../../build/shared/agent-plugin-parser.js").parseAgentManifest(JSON.stringify(manifest));
  await writeFile(file, JSON.stringify(manifest));
  const card = page
    .locator(".agent-card")
    .filter({ has: page.getByRole("heading", { name: "Fixture agent", exact: true }) });
  await expect(
    card.getByRole("img", { name: "Foom config · agents/foom-test-agent.json", exact: true }),
  ).toHaveAttribute("title", "Foom config · agents/foom-test-agent.json");
  await expect(card.getByRole("button", { name: "Review…", exact: true })).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.scanAgents(true))).agents.some(
        (agent) => agent.id === "foom-test-agent" && agent.path !== null,
      ),
    )
    .toBe(true);
  await expect(card.getByLabel("Fixture agent default arguments")).toBeVisible();
  await expect(card.getByLabel("New Fixture agent variable name")).toBeVisible();
  await expect(card.getByText("Hooks", { exact: true })).toBeVisible();
  await assertAccessible(page);
  await page.screenshot({
    path: evidencePath("agents-settings.png"),
  });
  {
    await page.evaluate((repository) => {
      window.v2Launch = window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "foom-test-agent",
      });
    }, repository.path);
    const disclosure = await confirmationPage(app);
    await expect(
      disclosure.getByRole("heading", { name: "Launch Fixture agent with bypass?" }),
    ).toBeVisible();
    await expect(disclosure.getByRole("alertdialog")).toContainText(
      "FIXTURE_BYPASS: present-nonempty",
    );
    await expect(disclosure.getByRole("alertdialog")).not.toContainText("private-bypass-value");
    await disclosure.getByRole("button", { name: "Launch with bypass", exact: true }).click();
    await page.evaluate(() => window.v2Launch);
  }
  await expect
    .poll(async () => {
      try {
        const args = JSON.parse(await readFile(output, "utf8"));
        return args.slice(0, 2);
      } catch {
        return null;
      }
    })
    .toEqual(["$(literal)", "--yolo"]);
  {
    const args = JSON.parse(await readFile(output, "utf8"));
    assert.ok(!args.includes("--mcp"));
    assert.equal(
      args.filter((arg) => /^mcp__foom_.*__(open_preview|list_previews|close_preview)$/u.test(arg))
        .length,
      3,
    );
    const mcp = await readFile(output + ".env", "utf8");
    assert.ok(!args.includes(mcp));
    assert.ok((await readFile(mcp, "utf8")).includes("Bearer ${FOOM_CONTROL_TOKEN}"));
    const received = JSON.parse(await readFile(output + ".mcp", "utf8"));
    const servers = Object.values(received.mcpServers);
    assert.equal(servers.length, 1);
    assert.match(servers[0].url, /^http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/u);
    assert.ok(args.at(-1).includes("Foom provides a workspace CLI"));
  }
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  const launched = snapshot.terminals.find((entry) => entry.agent === "foom-test-agent");
  assert.equal(launched.bypass, true);
  assert.equal(launched.providerOrigin, "config");
  {
    const args = JSON.parse(await readFile(output, "utf8"));
    const hooks = JSON.parse(await readFile(args[args.indexOf("--settings") + 1], "utf8"));
    assert.ok(hooks.hooks.PermissionRequest[0].command.includes("observer"));
    await page.evaluate((id) => window.desktop.input(id, "hooks\r"), launched.id);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.workspace())).terminals.find(
            (entry) => entry.id === launched.id,
          )?.conversationId,
      )
      .toBe("fixture-hook-conversation");
  }

  await writeFile(file, JSON.stringify({ ...manifest, name: "Edited fixture" }));
  await expect(
    page.locator(".agent-card").getByRole("heading", { name: "Edited fixture", exact: true }),
  ).toBeVisible();
  await writeFile(file, JSON.stringify({ ...manifest, version: 1 }));
  await expect(
    page.getByText(
      "$.version: Agent manifest version 1 is no longer supported; use version 2 (see README.md)",
      { exact: true },
    ),
  ).toBeVisible();
  assert.ok(
    (await page.evaluate(() => window.desktop.workspace())).terminals.some(
      (entry) => entry.id === launched.id,
    ),
  );
  await expect(page.getByText("Rejected · launch blocked", { exact: true })).toBeVisible();
  await assert.rejects(launch(), /foom-error:operation-failed/);
});

test("v2 plugin setup confirms fixed actions and refuses unknown, malformed and linked metadata", {
  timeout: deadline(60_000),
  skip:
    process.platform === "win32" &&
    "Fixture executable uses a POSIX shebang; ownership and fixed actions also run in cross-platform unit tests",
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-v2-setup-"));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await Promise.all([home, bin].map((directory) => mkdir(directory)));
  const directory = path.join(home, ".gemini/config/plugins/foom");
  const metadata = path.join(directory, "plugin.json");
  const config = path.join(home, ".gemini/config/config.json");
  const commands = path.join(root, "commands.jsonl");
  await writeFile(commands, "");
  for (const tool of ["sh", "head", "curl", "mkdir", "rmdir", "cat"])
    await require("node:fs/promises").symlink(
      `${tool === "curl" || tool === "head" ? "/usr/bin" : "/bin"}/${tool}`,
      path.join(bin, tool),
    );
  const repo = path.join(root, "repo");
  await mkdir(repo);
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
  await writeFile(
    path.join(bin, "foom-test-agent"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const directory = ${JSON.stringify(directory)};
if (args[0] === '--version') { console.log('fixture 1.2.3'); process.exit(0); }
if (args[0] === '--help') { console.log('Fixture CLI'); process.exit(0); }
if (args[0] !== 'plugin') {
  const hooks = JSON.parse(fs.readFileSync(path.join(directory, 'hooks.json'), 'utf8'))['foom-observer-v1'];
  const run = (event, payload) => {
    require('node:child_process').execFileSync('/bin/sh', ['-c', hooks[event][0].command], {cwd:directory, env:process.env, input:JSON.stringify(payload)});
  };
  run('PreInvocation', {conversationId:'staged-conversation'});
  process.stdin.on('data', () => run('Stop', {conversationId:'staged-conversation', terminationReason:'NO_TOOL_CALL', fullyIdle:true}));
  return;
}
if (args[1] === 'list') { console.log(JSON.stringify({imports:fs.existsSync(directory) ? [{name:'foom'}] : []})); process.exit(0); }
fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args)+'\\n');
if (args[1] === 'install') { fs.mkdirSync(path.dirname(directory), {recursive:true}); fs.cpSync(args[2], directory, {recursive:true}); }
else if (args[1] === 'enable' && args[2] === 'foom') fs.writeFileSync(${JSON.stringify(config)}, JSON.stringify({plugins:{foom:{enabled:true}}}));
else if (args[1] === 'uninstall' && args[2] === 'foom') fs.rmSync(directory, {recursive:true});
else process.exit(2);
`,
    { mode: 0o755 },
  );
  const app = await launchApp(context, { fixture: "agent", env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  const base = JSON.parse(
    await readFile(path.join(__dirname, "../fixtures/agent-plugin-v2.json"), "utf8"),
  );
  const observerFixture = JSON.parse(
    await readFile(path.join(__dirname, "../fixtures/agent-plugins-v2/agy.json"), "utf8"),
  );
  const setup = observerFixture.setup;
  const manifest = {
    ...base,
    id: "foom-test-agent",
    name: "Setup fixture",
    executables: ["foom-test-agent"],
    discovery: { facts: [] },
    launch: { order: base.launch.order },
    files: observerFixture.files,
    hooks: {
      channels: observerFixture.hooks.channels.map((channel) => ({
        ...channel,
        when: { all: [{ field: "hooksEnabled", op: "eq", value: true }] },
      })),
    },
    execution: observerFixture.execution,
    conversation: observerFixture.conversation,
    setup,
  };
  await writeFile(
    path.join(home, ".foom/config/agents/foom-test-agent.json"),
    JSON.stringify(manifest),
  );
  const card = page
    .locator(".agent-card")
    .filter({ has: page.getByRole("heading", { name: "Setup fixture", exact: true }) });
  await expect(
    card.getByRole("img", { name: "Foom config · agents/foom-test-agent.json", exact: true }),
  ).toHaveAttribute("title", "Foom config · agents/foom-test-agent.json");
  const rescan = async (state) => {
    const report = await page.evaluate(() => window.desktop.scanAgents(true));
    assert.equal(
      report.agents.find((agent) => agent.id === "foom-test-agent")?.setup?.state,
      state,
    );
    await page.getByRole("button", { name: "Scan again", exact: true }).click();
    await expect(
      card.getByText(`Plugin · ${state === "unavailable" ? "Status unavailable" : state}`, {
        exact: true,
      }),
    ).toBeVisible();
  };
  await rescan("not-installed");
  await card.getByRole("button", { name: "Install", exact: true }).click();
  let dialog = await confirmationPage(app);
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(dialog.getByRole("alertdialog")).toContainText("Staged files");
  await expect(dialog.getByRole("alertdialog")).toContainText(".gemini/config/plugins/foom");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
  assert.equal(await readFile(commands, "utf8"), "");
  const action = async (label, state) => {
    await card.getByRole("button", { name: label, exact: true }).click();
    dialog = await confirmationPage(app);
    await dialog.getByRole("button", { name: label, exact: true }).click();
    await expect(
      card.getByText(`Plugin · ${state === "unavailable" ? "Status unavailable" : state}`, {
        exact: true,
      }),
    ).toBeVisible();
  };
  await action("Install", "installed");
  await page.evaluate(
    (repository) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "foom-test-agent",
      }),
    repository.path,
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (entry) => entry.agent === "foom-test-agent",
        )?.conversationId,
    )
    .toBe("staged-conversation");
  const launched = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
    (entry) => entry.agent === "foom-test-agent",
  );
  await page.evaluate((id) => window.desktop.input(id, "stop\r"), launched.id);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (entry) => entry.id === launched.id,
        )?.execution?.phase,
    )
    .toBe("idle");
  await writeFile(metadata, JSON.stringify({ name: "foom", foomObserverVersion: 1 }));
  await rescan("outdated");
  await action("Update", "installed");
  await writeFile(config, JSON.stringify({ plugins: { foom: { enabled: false } } }));
  await rescan("disabled");
  await action("Enable", "installed");
  await action("Remove", "not-installed");
  const mutations = (await readFile(commands, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    mutations.map((args) => args.slice(0, 2)),
    [
      ["plugin", "install"],
      ["plugin", "install"],
      ["plugin", "enable"],
      ["plugin", "uninstall"],
    ],
  );
  await mkdir(directory);
  for (const content of [
    undefined,
    "{",
    JSON.stringify({ name: "other", foomObserverVersion: 2 }),
  ]) {
    if (content !== undefined) await writeFile(metadata, content);
    await rescan("unavailable");
    await assert.rejects(
      page.evaluate(() => window.desktop.changeAgentSetup("foom-test-agent", "remove")),
    );
  }
  await rm(metadata);
  const outside = path.join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ name: "foom", foomObserverVersion: 2 }));
  await require("node:fs/promises").symlink(outside, metadata);
  await rescan("unavailable");
  assert.equal((await readFile(commands, "utf8")).trim().split("\n").length, 4);
});

test("missing agent cards recover on Settings entry and manifest reload without toggling", {
  timeout: deadline(60_000),
}, async (context) => {
  const { chmod, copyFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-missing-agent-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await Promise.all([bin, home].map((directory) => mkdir(directory)));
  const app = await launchApp(context, { fixture: "agent", env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  const openAgents = async () => {
    await openSettingsScreen(page);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Agents", exact: true })
      .click();
  };
  await openAgents();
  const file = path.join(home, ".foom/config/agents/late-agent.json");
  const manifest = {
    ...JSON.parse(await readFile(path.join(__dirname, "../fixtures/agent-plugin-v2.json"), "utf8")),
    kind: "agent",
    version: 2,
    id: "late-agent",
    name: "Late agent",
    badge: "LA",
    executables: ["late-agent"],
    attention: { minimumEngineVersion: 1, rules: [] },
    execution: { completion: "attached", completionChannels: [] },
  };
  await writeFile(file, JSON.stringify(manifest));
  const card = page.locator("#agent-card-late-agent");
  await expect(card.getByText("Not found", { exact: true })).toBeVisible();
  await expect(card.getByRole("switch")).not.toBeChecked();
  await expect(card.getByRole("switch")).toBeDisabled();
  const executable = path.join(bin, process.platform === "win32" ? "late-agent.exe" : "late-agent");
  const install = async () => {
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
  };
  await page.keyboard.press("Escape");
  await install();
  await openAgents();
  await expect(card.getByRole("switch")).toBeEnabled();
  await expect(card.getByRole("switch")).toBeChecked();
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.agents["late-agent"],
    undefined,
  );
  await rm(executable);
  await writeFile(file, JSON.stringify({ ...manifest, name: "Late agent missing" }));
  await expect(card.getByText("Not found", { exact: true })).toBeVisible();
  await expect(card.getByRole("switch")).toBeDisabled();
  await install();
  await writeFile(file, JSON.stringify({ ...manifest, name: "Late agent restored" }));
  await expect(card.getByRole("switch")).toBeEnabled();
  await expect(card.getByRole("switch")).toBeChecked();
  await card.getByRole("switch").uncheck();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.setupState())).settings.agents["late-agent"],
    )
    .toBe(false);
  await page.keyboard.press("Escape");
  await openAgents();
  await expect(card.getByRole("switch")).toBeEnabled();
  await expect(card.getByRole("switch")).not.toBeChecked();
});
