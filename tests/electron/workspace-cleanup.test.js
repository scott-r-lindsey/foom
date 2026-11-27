const { measureClose, closeTiming } = require("./close-timing.js");
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
  assertConfirmationFocus,
  boardPage,
  confirmationPage,
  approvalPage,
  clickApproval,
  fixtureCleanup,
  launchApp,
  removeAfterApps,
} = require("./harness.js");

test("merged cleanup deletes external worktrees and branches while preserving a skipped checkout", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-merged-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const remote = path.join(root, "remote.git");
  git("clone", "--bare", repo, remote);
  git("remote", "add", "origin", remote);
  const app = await launchApp(context, { fixture: "empty-board", home });
  fixtureCleanup(context).apps.unshift(async () => {
    await app.evaluate(() => globalThis.mergedCleanupRestore?.()).catch(() => {});
  });
  const page = await boardPage(app);
  await app.evaluate(({ app, dialog }, repo) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { WorktreeService } = load("./build/main/workspace/worktrees.js");
    const original = WorktreeService.prototype.deleteMergedBranches;
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    globalThis.mergedCleanupBranchesReady = ready.promise;
    globalThis.mergedCleanupRelease = () => release.resolve();
    globalThis.mergedCleanupBranchTiming = { state: "waiting" };
    WorktreeService.prototype.deleteMergedBranches = async function (...args) {
      const started = performance.now();
      globalThis.mergedCleanupBranchTiming = { state: "running" };
      try {
        const result = await original.apply(this, args);
        globalThis.mergedCleanupBranchTiming.state = "succeeded";
        return result;
      } catch (error) {
        globalThis.mergedCleanupBranchTiming.state = "failed";
        throw error;
      } finally {
        globalThis.mergedCleanupBranchTiming.elapsedMs = performance.now() - started;
        // Run the real transaction first, then hold its return so 2/2 removals
        // cannot accidentally stand in for the final cleanup progress update.
        ready.resolve();
        await release.promise;
      }
    };
    globalThis.mergedCleanupRestore = () => {
      release.resolve();
      WorktreeService.prototype.deleteMergedBranches = original;
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("button", { name: "Actions for repo", exact: true })).toBeVisible();
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  const paths = {};
  for (const branch of ["merged-one", "merged-two", "dirty"]) {
    paths[branch] = path.join(root, `repo-${branch}`);
    git("worktree", "add", "-b", branch, paths[branch]);
  }
  await writeFile(path.join(paths.dirty, "keep.txt"), "must survive");
  // Wait for the source to include the fresh eligibility result before opening its menu.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.sidebarInventory())).repositories[0]
          ?.canDeleteMerged,
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Actions for merged-two", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await page.getByRole("menuitem", { name: /Delete merged worktrees…/ }).click();
  const confirmation = await confirmationPage(app);
  await expect(confirmation.getByRole("list", { name: "Cleanup checklist" })).toContainText(
    "merged-one",
  );
  await expect(confirmation.getByRole("list", { name: "Kept worktrees" })).toContainText(
    "dirtyuncommitted changes",
  );
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.screenshot({ path: evidencePath("foom-122-confirmation.png") });
  const results = await new AxeBuilder({ page: confirmation }).setLegacyMode().analyze();
  assert.deepEqual(
    results.violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    [],
  );
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  assert.ok((git("branch", "--list", "merged-one") || "").includes("merged-one"));
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await page.getByRole("menuitem", { name: /Delete merged worktrees…/ }).click();
  await expect(confirmation.getByRole("button", { name: "Delete 2", exact: true })).toBeVisible();
  await expect(confirmation.getByRole("checkbox", { name: "Close when completed" })).toBeChecked();
  const cleanupStarted = performance.now();
  await confirmation.getByRole("button", { name: "Delete 2", exact: true }).click();
  try {
    // The owning test deadline bounds real fetch/removal/ref work. The existing
    // visibility assertion measures dismissal after that work, not all phases.
    await app.evaluate(() => globalThis.mergedCleanupBranchesReady);
    await expect(
      confirmation
        .getByRole("list", { name: "Cleanup checklist" })
        .getByText("removed", { exact: true }),
    ).toHaveCount(2);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "app://confirmation/confirmation.html")
          .isVisible(),
      ),
      true,
    );
    await app.evaluate(() => globalThis.mergedCleanupRelease());
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find(
              (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
            )
            .isVisible(),
        ),
      )
      .toBe(false);
    assert.equal(
      (await page.evaluate((repository) => window.desktop.worktrees(repository), repository))
        .length,
      2,
    );
  } finally {
    await app.evaluate(() => globalThis.mergedCleanupRelease()).catch(() => {});
    context.diagnostic(
      `Merged cleanup: ${JSON.stringify({
        elapsedMs: performance.now() - cleanupStarted,
        branches: await app.evaluate(() => globalThis.mergedCleanupBranchTiming),
        checklist: await confirmation.locator("body").innerText(),
      })}`,
    );
  }
  for (const branch of ["merged-one", "merged-two"]) {
    await assert.rejects(realpath(paths[branch]), { code: "ENOENT" });
    // A hidden tombstone still leaves stale navigation/empty content behind.
    await expect(
      page.getByRole("treeitem", { name: branch, exact: true, includeHidden: true }),
    ).toHaveCount(0);
    await expect.poll(() => git("branch", "--list", branch).toString().trim()).toBe("");
  }
  await expect(page.getByRole("button", { name: "Actions for dirty", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Main checkout", exact: true })).toBeVisible();
  assert.equal(await readFile(path.join(paths.dirty, "keep.txt"), "utf8"), "must survive");
  assert.ok(git("branch", "--list", "dirty").includes("dirty"));
});

test("merged cleanup opens checking, continues hidden, reopens progress and stops unstarted worktrees", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-cleanup-progress-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const remote = path.join(root, "remote.git");
  git("clone", "--bare", repo, remote);
  git("remote", "add", "origin", remote);
  // Four workers start, one replacement starts after a completion, and one
  // checkout stays queued so Stop must leave it alone.
  for (const branch of [...Array.from({ length: 6 }, (_, i) => `merged-${i}`), "dirty"])
    git("worktree", "add", "--no-checkout", "-b", branch, path.join(root, branch));
  await writeFile(path.join(root, "dirty", "keep.txt"), "keep");
  const app = await launchApp(context, { fixture: "empty-board", home });
  fixtureCleanup(context).apps.unshift(async () => {
    // Run before launchApp's close callback, including after an assertion failure.
    await app.evaluate(() => globalThis.cleanupRestore?.()).catch(() => {});
  });
  const page = await boardPage(app);
  // Gate the worker results. The first worker exercises real Git through
  // deletion. Hold the other four until Stop, then let them report unavailable.
  await app.evaluate(({ app, dialog }, repo) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { WorktreeService } = load("./build/main/workspace/worktrees.js");
    const { WorkspaceContext: Workspace } = load("./build/main/workspace/workspace-context.js");
    const { KeptWorktree } = load("./build/main/workspace/cleanup-run.js");
    const fetch = WorktreeService.prototype.mergedDefault;
    const remove = Workspace.prototype.removeTree;
    const gate = new Promise((resolve) => {
      globalThis.cleanupFetchRelease = resolve;
    });
    globalThis.cleanupRemovals = [];
    globalThis.cleanupOperations = [];
    globalThis.cleanupFetchReady = false;
    const originals = new Map();
    for (const method of ["removalIdentity", "changes", "mergedCommit"]) {
      const original = WorktreeService.prototype[method];
      originals.set(method, original);
      WorktreeService.prototype[method] = async function (...args) {
        const entry = { method, branch: args[1]?.branch, started: Date.now() };
        globalThis.cleanupOperations.push(entry);
        try {
          return await original.apply(this, args);
        } catch (error) {
          entry.error = error.message;
          throw error;
        } finally {
          entry.elapsed = Date.now() - entry.started;
        }
      };
    }
    globalThis.cleanupRestore = async () => {
      for (const [method, original] of originals) WorktreeService.prototype[method] = original;
      WorktreeService.prototype.mergedDefault = fetch;
      Workspace.prototype.removeTree = remove;
      globalThis.cleanupFetchRelease();
      await Promise.allSettled(globalThis.cleanupRemovals.splice(0).map((finish) => finish()));
    };
    WorktreeService.prototype.mergedDefault = async function (...args) {
      const entry = { method: "mergedDefault", refresh: args[1], started: Date.now() };
      globalThis.cleanupOperations.push(entry);
      try {
        const result = await fetch.apply(this, args);
        // Gate the foreground result, without blocking the repository's initial
        // background eligibility scan or putting native fetch time after release.
        if (args[1]) {
          globalThis.cleanupFetchReady = true;
          await gate;
        }
        return result;
      } catch (error) {
        entry.error = error.message;
        throw error;
      } finally {
        entry.elapsed = Date.now() - entry.started;
      }
    };
    let firstRemoval = true;
    Workspace.prototype.removeTree = function (...args) {
      const useGit = firstRemoval;
      firstRemoval = false;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const operation = gate.then(() => {
        if (useGit) return remove.apply(this, args);
        throw new KeptWorktree("unavailable");
      });
      globalThis.cleanupRemovals.push(async () => {
        release();
        if (useGit) await operation;
        else await Promise.allSettled([operation]);
      });
      return operation;
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("button", { name: "Actions for repo", exact: true })).toBeVisible();
  await page.evaluate((repo) => {
    void window.desktop.sidebarCommand({ kind: "delete-merged-worktrees", repository: repo });
  }, repo);
  const confirmation = await confirmationPage(app);
  const reportCleanup = async (stage) => {
    context.diagnostic(
      JSON.stringify({
        stage,
        cleanup: await confirmation.locator("body").innerText(),
        operations: await app.evaluate(() => {
          const methods = [...new Set(globalThis.cleanupOperations.map((entry) => entry.method))];
          return methods.map((method) => {
            const entries = globalThis.cleanupOperations.filter((entry) => entry.method === method);
            return {
              method,
              count: entries.length,
              pending: entries.filter((entry) => entry.elapsed === undefined).length,
              longest: Math.max(
                ...entries.map((entry) => entry.elapsed ?? Date.now() - entry.started),
              ),
              errors: entries.flatMap((entry) => (entry.error ? [entry.error] : [])),
            };
          });
        }),
      }),
    );
  };
  await expect(confirmation.getByRole("list", { name: "Checking worktrees" })).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await expect.poll(() => app.evaluate(() => globalThis.cleanupFetchReady)).toBe(true);
  await app.evaluate(() => globalThis.cleanupFetchRelease());
  await expect(confirmation.getByRole("button", { name: "Delete 6", exact: true })).toBeEnabled();
  await expect(confirmation.getByRole("list", { name: "Kept worktrees" })).toContainText(
    "dirtyuncommitted changes",
  );
  // CDP sees the enabled button before the native child necessarily becomes
  // active. On macOS that first click can activate the window without accepting.
  await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
    );
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
        );
        return window.isVisible() && window.isFocused() && window.webContents.isFocused();
      }),
    )
    .toBe(true);
  await expect.poll(() => confirmation.evaluate(() => document.hasFocus())).toBe(true);
  await assertConfirmationFocus(
    app,
    confirmation,
    confirmation.getByRole("button", { name: "Cancel" }),
  );
  await confirmation.getByRole("button", { name: "Delete 6", exact: true }).click();
  // Acceptance changes the feed synchronously, before the fetch and removals.
  // Keep a lost click distinct from a blocked service boundary.
  await expect(confirmation.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
  try {
    await expect.poll(() => app.evaluate(() => globalThis.cleanupRemovals.length)).toBe(4);
    await reportCleanup("four removal sequences started");
  } catch (error) {
    await reportCleanup("waiting for removal sequences failed");
    throw error;
  }
  await confirmation.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByText("deleting 0/6", { exact: true })).toBeVisible();
  await app.evaluate(() => globalThis.cleanupRemovals.shift()());
  await expect(page.getByText("deleting 1/6", { exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate(() => globalThis.cleanupRemovals.length)).toBe(4);
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await page.getByRole("menuitem", { name: /Deleting merged worktrees/ }).click();
  await expect(confirmation.getByRole("progressbar", { name: "Cleanup progress" })).toHaveAttribute(
    "value",
    "1",
  );
  await confirmation.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(confirmation.getByText(/Finishing in-flight removals/)).toBeVisible();
  await app.evaluate(async () => {
    await Promise.all(globalThis.cleanupRemovals.splice(0).map((finish) => finish()));
  });
  await expect(confirmation.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await reportCleanup("stopped run finished");
  await expect(confirmation.locator('[data-cleanup="removed"]')).toHaveCount(1);
  const kept = confirmation.getByRole("list", { name: "Kept worktrees" });
  await expect(kept.getByText("unavailable", { exact: true })).toHaveCount(4);
  await expect(kept.getByText("not started", { exact: true })).toHaveCount(1);
  await confirmation.getByRole("button", { name: "Done", exact: true }).click();
  const inventory = await page.evaluate((repo) => window.desktop.worktrees(repo), repo);
  assert.equal(inventory.length, 7); // main, dirty, four unavailable, one never started
  assert.equal(await readFile(path.join(root, "dirty", "keep.txt"), "utf8"), "keep");
});

test("group cleanup reviews untracked files and removes detached checkouts inside its root", async (context) => {
  const remoteRoot = await mkdtemp(path.join(tmpdir(), "foom-729-remote-"));
  removeAfterApps(context, remoteRoot);
  const app = await launchApp(context, { fixture: "repository" });
  fixtureCleanup(context).apps.unshift(async () => {
    await app.evaluate(() => globalThis.groupCleanupRestore?.()).catch(() => {});
  });
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { CleanupRun } = load("./build/main/workspace/cleanup-run.js");
    const { WorkspaceContext } = load("./build/main/workspace/workspace-context.js");
    const act = CleanupRun.prototype.act;
    const remove = WorkspaceContext.prototype.removeTree;
    const gate = new Promise((resolve) => {
      globalThis.groupCleanupRelease = resolve;
    });
    let reached;
    globalThis.groupCleanupReached = new Promise((resolve) => {
      reached = resolve;
    });
    globalThis.groupCleanupWaitStarted = false;
    globalThis.groupCleanupSettled = false;
    CleanupRun.prototype.act = function (...args) {
      globalThis.groupCleanupRun = this;
      return act.apply(this, args);
    };
    WorkspaceContext.prototype.removeTree = async function (...args) {
      // Hold only completion delivery, after the real removal and every safety
      // check. The checklist must remain at 2/3 until this result is delivered.
      const result = await remove.apply(this, args);
      if (args[1].endsWith("review-detached-b")) {
        reached();
        await gate;
      }
      return result;
    };
    globalThis.groupCleanupRestore = () => {
      globalThis.groupCleanupRelease();
      CleanupRun.prototype.act = act;
      WorkspaceContext.prototype.removeTree = remove;
    };
  });
  const page = await boardPage(app);
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  isolatedGit(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repository },
  );
  const remote = path.join(remoteRoot, "remote.git");
  isolatedGit(["clone", "--bare", repository, remote], { cwd: repository });
  isolatedGit(["remote", "add", "origin", remote], { cwd: repository });
  const trees = [];
  for (const branch of ["review-detached-a", "review-detached-b", "untracked-evidence"])
    trees.push(
      await page.evaluate(
        async ({ repository, branch }) => window.desktop.createWorktree(repository, branch, "root"),
        { repository, branch },
      ),
    );
  for (const tree of trees.slice(0, 2)) isolatedGit(["checkout", "--detach"], { cwd: tree.path });
  await writeFile(path.join(trees[2].path, "screenshot.png"), "fixture evidence");
  isolatedGit(["config", "core.excludesFile", path.join(remoteRoot, "ignored")], {
    cwd: repository,
  });
  await writeFile(path.join(remoteRoot, "ignored"), ".env\n");
  await writeFile(path.join(trees[2].path, ".env"), "fixture secret");
  // Rebuild inventory after the fixture's external Git operations.
  await page.reload();
  await boardPage(app);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.sidebarInventory())).repositories[0]?.mergedCount,
    )
    .toBe(3);
  const name = path.basename(repository);
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: /Delete merged worktrees…/ }).click();
  const confirmation = await confirmationPage(app);
  await expect(
    confirmation.getByRole("button", { name: "Force delete 3", exact: true }),
  ).toBeVisible();
  await expect(confirmation.getByRole("list", { name: "Uncommitted changes" })).toContainText(
    "screenshot.png",
  );
  await expect(confirmation.getByRole("list", { name: "Uncommitted changes" })).toContainText(
    ".env",
  );
  await expect(confirmation.getByText("ignored", { exact: true })).toBeVisible();
  await expect(confirmation.getByRole("list", { name: "Cleanup checklist" })).toContainText(
    "Detached at",
  );
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await mkdir(evidencePath("screenshots-729"), { recursive: true });
  for (const colorMode of ["light", "dark"]) {
    await page.evaluate(
      (colorMode) =>
        window.desktop.saveSetup({
          interfaceTheme: colorMode === "system" ? "follow" : `eclipse-${colorMode}`,
        }),
      colorMode,
    );
    await expect
      .poll(() => confirmation.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(colorMode);
    await confirmation.screenshot({
      path: evidencePath(`screenshots-729/force-${colorMode}.png`),
      animations: "disabled",
    });
  }
  const accessibility = await new AxeBuilder({ page: confirmation }).setLegacyMode().analyze();
  assert.deepEqual(
    accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact),
    ),
    [],
  );
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).focus();
  await confirmation.keyboard.press("Shift+Tab");
  await expect(confirmation.getByRole("checkbox", { name: "Close when completed" })).toBeFocused();
  await confirmation.keyboard.press("Space");
  await expect(
    confirmation.getByRole("checkbox", { name: "Close when completed" }),
  ).not.toBeChecked();
  await confirmation.getByRole("button", { name: "Force delete 3", exact: true }).click();
  await app.evaluate(() => globalThis.groupCleanupReached);
  await expect(confirmation.getByRole("progressbar", { name: "Cleanup progress" })).toHaveAttribute(
    "value",
    "2",
  );
  await expect(
    confirmation.getByRole("alertdialog", { name: "Deleting merged worktrees" }),
  ).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Hide", exact: true })).toBeVisible();
  assert.equal(await confirmation.getByRole("button", { name: "Done", exact: true }).count(), 0);
  // Git completion is not dialog readiness. Await the main-owned run before
  // starting the ordinary UI assertion deadline, including for slow native Git.
  const settled = app.evaluate(async () => {
    globalThis.groupCleanupWaitStarted = true;
    await globalThis.groupCleanupRun.settled();
    globalThis.groupCleanupSettled = true;
  });
  try {
    await expect.poll(() => app.evaluate(() => globalThis.groupCleanupWaitStarted)).toBe(true);
    assert.equal(await app.evaluate(() => globalThis.groupCleanupSettled), false);
  } finally {
    await app.evaluate(() => globalThis.groupCleanupRelease());
    await settled;
    context.diagnostic(
      `Group cleanup completion: ${await confirmation.locator("body").innerText()}`,
    );
  }
  await expect(confirmation.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(confirmation.locator('[data-cleanup="removed"]')).toHaveCount(3);
  for (const tree of trees) await assert.rejects(realpath(tree.path), { code: "ENOENT" });
  await confirmation.getByRole("button", { name: "Done", exact: true }).click();
});

