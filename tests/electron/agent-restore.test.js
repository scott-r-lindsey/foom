const { sizeTileBoard } = require("./tile-fixture.js");
const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  boardPage,
  approvalPage,
  clickApproval,
  launchApp,
  quitAndWait,
  removeAfterApps,
  confirmationPage,
  stopSession,
} = require("./harness.js");

for (const { agent, linked, replaced } of [
  { agent: "claude", linked: false },
  { agent: "codex", linked: false },
  { agent: "claude", linked: true },
  { agent: "claude", linked: true, replaced: true },
])
  test(`restores running ${agent}${linked ? " in a linked worktree" : ""}${replaced ? " with a replaced checkout" : ""}, shell and orchestrator children across windows`, {
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
    const parentCheckout = linked ? path.join(root, "linked-parent") : repo;
    const parentName = path.basename(parentCheckout);
    if (linked) isolatedGit(["-C", repo, "worktree", "add", "-b", "parent-topic", parentCheckout]);
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
    });
    const rows = (page) => page.evaluate(async () => (await window.desktop.workspace()).terminals);
    await first.evaluate(
      ({ repo, agent, parentCheckout }) =>
        window.desktop.sidebarCommand({
          kind: "launch",
          repository: repo,
          worktree: parentCheckout,
          run: agent,
        }),
      { repo, agent, parentCheckout },
    );
    await expect
      .poll(() => rows(first))
      .toMatchObject([{ conversationId: `saved-${parentName}`, exited: false }]);
    const parentId = (await rows(first))[0].id;
    await first.evaluate((id) => {
      void window.desktop.sidebarCommand({ kind: "make-orchestrator", id });
    }, parentId);
    const grantPage = await approvalPage(app);
    await clickApproval(
      grantPage,
      grantPage.getByRole("button", { name: "Approve · Make orchestrator", exact: true }),
    );
    await expect.poll(async () => (await rows(first))[0].orchestration?.active).toBe(true);
    const readCredentials = async (name) =>
      JSON.parse(await readFile(`${credentials}.${name}`, "utf8"));
    const oldParent = await readCredentials(parentName);
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
    await sizeTileBoard(app, first);
    // Persist both assignments, including an exited screen that cannot survive quit.
    await first.locator(`[data-drag-session="${exitedChild.resultId}"]`).click();
    await expect(
      first.locator('.terminal-tile[data-exited="true"][data-empty="false"]'),
    ).toHaveCount(1);
    await first.evaluate(() => window.desktop.appMenu.execute("split-right"));
    await first.locator(`[data-drag-session="${parentId}"]`).click();
    await expect(
      first.locator('.terminal-tile[data-exited="true"][data-empty="false"]'),
    ).toHaveCount(1);
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
    if (replaced) {
      isolatedGit(["-C", repo, "worktree", "remove", parentCheckout]);
      isolatedGit(["-C", repo, "worktree", "add", parentCheckout, "parent-topic"]);
    }
    const restored = await launchApp(context, { ...options, fixture: "restored" });
    let pages;
    await expect
      .poll(() => {
        pages = restored.windows().filter((page) => page.url() === "app://bundle/index.html");
        return pages.length;
      })
      .toBe(2);
    const page = pages[0];
    if (replaced) {
      await expect
        .poll(async () => (await rows(page)).find((row) => row.id === parentId))
        .toMatchObject({ exited: true, dormant: true, roleNotRestored: true });
      assert.equal(
        (await rows(page)).find((row) => row.id === parentId).orchestration?.active,
        undefined,
      );
      await expect.poll(async () => (await rows(page)).filter((row) => !row.exited).length).toBe(2);
      assert.deepEqual(
        await readCredentials(parentName),
        oldParent,
        "replaced checkout was never spawned with authority",
      );
      return;
    }
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
    // Exited records retain their row, but no saved board assignment.
    for (const window of pages) {
      await expect(window.locator(`[data-drag-session="${exitedChild.resultId}"]`)).toHaveCount(1);
      await expect(
        window.locator('.terminal-tile[data-exited="true"][data-empty="false"]'),
      ).toHaveCount(0);
    }
    if (agent === "claude") {
      let ownerPage;
      for (const candidate of pages) {
        if ((await candidate.evaluate(() => window.desktop.windows.id)) === firstId)
          ownerPage = candidate;
      }
      assert.ok(ownerPage);
      // Pause only fixture snapshot delivery, then reload the restored board. The
      // real attachment still runs, but cannot satisfy the first-frame gate yet.
      await restored.evaluate(({ webContents }) => {
        globalThis.restoreStreams = [];
        globalThis.resumeRestoreStreams = [];
        for (const contents of webContents.getAllWebContents()) {
          const send = contents.send.bind(contents);
          contents.send = (channel, ...args) => {
            if (channel === "terminal:data")
              globalThis.restoreStreams.push(() => send(channel, ...args));
            else send(channel, ...args);
          };
          globalThis.resumeRestoreStreams.push(() => {
            contents.send = send;
          });
        }
      });
      try {
        await ownerPage.reload();
        await expect(ownerPage.locator(".tile-restoring").first()).toBeVisible();
        await expect
          .poll(() => restored.evaluate(() => globalThis.restoreStreams.length))
          .toBeGreaterThan(0);
        await expect(
          ownerPage.locator('.terminal-tile[data-empty="false"] .tile-restoring'),
        ).toHaveCount(await ownerPage.locator('.terminal-tile[data-empty="false"]').count());
        for (const theme of ["eclipse-light", "eclipse-dark"]) {
          await ownerPage.evaluate(
            (interfaceTheme) => window.desktop.saveSetup({ interfaceTheme }),
            theme,
          );
          await expect(ownerPage.locator(".tile-restoring").first()).toBeVisible();
          await expect
            .poll(() => ownerPage.evaluate(() => document.documentElement.style.colorScheme))
            .toBe(theme === "eclipse-light" ? "light" : "dark");
          if (process.env.FOOM_RESTORE_SCREENSHOTS) {
            await mkdir(evidencePath("restore_screenshots"), { recursive: true });
            await ownerPage.screenshot({
              path: evidencePath(path.join(evidencePath("restore_screenshots"), `${theme}.png`)),
            });
          }
        }
      } finally {
        await restored.evaluate(() => {
          for (const resume of globalThis.resumeRestoreStreams) resume();
          for (const send of globalThis.restoreStreams) send();
        });
      }
      await expect(ownerPage.locator(".tile-restoring")).toHaveCount(0);
    }
    const newParent = await waitForCredentials(parentName, oldParent);
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
    const removal = await approvalPage(restored);
    await expect(removal.getByRole("heading", { name: /exited-child$/ })).toBeVisible();
    await clickApproval(
      removal,
      removal.getByRole("button", { name: "Approve · Remove worktree", exact: true }),
    );
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
    if (agent === "claude") {
      // Disk restoration keeps its established role contract, but does not infer
      // consent to a later manual Resume from this persisted role.
      await page.evaluate((id) => window.desktop.input(id, "q"), parentId);
      await expect
        .poll(async () => (await rows(page)).find((row) => row.id === parentId)?.exited)
        .toBe(true);
      assert.equal(
        (await rows(page)).find((row) => row.id === parentId)?.orchestration?.restoreOnResume,
        undefined,
      );
      const parentRow = page
        .locator(".session-entry")
        .filter({ has: page.locator(`[data-drag-session="${parentId}"]`) });
      await parentRow
        .locator(":scope > .board-row")
        .getByRole("button", { name: /^Actions for/ })
        .click();
      await expect(page.getByRole("menuitem", { name: "Revoke orchestrator" })).toHaveCount(0);
      await page.getByRole("menuitem", { name: /^Resume conversation/ }).click();
      const ordinaryParent = await waitForCredentials(parentName, newParent);
      assert.equal((await call(ordinaryParent, "whoami")).role, "agent");
    }
    const beforeDisabled = await rows(page);
    await page.evaluate(() => window.desktop.saveSetup({ restoreSessions: false }));
    await quit(restored);
    const disabled = await launchApp(context, { ...options, fixture: "restored" });
    const off = await boardPage(disabled);
    await expect
      .poll(() => rows(off))
      .toMatchObject(beforeDisabled.map(({ id }) => ({ id, exited: true, dormant: true })));
  });

