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
  confirmationPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

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