// Human actions retain their shared serial presentation slot. Background owners
// instead expose independent rows in one queue. Both use real cleanup/removal
// owners and fixture Git; every target still needs its own trusted decision.
for (const { front, queued, sameBoard, checking, background } of [
  ...[
    ["cleanup", "orchestrator"],
    ["orchestrator", "cleanup"],
    ["cleanup", "review"],
    ["review", "cleanup"],
    ["orchestrator", "review"],
    ["review", "orchestrator"],
  ]
    .flatMap(([front, queued]) => [
      { front, queued, sameBoard: true, checking: false },
      { front, queued, sameBoard: false, checking: false },
      ...(front === "cleanup" ? [{ front, queued, sameBoard: false, checking: true }] : []),
    ])
    .map((scenario) => ({ ...scenario, background: false })),
  ...[true, false].flatMap((sameBoard) => [
    { front: "orchestrator", queued: "review", sameBoard, checking: false, background: true },
    { front: "review", queued: "orchestrator", sameBoard, checking: false, background: true },
  ]),
]) {
  test(`${background ? "background removal rows stay independent" : "removal reviews serialize"} ${front} before ${queued} ${sameBoard ? "on one board" : "across boards"}${checking ? " while checking" : ""}`, {
    timeout: deadline(60_000),
  }, async (context) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-removal-overlap-")));
    removeAfterApps(context, root);
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    await mkdir(repo);
    await mkdir(home);
    const git = (...args) =>
      isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: repo,
      });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const hasCleanup = front === "cleanup" || queued === "cleanup";
    const branches = ["orchestrator", "review"];
    if (hasCleanup) {
      const remote = path.join(root, "remote.git");
      git("clone", "--bare", repo, remote);
      git("remote", "add", "origin", remote);
      git("worktree", "add", "--no-checkout", "-b", "merged", path.join(root, "merged"));
      branches.push("merged");
      // Both individual worktrees can share one change ahead of the default.
      await writeFile(path.join(repo, "work.txt"), "unmerged work");
      git("add", "work.txt");
      git("commit", "-q", "-m", "unmerged work");
    }
    for (const branch of ["orchestrator", "review"])
      git(
        "worktree",
        "add",
        ...(!hasCleanup ? ["--no-checkout"] : []),
        "-b",
        branch,
        path.join(root, branch),
      );
    const app = await launchApp(context, { fixture: "empty-board", home });
    fixtureCleanup(context).apps.unshift(async () => {
      await app
        .evaluate(() => {
          globalThis.overlapFetchRelease?.();
          for (const abort of Object.values(globalThis.overlapAborts ?? {})) abort.abort();
          for (const off of globalThis.overlapOff ?? []) off();
          for (const dialog of globalThis.overlapDialogs ?? []) dialog.dispose();
        })
        .catch(() => {});
    });
    const first = await boardPage(app);
    await app.evaluate(
      ({ app, dialog }, { repo, checking }) => {
        const load = process
          .getBuiltinModule("node:module")
          .createRequire(app.getAppPath() + "/package.json");
        const { basename } = load("node:path");
        if (checking) {
          const { WorktreeService } = load("./build/main/workspace/worktrees.js");
          const fetch = WorktreeService.prototype.mergedDefault;
          const gate = new Promise((resolve) => {
            globalThis.overlapFetchRelease = resolve;
          });
          WorktreeService.prototype.mergedDefault = async function (...args) {
            await gate;
            return fetch.apply(this, args);
          };
        }
        const { Workspace } = load("./build/main/workspace/workspace.js");
        const { TrustedDialog } = load("./build/main/confirmations/trusted-dialog.js");
        const snapshot = Workspace.prototype.snapshot;
        Workspace.prototype.snapshot = function (...args) {
          globalThis.overlapOwner = this.owner;
          return snapshot.apply(this, args);
        };
        globalThis.overlapDialogs = new Set();
        globalThis.overlapOff = new Set();
        globalThis.overlapRequests = new Set();
        globalThis.overlapAnswers = {};
        globalThis.overlapAborts = {};
        const request = TrustedDialog.prototype.request;
        TrustedDialog.prototype.request = function (content, ...args) {
          globalThis.overlapDialogs.add(this);
          if (this.window) globalThis.overlapTrackVisible?.(this.window);
          if (content.approvalFeed) {
            const record = () => {
              for (const row of content.approvalFeed.current()) {
                const source = basename(row.request.worktreePath ?? "");
                if (["orchestrator", "review"].includes(source))
                  globalThis.overlapRequests.add(source);
              }
            };
            globalThis.overlapOff.add(content.approvalFeed.subscribe(record));
            record();
          }
          if (content.feed) globalThis.overlapRequests.add("cleanup");
          if (content.removal)
            globalThis.overlapRequests.add(
              content.removal.group.startsWith("review-close-") ? "review" : "orchestrator",
            );
          return request.call(this, content, ...args);
        };
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
      },
      { repo, checking },
    );
    await first.evaluate(() => window.desktop.addRepository());
    await first.evaluate(() => window.desktop.workspace());
    let second = first;
    if (!sameBoard) {
      await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
      await expect
        .poll(() => {
          second = app
            .windows()
            .find((page) => page !== first && page.url() === "app://bundle/index.html");
          return Boolean(second);
        })
        .toBe(true);
      await expect(second.locator(".board-home")).toBeVisible();
    }
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.overlapVisibleMax = 0;
      const record = () => {
        const visible = BrowserWindow.getAllWindows().filter(
          (window) =>
            window.webContents.getURL() === "app://confirmation/confirmation.html" &&
            window.isVisible(),
        ).length;
        globalThis.overlapVisibleMax = Math.max(globalThis.overlapVisibleMax, visible);
      };
      const tracked = new Set();
      globalThis.overlapTrackVisible = (window) => {
        if (!tracked.has(window)) {
          tracked.add(window);
          window.on("show", record);
        }
      };
      for (const window of BrowserWindow.getAllWindows())
        if (window.webContents.getURL() === "app://confirmation/confirmation.html")
          globalThis.overlapTrackVisible(window);
    });
    const pending = [];
    const start = async (source, board) => {
      const native = await app.browserWindow(board);
      await native.evaluate((window) => window.focus());
      await native.dispose();
      if (source === "cleanup") {
        const result = board.evaluate(
          (repo) =>
            window.desktop.sidebarCommand({
              kind: "delete-merged-worktrees",
              repository: repo,
            }),
          repo,
        );
        void result.catch(() => {});
        pending.push(result);
      } else {
        await app.evaluate(
          (_, { worktree, repo, source, background }) => {
            const owner = globalThis.overlapOwner;
            const path = worktree;
            const abort = new AbortController();
            globalThis.overlapAborts[source] = abort;
            void (async () => {
              const identity = await owner.deps.worktrees.launchIdentity(repo, path);
              return owner.cleanup.removeOwnedTree(
                repo,
                path,
                identity,
                (branch, changes, _automatic, fileCount) =>
                  owner.deps.dialog(
                    {
                      title: "Remove worktrees?",
                      accept: "Approve all",
                      ...(!background ? { userAction: true } : {}),
                      removal: {
                        group: source === "review" ? "review-close-session" : "overlap-actor",
                        item: {
                          id: source,
                          branch,
                          path,
                          changes,
                          fileCount,
                        },
                      },
                    },
                    abort.signal,
                  ),
                () => {},
              );
            })().then(
              (answer) => {
                globalThis.overlapAnswers[source] = answer;
              },
              () => {
                globalThis.overlapAnswers[source] = "failed";
              },
            );
          },
          { worktree: path.join(root, source), repo, source, background },
        );
      }
      await expect
        .poll(() => app.evaluate((_, source) => globalThis.overlapRequests.has(source), source))
        .toBe(true);
    };
    const dialogFor = async (source) => {
      if (background) {
        const page = await approvalPage(app);
        await expect(
          page.locator(".approval-row").filter({
            has: page.getByRole("heading", { name: path.join(root, source), exact: true }),
          }),
        ).toHaveCount(1);
        return page;
      }
      let page;
      await expect
        .poll(async () => {
          for (const candidate of app.windows()) {
            if (
              source === "cleanup"
                ? await candidate
                    .getByRole("list", {
                      name: checking ? "Checking worktrees" : "Cleanup checklist",
                    })
                    .count()
                : await candidate.locator(".subject").filter({ hasText: source }).count()
            ) {
              page = candidate;
              return true;
            }
          }
          return false;
        })
        .toBe(true);
      return page;
    };
    await start(front, first);
    const frontPage = await dialogFor(front);
    const rowFor = (page, source) =>
      page
        .locator(".approval-row")
        .filter({ has: page.getByRole("heading", { name: path.join(root, source), exact: true }) });
    const frontButton = background
      ? rowFor(frontPage, front).getByRole("button", {
          name: "Approve · Remove worktree",
          exact: true,
        })
      : frontPage.getByRole("button", {
          name: front === "cleanup" ? (checking ? "Delete" : "Delete 1") : "Remove worktree",
          exact: true,
        });
    if (checking) {
      await expect(frontButton).toBeDisabled();
      await expect(frontPage.getByRole("list", { name: "Checking worktrees" })).toBeVisible();
    } else await expect(frontButton).toBeEnabled();
    await start(queued, second);
    // Flush main's queued continuations, then inspect actual active presentations.
    // On the old implementation both boards had a pending, eventually visible child.
    const active = await app.evaluate(async () => {
      await new Promise(setImmediate);
      return [...globalThis.overlapDialogs].filter((dialog) => dialog.pending).length;
    });
    assert.equal(
      active,
      1,
      background
        ? "background removals must share one queue"
        : "human removal reviews must share one presentation slot",
    );
    if (background) await expect(frontPage.locator(".approval-row")).toHaveCount(2);
    for (const branch of branches)
      assert.ok(await realpath(path.join(root, branch)), "pending review must not remove anything");
    // Selecting a source's visible approval removes exactly its displayed target.
    await app.evaluate(() => {
      const dialog = [...globalThis.overlapDialogs].find((dialog) => dialog.pending);
      dialog.window.focus();
      dialog.window.webContents.focus();
    });
    await assertConfirmationFocus(
      app,
      frontPage,
      frontPage.getByRole("button", { name: background ? "Hide" : "Cancel", exact: true }),
    );
    if (checking) {
      await frontPage.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(
        await app.evaluate(
          (_, repo) => globalThis.overlapOwner.repositoryOperations.has(repo),
          repo,
        ),
        true,
      );
      const nextPage = await dialogFor(queued);
      const approve = nextPage.getByRole("button", { name: "Remove worktree", exact: true });
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect
        .poll(() => app.evaluate((_, source) => globalThis.overlapAnswers[source], queued))
        .toBe(true);
      assert.ok(await realpath(path.join(root, "merged")));
      await app.evaluate(() => globalThis.overlapFetchRelease());
      await Promise.all(pending);
      assert.equal(await app.evaluate(() => globalThis.overlapVisibleMax), 1);
      return;
    }
    if (background) await clickApproval(frontPage, frontButton);
    else await frontButton.click();
    await expect
      .poll(async () => {
        try {
          await realpath(path.join(root, front === "cleanup" ? "merged" : front));
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    const queuedPage = await dialogFor(queued);
    if (background) {
      await expect(queuedPage.locator(".approval-row")).toHaveCount(1);
      await expect(queuedPage.locator(".approval-placeholder")).toHaveCount(0);
      const remaining = rowFor(queuedPage, queued);
      await expect(
        remaining.getByRole("button", { name: "Approve · Remove worktree", exact: true }),
      ).toBeEnabled();
      await clickApproval(
        queuedPage,
        remaining.getByRole("button", { name: "Decline", exact: true }),
      );
    } else {
      await expect(
        queuedPage.getByRole("button", {
          name: queued === "cleanup" ? "Delete 1" : "Remove worktree",
          exact: true,
        }),
      ).toBeEnabled();
      // Declining the next human review preserves its checkout and unlisted trees.
      await queuedPage.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    if (queued !== "cleanup")
      await expect
        .poll(() => app.evaluate((_, source) => globalThis.overlapAnswers[source], queued))
        .toBe(false);
    await Promise.all(pending);
    assert.ok(await realpath(path.join(root, queued === "cleanup" ? "merged" : queued)));
    assert.equal(
      await app.evaluate(() => globalThis.overlapVisibleMax),
      1,
      "no two native removal windows may be shown at the same time",
    );
  });
}

test("merged cleanup skips Git-ignored build folders and hides the action at zero eligible", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-cleanup-990-")));
  removeAfterApps(context, root);
  const repository = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repository);
  await mkdir(home);
  const app = await launchApp(context, { fixture: "empty-board", home });
  const page = await boardPage(app);
  const worktreeRoot = await page.evaluate(
    async () => (await window.desktop.setupState()).worktreeRoot,
  );
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repository,
    });
  git("init", "-q", "-b", "main");
  await writeFile(path.join(repository, ".gitignore"), "packages/\n");
  await writeFile(path.join(repository, "tracked.txt"), "initial\n");
  git("add", ".gitignore", "tracked.txt");
  git("commit", "-m", "initial");
  const merged = { path: path.join(worktreeRoot, "repo", "merged-build") };
  await mkdir(path.dirname(merged.path), { recursive: true });
  git("worktree", "add", "-b", "merged-build", merged.path);
  await writeFile(path.join(merged.path, "feature.txt"), "merged feature\n");
  isolatedGit(["add", "feature.txt"], { cwd: merged.path });
  isolatedGit(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature"],
    { cwd: merged.path },
  );
  git("merge", "--no-ff", "merged-build", "-m", "merge feature");
  const remote = path.join(root, "remote.git");
  git("clone", "--bare", repository, remote);
  git("remote", "add", "origin", remote);
  const packages = path.join(merged.path, "packages");
  await mkdir(packages);
  for (let start = 0; start < 10_100; start += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) =>
        writeFile(path.join(packages, `package-${start + offset}.js`), ""),
      ),
    );
  }
  // The explicit policy also permits repositories inside Git-ignored folders.
  isolatedGit(["init", "-q", "-b", "main", path.join(packages, "nested")], { cwd: merged.path });
  const dirty = { path: path.join(worktreeRoot, "repo", "keep-changes") };
  git("worktree", "add", "-b", "keep-changes", dirty.path);
  await writeFile(path.join(dirty.path, "tracked.txt"), "keep tracked changes\n");
  await writeFile(path.join(dirty.path, "untracked.txt"), "keep untracked changes\n");
  // Register only after Git setup: an early background scan would cache a missing
  // remote or pre-merge default for a minute, hiding the behavior under test.
  await app.evaluate(({ dialog }, repository) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
  }, repository);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("button", { name: "Actions for repo", exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.sidebarInventory())).repositories[0]?.mergedCount,
    )
    .toBe(1);
  const openCleanup = async () => {
    await page
      .getByRole("button", { name: `Actions for ${path.basename(repository)}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: /Delete merged worktrees…/ }).click();
    return confirmationPage(app);
  };
  const confirmation = await openCleanup();
  await expect(
    confirmation.getByRole("button", { name: "Force delete 1", exact: true }),
  ).toBeEnabled();
  await expect(confirmation.getByRole("list", { name: "Uncommitted changes" })).toContainText(
    "packages/",
  );
  await expect(confirmation.getByRole("list", { name: "Kept worktrees" })).toContainText(
    "keep-changesuncommitted changes",
  );
  await confirmation.screenshot({ path: evidencePath("990-ignored-build-review.png") });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await readFile(path.join(packages, "package-10000.js"), "utf8"), "");
  await openCleanup();
  await assertConfirmationFocus(
    app,
    confirmation,
    confirmation.getByRole("button", { name: "Cancel" }),
  );
  await confirmation.getByRole("button", { name: "Force delete 1", exact: true }).click();
  await expect
    .poll(async () =>
      (await page.evaluate((repository) => window.desktop.worktrees(repository), repository)).some(
        (tree) => tree.path === merged.path,
      ),
    )
    .toBe(false);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "app://confirmation/confirmation.html")
          .isVisible(),
      ),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await expect(page.getByText("0 eligible to delete", { exact: true })).toBeVisible();
  const cleanupAction = page.getByRole("menuitem", { name: /Delete merged worktrees…/ });
  await expect(cleanupAction).toHaveCount(0);

  const eligible = path.join(path.dirname(dirty.path), "new-merged");
  const zero = page.getByRole("button", { name: "0 eligible to delete", exact: true });
  const newWorktree = page.getByRole("menuitem", { name: "New worktree" });
  await page.getByRole("button", { name: "Copy default branch" }).press("Tab");
  await expect(zero).toBeFocused();
  git("worktree", "add", "-b", "new-merged", eligible);
  await expect(page.getByText("1 eligible to delete", { exact: true })).toBeVisible();
  await expect(cleanupAction).toHaveText("Delete merged worktrees…1");
  await expect(newWorktree).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Pin to top" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(cleanupAction).toBeFocused();
  git("worktree", "lock", eligible);
  await expect(page.getByText("0 eligible to delete", { exact: true })).toBeVisible();
  await expect(cleanupAction).toHaveCount(0);
  await expect(newWorktree).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Pin to top" })).toBeFocused();
  assert.equal(
    await readFile(path.join(dirty.path, "tracked.txt"), "utf8"),
    "keep tracked changes\n",
  );
  assert.equal(
    await readFile(path.join(dirty.path, "untracked.txt"), "utf8"),
    "keep untracked changes\n",
  );
  await assert.rejects(realpath(merged.path), { code: "ENOENT" });
});

test("zero merged cleanup eligibility opens the kept review and refreshes while the board stays focused", {
  timeout: deadline(60_000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-kept-worktrees-")));
  removeAfterApps(context, root);
  const repository = path.join(root, "repo");
  const checkout = path.join(root, "keep-changes");
  const home = path.join(root, "home");
  await mkdir(repository);
  await mkdir(home);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repository,
    });
  git("init", "-q", "-b", "main");
  await writeFile(path.join(repository, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git("commit", "-m", "initial");
  const remote = path.join(root, "remote.git");
  git("clone", "--bare", repository, remote);
  git("remote", "add", "origin", remote);
  git("worktree", "add", "-b", "keep-changes", checkout);
  const edit = () => writeFile(path.join(checkout, "tracked.txt"), "keep tracked changes\n");
  const restore = () => writeFile(path.join(checkout, "tracked.txt"), "initial\n");
  await edit();

  const app = await launchApp(context, { fixture: "empty-board", home });
  const page = await boardPage(app);
  await app.evaluate(({ app, dialog }, repository) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { CleanupOwner } = load("./build/main/workspace/cleanup-owner.js");
    const inventory = CleanupOwner.prototype.inventory;
    CleanupOwner.prototype.inventory = function (...args) {
      CleanupOwner.prototype.inventory = inventory;
      let time = Date.now();
      this.deps.now = () => time;
      globalThis.expireEligibility = () => {
        time += 60_001;
      };
      return inventory.apply(this, args);
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
  }, repository);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const actions = page.getByRole("button", { name: "Actions for repo", exact: true });
  const zero = page.getByRole("button", { name: "0 eligible to delete", exact: true });
  const deletion = page.getByRole("menuitem", { name: /Delete merged worktrees…/ });
  const openPanel = async () => {
    await actions.click();
    await expect(actions).toHaveAttribute("aria-expanded", "true");
  };
  const closePanel = async () => {
    await page.keyboard.press("Escape");
    await expect(actions).toHaveAttribute("aria-expanded", "false");
  };
  const reviewKept = async () => {
    await zero.click();
    const review = await confirmationPage(app, "Kept worktrees");
    await expect(review.getByRole("list", { name: "Kept worktrees" })).toContainText(
      "keep-changesuncommitted changes",
    );
    await expect(review.getByRole("button", { name: /delete/i })).toHaveCount(0);
    return review;
  };
  await openPanel();
  await expect(zero).toBeVisible();
  await expect(deletion).toHaveCount(0);
  const review = await reviewKept();
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review.getByRole("alertdialog")).toHaveCount(0);

  if (process.env.FOOM_SCREENSHOTS === "1") {
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (mode) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${mode}` }),
        mode,
      );
      await expect
        .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(mode);
      await openPanel();
      await page.locator(".sidebar-panel").screenshot({
        path: evidencePath(`screenshots-1331/panel-${mode}.png`),
        animations: "disabled",
      });
      await reviewKept();
      await expect
        .poll(() => review.evaluate(() => document.documentElement.style.colorScheme))
        .toBe(mode);
      await review.screenshot({
        path: evidencePath(`screenshots-1331/review-${mode}.png`),
        animations: "disabled",
      });
      await review.getByRole("button", { name: "Close", exact: true }).click();
      await expect(review.getByRole("alertdialog")).toHaveCount(0);
    }
  }

  // A tracked edit does not change Git worktree membership or wake its watcher.
  // Keep the board focused so native focus refresh cannot repair the stale zero.
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await page.evaluate(() => {
    globalThis.blurredDuringEligibilityRefresh = false;
    window.addEventListener(
      "blur",
      () => {
        globalThis.blurredDuringEligibilityRefresh = true;
      },
      { once: true },
    );
  });
  await openPanel();
  await expect(zero).toBeVisible();
  await closePanel();
  await restore();
  await app.evaluate(() => globalThis.expireEligibility());
  await openPanel();
  await expect(page.getByText("1 eligible to delete", { exact: true })).toBeVisible();
  await expect(deletion).toHaveText("Delete merged worktrees…1");
  assert.equal(await page.evaluate(() => globalThis.blurredDuringEligibilityRefresh), false);

  await closePanel();
  await edit();
  await app.evaluate(() => globalThis.expireEligibility());
  await openPanel();
  await expect(zero).toBeVisible();
  await restore();
  await app.evaluate(() => globalThis.expireEligibility());
  await zero.click();
  await expect(review.getByRole("list", { name: "Kept worktrees" })).toContainText("main checkout");
  await expect(review.getByText("keep-changes", { exact: true })).toHaveCount(0);
  await expect(review.getByRole("button", { name: /delete/i })).toHaveCount(0);
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review.getByRole("alertdialog")).toHaveCount(0);
  await openPanel();
  await expect(deletion).toHaveText("Delete merged worktrees…1");
});

