const { evidencePath } = require("../helpers/evidence.js");
const { codexFixture } = require("./agent-fixture.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_CLAUDE,
  assertAccessible,
  boardCommand,
  boardPage,
  launchApp,
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
    /foom-error:worktree-missing/,
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
      "board_threads",
      "board_read",
      "board_post",
      "board_resolve",
      "manual",
      "open_preview",
      "list_previews",
      "close_preview",
      "review",
      "create_worktree",
      "launch",
      "stop",
      "close",
      "remove_worktree",
      "tail",
      "wait_for",
      "prompt",
      "send_keys",
      "operation_status",
    ],
  );
  const manual = await (
    await mcpRequest({ id: 20, method: "tools/call", params: { name: "manual" } })
  ).json();
  assert.equal(manual.result.isError, false);
  assert.equal(manual.result.structuredContent.sections.length, 13);
  const section = await (
    await mcpRequest({
      id: 21,
      method: "tools/call",
      params: {
        name: "manual",
        arguments: { section: manual.result.structuredContent.sections[0].id },
      },
    })
  ).json();
  assert.equal(section.result.isError, false);
  assert.match(section.result.structuredContent.text, /Foom is a desktop board/);
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
  await expect
    .poll(() => agentRow.locator(".activity-trace path").getAttribute("d"))
    .toContain("L");
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  await expect(agentRow.locator(".activity-trace")).toHaveCount(0);
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

  if (process.env.FOOM_UI_SCREENSHOTS)
    await page.screenshot({
      path: evidencePath(path.join(evidencePath("ui_screenshots"), "dismiss-attention.png")),
      animations: "disabled",
    });
  // Dismissal clears attention but does not establish resumed execution.
  await page.getByRole("button", { name: "Dismiss incorrect attention flag", exact: true }).click();
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
  const { page, repository, repo, help } = await codexFixture(context, {
    helpText: "--no-alt-screen",
    source: ({ help }) => `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('codex-cli 0.159.3');
else if (process.argv[2] === '--help') console.log(fs.readFileSync(${JSON.stringify(help)}, 'utf8'));
else console.log('ARGS:' + JSON.stringify(process.argv.slice(2)));
`,
  });
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