async function deferredStartup(context, makeSessions, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-deferred-startup-")));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const profile = path.join(root, "profile");
  const config = path.join(profile, ".foom", "config");
  const lock = path.join(config, ".foom-settings.lock");
  const sessionsFile = path.join(profile, "sessions.json");
  await Promise.all([mkdir(home), mkdir(config, { recursive: true })]);
  const shell = (id) => ({
    id,
    agent: "shell",
    home: true,
    repository: home,
    worktree: home,
    branch: null,
    running: true,
  });
  const settings = {
    kind: "settings",
    agents: { claude: true },
    hooks: false,
    ...options.config,
  };
  const baseline = JSON.stringify(settings);
  const env = {};
  if (options.claude) {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const { chmod, symlink } = require("node:fs/promises");
    await symlink(process.execPath, path.join(bin, "node"));
    const cli = path.join(bin, "claude");
    await writeFile(cli, FAKE_ORCHESTRATED_CLAUDE);
    await chmod(cli, 0o755);
    env.PATH = bin;
    env.TEST_FAKE_CREDENTIALS = path.join(root, "credentials");
  }
  const sessions = await makeSessions({ root, home, profile, shell });
  await Promise.all([
    writeFile(sessionsFile, JSON.stringify(sessions)),
    writeFile(
      path.join(config, "settings.json"),
      JSON.stringify({ ...settings, interfaceScale: 110 }),
    ),
    writeFile(
      path.join(profile, "settings.json"),
      JSON.stringify({
        version: 2,
        settings: { setupComplete: true, checkForUpdates: false, ...options.profile },
        configText: baseline,
        configDigest: require("node:crypto").createHash("sha256").update(baseline).digest("hex"),
      }),
    ),
    writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        start: null,
        hostname: require("node:os").hostname(),
        token: "deferred-startup-fixture",
        timestamp: Date.now(),
      }),
    ),
  ]);
  const app = await launchApp(context, {
    fixture: "restored",
    args: [`--user-data-dir=${profile}`, "--foom-isolated-state"],
    home,
    env,
    deferRestoreDaemonInventory: options.remote,
  });
  const page = await boardPage(app);
  const rows = () => page.evaluate(async () => (await window.desktop.workspace()).terminals);
  const saved = async () => JSON.parse(await readFile(sessionsFile, "utf8"));
  return { app, page, rows, saved, unlock: () => require("node:fs/promises").rm(lock) };
}

