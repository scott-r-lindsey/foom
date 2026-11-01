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
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
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
    context.diagnostic(
      `Merged cleanup: ${JSON.stringify({
        elapsedMs: performance.now() - cleanupStarted,
        checklist: await confirmation.locator("body").innerText(),
      })}`,
    );
  }
  for (const branch of ["merged-one", "merged-two"]) {
    await assert.rejects(realpath(paths[branch]), { code: "ENOENT" });
    await expect.poll(() => git("branch", "--list", branch).toString().trim()).toBe("");
  }
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
  for (const branch of [...Array.from({ length: 8 }, (_, i) => `merged-${i}`), "dirty"])
    git("worktree", "add", "-b", branch, path.join(root, branch));
  await writeFile(path.join(root, "dirty", "keep.txt"), "keep");
  const app = await launchApp(context, { fixture: "empty-board", home });
  fixtureCleanup(context).apps.unshift(async () => {
    // Run before launchApp's close callback, including after an assertion failure.
    await app.evaluate(() => globalThis.cleanupRestore?.()).catch(() => {});
  });
  const page = await boardPage(app);
  // Gate the start of each removal sequence, before its many real Git safety checks.
  // Releasing a gate still runs the original sequence, including every revalidation.
  await app.evaluate(({ app, dialog }, repo) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { WorktreeService } = load("./build/main/workspace/worktrees.js");
    const { WorkspaceContext: Workspace } = load("./build/main/workspace/workspace-context.js");
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
    Workspace.prototype.removeTree = function (...args) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const operation = gate.then(() => remove.apply(this, args));
      globalThis.cleanupRemovals.push(async () => {
        release();
        await operation;
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
  await expect(confirmation.getByRole("button", { name: "Delete 8", exact: true })).toBeEnabled();
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
  await confirmation.getByRole("button", { name: "Delete 8", exact: true }).click();
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
  await expect(page.getByText("deleting 0/8", { exact: true })).toBeVisible();
  await app.evaluate(() => globalThis.cleanupRemovals.shift()());
  await expect(page.getByText("deleting 1/8", { exact: true })).toBeVisible();
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
  await expect(confirmation.getByRole("list", { name: "Kept worktrees" })).toContainText(
    "not started",
  );
  await confirmation.getByRole("button", { name: "Done", exact: true }).click();
  const inventory = await page.evaluate((repo) => window.desktop.worktrees(repo), repo);
  assert.equal(inventory.length, 5); // main, dirty, and three never-started worktrees
  assert.equal(await readFile(path.join(root, "dirty", "keep.txt"), "utf8"), "keep");
});

test("group cleanup reviews untracked files and removes detached checkouts inside its root", async (context) => {
  const remoteRoot = await mkdtemp(path.join(tmpdir(), "foom-729-remote-"));
  removeAfterApps(context, remoteRoot);
  const app = await launchApp(context, { fixture: "repository" });
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
  await expect(confirmation.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(confirmation.locator('[data-cleanup="removed"]')).toHaveCount(3);
  for (const tree of trees) await assert.rejects(realpath(tree.path), { code: "ENOENT" });
  await confirmation.getByRole("button", { name: "Done", exact: true }).click();
});

test("merged cleanup skips Git-ignored build folders and exposes reasons when none qualify", {
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
  await openCleanup();
  await expect(confirmation.getByRole("list", { name: "Kept worktrees" })).toContainText(
    "keep-changesuncommitted changes",
  );
  await expect(confirmation.getByRole("button", { name: "Delete 0", exact: true })).toBeDisabled();
  await confirmation.screenshot({ path: evidencePath("990-no-eligible-worktrees.png") });
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
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
