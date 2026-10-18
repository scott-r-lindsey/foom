const { FAKE_GH } = require("../helpers/forge-cli.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_CLAUDE,
  FAKE_ORCHESTRATED_CLAUDE,
  assertAccessible,
  boardCommand,
  boardPage,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

test("launches an agent in a managed worktree and routes its attention signals", {
  timeout: deadline(60_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { chmod, mkdir, writeFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-workspace-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const credentials = path.join(root, "credentials.json");

  const app = await launchApp(context, {
    fixture: "running-shell",
    shell: "hidden",
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    // A private HOME keeps the login shell from loading rc files that would put a real
    // agent ahead of the fake one on PATH.
    env: {
      HOME: path.join(root, "home"),
      PATH: bin,
      TEST_FAKE_CREDENTIALS: credentials,
    },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const setup = await page.evaluate(async () => {
    window.foomStates = [];
    window.foomExecutions = [];
    window.desktop.onExecution((event) => window.foomExecutions.push(event));
    window.desktop.onState((state) => window.foomStates.push(state));
    const repository = await window.desktop.addRepository();
    const tree = await window.desktop.createWorktree(repository.path, "feature/fake", "adjacent");
    const scan = await window.desktop.scanAgents(false);
    return { repository, tree, claude: scan.agents.find((agent) => agent.id === "claude") };
  });
  assert.equal(setup.tree.branch, "feature/fake");
  assert.equal(setup.tree.managed, true);
  assert.equal(
    setup.claude.hooks,
    true,
    `Fake agent not detected: ${JSON.stringify(setup.claude)}`,
  );

  // The renderer cannot substitute a path outside the registered Git inventory.
  await assert.rejects(
    page.evaluate((request) => window.desktop.launchAgent(request), {
      agent: "claude",
      repository: setup.repository.path,
      worktree: path.dirname(repo),
      cols: 80,
      rows: 24,
    }),
    /Worktree is missing/,
  );

  const launched = await page.evaluate((request) => window.desktop.launchAgent(request), {
    agent: "claude",
    repository: setup.repository.path,
    worktree: setup.tree.path,
    cols: 80,
    rows: 24,
  });
  assert.equal(launched.attention, "hooks");
  const id = launched.id;
  const latest = () =>
    page.evaluate((terminal) => window.foomStates.filter((s) => s.id === terminal).at(-1), id);
  await expect
    .poll(() => page.evaluate((terminal) => window.desktop.tail(terminal, 5), id), {
      timeout: deadline(10000),
    })
    .toContain("FOOM_AGENT_READY");

  // Quiet after a y/n prompt: the text rules ask for attention.
  await expect
    .poll(async () => (await latest())?.state, { timeout: deadline(10000) })
    .toBe("needs_input");
  assert.equal((await latest()).signal, "pattern:confirmation");
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.deepEqual(
    snapshot.terminals
      .filter((entry) => entry.kind === "agent")
      .map(({ id: terminal, branch, agent }) => ({ terminal, branch, agent })),
    [{ terminal: id, branch: "feature/fake", agent: "claude" }],
  );

  const agentRow = page
    .locator('.board-row[data-kind="agent"]')
    .filter({ hasText: "feature/fake" });
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  await expect(agentRow).toContainText("pattern:confirmation");
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(page.locator(".rail-needs")).toHaveText("1 need you");
  await expect(page.locator('.board-row[data-kind="agent"] .board-light')).toBeVisible();
  await expect(page.getByRole("button", { name: /Actions for.*Needs you/ })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  const firstCredentials = JSON.parse(await readFile(credentials, "utf8"));
  const controlRequest = (
    token = firstCredentials.controlToken,
    instanceId = firstCredentials.instanceId,
  ) =>
    fetch(firstCredentials.controlUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, instanceId, method: "whoami", params: {} }),
    });
  const identity = await controlRequest();
  assert.equal(identity.status, 200);
  const controlIdentity = (await identity.json()).result;
  assert.equal(controlIdentity.terminalId, id);
  assert.equal(controlIdentity.sessionId, firstCredentials.session);
  assert.equal(controlIdentity.role, "agent");
  assert.equal((await controlRequest(firstCredentials.token)).status, 401);
  assert.equal((await controlRequest(firstCredentials.controlToken, "stale-instance")).status, 400);
  assert.ok(!JSON.stringify(snapshot).includes(firstCredentials.controlToken));
  const mcpUrl = firstCredentials.controlUrl.replace("/control/v1", "/mcp");
  let mcpSession;
  const mcpRequest = (message) =>
    fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firstCredentials.controlToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(mcpSession
          ? { "Mcp-Session-Id": mcpSession, "Mcp-Protocol-Version": "2025-11-25" }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
  const initialized = await mcpRequest({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "electron-test", version: "1" },
    },
  });
  assert.equal(initialized.status, 200);
  mcpSession = initialized.headers.get("mcp-session-id");
  assert.ok(mcpSession);
  assert.equal((await mcpRequest({ method: "notifications/initialized" })).status, 202);
  const listed = await (
    await mcpRequest({ id: 2, method: "tools/list", params: { _meta: { progressToken: 1 } } })
  ).json();
  // Every agent lists the orchestration tools (#303); an ordinary agent's calls are refused.
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "whoami",
      "sessions",
      "session_state",
      "open_preview",
      "list_previews",
      "close_preview",
      "create_worktree",
      "launch",
      "stop",
      "close",
      "remove_worktree",
      "tail",
      "wait_for",
      "reply",
      "operation_status",
    ],
  );
  const metadata = await (
    await mcpRequest({ id: 3, method: "tools/call", params: { name: "sessions", arguments: {} } })
  ).json();
  assert.ok(metadata.result.structuredContent.sessions.some((row) => row.id === id));
  for (const row of metadata.result.structuredContent.sessions) {
    assert.equal(row.reason, row.state);
    assert.equal("output" in row, false);
    assert.equal("conversationId" in row, false);
    assert.equal("signal" in row, false);
  }
  assert.ok(!JSON.stringify(metadata).includes(firstCredentials.controlToken));
  const forbidden = await (
    await mcpRequest({ id: 4, method: "tools/call", params: { name: "tail", arguments: { id } } })
  ).json();
  assert.equal(forbidden.result.isError, true);
  assert.match(forbidden.result.content[0].text, /call whoami/);

  await page.evaluate(async (repository) => {
    const tree = await window.desktop.createWorktree(repository, "feature/newer", "adjacent");
    await window.desktop.launchAgent({
      agent: "claude",
      repository,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    });
  }, setup.repository.path);
  await expect(page.locator(".board-row").filter({ hasText: "feature/newer" })).toHaveAttribute(
    "data-state",
    "needs_input",
  );
  // Sidebar focus leaves the terminal attachment alone.
  await agentRow.focus();
  await page.locator(".board-row:focus").focus();
  await expect(page.locator(".board-peek")).toHaveCount(0);
  await expect(agentRow).toBeFocused();
  await expect(page.locator(".tile-terminal")).toBeHidden();
  await page.locator('.board-row[data-kind="shell"]').press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await boardCommand(app, "B");
  // The native shortcut reaches the renderer asynchronously; wait before sending
  // the next key so ArrowDown cannot go to the terminal instead of the sidebar.
  await expect(page.locator('.board-row[data-kind="shell"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-nav]:focus")).toBeVisible();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await agentRow.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.locator('.board-row[data-kind="shell"]').press("Enter");
  await boardCommand(app, "N");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  await assertAccessible(page);
  await page.keyboard.type("f");
  await expect(agentRow).toHaveAttribute("data-state", "working");
  await expect
    .poll(() =>
      agentRow
        .locator(".board-light")
        .evaluate((element) => Number(element.style.getPropertyValue("--activity"))),
    )
    .toBeGreaterThan(0.9);
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  // Typing records feedback; the agent hook establishes the permission request.
  await page.keyboard.type("y");
  await expect
    .poll(async () => (await latest())?.signal, { timeout: deadline(10000) })
    .toBe("plugin:claude:PermissionRequest");
  assert.ok(
    !(await page.evaluate(() => window.foomStates.map((s) => s.signal))).includes("user:reply"),
  );
  // Later quiet evaluations keep the permission request in force.
  await page.waitForTimeout(2500);
  assert.equal((await latest()).state, "needs_input");

  // Dismissal clears attention but does not establish resumed execution.
  await page.getByRole("button", { name: "Not attention", exact: true }).click();
  await expect(agentRow).toHaveAttribute("data-state", "quiet_ok");
  assert.equal((await latest()).signal, "user:dismissed");
  assert.equal((await latest()).execution.phase, "blocked");

  // Approval followed by a fresh working title resumes the same turn; input alone
  // never did. A title-only end (Esc) is neutral until the authoritative Stop.
  await page.evaluate((terminal) => window.desktop.input(terminal, "a"), id);
  await expect(agentRow).toHaveAttribute("data-state", "working");
  await page.evaluate((terminal) => window.desktop.input(terminal, "e"), id);
  await expect(agentRow).toHaveAttribute("data-state", "quiet_ok");
  await page.evaluate((terminal) => window.desktop.input(terminal, "s"), id);
  await expect(agentRow).toHaveAttribute("data-state", "done");
  const transitions = await page.evaluate(
    (terminal) => window.foomExecutions.filter((event) => event.terminalId === terminal),
    id,
  );
  assert.ok(transitions.some((event) => event.to === "working" && event.source === "hook"));
  assert.deepEqual(
    transitions.slice(-2).map(({ from, to, source }) => ({ from, to, source })),
    [
      { from: "blocked", to: "working", source: "title" },
      { from: "working", to: "idle", source: "title" },
    ],
  );
  assert.equal(transitions.at(-1).turn, transitions.at(-2).turn);
  assert.ok(transitions.every((event) => Number.isFinite(event.at) && event.from !== event.to));

  // Exit is final and revokes the launch's hook credentials.
  const hook = firstCredentials;
  await page.evaluate((terminal) => window.desktop.input(terminal, "q"), id);
  await expect
    .poll(async () => (await latest())?.state, { timeout: deadline(10000) })
    .toBe("failed");
  const replay = await fetch(hook.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: hook.token,
      "X-Foom-Session": hook.session,
    },
    body: JSON.stringify({ session_id: "fake-session", hook_event_name: "PermissionRequest" }),
  });
  assert.equal(replay.status, 401);
  assert.equal((await controlRequest()).status, 401);
  assert.equal((await mcpRequest({ id: 5, method: "tools/list" })).status, 401);
  await expect(agentRow).toHaveAttribute("data-state", "failed");
  await boardCommand(app, "B");
  for (const branch of ["finish-ok", "finish-failed"]) {
    await page.evaluate(
      async ({ repository, branch }) => {
        const tree = await window.desktop.createWorktree(repository, branch, "adjacent");
        await window.desktop.launchAgent({
          agent: "claude",
          repository,
          worktree: tree.path,
          cols: 80,
          rows: 24,
        });
      },
      { repository: setup.repository.path, branch },
    );
    const row = page.locator(".board-row").filter({ hasText: branch });
    await expect(row).toHaveAttribute("data-state", branch === "finish-ok" ? "done" : "failed");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await row.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(page.locator(".xterm-rows")).toContainText(
      branch === "finish-ok" ? "Finished successfully" : "Failed task",
    );
    await page.keyboard.press("Escape");
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1200, 850),
  );
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
  }
  const log = await readFile(path.join(root, "user-data", "verdicts.jsonl"), "utf8");
  assert.match(log, /"feedback":"not_attention"/);
  assert.match(log, /"action":"replied"/);
  assert.doesNotMatch(log, /FOOM_AGENT_READY|npm test/);
});