async function requestDeferredQuit(app, page, capture = false) {
  await app.evaluate(({ app }) => app.quit());
  const stopping = page.getByRole("dialog", { name: "Stopping Foom" });
  await expect(stopping.getByRole("status")).toHaveText("Stopping…");
  if (capture) await page.screenshot({ path: evidencePath("deferred-restore-stopping.png") });
  return confirmationPage(app, "Quit while sessions are starting?");
}

test("deferred startup opens on the baseline and confirmed quit preserves queued sessions", {
  timeout: deadline(30000),
}, async (context) => {
  const { app, page, rows, saved } = await deferredStartup(context, ({ shell }) => [
    shell("deferred-shell"),
  ]);
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.interfaceScale,
    100,
  );
  assert.equal((await rows())[0]?.dormant, true);
  await quitAndWait(app, async () => {
    const prompt = await requestDeferredQuit(app, page, true);
    await prompt.getByRole("button", { name: "Stop all and quit", exact: true }).click();
  });
  assert.equal((await saved()).find((row) => row.id === "deferred-shell")?.running, true);
});

test("deferred startup resumes all queued sessions after a timed-out quit is cancelled", {
  timeout: deadline(30000),
}, async (context) => {
  const { app, page, rows, saved, unlock } = await deferredStartup(context, ({ shell }) => [
    shell("deferred-one"),
    shell("deferred-two"),
  ]);
  try {
    const prompt = await requestDeferredQuit(app, page);
    await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(async () => (await rows()).filter((row) => row.dormant && row.restoring).length)
      .toBe(2);
    await expect.poll(async () => (await saved()).filter((row) => row.running).length).toBe(2);
  } finally {
    await unlock();
  }
  await expect
    .poll(async () => (await rows()).filter((row) => !row.dormant && !row.exited).length)
    .toBe(2);
  await expect
    .poll(
      async () => (await page.evaluate(() => window.desktop.setupState())).settings.interfaceScale,
    )
    .toBe(110);
});