test("closing a board declines its queued cleanup and releases its repository before another board answers", {
  timeout: deadline(60_000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-queued-cleanup-")));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  await mkdir(home);
  const repos = [path.join(root, "front"), path.join(root, "queued")];
  const trees = repos.map((repo) => `${repo}-merged`);
  for (const [index, repo] of repos.entries()) {
    await mkdir(repo);
    const git = (...args) =>
      isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: repo,
      });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("clone", "--bare", repo, `${repo}-remote.git`);
    git("remote", "add", "origin", `${repo}-remote.git`);
    git("worktree", "add", "-b", "merged", trees[index]);
  }
  const app = await launchApp(context, { fixture: "empty-board", home });
  fixtureCleanup(context).apps.unshift(async () => {
    await app
      .evaluate(() => {
        for (const request of globalThis.queuedCleanupRequests ?? []) request.dialog.dispose();
      })
      .catch(() => {});
  });
  const first = await boardPage(app);
  await app.evaluate(({ app, dialog }, repos) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { Workspace } = load("./build/main/workspace/workspace.js");
    const { TrustedDialog } = load("./build/main/confirmations/trusted-dialog.js");
    const snapshot = Workspace.prototype.snapshot;
    Workspace.prototype.snapshot = function (...args) {
      globalThis.queuedCleanupWorkspace = this;
      return snapshot.apply(this, args);
    };
    const request = TrustedDialog.prototype.request;
    globalThis.queuedCleanupRequests = [];
    TrustedDialog.prototype.request = function (content, ...args) {
      if (!content.feed) return request.call(this, content, ...args);
      const record = { dialog: this, feed: content.feed, answer: undefined };
      globalThis.queuedCleanupRequests.push(record);
      return request.call(this, content, ...args).then((answer) => {
        record.answer = answer;
        return answer;
      });
    };
    let next = 0;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repos[next++]] });
  }, repos);
  for (let index = 0; index < repos.length; index++)
    await first.evaluate(() => window.desktop.addRepository());
  await first.evaluate(() => window.desktop.workspace());
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
  await expect(second.locator(".board-home")).toBeVisible();
  const native = await app.browserWindow(first);
  await native.evaluate((window) => window.focus());
  await native.dispose();
  const front = first.evaluate(
    (repository) => window.desktop.sidebarCommand({ kind: "delete-merged-worktrees", repository }),
    repos[0],
  );
  void front.catch(() => {});
  await expect
    .poll(() => app.evaluate(() => globalThis.queuedCleanupRequests[0]?.feed.current().stage))
    .toBe("ready");
  const confirmation = await confirmationPage(app);
  await expect(confirmation.getByRole("button", { name: "Delete 1", exact: true })).toBeEnabled();
  const queued = second.evaluate(
    (repository) => window.desktop.sidebarCommand({ kind: "delete-merged-worktrees", repository }),
    repos[1],
  );
  // Closing the board rejects its IPC call; the main-owned request must still settle.
  void queued.catch(() => {});
  await expect
    .poll(() => app.evaluate(() => globalThis.queuedCleanupRequests[1]?.feed.current().stage))
    .toBe("ready");
  assert.equal(
    await app.evaluate(
      (_, repo) => globalThis.queuedCleanupWorkspace.owner.repositoryOperations.has(repo),
      repos[1],
    ),
    true,
  );
  assert.equal(await app.evaluate(() => globalThis.queuedCleanupRequests[0].answer), undefined);
  const closing = await app.browserWindow(second);
  await closing.evaluate((window) => window.close());
  await closing.dispose();
  await expect
    .poll(() => app.evaluate(() => globalThis.queuedCleanupRequests[1].answer))
    .toBe(false);
  await expect
    .poll(() =>
      app.evaluate(
        (_, repo) => globalThis.queuedCleanupWorkspace.owner.repositoryOperations.has(repo),
        repos[1],
      ),
    )
    .toBe(false);
  // The unrelated unanswered front presentation remains untouched throughout.
  assert.equal(await app.evaluate(() => globalThis.queuedCleanupRequests[0].answer), undefined);
  await app.evaluate(
    async (_, repo) => globalThis.queuedCleanupWorkspace.removeRepository(repo),
    repos[1],
  );
  assert.equal(
    (await first.evaluate(() => window.desktop.workspace())).repositories.some(
      (repo) => repo.path === repos[1],
    ),
    false,
  );
  assert.equal(await realpath(trees[1]), trees[1], "declining cleanup must preserve its checkout");
  await app.evaluate(() => {
    const window = globalThis.queuedCleanupRequests[0].dialog.window;
    window.focus();
    window.webContents.focus();
  });
  await assertConfirmationFocus(
    app,
    confirmation,
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  );
  await confirmation.getByRole("button", { name: "Delete 1", exact: true }).click();
  await front;
  await assert.rejects(realpath(trees[0]), { code: "ENOENT" });
  assert.equal(await realpath(trees[1]), trees[1]);
  assert.equal(
    await app.evaluate(() => globalThis.queuedCleanupRequests[1].dialog.pending !== undefined),
    false,
  );
});