test("fake Codex receives inline flag only when help advertises it", {
  timeout: deadline(30000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-inline-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
  const help = path.join(root, "help");
  const cli = path.join(bin, "codex");
  await writeFile(
    cli,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('codex-cli 0.159.3');
else if (process.argv[2] === '--help') console.log(fs.readFileSync(${JSON.stringify(help)}, 'utf8'));
else console.log('ARGS:' + JSON.stringify(process.argv.slice(2)));
`,
  );
  await chmod(cli, 0o755);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  await writeFile(help, "--no-alt-screen");
  const app = await launchApp(context, { fixture: "agent", env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.equal(repository.path, await realpath(repo));
  await expect(page.getByRole("treeitem", { name: "repo", exact: true })).toBeVisible();
  for (const supported of [true, false]) {
    await writeFile(help, supported ? "--no-alt-screen" : "--no-alt-screen-extra");
    const id = await page.evaluate(
      async ({ repo, branch }) => {
        await window.desktop.scanAgents(true);
        const tree = await window.desktop.createWorktree(repo, branch, "adjacent");
        return (
          await window.desktop.launchAgent({
            agent: "codex",
            repository: repo,
            worktree: tree.path,
            cols: 80,
            rows: 24,
          })
        ).id;
      },
      { repo: repository.path, branch: supported ? "inline" : "fullscreen" },
    );
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
      .toContain(supported ? 'ARGS:["--no-alt-screen"]' : "ARGS:[]");
  }
});

test("agent hooks and titles publish execution transitions independently of terminal output", {
  timeout: deadline(30000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-inline-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
  const help = path.join(root, "help");
  const cli = path.join(bin, "codex");
  await writeFile(
    cli,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('codex-cli 0.159.3');
else if (process.argv[2] === '--help') console.log(fs.readFileSync(${JSON.stringify(help)}, 'utf8'));
else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\\x1b]2;⠋ codex\\x07');
  process.stdin.on('data', data => {
    if (data.toString().includes('w')) process.stdout.write('\\x1b[2J\\x1b[H\\x1b]2;⠙ codex\\x07');
    if (data.toString().includes('n')) {
      const command = JSON.parse(process.argv.find(arg => arg.startsWith('notify=')).slice(7));
      require('node:child_process').spawnSync(command[0], [...command.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'fake-thread', 'turn-id': 'fake-turn' })]);
      process.stdout.write('NOTIFIED\\n');
    }
    if (data.toString().includes('a')) process.stdout.write('\\x1b]2;Action Required | codex\\x07');
    if (data.toString().includes('i')) process.stdout.write('\\x1b[2J\\x1b[HWhich file should I edit?\\x1b]2;codex\\x07');
  });
}
`,
  );
  await chmod(cli, 0o755);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  await writeFile(help, "--no-alt-screen -c, --config <value>");
  const app = await launchApp(context, { fixture: "agent", env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.equal(repository.path, await realpath(repo));
  await expect(page.getByRole("treeitem", { name: "repo", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.executionEvents = [];
    window.desktop.onExecution((event) => window.executionEvents.push(event));
  });
  const id = await page.evaluate(async (repo) => {
    await window.desktop.scanAgents(true);
    const tree = await window.desktop.createWorktree(repo, "titles", "adjacent");
    return (
      await window.desktop.launchAgent({
        agent: "codex",
        acknowledgeNotifierReplacement: true,
        repository: repo,
        worktree: tree.path,
        cols: 80,
        rows: 24,
      })
    ).id;
  }, repository.path);
  const row = page.locator('.board-row[data-kind="agent"]');
  await expect(row).toHaveAttribute("data-state", "working");
  await expect(row).toContainText("rules:codex:osc_title_working");
  await page.evaluate((id) => window.desktop.input(id, "a"), id);
  await expect(row).toHaveAttribute("data-state", "needs_input");
  await expect(row).toContainText("Approval requested");
  await expect(row).toContainText("rules:codex:osc_title_blocked");
  await page.evaluate((id) => window.desktop.input(id, "i"), id);
  await expect(row).toHaveAttribute("data-state", "needs_input");
  await expect(row).toContainText("Agent asks a question");
  await expect(row).toContainText("pattern:question");
  await page.evaluate((id) => window.desktop.input(id, "w"), id);
  await expect(row).toHaveAttribute("data-state", "working");
  await page.evaluate((id) => window.desktop.input(id, "n"), id);
  await expect(row).toHaveAttribute("data-state", "done");
  const events = await page.evaluate(() => window.executionEvents);
  assert.deepEqual(
    events.map((event) => event.to),
    ["working", "blocked", "idle", "blocked", "working", "idle"],
  );
  assert.equal(events.at(-1).source, "hook");
  assert.equal(events.at(-1).turn, 2);
  assert.ok(
    events.every((event) => event.terminalId === id && !("tail" in event) && !("prompt" in event)),
  );
});

for (const agent of ["claude", "codex", "agy"]) {
  test(`resumes exited ${agent} conversations in place after a Foom restart`, {
    timeout: deadline(60_000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod } = require("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "foom-resume-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const profile = path.join(root, "profile");
    const argvFile = path.join(root, "argv.json");
    await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    if (agent === "agy") {
      const plugin = path.join(home, ".gemini/config/plugins/foom");
      await mkdir(plugin, { recursive: true });
      await writeFile(
        path.join(plugin, "plugin.json"),
        JSON.stringify({ name: "foom", foomObserverVersion: 2 }),
      );
    }
    const conversation = "0199abcd-1234-7890-abcd-123456789abc";
    await writeFile(
      path.join(bin, agent),
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync, renameSync } = require("node:fs");
const args = process.argv.slice(2);
const agent = ${JSON.stringify(agent)};
if (args[0] === "--version") { console.log(agent === "claude" ? "2.1.300 (Claude Code)" : agent === "codex" ? "codex-cli 0.160.1" : "1.3.3"); process.exit(0); }
if (args[0] === "--help") { console.log("--settings <json> -c, --config <value> --no-alt-screen"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "list") { console.log(JSON.stringify({ imports: [{ name: "foom" }] })); process.exit(0); }
const record = process.env.TEST_ARGV + "." + process.pid + ".tmp";
writeFileSync(record, JSON.stringify({ args, cwd: process.cwd(), token: process.env.FOOM_TOKEN, pid: process.pid }));
renameSync(record, process.env.TEST_ARGV);
const resumed = args.includes("--resume") || args.includes("resume") || args.includes("--conversation");
if (resumed) {
  console.log("RESUMED_CONVERSATION " + process.pid);
  process.stdin.setRawMode(true);
  process.stdin.on("data", () => process.exit(0));
} else if (agent === "agy") {
  const payload = JSON.stringify({ conversationId: ${JSON.stringify(conversation)}, fullyIdle: true, terminationReason: "NO_TOOL_CALL", transcriptPath: "/must/not/read" });
  const request = require("node:http").request(process.env.FOOM_HOOK_URL, { method: "POST", headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "X-Foom-Event": "Stop", "X-Foom-Sequence": "1", "Content-Type": "application/json" } }, response => {
    response.resume();
    response.on("end", () => { console.log("AGENT_EXITED"); process.exit(response.statusCode === 204 ? 0 : 1); });
  });
  request.on("error", error => { console.error(error.message); process.exit(1); });
  request.end(payload);
} else {
  const payload = agent === "claude" ? { session_id: ${JSON.stringify(conversation)}, hook_event_name: "Stop" } : { "thread-id": ${JSON.stringify(conversation)}, "turn-id": "turn-1", type: "agent-turn-complete" };
  let command, hookArgs, input;
  if (agent === "claude") {
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    command = "sh"; hookArgs = ["-c", settings.hooks.Stop[0].hooks[0].command]; input = JSON.stringify(payload);
  } else {
    const notify = args.find(arg => arg.startsWith("notify="));
    [command, ...hookArgs] = JSON.parse(notify.slice(7));
    hookArgs.push(JSON.stringify(payload));
  }
  const hook = spawn(command, hookArgs, { stdio: ["pipe", "ignore", "inherit"] });
  hook.stdin.end(input);
  hook.on("exit", () => { console.log("AGENT_EXITED"); process.exit(0); });
}
`,
    );
    await chmod(path.join(bin, agent), 0o755);
    const options = {
      fixture: "agent",
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: bin, TEST_ARGV: argvFile },
    };
    const app = await launchApp(context, options);
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    const id = await page.evaluate(async (agent) => {
      const repository = await window.desktop.addRepository();
      return window.desktop.startWorktree({
        repository: repository.path,
        branch: "resume-test",
        run: agent,
        acknowledgeNotifierReplacement: true,
      });
    }, agent);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.desktop.workspace()).terminals.find((row) => row.id === id),
          id,
        ),
      )
      .toMatchObject({ exited: true, conversationId: conversation });
    const firstLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8"))[0]
            ?.conversationId,
      )
      .toBe(conversation);
    await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
    const restoredApp = await launchApp(context, { ...options, fixture: "restored" });
    const restored = await boardPage(restoredApp);
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: true, dormant: true, conversationId: conversation }]);
    const agentName =
      agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Antigravity";
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "Copy session ID", exact: true }).click();
    // Clipboard writing finishes before the source's inventory refresh and panel
    // dismissal. Wait for the actual details dialog to close before opening it again.
    await expect(
      restored.getByRole("dialog", { name: `${agentName} details and commands`, exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => restoredApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(conversation);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: false, conversationId: conversation }]);
    await expect(restored.locator(".xterm-rows")).toContainText("RESUMED_CONVERSATION");
    const resumedLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${resumedLaunch.pid}`,
    );
    assert.deepEqual(resumedLaunch.args.slice(0, 2), [
      agent === "claude" ? "--resume" : agent === "codex" ? "resume" : "--conversation",
      conversation,
    ]);
    assert.equal(resumedLaunch.cwd, firstLaunch.cwd);
    assert.ok(firstLaunch.token);
    assert.ok(resumedLaunch.token);
    assert.notEqual(resumedLaunch.token, firstLaunch.token);
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    await restored.locator(".xterm-helper-textarea").press("q");
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(true);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(false);
    await expect
      .poll(async () => JSON.parse(await readFile(argvFile, "utf8")).token)
      .not.toBe(resumedLaunch.token);
    const secondResume = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${secondResume.pid}`,
    );
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    await restored.locator(".xterm-helper-textarea").press("q");
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(true);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals.length),
      )
      .toBe(0);
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8")))
      .toEqual([]);
    assert.equal(await realpath(resumedLaunch.cwd), resumedLaunch.cwd);
  });
}

test("stable Codex observers drive execution and retire the notifier after a verified turn", {
  timeout: deadline(30000),
  skip:
    process.platform === "win32" &&
    "The fake CLI is a POSIX executable; native Windows observers have unit integration coverage",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-codex-hooks-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
  const cli = path.join(bin, "codex");
  await writeFile(
    cli,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.161.0'); process.exit(0); }
if (args[0] === '--help') { console.log('-c, --config <value> --no-alt-screen'); process.exit(0); }
const notify = args.find(arg => arg.startsWith('notify='));
const hooks = args.filter(arg => arg.startsWith('hooks.'));
if (hooks.length !== 6) throw new Error('Missing lifecycle hooks');
const emit = (event) => {
  const definition = hooks.find(arg => arg.startsWith('hooks.' + event + '='));
  const command = JSON.parse(definition.match(/command=("(?:[^"\\\\]|\\\\.)*")/)[1]);
  const payload = { session_id: 'fake-conversation', hook_event_name: event, turn_id: 'turn', source: 'startup', tool_name: 'Bash', stop_hook_active: false, prompt: 'DISCARDED', transcript_path: '/never-read' };
  const result = spawnSync('sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (result.status !== 0 || result.stdout || result.stderr) throw new Error('Observer emitted output or failed');
};
console.log(notify ? 'NOTIFIER FALLBACK' : 'USER NOTIFIER PRESERVED');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  const key = data.toString();
  if (key === 's') emit('SessionStart');
  if (key === 'w') emit('UserPromptSubmit');
  if (key === 'b') emit('PermissionRequest');
  if (key === 'p') emit('PostToolUse');
  if (key === 'e') { console.log('Completed.'); emit('Stop'); }
  if (key === 'n') {
    const command = JSON.parse(notify.slice(7));
    spawnSync(command[0], [...command.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'fake-conversation', 'turn-id': 'fallback-turn' })]);
  }
  console.log('OBSERVED ' + key);
});
`,
  );
  await chmod(cli, 0o755);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  const app = await launchApp(context, { fixture: "agent", env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  const launch = (branch, acknowledge) =>
    page.evaluate(
      async ({ repository, branch, acknowledge }) => {
        await window.desktop.scanAgents(true);
        const tree = await window.desktop.createWorktree(repository, branch, "adjacent");
        return (
          await window.desktop.launchAgent({
            agent: "codex",
            repository,
            worktree: tree.path,
            cols: 80,
            rows: 24,
            acknowledgeNotifierReplacement: acknowledge,
          })
        ).id;
      },
      { repository: repository.path, branch, acknowledge },
    );
  const id = await launch("first", true);
  const health = () =>
    page.evaluate(
      async () =>
        (await window.desktop.scanAgents(false)).agents.find((agent) => agent.id === "codex")
          .hookState,
    );
  const phase = () =>
    page.evaluate(
      async (id) =>
        (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
          .execution.phase,
      id,
    );
  const key = async (value) => {
    await page.evaluate(({ id, value }) => window.desktop.input(id, value), { id, value });
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
      .toContain(`OBSERVED ${value}`);
  };
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
    .toContain("NOTIFIER FALLBACK");
  await key("n");
  await expect.poll(health).toBe("declined");
  await key("s");
  await key("w");
  await expect.poll(phase).toBe("working");
  await key("b");
  await expect.poll(phase).toBe("blocked");
  await key("p");
  await expect.poll(phase).toBe("working");
  await key("e");
  await expect.poll(phase).toBe("idle");
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id).state
            ?.state,
        id,
      ),
    )
    .toBe("done");
  await expect.poll(health).toBe("trusted");
  const later = await launch("later", false);
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), later))
    .toContain("USER NOTIFIER PRESERVED");
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(page.getByText(/Trusted · observed working/)).toBeVisible();
  await page.screenshot({ path: path.join(__dirname, "../../test-results/codex-hook-setup.png") });
});

for (const firstRun of [false, true]) {
  test(`Antigravity plugin ${firstRun ? "first run" : "Settings"} disclosure installs and removes an observer that reports lifecycle`, {
    timeout: deadline(60_000),
    skip:
      process.platform === "win32" &&
      "Fake CLI is POSIX; Windows cmd/PowerShell observer runs in native unit integration",
  }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "foom-agy-plugin-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    const repo = path.join(root, "repository");
    await Promise.all([bin, home, repo].map((directory) => mkdir(directory)));
    const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const args = process.argv.slice(2);
const directory = path.join(require('node:os').homedir(), '.gemini/config/plugins/foom');
if (args[0] === '--version') { console.log('1.3.1'); process.exit(0); }
if (args[0] === '--help') { console.log('Antigravity CLI'); process.exit(0); }
if (args[0] === 'plugin') {
  if (args[1] === 'list') console.log(JSON.stringify({imports: fs.existsSync(directory) ? [{name:'foom'}] : []}));
  else if (args[1] === 'install') { fs.mkdirSync(path.dirname(directory), {recursive:true}); fs.cpSync(args[2], directory, {recursive:true}); }
  else if (args[1] === 'uninstall' && args[2] === 'foom') fs.rmSync(directory, {recursive:true, force:true});
  else process.exit(2);
  process.exit(0);
}
const spec = JSON.parse(fs.readFileSync(path.join(directory,'hooks.json'),'utf8'))['foom-observer-v1'];
process.stdin.setRawMode(true);
process.stdin.resume();
console.log('AGY_READY');
process.stdin.on('data', (data) => {
  const key = data.toString();
  if (key === 'q') process.exit(0);
  const event = key === 'w' ? 'PreInvocation' : 'Stop';
  const child = execFile('sh', ['-c', spec[event][0].command], {cwd:directory}, (error, stdout, stderr) => {
    if (error || stdout.trim() !== '{}' || stderr) process.exit(4);
    console.log('OBSERVER_RETURNED_' + event);
  });
  child.stdin.end(JSON.stringify({conversationId:'fake-agy-session', terminationReason:key === 'f' ? 'error' : 'NO_TOOL_CALL', fullyIdle:true, transcriptPath:'/must-not-read'}));
});
`;
    await writeFile(path.join(bin, "agy"), fake, { mode: 0o755 });
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
      fixture: firstRun ? "first-run" : "agent",
      env: { HOME: home, PATH: bin },
    });
    const page = await boardPage(app);
    if (firstRun) await page.getByRole("button", { name: "Start preflight" }).click();
    else {
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "Agents", exact: true }).click();
      await expect(page.getByText("Plugin available", { exact: true })).toBeVisible();
    }
    const agyRow = page
      .locator(".agent-card")
      .filter({ has: page.getByText("Antigravity", { exact: true }) });
    await expect(agyRow.getByRole("button", { name: "Screen rules", exact: true })).toBeVisible();
    await expect(agyRow.getByText("Screen rules active", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Install", exact: true }).click();
    let disclosure = await confirmationPage(app);
    await expect(
      disclosure.getByText("~/.gemini/config/plugins/foom", { exact: true }),
    ).toBeVisible();
    await expect(
      disclosure.getByText(
        /observes only Foom launches, approves no tools, stores no credentials/u,
      ),
    ).toBeVisible();
    await expect(disclosure.getByText(/agy plugin uninstall foom/u)).toBeVisible();
    await disclosure.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Plugin available", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.desktop.scanAgents(true)).agents.find((agent) => agent.id === "agy")
              ?.setup?.offer === undefined,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Install", exact: true }).click();
    disclosure = await confirmationPage(app);
    await disclosure.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByText("Plugin · installed", { exact: true })).toBeVisible();
    await expect(agyRow.getByRole("button", { name: "Hooks", exact: true })).toBeVisible();
    await assertAccessible(page);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    const id = await page.evaluate(async () => {
      window.agyTransitions = [];
      window.desktop.onExecution((event) => window.agyTransitions.push(event));
      const repository = await window.desktop.addRepository();
      const tree = await window.desktop.createWorktree(repository.path, "feature/agy", "adjacent");
      const launch = await window.desktop.launchAgent({
        agent: "agy",
        repository: repository.path,
        worktree: tree.path,
        cols: 80,
        rows: 24,
      });
      return launch.id;
    });
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 10), id))
      .toContain("AGY_READY");
    await page.evaluate((id) => window.desktop.input(id, "w"), id);
    await expect.poll(() => page.evaluate(() => window.agyTransitions.at(-1)?.to)).toBe("working");
    await page.evaluate((id) => window.desktop.input(id, "s"), id);
    await expect.poll(() => page.evaluate(() => window.agyTransitions.at(-1)?.to)).toBe("idle");
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.state?.state,
          id,
        ),
      )
      .toBe("done");
    // A later turn can lose its detached Working report. Its newer failed Stop
    // must still replace Done; sequence ordering already rejects old reports.
    await page.evaluate((id) => window.desktop.input(id, "f"), id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.state?.state,
          id,
        ),
      )
      .toBe("failed");
    await page.evaluate((id) => window.desktop.input(id, "w"), id);
    await expect.poll(() => page.evaluate(() => window.agyTransitions.at(-1)?.to)).toBe("working");
    await page.evaluate((id) => window.desktop.input(id, "f"), id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.state?.state,
          id,
        ),
      )
      .toBe("failed");
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    disclosure = await confirmationPage(app);
    await disclosure.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
    await page.evaluate((id) => window.desktop.input(id, "q"), id);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) =>
            (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
              ?.exited,
          id,
        ),
      )
      .toBe(true);
  });
}

test("console pairing requires trusted approval and gives only read-only repository scope", {
  timeout: deadline(45000),
}, async (context) => {
  const { assertCliPairing } = require("./cli-checks.js");
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  const confirmation = await confirmationPage(app);
  await assertCliPairing(
    context,
    path.join(__dirname, "../../build/console", process.platform === "win32" ? "foom.exe" : "foom"),
    profile,
    repository,
    confirmation,
  );
});

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
  await panel.getByRole("menuitem", { name: "Claude Code" }).click();
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
  // A second launch focuses the running session instead of starting another.
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "config-launch", run: "shell" }));
  assert.equal(
    (await page.evaluate(() => window.desktop.workspace())).terminals.filter(
      (entry) => entry.config,
    ).length,
    1,
  );

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
  await sections.getByRole("button", { name: "Themes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Agent", exact: true })).toBeVisible();

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
  await page.screenshot({ path: "test-results/config-footer-compact.png", animations: "disabled" });
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

test("an orchestrator adopts an open PR, launches its child without taking focus and closes it after exit", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { chmod, mkdir, readFile, symlink, writeFile } = require("node:fs/promises");
  const { existsSync } = require("node:fs");
  const root = await mkdtemp(path.join(tmpdir(), "foom-forge-adopt-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  for (const directory of [bin, repo, home]) await mkdir(directory);
  await writeFile(path.join(bin, "claude"), FAKE_ORCHESTRATED_CLAUDE);
  await writeFile(path.join(bin, "gh"), FAKE_GH);
  for (const name of ["claude", "gh"]) await chmod(path.join(bin, name), 0o755);
  await symlink(process.execPath, path.join(bin, "node"));
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "child-one");
  const remote = path.join(root, "remote.git");
  git("clone", "--bare", repo, remote);
  git("branch", "-D", "child-one");
  git("remote", "add", "origin", "https://github.com/fixture/offline.git");
  git("config", `url.${remote}.insteadOf`, "https://github.com/fixture/offline.git");
  git("config", "remote.pushDefault", "elsewhere");
  const forgeState = path.join(root, "forge.json");
  await writeFile(
    forgeState,
    JSON.stringify({ pr: { headRepositoryOwner: { login: "fixture" } }, checks: [] }),
  );
  const credentials = path.join(root, "credentials.json");
  const app = await launchApp(context, {
    fixture: "agent",
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    env: {
      HOME: home,
      PATH: [bin, "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter),
      TEST_FAKE_CREDENTIALS: credentials,
      TEST_FORGE_STATE: forgeState,
    },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(async () => (await window.desktop.addRepository()).path);
  await page.evaluate(
    ({ repository }) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "claude",
      }),
    { repository },
  );
  await expect.poll(() => existsSync(`${credentials}.app`)).toBe(true);
  const parent = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
  const call = async (method, params = {}) => {
    const response = await fetch(parent.controlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${parent.controlToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, instanceId: parent.instanceId, method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const parentId = (await call("whoami")).terminalId;
  const parentRow = page
    .locator(".session-entry")
    .filter({ has: page.locator(`[data-drag-session="${parentId}"]`) });
  await parentRow
    .locator(":scope > .board-row")
    .getByRole("button", { name: /^Actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Make orchestrator…" }).click();
  const confirmation = await confirmationPage(app);
  await expect(
    confirmation.getByText(/Close its exited children, discarding their final screens/),
  ).toBeVisible();
  await confirmation.getByRole("button", { name: "Make orchestrator" }).click();
  await expect.poll(async () => (await call("whoami")).role).toBe("orchestrator");
  const mcpUrl = parent.controlUrl.replace("/control/v1", "/mcp");
  let mcpSession;
  const mcp = async (method, params, notification = false) => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${parent.controlToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: 1 }), method, params }),
    });
    if (method === "initialize") mcpSession = response.headers.get("mcp-session-id");
    assert.equal(response.status, notification ? 202 : 200);
    if (notification) return;
    return (await response.json()).result;
  };
  await mcp("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  await mcp("notifications/initialized", {}, true);
  const tool = async (name, args) => {
    const result = await mcp("tools/call", { name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  await page.locator(`[data-drag-session="${parentId}"]`).click();
  const focusedTile = page.locator('.terminal-tile[data-focused="true"]');
  const tileId = await focusedTile.getAttribute("data-tile");
  const input = focusedTile.locator("textarea.xterm-helper-textarea");
  await expect(input).toBeFocused();
  const tree = await call("create_worktree", { pullRequest: 340, idempotencyKey: "adopt-tree" });
  assert.equal(tree.status, "succeeded");
  const child = await tool("launch", {
    worktreeId: tree.resultId,
    agent: "claude",
    idempotencyKey: "adopt-child",
  });
  assert.equal(child.status, "succeeded");
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(2);
  await expect(focusedTile).toHaveAttribute("data-tile", tileId);
  await expect(input).toBeFocused();
  // A single character would exit either fixture if an arrival stole input.
  await page.keyboard.type("x");
  await expect(input).toBeFocused();
  await expect
    .poll(async () => (await call("session_state", { id: child.resultId })).pullRequest?.number)
    .toBe(340);
  const rows = (await page.evaluate(() => window.desktop.workspace())).terminals;
  const childRow = rows.find((row) => row.id === child.resultId);
  assert.equal(childRow.branch, "child-one");
  assert.equal(git("config", "--get", "branch.child-one.pushRemote").trim(), "origin");
  assert.equal(
    isolatedGit(["rev-parse", "--abbrev-ref", "@{upstream}"], {
      cwd: childRow.worktree,
      encoding: "utf8",
    }).trim(),
    "origin/child-one",
  );
  assert.equal(
    isolatedGit(["rev-parse", "HEAD"], { cwd: childRow.worktree, encoding: "utf8" }).trim(),
    git("rev-parse", "origin/child-one").trim(),
  );
  const closed = await tool("stop", { id: child.resultId, idempotencyKey: "stop-child" });
  assert.equal(closed.status, "succeeded");
  await expect
    .poll(async () => (await call("session_state", { id: child.resultId })).state)
    .toBe("exited");
  const close = await tool("close", { id: child.resultId, idempotencyKey: "close-child" });
  assert.equal(close.status, "succeeded");
  await expect(page.locator(`[data-drag-session="${child.resultId}"]`)).toHaveCount(0);
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await expect(input).toBeFocused();
  assert.ok(existsSync(childRow.worktree));
  assert.match(git("branch", "--list", "child-one"), /child-one/);
  assert.equal(
    (await tool("close", { id: child.resultId, idempotencyKey: "close-child" })).operationId,
    close.operationId,
  );
});

test("an orchestrator wait_for wakes on a child PR required-check conclusion", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { chmod, mkdir, readFile, symlink, writeFile } = require("node:fs/promises");
  const { existsSync } = require("node:fs");
  const root = await mkdtemp(path.join(tmpdir(), "foom-forge-wait-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  for (const directory of [bin, repo, home]) await mkdir(directory);
  await writeFile(path.join(bin, "claude"), FAKE_ORCHESTRATED_CLAUDE);
  await writeFile(path.join(bin, "gh"), FAKE_GH);
  for (const name of ["claude", "gh"]) await chmod(path.join(bin, name), 0o755);
  await symlink(process.execPath, path.join(bin, "node"));
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("remote", "add", "origin", "https://github.com/fixture/offline.git");
  const forgeState = path.join(root, "forge.json");
  await writeFile(forgeState, JSON.stringify({ checks: [{ bucket: "pending" }], exitCode: 8 }));
  const credentials = path.join(root, "credentials.json");
  const app = await launchApp(context, {
    fixture: "agent",
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    env: {
      HOME: home,
      PATH: bin,
      TEST_FAKE_CREDENTIALS: credentials,
      TEST_FORGE_STATE: forgeState,
    },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(async () => (await window.desktop.addRepository()).path);
  await page.evaluate(
    ({ repository }) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "claude",
      }),
    { repository },
  );
  await expect.poll(() => existsSync(`${credentials}.app`)).toBe(true);
  const parent = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
  const call = async (method, params = {}) => {
    const response = await fetch(parent.controlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${parent.controlToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, instanceId: parent.instanceId, method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const parentId = (await call("whoami")).terminalId;
  const parentRow = page
    .locator(".session-entry")
    .filter({ has: page.locator(`[data-drag-session="${parentId}"]`) });
  await parentRow
    .locator(":scope > .board-row")
    .getByRole("button", { name: /^Actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Make orchestrator…" }).click();
  const confirmation = await confirmationPage(app);
  await confirmation.getByRole("button", { name: "Make orchestrator" }).click();
  await expect.poll(async () => (await call("whoami")).role).toBe("orchestrator");
  const tree = await call("create_worktree", { branch: "child-one", idempotencyKey: "forge-tree" });
  const child = await call("launch", {
    worktreeId: tree.resultId,
    agent: "claude",
    idempotencyKey: "forge-child",
  });
  const childId = child.resultId;
  await expect
    .poll(async () => (await call("session_state", { id: childId })).attentionKind)
    .toBe("question");
  await expect
    .poll(async () => (await call("session_state", { id: childId })).pullRequest?.requiredChecks)
    .toBe("pending");
  const before = await call("session_state", { id: childId });
  let cursor = before.revision;
  let changed;
  await writeFile(forgeState, JSON.stringify({ checks: [{ bucket: "pass" }] }));
  // Settled verdict revisions may precede the forge sample. Advance only the
  // Foom API cursor; the orchestrator makes no forge calls or terminal writes.
  await expect
    .poll(
      async () => {
        const result = await call("wait_for", {
          ids: [childId],
          after: { [childId]: cursor },
          timeoutMs: 30000,
        });
        assert.equal(result.sessions[0].state, before.state);
        cursor = result.sessions[0].revision;
        if (result.sessions[0].pullRequest?.requiredChecks !== "success") return false;
        changed = result;
        return true;
      },
      { timeout: deadline(60000), intervals: [0] },
    )
    .toBe(true);
  assert.equal(changed.timedOut, false);
  assert.deepEqual(changed.changed, [childId]);
  assert.deepEqual(changed.sessions[0].pullRequest, {
    number: 340,
    headSha: "a".repeat(40),
    state: "OPEN",
    requiredChecks: "success",
  });
  assert.deepEqual(
    (await call("sessions")).sessions.find((row) => row.id === childId).pullRequest,
    changed.sessions[0].pullRequest,
  );
});

test("an agent made orchestrator reports MCP attachment independently", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "attachment");
});

test("an Antigravity orchestrator has no MCP attachment indicator", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, true, "attachment");
});

test("an agent made orchestrator manages and reviews only its own children", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "children");
});

test("an Antigravity orchestrator manages and reviews children through the packaged console", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, true, "children");
});

test("an agent made orchestrator reviews worktree cleanup and revokes with a live child", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "cleanup");
});

test("an Antigravity orchestrator reviews worktree cleanup and revokes through the packaged console", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, true, "cleanup");
});

test("a child hands off results through the CLI without terminal input and the parent pulls them", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "handoff");
});

test("an idle orchestrator waits on children without hiding real attention", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  await runOrchestratorScenario(context, false, "waiting");
});

// Each scenario owns its app/profile and cleanup; no state crosses test boundaries.
async function runOrchestratorScenario(context, cliOnly, phase) {
  const { chmod, mkdir, readdir, readFile, symlink, writeFile } = require("node:fs/promises");
  const { existsSync } = require("node:fs");
  const root = await mkdtemp(path.join(tmpdir(), "foom-orchestrator-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(home);
  const waitingFixture = FAKE_ORCHESTRATED_CLAUDE.replace(
    '  if (key.toString() === "q") process.exit(0);',
    `  if (key.toString() === "q") process.exit(0);
  if (!isChild && ["w", "i", "?"].includes(key.toString())) {
    const title = key.toString() === "w" ? "◐ Working" : "✳ Claude Code";
    const line = key.toString() === "?" ? "Continue? (y/n)" : "Ready";
    process.stdout.write("\\x1b[2J\\x1b[H\\x1b]0;" + title + "\\x07" + line + "\\r\\n");
    return;
  }`,
  );
  await writeFile(
    path.join(bin, "claude"),
    phase === "waiting" ? waitingFixture : FAKE_ORCHESTRATED_CLAUDE,
  );
  if (cliOnly) {
    await writeFile(
      path.join(bin, "agy"),
      FAKE_ORCHESTRATED_CLAUDE.replace("2.1.296 (Claude Code)", "1.2.13 (Antigravity)").replace(
        "--mcp-config <configs...>",
        "--prompt-interactive <prompt>",
      ),
    );
    await chmod(path.join(bin, "agy"), 0o755);
  }
  // Screen-only Codex stand-in: no hooks/MCP advertised and no notifier consent.
  const providerScreens = {
    "@": "Selected model is at capacity",
    "#": "■ rate limit exceeded: Please try again in 10s.",
    $: "Approaching rate limits\nSwitch to gpt-6-luna for lower credit usage?\nKeep current model\nenter select · esc back",
  };
  await writeFile(
    path.join(bin, "codex"),
    FAKE_ORCHESTRATED_CLAUDE.replace("2.1.296 (Claude Code)", "codex-cli 0.160.1")
      .replace("--settings <file-or-json>  Load settings", "--no-alt-screen")
      .replace(
        "  if (isChild) {",
        `  if (isChild && ${JSON.stringify(providerScreens)}[key.toString()]) {
        process.stdout.write("\\x1b[2J\\x1b[H" + ${JSON.stringify(providerScreens)}[key.toString()].replaceAll("\\n", "\\r\\n") + "\\r\\n");
        return;
      }
      if (isChild) {`,
      ),
  );
  await chmod(path.join(bin, "codex"), 0o755);
  await chmod(path.join(bin, "claude"), 0o755);
  // Only the fake agent and system tools: real agents on PATH write their own state when probed.
  await symlink(process.execPath, path.join(bin, "node"));
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const credentials = path.join(root, "credentials.json");
  const app = await launchApp(context, {
    fixture: "agent",
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    env: {
      HOME: home,
      PATH: bin,
      TEST_FAKE_CREDENTIALS: credentials,
    },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const repository = await page.evaluate(async () => (await window.desktop.addRepository()).path);
  const claude = await page.evaluate(async () =>
    (await window.desktop.scanAgents(true)).agents.find((agent) => agent.id === "claude"),
  );
  assert.equal(claude.mcp, true, `Fake agent lacks MCP: ${JSON.stringify(claude)}`);
  const read = async (name) => JSON.parse(await readFile(`${credentials}.${name}`, "utf8"));

  await page.evaluate(
    ({ repository, run }) =>
      window.desktop.sidebarCommand({ kind: "launch", repository, worktree: repository, run }),
    { repository, run: cliOnly ? "agy" : "claude" },
  );
  await expect
    .poll(() => existsSync(`${credentials}.app`), { timeout: deadline(15000) })
    .toBe(true);
  const parent = await read("app");
  // Per-launch MCP with an environment-sourced header; no token in argv or the file.
  if (cliOnly) {
    assert.equal(parent.mcp, null);
    assert.ok(parent.args.includes("--prompt-interactive"));
    assert.ok(parent.args.some((arg) => arg.includes("foom whoami --json lists your current")));
  } else {
    assert.ok(parent.args.includes("--mcp-config"));
    const server = Object.values(parent.mcp.mcpServers)[0];
    assert.equal(server.headers.Authorization, "Bearer ${FOOM_CONTROL_TOKEN}");
  }
  assert.ok(!JSON.stringify(parent.args).includes(parent.controlToken));
  let requestId = 0;
  let parentId;
  let elevated = false;
  const call = async (token, method, params = {}) => {
    if (cliOnly && elevated && token === parent.controlToken && method !== "whoami") {
      const args = [method.replaceAll("_", "-")];
      if (params.branch) args.push(params.branch);
      if (params.worktreeId) args.push(params.worktreeId);
      if (params.id) args.push(params.id);
      if (params.ids) args.push(...params.ids);
      for (const [key, flag] of [
        ["idempotencyKey", "--idempotency-key"],
        ["agent", "--agent"],
        ["prompt", "--prompt"],
        ["lines", "--lines"],
        ["timeoutMs", "--timeout-ms"],
        ["revision", "--revision"],
        ["verdictId", "--verdict-id"],
        ["text", "--text"],
      ])
        if (params[key] !== undefined) args.push(flag, String(params[key]));
      if (params.after) args.push("--after", JSON.stringify(params.after));
      const id = ++requestId;
      await page.evaluate(({ parentId, text }) => window.desktop.input(parentId, text), {
        parentId,
        text: JSON.stringify({ id, args }) + "\n",
      });
      const file = `${credentials}.response-${id}`;
      await expect.poll(() => existsSync(file), { timeout: deadline(40000) }).toBe(true);
      const result = JSON.parse(await readFile(file, "utf8"));
      return {
        status: result.code === 0 ? 200 : result.code === 3 ? 403 : 400,
        body: JSON.parse(result.stdout || result.stderr),
      };
    }
    const response = await fetch(parent.controlUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, instanceId: parent.instanceId, method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  const ordinary = await call(parent.controlToken, "whoami");
  assert.equal(ordinary.body.result.role, "agent");
  assert.ok(!ordinary.body.result.capabilities.includes("launch"));
  parentId = ordinary.body.result.terminalId;
  assert.equal(
    (await call(parent.controlToken, "create_worktree", { idempotencyKey: "early", branch: "x" }))
      .status,
    403,
  );

  // The human grants the role from the session menu; the agent keeps running.
  const parentRow = page
    .locator(".session-entry")
    .filter({ has: page.locator(`[data-drag-session="${parentId}"]`) });
  await parentRow
    .locator(":scope > .board-row")
    .getByRole("button", { name: /^Actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Make orchestrator…" }).click();
  const confirmation = await confirmationPage(app);
  await expect(
    confirmation.getByRole("heading", {
      name: `Make ${cliOnly ? "Antigravity" : "Claude Code"} the Foom orchestrator?`,
    }),
  ).toBeVisible();
  await expect(confirmation.getByText(/model provider/)).toBeVisible();
  await confirmation.getByRole("button", { name: "Make orchestrator" }).click();
  await expect
    .poll(async () => (await call(parent.controlToken, "whoami")).body.result?.role)
    .toBe("orchestrator");
  elevated = true;
  const whoami = await call(parent.controlToken, "whoami");
  assert.ok(whoami.body.result.capabilities.includes("launch"));
  assert.equal(whoami.body.result.terminalId, parentId);

  const connection = async (id) =>
    (await page.evaluate(() => window.desktop.workspace())).terminals.find((row) => row.id === id)
      ?.mcpConnection;
  const connect = async (client) => {
    const response = await fetch(client.controlUrl.replace("/control/v1", "/mcp"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.controlToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  if (phase === "attachment") {
    if (!cliOnly) {
      // The fake client never calls MCP. CLI traffic cannot prove attachment.
      assert.equal(await connection(parentId), "connecting");
      await expect
        .poll(() => connection(parentId), { timeout: deadline(35000) })
        .toBe("not-connected");
      await parentRow
        .locator(":scope > .board-row")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await expect(page.getByText("Not connected", { exact: true })).toBeVisible();
      await expect(page.getByText("Not connected", { exact: true })).toHaveAttribute(
        "data-tone",
        "failed",
      );
      await connect(parent);
      await expect.poll(() => connection(parentId)).toBe("connected");
      await expect(page.getByText("Connected", { exact: true })).toHaveAttribute(
        "data-tone",
        "neutral",
      );
      await page.keyboard.press("Escape");
    } else {
      assert.equal(await connection(parentId), undefined);
    }
  }

  if (phase !== "attachment") {
    if (phase === "children") {
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "General", exact: true }).click();
      const limit = page.getByRole("spinbutton", { name: "Concurrent children per orchestrator" });
      await expect(limit).toHaveValue("4");
      await limit.fill("1");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.desktop.setupState())).settings.concurrentChildren,
        )
        .toBe(1);
      await page.screenshot({ path: `test-results/child-limit-${cliOnly ? "agy" : "claude"}.png` });
      await assertAccessible(page);
      await page.keyboard.press("Escape");
    }
    const tree = await call(parent.controlToken, "create_worktree", {
      idempotencyKey: "tree-1",
      branch: "child-one",
    });
    assert.equal(tree.body.result.status, "succeeded");
    assert.deepEqual(
      (
        await call(parent.controlToken, "create_worktree", {
          idempotencyKey: "tree-1",
          branch: "child-one",
        })
      ).body,
      tree.body,
    );
    const launched = await call(parent.controlToken, "launch", {
      idempotencyKey: "launch-1",
      worktreeId: tree.body.result.resultId,
      agent: "claude",
      prompt: "Summarize the README",
    });
    assert.equal(launched.body.result.status, "succeeded", JSON.stringify(launched.body));
    const childId = launched.body.result.resultId;
    if (phase === "waiting") {
      const parentBoard = parentRow.locator(":scope > .board-row");
      const input = (text) =>
        page.evaluate(({ id, text }) => window.desktop.input(id, text), { id: parentId, text });
      await input("w");
      await expect(parentBoard).toHaveAttribute("data-state", "working");
      await input("i");
      await expect(parentBoard).toHaveAttribute("data-state", "waiting");
      await expect(parentBoard.locator(".board-reason")).toHaveText("Waiting on 1");
      await expect(parentBoard.locator(".board-light")).toHaveAttribute(
        "data-light-state",
        "waiting",
      );
      await expect(parentBoard).toHaveAccessibleName(/Waiting on 1/);
      const waitingColor = await parentBoard
        .locator(".board-light")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      await input("?");
      await expect(parentBoard).toHaveAttribute("data-state", "needs_input");
      assert.notEqual(
        await parentBoard
          .locator(".board-light")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
        waitingColor,
      );
      await input("w");
      await expect(parentBoard).toHaveAttribute("data-state", "working");
      await input("i");
      await expect(parentBoard).toHaveAttribute("data-state", "waiting");
      await assertAccessible(page);
      await page.screenshot({
        path: "test-results/orchestrator-waiting.png",
        animations: "disabled",
      });
      const stop = await call(parent.controlToken, "stop", {
        id: childId,
        idempotencyKey: "waiting-stop",
      });
      assert.equal(stop.body.result.status, "succeeded");
      await expect(parentBoard).toHaveAttribute("data-state", "quiet_ok");
      return;
    }
    if (phase === "handoff") {
      await expect.poll(() => existsSync(`${credentials}.child-one`)).toBe(true);
      const child = await read("child-one");
      assert.match(child.args.at(-1), /Before stopping.*CI fails/s);
      const summary = "CI failed. <img src=x onerror=alert(1)>\n**Plain child-authored text**";
      const file = path.join(root, "handoff.txt");
      await writeFile(file, summary);
      const state = (await call(parent.controlToken, "session_state", { id: childId })).body.result;
      const waitDeadline = Date.now() + deadline(30000);
      const execFile = require("node:util").promisify(require("node:child_process").execFile);
      const cli = async (credential, args) => {
        const { stdout } = await execFile("foom", [...args, "--json"], {
          env: {
            PATH: credential.cliPath,
            FOOM_CONTROL_URL: credential.controlUrl,
            FOOM_CONTROL_TOKEN: credential.controlToken,
            FOOM_CONTROL_INSTANCE: credential.instanceId,
          },
          timeout: deadline(10000),
        });
        return JSON.parse(stdout).result;
      };
      const waitFrom = async (revision) => ({
        body: {
          result: await cli(parent, [
            "wait-for",
            childId,
            "--until-event",
            "--after",
            JSON.stringify({ [childId]: revision }),
            "--timeout",
            "30",
          ]),
        },
      });
      const waiting = waitFrom(state.revision);
      const report = await cli(child, [
        "handoff",
        "--status",
        "failed",
        "--summary-file",
        file,
        "--link",
        "https://example.com/pull/514",
        "--idempotency-key",
        "report",
      ]);
      assert.equal(report.seq, 1);
      // A fresh snapshot after acknowledgement must already contain the report.
      assert.deepEqual(
        (await call(parent.controlToken, "session_state", { id: childId })).body.result.handoff,
        { seq: 1, status: "failed" },
      );
      let woke = (await waiting).body.result;
      // Startup output and settled verdicts also change the revision. A wait
      // resolved before the report was accepted keeps that earlier snapshot.
      while (woke.sessions[0].handoff === undefined) {
        context.diagnostic(`Pre-handoff wait snapshot: ${JSON.stringify(woke)}`);
        assert.equal(woke.timedOut, false);
        assert.deepEqual(woke.changed, [childId]);
        assert.ok(Date.now() < waitDeadline, "Handoff was not observed before the wait deadline");
        woke = (await waitFrom(woke.sessions[0].revision)).body.result;
      }
      assert.equal(woke.timedOut, false);
      assert.deepEqual(woke.changed, [childId]);
      assert.deepEqual(woke.sessions[0].handoff, { seq: 1, status: "failed" });
      assert.ok(!JSON.stringify(woke).includes(summary));
      assert.equal((await cli(parent, ["read-handoff", childId, "--seq", "1"])).summary, summary);
      const row = page.locator(`[data-drag-session="${childId}"]`);
      await expect(row.locator(".session-handoff")).toHaveText("■ failed");
      await row
        .locator("..")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await expect(page.locator(".handoff-summary")).toHaveText(summary);
      await expect(page.locator(".handoff-summary img")).toHaveCount(0);
      await expect(page.locator(".handoff-links a")).toHaveAttribute(
        "href",
        "https://example.com/pull/514",
      );
      await assertAccessible(page);
      await page.screenshot({ path: "test-results/child-handoff.png", animations: "disabled" });
      await page.getByRole("textbox", { name: "Filter repositories and sessions" }).hover();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Foom menu" }).click();
      await page.getByRole("menuitem", { name: "Action log", exact: true }).click();
      await page.getByLabel("Action", { exact: true }).selectOption("handoff");
      const history = page.getByRole("region", { name: "Action history" });
      await expect(history.getByText("Handoff #1 (failed)")).toBeVisible();
      await expect(history).not.toContainText(summary);
      const log = await page.evaluate(() =>
        window.desktop.actionLog({ search: "", action: "handoff", status: "", offset: 0 }),
      );
      assert.equal(log.entries[0].actorId, childId);
      assert.equal(log.entries[0].parentId, parentId);
      assert.equal(existsSync(`${credentials}.reply-child-one`), false);
      await page.getByRole("searchbox").press("Escape");
      await page.evaluate(
        (id) => window.desktop.sidebarCommand({ kind: "take-over", id }),
        childId,
      );
      assert.equal(
        (
          await call(child.controlToken, "handoff", {
            status: "done",
            summary: "later",
            idempotencyKey: "later",
          })
        ).body.error,
        "no_parent",
      );
      assert.equal(
        (await call(parent.controlToken, "read_handoff", { id: childId })).body.error,
        "not_found",
      );
      return;
    }

    if (phase === "children") {
      const extraTree = await call(parent.controlToken, "create_worktree", {
        idempotencyKey: "tree-limit",
        branch: "child-limit",
      });
      assert.equal(extraTree.body.result.status, "succeeded");
      const refusedLaunch = await call(parent.controlToken, "launch", {
        idempotencyKey: "launch-limit",
        worktreeId: extraTree.body.result.resultId,
        agent: "claude",
      });
      assert.equal(refusedLaunch.status, 400);
      assert.equal(refusedLaunch.body.error, "capacity");
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "General", exact: true }).click();
      await expect(
        page.getByRole("spinbutton", { name: "Concurrent children per orchestrator" }),
      ).toHaveValue("1");
      await page.keyboard.press("Escape");
      await expect.poll(() => existsSync(`${credentials}.child-one`)).toBe(true);
      const child = await read("child-one");
      assert.match(
        child.args.at(-1),
        /^Task from your Foom orchestrator.*\n\nSummarize the README$/s,
      );
      const childIdentity = (await call(child.controlToken, "whoami")).body.result;
      assert.equal(childIdentity.role, "agent");
      assert.equal(childIdentity.parentId, parentId);
      assert.equal(await connection(childId), "connecting");
      await connect(child);
      await expect.poll(() => connection(childId)).toBe("connected");
      // Question replies require review over the real MCP/CLI and PTY boundaries.
      await expect
        .poll(
          async () =>
            (await call(parent.controlToken, "session_state", { id: childId })).body.result
              .attentionKind,
        )
        .toBe("question");
      const question = (await call(parent.controlToken, "session_state", { id: childId })).body
        .result;
      const proposal = {
        id: childId,
        revision: question.revision,
        verdictId: question.verdictId,
        idempotencyKey: "reply-1",
        text: "src/app.ts",
      };
      const proposed = await call(parent.controlToken, "reply", proposal);
      assert.equal(proposed.body.result.status, "pending_confirmation");
      const replyReview = await confirmationPage(app);
      await expect(replyReview.getByRole("heading", { name: "Reply to child-one?" })).toBeVisible();
      await expect(replyReview.getByLabel("Current child context")).toContainText(
        "Which file should I change?",
      );
      await expect(replyReview.getByLabel("Exact proposed reply")).toHaveText("src/app.ts");
      assert.equal(existsSync(`${credentials}.reply-child-one`), false);
      await replyReview.getByRole("button", { name: "Send reply" }).click();
      await expect.poll(() => existsSync(`${credentials}.reply-child-one`)).toBe(true);
      assert.equal(await readFile(`${credentials}.reply-child-one`, "utf8"), "src/app.ts\r");
      await expect
        .poll(
          async () =>
            (await call(parent.controlToken, "operation_status", { idempotencyKey: "reply-1" }))
              .body.result.status,
        )
        .toBe("succeeded");
      assert.equal(
        (await call(parent.controlToken, "reply", proposal)).body.result.status,
        "succeeded",
      );
      // No grandchildren: a child's credential cannot reach orchestration.
      assert.equal(
        (
          await call(child.controlToken, "create_worktree", {
            idempotencyKey: "x",
            branch: "nested",
          })
        ).status,
        403,
      );
      await expect
        .poll(
          async () => {
            const tail = await call(parent.controlToken, "tail", { id: childId, lines: 5 });
            return tail.body.result?.lines?.join("\n") ?? "";
          },
          { intervals: [1100], timeout: deadline(15000) },
        )
        .toContain("FOOM_AGENT_READY");
      const waited = await call(parent.controlToken, "wait_for", { ids: [childId], timeoutMs: 0 });
      assert.equal(waited.body.result.sessions[0].id, childId);
      // Children belong to their own checkout and retain an independent light.
      const childRow = page.locator(`[data-drag-session="${childId}"]`);
      const parentSession = page.locator(`[data-drag-session="${parentId}"]`);
      const childEntry = childRow.locator("..");
      const parentEntry = parentSession.locator("..");
      await expect(childRow).toHaveCount(1);
      const childMark = childRow.locator('.session-robot-mark[data-kind="rx"]');
      const parentMark = parentSession.locator('.session-robot-mark[data-kind="tx"]');
      await expect(childMark).toHaveAttribute("aria-hidden", "true");
      await expect(parentMark).toHaveCount(1);
      await expect(childRow).toHaveAttribute(
        "title",
        `Child of ${cliOnly ? "Antigravity" : "Claude Code"}`,
      );
      const checkout = childRow.locator('xpath=ancestor::div[@role="group"][1]/..');
      await expect(checkout.locator(".worktree-row").first()).toContainText("child-one");
      await expect(checkout.locator(`[data-drag-session="${parentId}"]`)).toHaveCount(0);
      await expect(childRow.locator(".board-light")).toHaveCount(1);
      await parentSession.focus();
      await expect(childEntry).toHaveAttribute("data-related", "true");
      await expect(childMark).toHaveAttribute("data-related", "true");
      await childRow.focus();
      await expect(parentEntry).toHaveAttribute("data-related", "true");
      await expect(parentMark).toHaveAttribute("data-related", "true");
      await page.getByRole("textbox", { name: "Filter repositories and sessions" }).focus();
      await childRow.hover();
      await expect(parentEntry).toHaveAttribute("data-related", "true");
      await expect(parentMark).toHaveAttribute("data-related", "true");
      await parentSession.hover();
      await expect(childEntry).toHaveAttribute("data-related", "true");
      await expect(childMark).toHaveAttribute("data-related", "true");
      await childRow.focus();
      // Finish the hover interaction before the later Settings checks: its panel
      // otherwise follows the stationary pointer and covers Settings navigation.
      await page.getByRole("textbox", { name: "Filter repositories and sessions" }).hover();
      await page.keyboard.press("Escape");
      await expect(page.locator(".row-menu")).toHaveCount(0);
      if (phase === "children") {
        await parentSession.click();
        await expect(childMark).toHaveAttribute("data-related", "true");
        await expect(childMark.locator(".robot-wave-inner")).toHaveCSS(
          "animation-name",
          "robot-receive",
        );
        await childRow.focus();
        await expect(parentMark.locator(".robot-wave-inner")).toHaveCSS(
          "animation-name",
          "robot-transmit",
        );
        await expect(childRow).toHaveCSS("box-shadow", "none");
        if (!cliOnly) {
          for (const colorScheme of ["light", "dark"]) {
            await parentSession.focus();
            await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
            await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
            await expect(childMark.locator(".robot-wave-inner")).toHaveCSS(
              "animation-name",
              "none",
            );
            await expect(childMark).toHaveCSS(
              "color",
              colorScheme === "light" ? "rgb(91, 43, 217)" : "rgb(155, 107, 255)",
            );
            for (const scale of [80, 100, 150]) {
              await page.evaluate(
                (interfaceScale) => window.desktop.saveSetup({ interfaceScale }),
                scale,
              );
              await expect(childMark).toBeVisible();
              await expect(parentMark).toBeVisible();
              if (process.env.FOOM_SCREENSHOTS)
                await page.screenshot({
                  path: `test-results/477-marks-${colorScheme}-${scale}.png`,
                  animations: "disabled",
                });
            }
            await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 100 }));
            await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
            await expect(childMark).toBeVisible();
            await expect(parentMark).toBeVisible();
            const markBox = await childMark.boundingBox();
            const rowBox = await childRow.boundingBox();
            assert.ok(
              markBox &&
                rowBox &&
                markBox.x >= rowBox.x &&
                markBox.x + markBox.width <= rowBox.x + rowBox.width,
            );
            if (process.env.FOOM_SCREENSHOTS)
              await page.screenshot({
                path: `test-results/477-marks-${colorScheme}-compact.png`,
                animations: "disabled",
              });
            await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
          }
          await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
        }
        await page.getByRole("textbox", { name: "Filter repositories and sessions" }).hover();
        await page.keyboard.press("Escape");
        await expect(page.locator(".row-menu")).toHaveCount(0);
      }
      await assertAccessible(page);
    }
    const stopped = await call(parent.controlToken, "stop", {
      idempotencyKey: "stop-1",
      id: childId,
    });
    assert.equal(stopped.body.result.status, "succeeded");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.workspace())).terminals.find(
            (row) => row.orchestration?.role === "child",
          )?.exited,
      )
      .toBe(true);

    if (phase === "cleanup") {
      // Exercise the shared main-process policy once through MCP. The CLI case
      // retains its transport and batch-review checks without duplicating this flow.
      if (!cliOnly) {
        // Part 2: profile opt-in, real Git fetch/ancestry, and operation completion.
        const remote = path.join(root, "remote.git");
        git("clone", "--bare", repo, remote);
        git("remote", "add", "origin", remote);
        await openSettingsScreen(page);
        await page.getByRole("button", { name: "Repositories", exact: true }).click();
        await expect(
          page.getByRole("checkbox", { name: /Auto-remove merged worktrees/ }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "General", exact: true }).click();
        const autoRemove = page.getByRole("checkbox", { name: "Auto-remove merged worktrees" });
        await expect(autoRemove).not.toBeChecked();
        await autoRemove.check();
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.desktop.setupState())).settings
                .autoRemoveMergedWorktrees,
          )
          .toBe(true);
        await assertAccessible(page);
        await page.keyboard.press("Escape");
        const automaticTree = await call(parent.controlToken, "create_worktree", {
          idempotencyKey: "auto-tree",
          branch: "auto-merged",
        });
        assert.equal(automaticTree.body.result.status, "succeeded");
        await call(parent.controlToken, "remove_worktree", {
          idempotencyKey: "auto-remove",
          worktreeId: automaticTree.body.result.resultId,
        });
        await expect
          .poll(
            async () =>
              (
                await call(parent.controlToken, "operation_status", {
                  idempotencyKey: "auto-remove",
                })
              ).body.result.status,
          )
          .toBe("succeeded");
        assert.equal(
          String(git("worktree", "list", "--porcelain")).includes("refs/heads/auto-merged"),
          false,
        );
        assert.match(String(git("branch", "--list", "auto-merged")), /auto-merged/);
        await expect(
          confirmation.getByRole("heading", { name: "Remove worktrees?" }),
        ).not.toBeVisible();
        const dirtyAuto = await call(parent.controlToken, "create_worktree", {
          idempotencyKey: "auto-dirty-tree",
          branch: "auto-dirty",
        });
        const dirtyAutoTree = (
          await page.evaluate((repository) => window.desktop.worktrees(repository), repository)
        ).find((worktree) => worktree.branch === "auto-dirty");
        assert.ok(dirtyAutoTree);
        await writeFile(path.join(dirtyAutoTree.path, "untracked.txt"), "needs review");
        await call(parent.controlToken, "remove_worktree", {
          idempotencyKey: "auto-dirty-remove",
          worktreeId: dirtyAuto.body.result.resultId,
        });
        await expect(
          confirmation.getByRole("heading", { name: "Remove worktree with uncommitted changes?" }),
        ).toBeVisible();
        await expect(confirmation.getByRole("list", { name: "Uncommitted changes" })).toContainText(
          "untracked.txt",
        );
        await confirmation
          .getByRole("button", { name: "Discard changes and remove", exact: true })
          .click();
        await expect
          .poll(
            async () =>
              (
                await call(parent.controlToken, "operation_status", {
                  idempotencyKey: "auto-dirty-remove",
                })
              ).body.result.status,
          )
          .toBe("succeeded");
        await openSettingsScreen(page);
        await page.getByRole("button", { name: "General", exact: true }).click();
        await expect(autoRemove).toBeChecked();
        await autoRemove.uncheck();
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.desktop.setupState())).settings
                .autoRemoveMergedWorktrees,
          )
          .toBe(false);
        await page.keyboard.press("Escape");
      }
      // With the policy off, clean merged branches still join the review batch.
      const extraTrees = [];
      for (const branch of ["batch-selected", "batch-declined"]) {
        const created = await call(parent.controlToken, "create_worktree", {
          idempotencyKey: `create-${branch}`,
          branch,
        });
        assert.equal(created.body.result.status, "succeeded");
        extraTrees.push({ branch, id: created.body.result.resultId });
      }
      const dirtyTree = (
        await page.evaluate((repository) => window.desktop.worktrees(repository), repository)
      ).find((worktree) => worktree.branch === "batch-selected");
      assert.ok(dirtyTree);
      await writeFile(path.join(dirtyTree.path, "uncommitted.txt"), "discard only by named action");
      const removal = await call(parent.controlToken, "remove_worktree", {
        idempotencyKey: "remove-1",
        worktreeId: tree.body.result.resultId,
      });
      assert.equal(removal.body.result.status, "pending_confirmation");
      await expect(
        confirmation.getByRole("heading", { name: "Remove worktree?", exact: true }),
      ).toBeVisible();
      for (const tree of extraTrees) {
        const queued = await call(parent.controlToken, "remove_worktree", {
          idempotencyKey: `remove-${tree.branch}`,
          worktreeId: tree.id,
        });
        assert.equal(queued.body.result.status, "pending_confirmation");
      }
      await expect(confirmation.getByRole("checkbox")).toHaveCount(3);
      await expect(confirmation.getByRole("list", { name: "Worktrees to remove" })).toContainText(
        "Clean",
      );
      await assertAccessible(confirmation);
      await confirmation.screenshot({
        path: `test-results/batch-removal-${cliOnly ? "agy" : "claude"}.png`,
        animations: "disabled",
      });
      await confirmation.getByRole("checkbox", { name: "child-one", exact: true }).check();
      await confirmation.getByRole("checkbox", { name: "batch-selected", exact: true }).check();
      await confirmation
        .getByRole("button", { name: "Discard changes and remove selected" })
        .click();
      for (const tree of extraTrees) {
        await expect
          .poll(
            async () =>
              (
                await call(parent.controlToken, "operation_status", {
                  idempotencyKey: `remove-${tree.branch}`,
                })
              ).body.result.status,
          )
          .toBe(tree.branch === "batch-selected" ? "succeeded" : "declined");
      }
      assert.equal(
        String(git("worktree", "list", "--porcelain")).includes("refs/heads/batch-selected"),
        false,
      );
      assert.equal(
        String(git("worktree", "list", "--porcelain")).includes("refs/heads/batch-declined"),
        true,
      );

      await expect
        .poll(
          async () =>
            (await call(parent.controlToken, "operation_status", { idempotencyKey: "remove-1" }))
              .body.result.status,
        )
        .toBe("succeeded");
      assert.match(String(git("branch", "--list", "child-one")), /child-one/);

      // Exercise whole-batch decisions through the real control and Git removal paths.
      for (const approve of [true, false]) {
        const batch = [];
        for (const suffix of ["one", "two"]) {
          const branch = `batch-${approve ? "all" : "none"}-${suffix}`;
          const created = await call(parent.controlToken, "create_worktree", {
            idempotencyKey: `create-${branch}`,
            branch,
          });
          assert.equal(created.body.result.status, "succeeded");
          batch.push({ branch, id: created.body.result.resultId });
        }
        for (const tree of batch) {
          await call(parent.controlToken, "remove_worktree", {
            idempotencyKey: `remove-${tree.branch}`,
            worktreeId: tree.id,
          });
        }
        await expect(confirmation.getByRole("checkbox")).toHaveCount(2);
        await confirmation
          .getByRole("button", { name: approve ? "Approve all" : "Decline", exact: true })
          .click();
        for (const tree of batch) {
          await expect
            .poll(
              async () =>
                (
                  await call(parent.controlToken, "operation_status", {
                    idempotencyKey: `remove-${tree.branch}`,
                  })
                ).body.result.status,
            )
            .toBe(approve ? "succeeded" : "declined");
          assert.equal(
            String(git("worktree", "list", "--porcelain")).includes(`refs/heads/${tree.branch}`),
            !approve,
          );
        }
      }

      await assert.rejects(
        page.evaluate(() =>
          window.desktop.actionLog({ search: "", action: "", status: "", offset: -1 }),
        ),
      );
      await assert.rejects(
        page.evaluate(() =>
          window.desktop.actionLog({
            search: "",
            action: "",
            status: "",
            offset: 0,
            path: "/secret",
          }),
        ),
      );
      await page.getByRole("button", { name: "Foom menu" }).click();
      await page.getByRole("menuitem", { name: "Action log", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Action log" })).toBeVisible();
      const history = page.getByRole("region", { name: "Action history" });
      await expect(history.getByText("make orchestrator", { exact: true }).first()).toBeVisible();
      await page.getByRole("searchbox").fill("remove_worktree");
      await page.getByLabel("Outcome", { exact: true }).selectOption("succeeded");
      await expect(history.getByText("remove worktree", { exact: true })).toHaveCount(
        cliOnly ? 4 : 6,
      );
      await page.screenshot({
        path: `test-results/action-log-${cliOnly ? "agy" : "claude"}.png`,
        animations: "disabled",
      });
      await assertAccessible(page);
      await page.getByRole("searchbox").press("Escape");
      await expect(page.getByRole("heading", { name: "Action log" })).toHaveCount(0);

      // Making the orchestrator again is a no-op without a dialog.
      await page.evaluate(
        (id) => window.desktop.sidebarCommand({ kind: "make-orchestrator", id }),
        parentId,
      );
      const orchestrators = (
        await page.evaluate(() => window.desktop.workspace())
      ).terminals.filter((row) => row.orchestration?.role === "orchestrator");
      assert.equal(orchestrators.length, 1);

      // Keep a live child when its parent is revoked and exits.
      const liveTree = await call(parent.controlToken, "create_worktree", {
        idempotencyKey: "tree-live",
        branch: "child-live",
      });
      assert.equal(liveTree.body.result.status, "succeeded");
      const liveLaunch = await call(parent.controlToken, "launch", {
        idempotencyKey: "launch-live",
        worktreeId: liveTree.body.result.resultId,
        agent: cliOnly ? "claude" : "codex",
      });
      assert.equal(liveLaunch.body.result.status, "succeeded");
      const liveId = liveLaunch.body.result.resultId;
      await expect(page.locator('.session-robot-mark[data-kind="rx"]')).toHaveCount(1);

      if (!cliOnly) {
        let previous = (await call(parent.controlToken, "session_state", { id: liveId })).body
          .result;
        for (const [key, label] of [
          ["@", "Provider unavailable"],
          ["#", "Provider rate limit"],
          ["$", "Model switch requested"],
        ]) {
          const waiting = call(parent.controlToken, "wait_for", {
            ids: [liveId],
            after: { [liveId]: previous.revision },
            timeoutMs: 30000,
          });
          await page.evaluate(({ id, key }) => window.desktop.input(id, key), { id: liveId, key });
          await expect
            .poll(
              async () =>
                (await call(parent.controlToken, "session_state", { id: liveId })).body.result
                  .reason,
            )
            .toBe("provider_unavailable");
          const stalled = (await call(parent.controlToken, "session_state", { id: liveId })).body
            .result;
          assert.equal(stalled.state, "needs_input");
          assert.equal(stalled.attentionKind, "provider");
          assert.notEqual(stalled.revision, previous.revision);
          // A wait may wake on input invalidation before classification; waiting again
          // from that revision must expose the same fixed stall metadata.
          const awakened = (await waiting).body.result.sessions[0];
          const observed =
            awakened.reason === "provider_unavailable"
              ? awakened
              : (
                  await call(parent.controlToken, "wait_for", {
                    ids: [liveId],
                    after: { [liveId]: awakened.revision },
                    timeoutMs: 30000,
                  })
                ).body.result.sessions[0];
          assert.equal(observed.reason, "provider_unavailable");
          assert.equal(observed.attentionKind, "provider");
          const rejected = await call(parent.controlToken, "reply", {
            id: liveId,
            revision: stalled.revision,
            verdictId: stalled.verdictId,
            idempotencyKey: `provider-reply-${key.codePointAt(0)}`,
            text: "Switch model",
          });
          assert.equal(rejected.status, 400);
          assert.equal(rejected.body.error, "conflict");
          await expect(
            page.getByRole("treeitem", { name: new RegExp(`Needs you.*${label}`) }),
          ).toBeVisible();
          previous = stalled;
        }
      }

      // Revoke ends orchestration on the same credential; the session keeps running.
      await parentRow
        .locator(":scope > .board-row")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await page.getByRole("menuitem", { name: "Revoke orchestrator" }).click();
      await expect
        .poll(async () => (await call(parent.controlToken, "whoami")).body.result?.role)
        .toBe("agent");
      assert.equal(
        (await call(parent.controlToken, "tail", { id: childId, lines: 1 })).status,
        403,
      );

      const liveChild = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
        (row) => row.id === liveId,
      );
      assert.equal(liveChild.exited, false);
      await expect(page.getByText("Revoked orchestrator", { exact: true })).toBeVisible();
      await expect(page.locator('.session-robot-mark[data-kind="rx"]')).toHaveCount(1);
      const logged = await page.evaluate(() =>
        window.desktop.actionLog({
          search: "",
          action: "revoke_orchestrator",
          status: "succeeded",
          offset: 0,
        }),
      );
      assert.equal(logged.total, 1);
      await page.evaluate(() => window.desktop.clearActionLog());
      assert.equal(
        (
          await page.evaluate(() =>
            window.desktop.actionLog({ search: "", action: "", status: "", offset: 0 }),
          )
        ).total,
        0,
      );

      // Exit revokes the credential itself; the snapshot keeps the history.
      await page.evaluate((id) => window.desktop.input(id, "q"), parentId);
      await expect.poll(async () => (await call(parent.controlToken, "whoami")).status).toBe(401);
      const after = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
        (row) => row.id === parentId,
      );
      assert.equal(after.orchestration.active, false);
      await expect(page.getByText("Exited orchestrator", { exact: true })).toBeVisible();
      await expect(page.locator('.session-robot-mark[data-kind="rx"]')).toHaveCount(1);
      await assert.rejects(
        page.evaluate((id) => window.desktop.sidebarCommand({ kind: "close", id }), parentId),
        /Close the orchestrator/u,
      );
      assert.ok(after.orchestration.history.some((entry) => entry.action === "remove_worktree"));
    }
  }

  // Attachment is per launch: nothing written to the user's agent config or the repository.
  const homeEntries = await readdir(home);
  for (const name of [".claude", ".claude.json", ".codex", ".gemini"])
    assert.ok(!homeEntries.includes(name), `${name} was written`);
  const repoEntries = await readdir(repo);
  for (const name of [".mcp.json", ".claude", ".codex"])
    assert.ok(!repoEntries.includes(name), `${name} was written to the repository`);
}

for (const agent of ["claude", "codex"])
  test(`restores running ${agent}, shell and orchestrator children across windows`, {
    timeout: deadline(90000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod, symlink } = require("node:fs/promises");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-launch-restore-")));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    const repo = path.join(root, "repo");
    const profile = path.join(root, "profile");
    const credentials = path.join(root, "credentials");
    await Promise.all([mkdir(bin), mkdir(home), mkdir(repo)]);
    await symlink(process.execPath, path.join(bin, "node"));
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    let fake = FAKE_ORCHESTRATED_CLAUDE;
    if (agent === "codex")
      fake = fake
        .replace("2.1.296 (Claude Code)", "codex-cli 0.161.0")
        .replace("--mcp-config <configs...>", "-c, --config <value>");
    fake += `
const conversation = "saved-" + path.basename(process.cwd());
const payload = ${JSON.stringify(agent)} === "claude"
  ? { session_id: conversation, hook_event_name: "Stop" }
  : { "thread-id": conversation, "turn-id": "turn", type: "agent-turn-complete" };
const req = require("node:http").request(process.env.FOOM_HOOK_URL, { method: "POST", headers: { Authorization: process.env.FOOM_TOKEN, "X-Foom-Session": process.env.FOOM_SESSION, "Content-Type": "application/json", "X-Foom-Channel": process.env[${JSON.stringify(agent === "codex" ? "FOOM_CHANNEL_notify" : "FOOM_CHANNEL_lifecycle")}] } }, res => res.resume());
req.on("error", () => process.exit(1));
req.end(JSON.stringify(payload));
`;
    await writeFile(path.join(bin, agent), fake);
    await chmod(path.join(bin, agent), 0o755);
    const options = {
      fixture: "agent",
      home,
      args: [`--user-data-dir=${profile}`],
      env: {
        HOME: home,
        PATH: bin,
        TEST_FAKE_CREDENTIALS: credentials,
      },
    };
    const app = await launchApp(context, options);
    const first = await boardPage(app);
    await app.evaluate(({ dialog }, repo) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    }, repo);
    await first.evaluate(async () => {
      await window.desktop.addRepository();
      await window.desktop.saveSetup({ codexNotifierAcknowledged: true });
    });
    const rows = (page) => page.evaluate(async () => (await window.desktop.workspace()).terminals);
    await first.evaluate(
      ({ repo, agent }) =>
        window.desktop.sidebarCommand({
          kind: "launch",
          repository: repo,
          worktree: repo,
          run: agent,
        }),
      { repo, agent },
    );
    await expect
      .poll(() => rows(first))
      .toMatchObject([{ conversationId: "saved-repo", exited: false }]);
    const parentId = (await rows(first))[0].id;
    await first.evaluate((id) => {
      void window.desktop.sidebarCommand({ kind: "make-orchestrator", id });
    }, parentId);
    await (await confirmationPage(app)).getByRole("button", { name: "Make orchestrator" }).click();
    await expect.poll(async () => (await rows(first))[0].orchestration?.active).toBe(true);
    const readCredentials = async (name) =>
      JSON.parse(await readFile(`${credentials}.${name}`, "utf8"));
    const oldParent = await readCredentials("repo");
    const call = async (parent, method, params = {}) => {
      const response = await fetch(parent.controlUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${parent.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, instanceId: parent.instanceId, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const tree = await call(oldParent, "create_worktree", {
      branch: "child",
      idempotencyKey: "tree",
    });
    const child = await call(oldParent, "launch", {
      worktreeId: tree.resultId,
      agent,
      idempotencyKey: "child",
    });
    assert.equal(child.status, "succeeded");
    const childId = child.resultId;
    await expect
      .poll(async () => (await rows(first)).find((row) => row.id === childId)?.conversationId)
      .toBe("saved-child");
    const exitedTree = await call(oldParent, "create_worktree", {
      branch: "exited-child",
      idempotencyKey: "exited-tree",
    });
    const exitedChild = await call(oldParent, "launch", {
      worktreeId: exitedTree.resultId,
      agent,
      idempotencyKey: "exited-child",
    });
    assert.equal(exitedChild.status, "succeeded");
    await expect
      .poll(
        async () =>
          (await rows(first)).find((row) => row.id === exitedChild.resultId)?.conversationId,
      )
      .toBe("saved-exited-child");
    await call(oldParent, "stop", {
      id: exitedChild.resultId,
      idempotencyKey: "stop-before-restart",
    });
    await expect
      .poll(async () => (await rows(first)).find((row) => row.id === exitedChild.resultId)?.exited)
      .toBe(true);
    const unusedTree = await call(oldParent, "create_worktree", {
      branch: "unused-child",
      idempotencyKey: "unused-tree",
    });
    const oldChild = await readCredentials("child");
    await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
    let second;
    await expect
      .poll(() => {
        second = app
          .windows()
          .find((page) => page !== first && page.url() === "app://bundle/index.html");
        return Boolean(second);
      })
      .toBe(true);
    await second.getByRole("button", { name: "Actions for Home shell", exact: true }).click();
    await second.getByRole("menuitem", { name: "New shell", exact: true }).click();
    await expect
      .poll(async () => (await rows(second)).filter((row) => row.agent === "shell").length)
      .toBe(1);
    const shellId = (await rows(second)).find((row) => row.agent === "shell").id;
    const firstId = await first.evaluate(() => window.desktop.windows.id);
    const secondId = await second.evaluate(() => window.desktop.windows.id);
    const quit = async (current) =>
      quitAndWait(current, async () => {
        await current.evaluate(({ app }) => app.quit());
        let dialog;
        await expect
          .poll(async () => {
            for (const candidate of current
              .windows()
              .filter((window) => window.url() === "app://confirmation/confirmation.html")) {
              if (await candidate.getByRole("button", { name: "Stop all and quit" }).count()) {
                dialog = candidate;
                return true;
              }
            }
            return false;
          })
          .toBe(true);
        await dialog.getByRole("button", { name: "Stop all and quit" }).click();
      });
    await quit(app);
    const saved = JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8"));
    assert.equal(saved.filter((row) => row.running).length, 3);
    assert.ok(saved.find((row) => row.id === parentId).orchestrator.identity);
    const restored = await launchApp(context, { ...options, fixture: "restored" });
    let pages;
    await expect
      .poll(() => {
        pages = restored.windows().filter((page) => page.url() === "app://bundle/index.html");
        return pages.length;
      })
      .toBe(2);
    const page = pages[0];
    await expect
      .poll(async () => (await rows(page)).filter((row) => !row.exited && !row.dormant).length)
      .toBe(3);
    // PTY registration precedes the fake agent writing its per-launch credentials.
    // Wait for both new processes rather than reading the previous launch's files.
    const waitForCredentials = async (name, previous) => {
      await expect
        .poll(async () => {
          try {
            return (await readCredentials(name)).controlToken !== previous.controlToken;
          } catch {
            return false; // The fixture may be in the middle of rewriting the file.
          }
        })
        .toBe(true);
      return readCredentials(name);
    };
    const newParent = await waitForCredentials("repo", oldParent);
    // The role is re-granted from main's store; the resumed agent gets no launch prompt.
    assert.ok(
      !newParent.args.includes("--"),
      "resumed parent receives no positional launch prompt",
    );
    const restoredChild = await waitForCredentials("child", oldChild);
    assert.ok(restoredChild.args.includes(agent === "claude" ? "--resume" : "resume"));
    assert.ok(restoredChild.args.some((arg) => arg.startsWith("Task from your Foom orchestrator")));
    for (const window of pages) {
      const id = await window.evaluate(() => window.desktop.windows.id);
      assert.ok(id === firstId || id === secondId);
      if (id === secondId) {
        await expect(window.locator(".tile-terminal:visible")).toHaveCount(1);
        await window
          .locator(".xterm-helper-textarea")
          .pressSequentially("echo RESTORED_HOME_SHELL");
        await window.locator(".xterm-helper-textarea").press("Enter");
        await expect
          .poll(() =>
            window.evaluate(async (id) => (await window.desktop.tail(id, 10)).join("\n"), shellId),
          )
          .toContain("RESTORED_HOME_SHELL");
      }
    }
    assert.equal(
      (await call(newParent, "stop", { id: childId, idempotencyKey: "stop-after-restore" })).status,
      "succeeded",
    );
    await expect
      .poll(async () => (await rows(page)).find((row) => row.id === childId)?.exited)
      .toBe(true);
    assert.equal(
      (
        await call(newParent, "remove_worktree", {
          worktreeId: exitedTree.resultId,
          idempotencyKey: "remove-after-restart",
        })
      ).status,
      "pending_confirmation",
    );
    let removal;
    await expect
      .poll(async () => {
        for (const candidate of restored
          .windows()
          .filter((window) => window.url() === "app://confirmation/confirmation.html")) {
          if (
            await candidate
              .getByRole("heading", { name: "Remove worktree?", exact: true })
              .isVisible()
          ) {
            removal = candidate;
            return true;
          }
        }
        return false;
      })
      .toBe(true);
    await removal.getByRole("button", { name: "Remove worktree", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await call(newParent, "operation_status", { idempotencyKey: "remove-after-restart" }))
            .status,
      )
      .toBe("succeeded");
    assert.ok(
      !isolatedGit(["-C", repo, "worktree", "list", "--porcelain"]).includes(
        "branch refs/heads/exited-child",
      ),
    );
    assert.equal(
      (
        await call(newParent, "launch", {
          worktreeId: unusedTree.resultId,
          agent,
          idempotencyKey: "launch-after-restart",
        })
      ).status,
      "succeeded",
    );
    await expect
      .poll(
        async () => (await rows(page)).find((row) => row.branch === "unused-child")?.conversationId,
      )
      .toBe("saved-unused-child");
    const beforeDisabled = await rows(page);
    await page.evaluate(() => window.desktop.saveSetup({ restoreSessions: false }));
    await quit(restored);
    const disabled = await launchApp(context, { ...options, fixture: "restored" });
    const off = await boardPage(disabled);
    await expect
      .poll(() => rows(off))
      .toMatchObject(beforeDisabled.map(({ id }) => ({ id, exited: true, dormant: true })));
  });

for (const [agent, form] of [
  ["claude", "--resume"],
  ["claude", "-r"],
  ["codex", "resume"],
  ["agy", "--conversation"],
]) {
  test(`pastes ${agent} ${form} in a checkout and retains rejected conversations`, {
    timeout: deadline(60_000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod } = require("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "foom-pasted-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin"),
      repo = path.join(root, "repo"),
      home = path.join(root, "home");
    const profile = path.join(root, "profile"),
      argvFile = path.join(root, "argv.json");
    await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    await writeFile(
      path.join(bin, agent),
      `#!/usr/bin/env node
const { writeFileSync, renameSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0"); process.exit(0); }
if (args[0] === "--help") { console.log("resume"); process.exit(0); }
if (args[0] === "plugin") { console.log("{}"); process.exit(0); }
const record = process.env.TEST_ARGV + ".tmp";
writeFileSync(record, JSON.stringify({ args, cwd: process.cwd() }));
renameSync(record, process.env.TEST_ARGV);
console.log("UNKNOWN_CONVERSATION " + args[1]);
process.exit(1);
`,
    );
    await chmod(path.join(bin, agent), 0o755);
    const app = await launchApp(context, {
      fixture: "agent",
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: bin, TEST_ARGV: argvFile },
    });
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    await page.evaluate(async () => {
      await window.desktop.addRepository();
    });
    const panel = page.getByRole("button", { name: "Actions for Main checkout", exact: true });
    await panel.click();
    await page.getByRole("menuitem", { name: "Resume conversation…", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Conversation ID or resume command" });
    await expect(input).toBeFocused();
    await input.fill(`${agent} ${form} external-123`);
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
    await page.getByRole("menuitem", { name: "Resume conversation…", exact: true }).click();
    await input.fill(`${agent} ${form} external-123 --extra`);
    await input.press("Enter");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
    await input.fill(`${agent} ${form} external-123`);
    await input.press("Enter");
    await expect
      .poll(() => page.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ agent, exited: true, conversationId: "external-123" }]);
    await expect(page.locator(".xterm-rows")).toContainText("UNKNOWN_CONVERSATION external-123");
    const exitedRow = page.locator(".board-row[data-kind='agent']");
    await expect(exitedRow).toHaveAccessibleName(/Exited/);
    await expect(exitedRow.locator(".session-program")).toHaveText("exited");
    for (const bulb of [
      exitedRow.locator(".board-light"),
      page.locator(".tile-title .board-light"),
    ]) {
      await expect(bulb).toHaveAttribute("data-exited", "true");
      await expect(bulb).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(bulb).toHaveCSS("border-radius", "0px");
    }
    const record = JSON.parse(await readFile(argvFile, "utf8"));
    assert.deepEqual(record.args.slice(0, 2), [
      agent === "claude" ? "--resume" : form,
      "external-123",
    ]);
    assert.equal(record.cwd, await realpath(repo));
    const label = agent === "claude" ? "Claude Code" : agent === "codex" ? "Codex" : "Antigravity";
    await page.getByRole("button", { name: `Actions for ${label} in main`, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^Resume conversation/ })).toBeVisible();
    await page.getByRole("menuitem", { name: "Copy session ID", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("external-123");
  });
}

for (const version of [1, 2])
  test(version === 1
    ? "a manifest-only fixture agent loads from the config folder, reloads edits and is withdrawn when invalid"
    : "a manifest-only v2 fixture agent loads from the config folder, reloads edits and is withdrawn when invalid", {
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
    const legacy = {
      kind: "agent",
      version: 1,
      id: "foom-test-agent",
      name: "Fixture agent",
      badge: "FT",
      executables: ["foom-test-agent"],
      launch: {
        arguments: [script, "$(literal)", "--yolo"],
        prompt: ["--prompt", "{prompt}"],
        resume: ["--resume", "{conversationId}"],
      },
      bypassArguments: ["--yolo"],
      attention: { minimumEngineVersion: 1, rules: [] },
    };
    const v2 = JSON.parse(
      await readFile(path.join(__dirname, "../fixtures/agent-plugin-v2.json"), "utf8"),
    );
    const manifest =
      version === 1
        ? legacy
        : {
            ...v2,
            id: legacy.id,
            name: legacy.name,
            badge: legacy.badge,
            executables: legacy.executables,
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
              arguments: { arguments: legacy.launch.arguments },
              display: undefined,
              prompt: { arguments: ["--prompt", "{prompt}"] },
              mcp: {
                arguments: ["--mcp", "{file:config/mcp.json}"],
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
            resumePaste: [{ command: legacy.id, selector: "--resume" }],
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
    require("../../build/shared/agent-plugin-parser.js").parseAgentManifest(
      JSON.stringify(manifest),
    );
    await writeFile(file, JSON.stringify(manifest));
    const card = page
      .locator(".agent-card")
      .filter({ has: page.getByRole("heading", { name: "Fixture agent", exact: true }) });
    await expect(card).toContainText("agents/foom-test-agent.json");
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
    await expect(
      card.getByText(version === 2 ? "Hooks" : "Screen rules", { exact: true }),
    ).toBeVisible();
    await assertAccessible(page);
    await page.screenshot({ path: path.join(__dirname, "../../test-results/agents-settings.png") });
    if (version === 2) {
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
    } else await launch();
    await expect
      .poll(async () => {
        try {
          const args = JSON.parse(await readFile(output, "utf8"));
          return version === 1 ? args : args.slice(0, 2);
        } catch {
          return null;
        }
      })
      .toEqual(["$(literal)", "--yolo"]);
    if (version === 2) {
      const args = JSON.parse(await readFile(output, "utf8"));
      assert.ok(args.includes("--mcp"));
      assert.equal(
        args.filter((arg) =>
          /^mcp__foom_.*__(open_preview|list_previews|close_preview)$/u.test(arg),
        ).length,
        3,
      );
      const mcp = args[args.indexOf("--mcp") + 1];
      assert.ok((await readFile(mcp, "utf8")).includes("Bearer ${FOOM_CONTROL_TOKEN}"));
      assert.ok(args.at(-1).includes("Foom provides a workspace CLI"));
    }
    const snapshot = await page.evaluate(() => window.desktop.workspace());
    const launched = snapshot.terminals.find((entry) => entry.agent === "foom-test-agent");
    assert.equal(launched.bypass, true);
    assert.equal(launched.providerOrigin, "config");
    if (version === 2) {
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
    await writeFile(file, "{}");
    await expect(page.getByText("Rejected · launch blocked", { exact: true })).toBeVisible();
    await assert.rejects(launch(), /Invalid sidebar command/);
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
  await expect(card).toContainText("agents/foom-test-agent.json");
  const rescan = async (state) => {
    const report = await page.evaluate(() => window.desktop.scanAgents(true));
    assert.equal(
      report.agents.find((agent) => agent.id === "foom-test-agent")?.setup?.state,
      state,
    );
    await page.getByRole("button", { name: "Scan again", exact: true }).click();
    await expect(card.getByText(`Plugin · ${state}`, { exact: true })).toBeVisible();
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
    await expect(card.getByText(`Plugin · ${state}`, { exact: true })).toBeVisible();
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

test("board pull requests show running failed and passed checks through fixture gh", {
  skip: process.platform === "win32" && "The fixture gh is a POSIX script",
}, async (context) => {
  const { chmod, symlink } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-board-forge-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  for (const directory of [bin, repo, home]) await mkdir(directory);
  await writeFile(path.join(bin, "gh"), FAKE_GH);
  await chmod(path.join(bin, "gh"), 0o755);
  await symlink(process.execPath, path.join(bin, "node"));
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("remote", "add", "origin", "https://github.com/fixture/offline.git");
  const state = path.join(root, "forge.json");
  await writeFile(state, JSON.stringify({ checks: [{ bucket: "pending" }] }));
  const app = await launchApp(context, {
    fixture: "running-shell",
    args: [`--user-data-dir=${path.join(root, "profile")}`],
    env: { HOME: home, PATH: bin, TEST_FORGE_STATE: state },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog, shell, Notification }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    globalThis.forgeOpened = [];
    globalThis.forgeNotices = [];
    shell.openExternal = async (url) => {
      globalThis.forgeOpened.push(url);
    };
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      globalThis.forgeNotices.push({ title: this.title, body: this.body });
      globalThis.lastForgeNotice = this;
    };
  }, repo);
  const repository = await page.evaluate(async () => (await window.desktop.addRepository()).path);
  await page.evaluate(async (repository) => {
    await window.desktop.createWorktree(repository, "child-one");
    await window.desktop.saveSetup({ showPullRequests: true });
  }, repository);
  await page.getByRole("button", { name: "Expand app", exact: true }).click();
  const mark = page.getByRole("button", { name: "Pull request #340 · running", exact: true });
  await expect(mark).toBeVisible();
  await mark.click();
  await expect
    .poll(() => app.evaluate(() => globalThis.forgeOpened))
    .toEqual(["https://github.com/fixture/offline/pull/340"]);
  const transition = async (bucket) => {
    await page.evaluate(() => window.desktop.saveSetup({ showPullRequests: false }));
    await expect(page.locator(".pull-request")).toHaveCount(0);
    await writeFile(state, JSON.stringify({ checks: [{ bucket }] }));
    await page.evaluate(() => window.desktop.saveSetup({ showPullRequests: true }));
  };
  await transition("fail");
  await expect(
    page.getByRole("button", { name: "Pull request #340 · failed", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => app.evaluate(() => globalThis.forgeNotices))
    .toEqual([{ title: "Pull request #340", body: "1 checks failed" }]);
  await app.evaluate(() => globalThis.lastForgeNotice.emit("click"));
  await expect(page.locator(".worktree-row .tree-name:focus")).toContainText("child-one");
  await transition("pass");
  await expect(
    page.getByRole("button", { name: "Pull request #340 · passed", exact: true }),
  ).toBeVisible();
  await page
    .locator(".worktree-row")
    .filter({ hasText: "child-one" })
    .getByRole("button", { name: /^Actions for/ })
    .click();
  await expect(page.getByText("#340 · Fixture pull request", { exact: true })).toBeVisible();
  await expect(page.getByText("1 passed · 0 failed · 0 running", { exact: true })).toBeVisible();
  await assertAccessible(page);
});