test("Restart, Resume and Close claim queued rows before the deferred startup pass", {
  timeout: deadline(45000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { app, page, rows, unlock } = await deferredStartup(
    context,
    ({ shell }) => [
      shell("replace-shell"),
      shell("close-shell"),
      { ...shell("resume-agent"), agent: "claude", machine: true, conversationId: "saved-agent" },
      shell("restore-shell"),
    ],
    { claude: true },
  );
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { AgentService } = load("./build/main/agents/agents.js");
    const original = AgentService.prototype.launch;
    AgentService.prototype.launch = async function (request) {
      if (request.terminalId === "resume-agent") {
        AgentService.prototype.launch = original;
        await new Promise((resolve) => {
          globalThis.releaseManualResume = resolve;
        });
      }
      return original.call(this, request);
    };
  });
  let unlocked = false;
  try {
    const prompt = await requestDeferredQuit(app, page);
    await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(async () => (await rows()).filter((row) => row.dormant && row.restoring).length)
      .toBe(4);
    const commands = page.evaluate(async () => {
      const completions = Promise.allSettled([
        window.desktop.sidebarCommand({ kind: "restart", id: "replace-shell" }),
        window.desktop.sidebarCommand({ kind: "resume", id: "resume-agent" }),
        window.desktop.sidebarCommand({ kind: "close", id: "close-shell" }),
      ]);
      const duplicate = await window.desktop
        .sidebarCommand({ kind: "resume", id: "resume-agent" })
        .then(
          () => false,
          () => true,
        );
      return { duplicate, completions: await completions };
    });
    await expect
      .poll(() => app.evaluate(() => typeof globalThis.releaseManualResume))
      .toBe("function");
    await unlock();
    unlocked = true;
    await expect
      .poll(async () => (await rows()).find((row) => row.id === "restore-shell")?.exited)
      .toBe(false);
    await app.evaluate(() => globalThis.releaseManualResume());
    const result = await commands;
    assert.equal(result.duplicate, true);
    assert.deepEqual(
      result.completions.map(({ status }) => status),
      ["fulfilled", "fulfilled", "fulfilled"],
      JSON.stringify(result.completions),
    );
  } finally {
    await app.evaluate(() => globalThis.releaseManualResume?.());
    if (!unlocked) await unlock();
  }
  const inventory = await rows();
  assert.equal(inventory.length, 3);
  assert.ok(!inventory.some((row) => ["replace-shell", "close-shell"].includes(row.id)));
  assert.ok(inventory.every((row) => !row.exited && !row.dormant));
});

test("a stalled restore completes after Cancel and releases its claim", {
  timeout: deadline(30000),
}, async (context) => {
  const { app, page, rows, unlock } = await deferredStartup(context, ({ shell }) => [
    shell("stalled-shell"),
  ]);
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { TerminalHostClient } = load("./build/main/terminals/terminal-host-client.js");
    const original = TerminalHostClient.prototype.create;
    TerminalHostClient.prototype.create = async function (spec) {
      if (spec.id === "stalled-shell") {
        TerminalHostClient.prototype.create = original;
        await new Promise((resolve) => {
          globalThis.releaseStalledRestore = resolve;
        });
      }
      return original.call(this, spec);
    };
  });
  await unlock();
  try {
    await expect
      .poll(() => app.evaluate(() => typeof globalThis.releaseStalledRestore))
      .toBe("function");
    const prompt = await requestDeferredQuit(app, page);
    await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    await app.evaluate(() => globalThis.releaseStalledRestore?.());
  }
  await expect
    .poll(async () => (await rows()).find((row) => row.id === "stalled-shell")?.exited)
    .toBe(false);
  await stopSession(page, "stalled-shell");
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "close", id: "stalled-shell" }));
  await expect.poll(rows).toEqual([]);
});

test("Close persists across a stale startup daemon discovery reply", {
  timeout: deadline(30000),
}, async (context) => {
  const { app, page, rows, saved, unlock } = await deferredStartup(
    context,
    ({ shell }) => [
      {
        ...shell("remote-saved"),
        remote: true,
        running: false,
        placement: { kind: "remote", host: "fixture-host" },
      },
      shell("discovery-follower"),
    ],
    {
      remote: true,
      profile: { registeredHosts: [{ host: "fixture-host", codeFolder: "/code" }] },
    },
  );
  try {
    assert.equal(await app.evaluate(() => globalThis.restoreDaemon.requested), true);
    await page.evaluate(() => window.desktop.sidebarCommand({ kind: "close", id: "remote-saved" }));
    assert.equal(await app.evaluate(() => globalThis.restoreDaemon.closed), true);
    assert.equal(
      (await rows()).some((row) => row.id === "remote-saved"),
      false,
    );
  } finally {
    await app.evaluate(() =>
      globalThis.restoreDaemon.release([{ host: "fixture-host", session: { id: "remote-saved" } }]),
    );
    await unlock();
  }
  await expect
    .poll(async () => (await rows()).find((row) => row.id === "discovery-follower")?.exited)
    .toBe(false);
  assert.equal(
    (await rows()).some((row) => row.id === "remote-saved"),
    false,
  );
  await expect
    .poll(async () => (await saved()).map((row) => row.id))
    .toEqual(["discovery-follower"]);
});