test("detached removals share one review per checkout and approve independently", {
  timeout: deadline(60_000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-detached-removals-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const paths = [path.join(root, "review-one"), path.join(root, "review-two")];
  for (const tree of paths) git("worktree", "add", "--no-checkout", "--detach", tree, "HEAD");
  const app = await launchApp(context, { fixture: "empty-board", home });
  fixtureCleanup(context).apps.unshift(async () => {
    await app.evaluate(() => globalThis.detachedAbort?.abort()).catch(() => {});
  });
  const board = await boardPage(app);
  await app.evaluate(({ app, dialog }, repo) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { Workspace } = load("./build/main/workspace/workspace.js");
    const snapshot = Workspace.prototype.snapshot;
    Workspace.prototype.snapshot = function (...args) {
      globalThis.detachedOwner = this.owner;
      return snapshot.apply(this, args);
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await board.evaluate(() => window.desktop.addRepository());
  await board.evaluate(() => window.desktop.workspace());
  await app.evaluate((_, repo) => {
    globalThis.detachedAbort = new AbortController();
    globalThis.detachedAnswers = {};
    globalThis.detachedReviews = [];
    globalThis.startDetachedRemoval = (path, id) => {
      const owner = globalThis.detachedOwner;
      void (async () => {
        const identity = await owner.deps.worktrees.launchIdentity(repo, path);
        return owner.cleanup.removeOwnedTree(
          repo,
          path,
          identity,
          (branch, changes, _automatic, fileCount) => {
            globalThis.detachedReviews.push(id);
            return owner.deps.dialog(
              {
                title: "Remove worktrees?",
                accept: "Approve all",
                removal: {
                  group: "detached-regression",
                  item: { id, branch, path, changes, fileCount },
                },
              },
              globalThis.detachedAbort.signal,
            );
          },
          () => {},
        );
      })().then(
        (answer) => {
          globalThis.detachedAnswers[id] = answer;
        },
        (error) => {
          globalThis.detachedAnswers[id] = String(error);
        },
      );
    };
  }, repo);
  await app.evaluate((_, tree) => globalThis.startDetachedRemoval(tree, "one"), paths[0]);
  const dialog = await approvalPage(app);
  await expect(dialog.getByRole("heading", { name: paths[0], exact: true })).toBeVisible();
  await app.evaluate((_, paths) => {
    globalThis.startDetachedRemoval(paths[0], "duplicate");
    globalThis.startDetachedRemoval(paths[1], "two");
  }, paths);
  await expect(dialog.locator(".approval-row")).toHaveCount(2);
  const rowFor = (path) =>
    dialog.locator(".approval-row").filter({ has: dialog.getByText(path, { exact: true }) });
  for (const path of paths) await expect(rowFor(path)).toHaveCount(1);
  await expect.poll(() => app.evaluate(() => globalThis.detachedReviews)).toEqual(["one", "two"]);
  await clickApproval(
    dialog,
    rowFor(paths[0]).getByRole("button", { name: "Approve · Remove worktree", exact: true }),
  );
  await expect
    .poll(() => app.evaluate(() => globalThis.detachedAnswers))
    .toEqual({ one: true, duplicate: true });
  assert.equal(require("node:fs").existsSync(paths[0]), false);
  assert.equal(require("node:fs").existsSync(paths[1]), true);
  // Approval of one checkout must leave the other caller pending until its own decision.
  await clickApproval(
    dialog,
    rowFor(paths[1]).getByRole("button", { name: "Decline", exact: true }),
  );
  await expect
    .poll(() => app.evaluate(() => globalThis.detachedAnswers))
    .toEqual({ one: true, duplicate: true, two: false });
  // Re-review the declined checkout in the real bulk path with one new
  // checkout. The approval queue fixture covers larger mixed batches.
  const branch = "bulk-clean";
  const clean = path.join(root, branch);
  git("worktree", "add", "--no-checkout", "-b", branch, clean);
  await app.evaluate(
    ({ app }, { clean, changedLate }) => {
      const load = process
        .getBuiltinModule("node:module")
        .createRequire(app.getAppPath() + "/package.json");
      const path = load("node:path");
      const { writeFile } = load("node:fs/promises");
      const worktrees = globalThis.detachedOwner.cleanup.deps.worktrees;
      const remove = worktrees.removeWorktree.bind(worktrees);
      worktrees.removeWorktree = (repository, tree, force, identity, beforeRemove) =>
        remove(
          repository,
          tree,
          force,
          identity,
          tree === changedLate
            ? async () => {
                // Leave the earlier status reads intact and change the checkout at the final guard.
                await writeFile(path.join(tree, "late.txt"), "changed after consent");
                await beforeRemove();
              }
            : beforeRemove,
        );
      globalThis.startDetachedRemoval(changedLate, "retry");
      globalThis.startDetachedRemoval(clean, "bulk");
    },
    { clean, changedLate: paths[1] },
  );
  const queue = await approvalPage(app);
  const bulk = queue.getByRole("button", {
    name: "Approve all clean removals (2)",
    exact: true,
  });
  await expect(bulk).toBeEnabled();
  await bulk.click();
  await expect.poll(() => app.evaluate(() => globalThis.detachedAnswers.bulk)).toBe(true);
  await expect
    .poll(() => app.evaluate(() => globalThis.detachedAnswers.retry))
    .toContain("Worktree changes have changed");
  await assert.rejects(realpath(clean), { code: "ENOENT" });
  assert.ok(String(git("branch", "--list", branch)).trim(), `Branch ${branch} must survive`);
  assert.equal(await readFile(path.join(paths[1], "late.txt"), "utf8"), "changed after consent");
});

test("Close hides a review session before slow worktree removal finishes", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const repo = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  isolatedGit(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  const head = isolatedGit(["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { Workspace } = load("./build/main/workspace/workspace.js");
    const snapshot = Workspace.prototype.snapshot;
    Workspace.prototype.snapshot = function (...args) {
      globalThis.closeOwner = this.owner;
      return snapshot.apply(this, args);
    };
  });
  await page.evaluate(() => window.desktop.workspace());
  const tree = await app.evaluate(
    async (_, { repo, head }) => {
      const service = globalThis.closeOwner.deps.worktrees;
      const tree = await service.createWorktree(repo, "close-review", {
        detachedHead: head,
        reviewBranch: "Close review",
      });
      globalThis.closeRemovalTiming = {};
      const remove = service.removeWorktree.bind(service);
      service.removeWorktree = async (...args) => {
        globalThis.closeRemovalTiming.removalStarted = Date.now();
        await new Promise((resolve) => {
          globalThis.releaseRemoval = resolve;
        });
        await remove(...args);
        globalThis.closeRemovalTiming.finished = Date.now();
      };
      return tree.path;
    },
    { repo, head },
  );
  await page.evaluate(
    ({ repo, tree }) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: tree,
        run: "shell",
      }),
    { repo, tree },
  );
  const row = page.locator(".board-row[data-kind='shell']");
  await row.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-exited", "true");
  const id = await page.evaluate(async () => (await window.desktop.workspace()).terminals[0].id);
  const changedFile = path.join(tree, "kept-until-approved.txt");
  await writeFile(changedFile, "keep until approved");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row).toHaveCount(0);
  const declined = await confirmationPage(app);
  await expect(declined.getByText("kept-until-approved.txt", { exact: true })).toBeVisible();
  await declined.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toHaveCount(1);
  assert.equal(await readFile(changedFile, "utf8"), "keep until approved");
  await row.press("Enter");
  await measureClose(app, page, id);
  const started = Date.now();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".tile-terminal")).toBeHidden();
  const hiddenMs = Date.now() - started;
  const approved = await confirmationPage(app);
  await approved.getByRole("button", { name: "Discard changes and remove", exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.closeRemovalTiming.removalStarted))
    .toBeTruthy();
  assert.equal(await app.evaluate(() => globalThis.closeRemovalTiming.finished), undefined);
  await page.screenshot({
    animations: "disabled",
    path: evidencePath("1048-close-removal-background.png"),
  });
  await app.evaluate(() => globalThis.releaseRemoval());
  await expect.poll(() => app.evaluate(() => globalThis.closeRemovalTiming.finished)).toBeTruthy();
  const timing = await app.evaluate(() => globalThis.closeRemovalTiming);
  console.log(
    `1048 local removal fixture: tile+row hidden in ${hiddenMs}ms; gated removal ${timing.finished - timing.removalStarted}ms; ${JSON.stringify(await closeTiming(app, page))}`,
  );
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 0);
});

