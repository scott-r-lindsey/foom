const { FAKE_GH } = require("../helpers/forge-cli.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  removeAfterApps,
} = require("./harness.js");

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
    checksMeaning: "required",
    title: "Fixture pull request",
    url: "https://github.com/fixture/offline/pull/340",
  });
  assert.deepEqual(
    (await call("sessions")).sessions.find((row) => row.id === childId).pullRequest,
    changed.sessions[0].pullRequest,
  );
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
  await expect(mark).toHaveAttribute("title", "Pull request #340 · running · Fixture pull request");
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
  await expect(page.getByText("Required checks", { exact: true })).toBeVisible();
  await expect(page.getByText("success", { exact: true })).toBeVisible();
  if (process.env.FOOM_FORGE_SCREENSHOTS) {
    const directory = path.resolve(process.env.FOOM_FORGE_SCREENSHOTS);
    await mkdir(directory, { recursive: true });
    for (const variant of ["light", "dark"]) {
      await page.evaluate(
        (variant) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${variant}` }),
        variant,
      );
      await expect(page.locator("html")).toHaveCSS("color-scheme", variant);
      await page.screenshot({ path: path.join(directory, `${variant}.png`) });
    }
  }
  await assertAccessible(page);
});
