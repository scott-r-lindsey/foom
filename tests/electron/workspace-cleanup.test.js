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

// All three sources use the real cleanup/removal owners and fixture Git repositories.
// The grouped callbacks below match the main-only remove_worktree and reviewer-close
// routes without launching an agent or exposing consent through the board bridge.
for (const { front, queued, sameBoard, checking } of [
  ["cleanup", "orchestrator"],
  ["orchestrator", "cleanup"],
  ["cleanup", "review"],
  ["review", "cleanup"],
  ["orchestrator", "review"],
  ["review", "orchestrator"],
].flatMap(([front, queued]) => [
  { front, queued, sameBoard: true, checking: false },
  { front, queued, sameBoard: false, checking: false },
  ...(front === "cleanup" ? [{ front, queued, sameBoard: false, checking: true }] : []),
])) {
  test(`removal reviews serialize ${front} before ${queued} ${sameBoard ? "on one board" : "across boards"}${checking ? " while checking" : ""}`, {
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
    git("clone", "--bare", repo, path.join(root, "remote.git"));
    git("remote", "add", "origin", path.join(root, "remote.git"));
    for (const branch of ["merged", "orchestrator", "review"]) {
      const tree = path.join(root, branch);
      git("worktree", "add", "-b", branch, tree);
      if (branch !== "merged") {
        // Keep the individual removal targets out of merged cleanup's approved set.
        await writeFile(path.join(tree, "work.txt"), branch);
        git("-C", tree, "add", "work.txt");
        git("-C", tree, "commit", "-q", "-m", "unmerged work");
      }
    }
    const app = await launchApp(context, { fixture: "empty-board", home });
    fixtureCleanup(context).apps.unshift(async () => {
      await app
        .evaluate(() => {
          globalThis.overlapFetchRelease?.();
          for (const abort of Object.values(globalThis.overlapAborts ?? {})) abort.abort();
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
        globalThis.overlapRequests = new Set();
        globalThis.overlapAnswers = {};
        globalThis.overlapAborts = {};
        const request = TrustedDialog.prototype.request;
        TrustedDialog.prototype.request = function (content, ...args) {
          globalThis.overlapDialogs.add(this);
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
      for (const window of BrowserWindow.getAllWindows())
        if (window.webContents.getURL() === "app://confirmation/confirmation.html")
          window.on("show", record);
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
          (_, { worktree, repo, source }) => {
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
                (branch, changes) =>
                  owner.deps.dialog(
                    {
                      title: "Remove worktrees?",
                      accept: "Approve all",
                      removal: {
                        group: source === "review" ? "review-close-session" : "overlap-actor",
                        item: {
                          id: source,
                          branch,
                          path,
                          changes,
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
          { worktree: path.join(root, source), repo, source },
        );
      }
      await expect
        .poll(() => app.evaluate((_, source) => globalThis.overlapRequests.has(source), source))
        .toBe(true);
    };
    const dialogFor = async (source) => {
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
    const frontButton = frontPage.getByRole("button", {
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
    assert.equal(active, 1, "cross-type removal reviews must share one presentation slot");
    for (const branch of ["merged", "orchestrator", "review"])
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
      frontPage.getByRole("button", { name: "Cancel", exact: true }),
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
    await frontButton.click();
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
    await expect(
      queuedPage.getByRole("button", {
        name: queued === "cleanup" ? "Delete 1" : "Remove worktree",
        exact: true,
      }),
    ).toBeEnabled();
    // Declining the next source must preserve its checkout and every unlisted tree.
    await queuedPage.getByRole("button", { name: "Cancel", exact: true }).click();
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