test("ordinary Close refuses a second owned or sidebar removal until terminal teardown settles", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const repo = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  isolatedGit(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { Workspace } = load("./build/main/workspace/workspace.js");
    const snapshot = Workspace.prototype.snapshot;
    Workspace.prototype.snapshot = function (...args) {
      globalThis.ordinaryCloseOwner = this.owner;
      return snapshot.apply(this, args);
    };
  });
  await page.evaluate(() => window.desktop.workspace());
  const tree = await app.evaluate(async (_, repo) => {
    const owner = globalThis.ordinaryCloseOwner;
    const tree = await owner.deps.worktrees.createWorktree(repo, "ordinary-close-race");
    const identity = await owner.deps.worktrees.launchIdentity(repo, tree.path);
    const kill = owner.deps.terminals.kill.bind(owner.deps.terminals);
    globalThis.ordinaryCloseKills = 0;
    owner.deps.terminals.kill = async (...args) => {
      globalThis.ordinaryCloseKills++;
      await new Promise((resolve) => {
        globalThis.releaseOrdinaryClose = resolve;
      });
      return kill(...args);
    };
    return { path: tree.path, identity };
  }, repo);
  context.after(async () => {
    await app.evaluate(() => globalThis.releaseOrdinaryClose?.()).catch(() => {});
  });
  const launched = await page.evaluate(
    ({ repo, tree }) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: tree,
        run: "shell",
      }),
    { repo, tree: tree.path },
  );
  const id = launched.terminalId;
  await page.locator(`[data-drag-session="${id}"]`).press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeEditable();
  await page.evaluate((id) => window.desktop.input(id, "exit\r"), id);
  await expect(page.locator(`[data-drag-session="${id}"]`)).toHaveAttribute("data-exited", "true");
  isolatedGit(["checkout", "-b", "changed-ordinary-close"], { cwd: tree.path });
  const keptFile = path.join(tree.path, "held-removal.txt");
  await writeFile(keptFile, "kept until removal is approved");
  for (const detached of [false, true]) {
    if (detached) isolatedGit(["checkout", "--detach"], { cwd: tree.path });
    await page.evaluate(
      ({ repo, tree }) => {
        globalThis.pendingIdleRemoval = window.desktop.sidebarCommand({
          kind: "remove-worktree",
          repository: repo,
          worktree: tree,
        });
      },
      { repo, tree: tree.path },
    );
    const review = await confirmationPage(app);
    await expect(review.getByText("held-removal.txt", { exact: true })).toBeVisible();
    try {
      const closeRefused = await page.evaluate(async (id) => {
        try {
          await window.desktop.sidebarCommand({ kind: "close", id });
          return false;
        } catch {
          return true;
        }
      }, id);
      assert.equal(closeRefused, true);
      assert.equal(await app.evaluate(() => globalThis.ordinaryCloseKills), 0);
      const entry = await page.evaluate(
        async (id) => (await window.desktop.workspace()).terminals.find((row) => row.id === id),
        id,
      );
      assert.equal(entry.closeState, undefined);
      assert.equal(await readFile(keptFile, "utf8"), "kept until removal is approved");
    } finally {
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.evaluate(() => globalThis.pendingIdleRemoval);
    }
  }
  isolatedGit(["checkout", "changed-ordinary-close"], { cwd: tree.path });
  await page.evaluate((id) => {
    globalThis.pendingOrdinaryClose = window.desktop.sidebarCommand({ kind: "close", id });
  }, id);
  await expect.poll(() => app.evaluate(() => globalThis.ordinaryCloseKills)).toBe(1);
  for (const detached of [false, true]) {
    if (detached) isolatedGit(["checkout", "--detach"], { cwd: tree.path });
    const current = await page.evaluate(
      async ({ repo, tree }) => {
        const inventory = await window.desktop.sidebarInventory();
        return inventory.repositories
          .find((entry) => entry.path === repo)
          .worktrees.find((entry) => entry.path === tree);
      },
      { repo, tree: tree.path },
    );
    assert.equal(current.branch, detached ? null : "changed-ordinary-close");
    const launchRefused = await page.evaluate(
      async ({ repo, tree }) => {
        try {
          await window.desktop.sidebarCommand({
            kind: "launch",
            repository: repo,
            worktree: tree,
            run: "shell",
          });
          return false;
        } catch {
          return true;
        }
      },
      { repo, tree: tree.path },
    );
    assert.equal(launchRefused, true);
    assert.equal(
      await page.evaluate(async () => (await window.desktop.workspace()).terminals.length),
      1,
    );
    assert.equal(
      await app.evaluate(
        async (_, { repo, tree }) =>
          globalThis.ordinaryCloseOwner.deps.worktrees.launchIdentity(repo, tree.path),
        { repo, tree },
      ),
      tree.identity,
    );
  }
  const reason = await app.evaluate(
    async (_, { repo, tree }) => {
      try {
        await globalThis.ordinaryCloseOwner.cleanup.removeOwnedTree(
          repo,
          tree.path,
          tree.identity,
          () => Promise.resolve(true),
          () => {},
        );
        return "unexpected success";
      } catch (error) {
        return error.reason;
      }
    },
    { repo, tree },
  );
  assert.equal(reason, "busy");
  const refused = await page.evaluate(
    async ({ repo, tree }) => {
      try {
        await window.desktop.sidebarCommand({
          kind: "remove-worktree",
          repository: repo,
          worktree: tree,
        });
        return false;
      } catch {
        return true;
      }
    },
    { repo, tree: tree.path },
  );
  assert.equal(refused, true);
  assert.equal(await app.evaluate(() => globalThis.ordinaryCloseKills), 1);
  assert.equal(await readFile(path.join(tree.path, ".git"), "utf8").then(() => true), true);
  await app.evaluate(() => globalThis.releaseOrdinaryClose());
  await page.evaluate(() => globalThis.pendingOrdinaryClose);
  await expect(page.locator(`[data-drag-session="${id}"]`)).toHaveCount(0);
});