test("a skipped queued restore leaves the orchestrator child slot available", {
  timeout: deadline(45000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  let credentials;
  const { app, page, rows, unlock } = await deferredStartup(
    context,
    async ({ root, profile }) => {
      const repo = path.join(root, "restore-parent");
      const child = path.join(root, "skipped-child");
      credentials = path.join(root, "credentials.restore-parent");
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
      isolatedGit(["-C", repo, "worktree", "add", "-b", "skipped-child", child]);
      const { lstat } = require("node:fs/promises");
      const identity = async (checkout, gitDir) => {
        const entries = await Promise.all(
          [checkout, path.join(checkout, ".git"), gitDir].map(async (entry) => {
            const stat = await lstat(entry, { bigint: true });
            return [stat.dev, stat.ino, stat.birthtimeNs].map(String);
          }),
        );
        return JSON.stringify([gitDir, entries]);
      };
      await writeFile(
        path.join(profile, "worktrees.json"),
        JSON.stringify({
          version: 1,
          repositories: [repo],
          managed: [
            {
              path: child,
              repository: repo,
              root,
              identity: await identity(
                child,
                path.join(repo, ".git", "worktrees", "skipped-child"),
              ),
            },
          ],
        }),
      );
      const parent = {
        id: "restore-parent",
        agent: "claude",
        repository: repo,
        worktree: repo,
        branch: "main",
        conversationId: "saved-parent",
        running: true,
        orchestrator: { identity: await identity(repo, path.join(repo, ".git")), history: [] },
      };
      return [
        parent,
        {
          id: "skipped-child",
          agent: "claude",
          repository: repo,
          worktree: child,
          branch: "skipped-child",
          conversationId: "saved-child",
          running: true,
          parentId: parent.id,
        },
      ];
    },
    { claude: true, config: { concurrentChildren: 1 } },
  );
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { OrchestrationAuthority } = load("./build/main/control/orchestration-authority.js");
    const original = OrchestrationAuthority.prototype.restoreChild;
    OrchestrationAuthority.prototype.restoreChild = async function (parent, entry, current) {
      const restored = await original.call(this, parent, entry, current);
      if (entry.id === "skipped-child") {
        OrchestrationAuthority.prototype.restoreChild = original;
        if (!restored) throw new Error("Fixture child relationship did not restore");
        await new Promise((resolve) => {
          globalThis.releaseChildRestore = resolve;
        });
      }
      return restored;
    };
  });
  await unlock();
  try {
    await expect
      .poll(() => app.evaluate(() => typeof globalThis.releaseChildRestore))
      .toBe("function");
    await page.evaluate(() => window.desktop.saveSetup({ restoreSessions: false }));
    assert.equal(
      (await rows()).find((row) => row.id === "restore-parent")?.orchestration?.children,
      0,
    );
  } finally {
    await app.evaluate(() => globalThis.releaseChildRestore?.());
  }
  await expect
    .poll(async () => (await rows()).find((row) => row.id === "skipped-child")?.restoring)
    .toBeUndefined();
  const parent = JSON.parse(await readFile(credentials, "utf8"));
  const call = async (method, params) => {
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
  const tree = await call("create_worktree", { branch: "child-next", idempotencyKey: "next-tree" });
  assert.equal(tree.status, "succeeded");
  const next = await call("launch", {
    worktreeId: tree.resultId,
    agent: "claude",
    idempotencyKey: "next-child",
  });
  assert.equal(next.status, "succeeded");
  await expect
    .poll(
      async () =>
        (await rows()).find((row) => row.id === "restore-parent")?.orchestration?.children,
    )
    .toBe(1);
});
