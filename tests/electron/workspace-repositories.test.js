const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_CLAUDE,
  assertAccessible,
  boardCommand,
  boardPage,
  captureConfirmationDesktop,
  confirmationPage,
  launchApp,
  removeAfterApps,
  stopSession,
  tabTo,
} = require("./harness.js");

test("the trailing add repository row opens the fixture folder chooser", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-add-repository-"));
  removeAfterApps(context, root);
  const repo = path.join(root, "added-repo");
  await mkdir(repo);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const add = page.getByRole("button", { name: "Add repository", exact: true });
  await expect(add).toHaveText("+ Add repo");
  await expect(page.locator(".sidebar-filter button")).toHaveCount(0);
  await expect(page.locator(".board-list > :last-child")).toHaveAttribute(
    "aria-label",
    "Add repository",
  );
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await add.click();
  await expect(
    page.getByRole("button", { name: "Actions for added-repo", exact: true }),
  ).toBeVisible();
  await expect(add).toHaveCount(1);
  await page.getByLabel("Filter repositories and sessions").fill("added-repo");
  await expect(add).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(add).toBeVisible();
  await page.getByRole("navigation", { name: "Terminal sidebar" }).press("End");
  await expect(add).toBeFocused();
  await assertAccessible(page);
});

test("the branch field creates a worktree by keyboard without launching; dirty removal confirms", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-launch-ui-"));
  removeAfterApps(context, root);
  const repo = path.join(root, "app");
  const bin = path.join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await mkdir(path.join(root, "home"));
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
  if (process.platform !== "win32") {
    await writeFile(path.join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  }
  const app = await launchApp(context, {
    fixture: "agent",
    env: {
      HOME: path.join(root, "home"),
      PATH: bin,
      TEST_FAKE_CREDENTIALS: path.join(root, "fake-hook.json"),
    },
  });
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Add repository", exact: true }).waitFor();
  await expect(page.locator(".board-row")).toHaveCount(0);
  await page.evaluate(() => window.desktop.saveSetup({ worktreeLocation: "adjacent" }));
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await tabTo(page, "Add repository");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Actions for app", exact: true }).waitFor();
  // Command+T or Ctrl+Shift+T opens the repository's panel with the branch field focused.
  await boardCommand(app, "T", process.platform !== "darwin");
  const field = page.getByLabel("Branch for the new worktree");
  await expect(field).toBeFocused();
  const panel = page.getByRole("dialog", { name: "app details and commands" });
  await expect(panel.getByRole("menuitem", { name: "New worktree" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const status = panel.locator(".branch-status");
  await page.keyboard.type("--bad");
  await expect(status).toHaveText("Can't start with -");
  await page.keyboard.press("Enter");
  await expect(field).toBeEnabled();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("feature/ui");
  await expect(status).toHaveText("new, from main");
  await assertAccessible(page);
  await page.keyboard.press("Enter");
  // Creating includes real Git worktree creation, which can be slow on Windows runners.
  await expect(panel).toHaveCount(0, { timeout: deadline(15000) });
  const created = page.getByRole("button", { name: "feature/ui", exact: true });
  await expect(created).toBeFocused();
  await expect(page.locator(".worktree-row.arriving")).toHaveCount(1);
  assert.match(
    isolatedGit(["worktree", "list", "--porcelain"], { cwd: repo }).toString(),
    /\nbranch refs\/heads\/feature\/ui\n/u,
  );
  // Creating starts nothing; the new row's own panel offers the launchers.
  assert.deepEqual((await page.evaluate(() => window.desktop.workspace())).terminals, []);
  await page.keyboard.press("Enter");
  await page
    .getByRole("menuitem", { name: process.platform === "win32" ? /^Shell/u : "Claude Code" })
    .click();
  const row = page.locator(".board-row").filter({ hasText: "feature/ui" });
  await expect(row).toBeVisible({ timeout: deadline(15000) });
  const launched = await page.evaluate(() => window.desktop.workspace());
  const terminal = launched.terminals[0];
  assert.ok(terminal);
  if (process.platform !== "win32") {
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 5), terminal.id))
      .toContain("FOOM_AGENT_READY");
  }
  const remaining = await page.evaluate(
    (repository) =>
      window.desktop.startWorktree({
        repository,
        branch: "feature/remaining",
        run: "shell",
      }),
    terminal.repository,
  );
  await row.click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".tile-terminal")).toBeVisible();
  await stopSession(page, terminal.id);
  const dirty = path.join(terminal.worktree, "unsaved.txt");
  await writeFile(dirty, "preserve unless confirmed");
  await page.getByRole("button", { name: "Actions for feature/ui", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete worktree…" }).click();
  const confirmation = await confirmationPage(app);
  await expect(
    confirmation.getByRole("list", { name: "Uncommitted changes", exact: true }),
  ).toContainText("unsaved.txt");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(page.locator(".board-confirmation-scrim")).toBeVisible();
  for (const colorMode of ["light", "dark"]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), colorMode);
    await expect
      .poll(() => confirmation.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(colorMode);
    await mkdir("test-results", { recursive: true });
    await confirmation.screenshot({
      path: evidencePath(`confirmation-dirty-${colorMode}.png`),
      animations: "disabled",
    });
    await page.screenshot({
      path: evidencePath(`confirmation-dirty-board-${colorMode}.png`),
      animations: "disabled",
    });
    captureConfirmationDesktop(`dirty-${colorMode}`);
  }
  await confirmation.keyboard.press("Enter");
  await expect(page.locator(".board-confirmation-scrim")).toHaveCount(0);
  await expect(confirmation.getByRole("alertdialog")).toHaveCount(0);
  assert.equal(await readFile(dirty, "utf8"), "preserve unless confirmed");
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Actions for feature/ui", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete worktree…" }).click();
  await confirmation.getByRole("button", { name: "Discard 1 change and remove" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".board-confirmation-scrim")).toHaveCount(0);
  await assert.rejects(readFile(dirty), { code: "ENOENT" });
  await page.locator(".board-row").filter({ hasText: "feature/remaining" }).click();
  await expect(page.locator(".tile-terminal")).toBeVisible();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("echo FOOM_REMAINING_TERMINAL");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 10), remaining))
    .toContain("FOOM_REMAINING_TERMINAL");

  assert.equal(
    isolatedGit(["branch", "--list", "feature/ui"], { cwd: repo }).toString().trim(),
    "feature/ui",
  );
});

test("sidebar refuses deletion of a running shell and enables it after exit, preserving branches and the main checkout", {
  timeout: deadline(45000),
}, async (context) => {
  // Match main’s canonical paths on macOS temp aliases and Windows short paths.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-external-removal-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const external = path.join(root, "external");
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
  isolatedGit(["worktree", "add", "-b", "external", external], { cwd: repo });
  const dirty = path.join(external, "unsaved.txt");
  await writeFile(dirty, "keep until confirmed");
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const row = page.getByRole("button", { name: "Actions for external", exact: true });
  await row.click();
  await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
  await expect(page.locator(".board-row").filter({ hasText: "external" })).toHaveCount(1);
  const shell = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
    (t) => t.worktree === external,
  );
  assert.ok(shell);
  await row.click();
  await expect(page.getByRole("menuitem", { name: "Delete worktree…" })).toBeDisabled();
  await assert.rejects(
    page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({ kind: "remove-worktree", repository, worktree }),
      { repository: repo, worktree: external },
    ),
    /foom-error:operation-failed/u,
  );
  await expect(page.locator(".board-confirmation-scrim")).toHaveCount(0);
  assert.equal(await readFile(dirty, "utf8"), "keep until confirmed");
  await page.keyboard.press("Escape");
  await page.locator(".board-row").filter({ hasText: "external" }).click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.evaluate((id) => window.desktop.input(id, "exit\r"), shell.id);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (t) => t.id === shell.id,
        )?.exited,
    )
    .toBe(true);
  await row.click();
  await expect(page.getByRole("menuitem", { name: "Delete worktree…" })).toBeEnabled();
  await page.getByRole("menuitem", { name: "Delete worktree…" }).click();
  const confirmation = await confirmationPage(app);
  await expect(
    confirmation.getByRole("list", { name: "Uncommitted changes", exact: true }),
  ).toContainText("unsaved.txt");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.keyboard.press("Enter");
  await expect(confirmation.getByRole("alertdialog")).toHaveCount(0);
  assert.equal(await readFile(dirty, "utf8"), "keep until confirmed");
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole("menuitem", { name: "Delete worktree…" }).click();
  await confirmation.getByRole("button", { name: "Discard 1 change and remove" }).click();
  await expect(row).toHaveCount(0);
  await assert.rejects(readFile(dirty), { code: "ENOENT" });
  assert.equal(
    isolatedGit(["branch", "--list", "external"], { cwd: repo }).toString().trim(),
    "external",
  );
  await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Delete worktree…" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
  await expect(
    page.getByRole("heading", { name: "repo › Main checkout › Shell", exact: true }),
  ).toBeVisible();
  const checkout = page.getByRole("button", { name: "Main checkout", exact: true });
  await expect(checkout.locator(".tree-checkout-branch")).toHaveText("main");
  await expect(
    page.getByRole("treeitem", { name: "Main checkout", exact: true }).locator(".board-row"),
  ).toHaveCount(1);
  if (process.env.FOOM_SCREENSHOTS) {
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: evidencePath(`foom-main-checkout-${colorScheme}.png`) });
    }
  }
});

test("external worktrees support independent shells and confirmed shared agents", {
  timeout: deadline(60000),
}, async (context) => {
  // macOS temp aliases and Windows short/case-normalized paths differ from Git's inventory.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-external-launch-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await mkdir(path.join(root, "home"));
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const external = path.join(root, "external");
  const detached = path.join(root, "detached");
  const agentTree = path.join(root, "agent");
  git("worktree", "add", "-b", "external", external);
  git("worktree", "add", "--detach", detached);
  git("worktree", "add", "-b", "agent", agentTree);
  if (process.platform !== "win32") {
    await writeFile(
      path.join(bin, "claude"),
      FAKE_CLAUDE.replace(
        "const settings =",
        'process.stdout.write("CWD:" + process.cwd() + "\\r\\n");\nconst settings =',
      ),
      { mode: 0o755 },
    );
  }
  if (process.platform !== "win32") {
    await writeFile(
      path.join(bin, "codex"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.1.0"); process.exit(0); }
if (args[0] === "--help") { console.log("-c, --config <key=value> --sandbox <mode> read-only"); process.exit(0); }
console.log("REVIEW_ARGS:" + JSON.stringify(args));
console.log("Listening on http://localhost:3000");
process.stdin.setRawMode(true);
process.stdin.resume();
`,
      { mode: 0o755 },
    );
  }
  const app = await launchApp(context, {
    fixture: "agent",
    env: {
      HOME: path.join(root, "home"),
      PATH: bin,
      TEST_FAKE_CREDENTIALS: path.join(root, "fake-hook.json"),
    },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  for (const [name, directory] of [
    ["external", external],
    [
      `⏣ ${isolatedGit(["rev-parse", "--short=7", "HEAD"], { cwd: detached }).toString().trim()}`,
      detached,
    ],
  ]) {
    await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
    await expect(page.locator(".board-row").filter({ hasText: name })).toBeVisible();
    const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (t) => t.worktree === directory,
    );
    assert.ok(terminal);
    const command =
      process.platform === "win32"
        ? "[Console]::WriteLine(('CWD:' + (Get-Location).Path))"
        : "printf 'CWD:%s\\n' \"$PWD\"";
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "\r"), {
      id: terminal.id,
      command,
    });
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 20)).join(""), terminal.id),
      )
      .toContain(`CWD:${directory}`);
  }
  const sharedSessions = () =>
    page.evaluate(
      async (worktree) =>
        (await window.desktop.workspace()).terminals.filter((t) => t.worktree === worktree),
      agentTree,
    );
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
    await expect.poll(async () => (await sharedSessions()).length).toBe(i + 1);
    // Inventory arrives before the launch command finishes revealing the row and
    // focusing its terminal. Revealing clears any open menu, so wait for focus
    // before opening the next one.
    await expect(
      page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea'),
    ).toBeFocused();
  }
  if (process.platform !== "win32") {
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
    await expect(page.locator(".board-row").filter({ hasText: "agent" })).toHaveCount(3);
    const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (t) => t.worktree === agentTree && t.kind === "agent",
    );
    assert.ok(terminal);
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 20)).join(""), terminal.id),
      )
      .toContain(`CWD:${agentTree}`);
    // Output can precede launch's reveal, which closes any open action menu.
    await expect(
      page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea'),
    ).toBeFocused();
    const armSharedAgent = async () => {
      // DOM terminal focus does not establish native activation on macOS.
      await app.evaluate(({ app, BrowserWindow }) => {
        const board = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        app.focus({ steal: true });
        board.focus();
        board.webContents.focus();
      });
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const board = BrowserWindow.getAllWindows().find(
              (window) => window.webContents.getURL() === "app://bundle/index.html",
            );
            return board.isVisible() && board.isFocused() && board.webContents.isFocused();
          }),
        )
        .toBe(true);
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
      // A pointer leave cancels even while main is still preparing the launch,
      // before an arm exists. CI recorded click + pointerleave with no arm:
      // native activation succeeded, but cancellation invalidated that request.
      // Keep the pointer outside the moving panel and activate its focused item.
      await page.getByRole("button", { name: "Add repository", exact: true }).hover();
      await page.getByRole("button", { name: "Actions for agent", exact: true }).press("Enter");
      const panel = page.getByRole("dialog", { name: "agent details and commands" });
      await expect(panel).toHaveAttribute("data-pinned", "true");
      const item = panel.getByRole("menuitem", { name: "Claude Code", exact: true });
      await item.focus();
      await expect(item).toBeFocused();
      await item.evaluate((element) => {
        window.sharedAgentTrace = [];
        for (const type of ["click", "blur", "pointerleave"])
          element.addEventListener(type, () => window.sharedAgentTrace.push(type));
        window.sharedAgentUnsubscribe = window.desktop.confirmations.subscribe((arm) => {
          window.sharedAgentTrace.push(arm ? `arm:${arm.label}` : "cancel");
        });
      });
      try {
        await item.press("Enter");
        assert.ok(
          await page.evaluate(() => window.sharedAgentTrace.includes("click")),
          "Shared-agent activation must reach the focused menu item",
        );
        await expect
          .poll(() =>
            page.evaluate(() =>
              window.sharedAgentTrace.includes("arm:Click again for multiple agents here"),
            ),
          )
          .toBe(true);
        const armed = panel.getByRole("menuitem", {
          name: "Click again for multiple agents here",
        });
        await expect(armed).toBeVisible();
        await expect(armed).toHaveAttribute("data-armed", "true");
        await expect(armed).toBeFocused();
        return armed;
      } catch (error) {
        console.error("Shared-agent confirmation diagnostics:", {
          renderer: await page.evaluate(() => ({
            events: window.sharedAgentTrace,
            focused: document.hasFocus(),
            active: document.activeElement?.getAttribute("role"),
            panelPinned: document.querySelector(".sidebar-panel")?.getAttribute("data-pinned"),
          })),
          windows: await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window) => ({
              url: window.webContents.getURL(),
              focused: window.isFocused(),
              contentsFocused: window.webContents.isFocused(),
            })),
          ),
          agents: (await sharedSessions()).filter((session) => session.kind === "agent").length,
        });
        throw error;
      } finally {
        await page.evaluate(() => window.sharedAgentUnsubscribe());
      }
    };
    await armSharedAgent();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "agent details and commands" })).toHaveCount(0);
    assert.equal((await sharedSessions()).length, 3, "Cancel must not create an agent");
    const sharedArm = await armSharedAgent();
    // Measure the minimum interval from main's arm, not from the async launch request.
    await page.waitForTimeout(310);
    await sharedArm.press("Enter");
    await expect
      .poll(async () => (await sharedSessions()).filter((t) => t.kind === "agent").length)
      .toBe(2);
    await expect(
      page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea'),
    ).toBeFocused();
  }
  const shell = (await sharedSessions()).find((t) => t.kind === "shell");
  assert.ok(shell);
  await page.evaluate(() => {
    window.confirmationArm = null;
    window.desktop.confirmations.subscribe((arm) => {
      window.confirmationArm = arm;
    });
  });
  const stop = page.evaluate((id) => window.desktop.sidebarCommand({ kind: "stop", id }), shell.id);
  await page.waitForFunction(() => window.confirmationArm !== null);
  await page.waitForTimeout(310);
  await page.evaluate(() => window.desktop.confirmations.confirm(window.confirmationArm));
  await stop;
  await expect
    .poll(async () => (await sharedSessions()).find((t) => t.id === shell.id)?.exited)
    .toBe(true);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "restart", id }), shell.id);
  assert.equal((await sharedSessions()).filter((t) => t.kind === "shell").length, 2);
  assert.ok((await sharedSessions()).every((t) => t.id !== shell.id));
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  assert.ok(
    inventory.repositories[0].worktrees.every((tree) => !tree.managed),
    "Launching must not adopt external checkouts",
  );
  for (const session of await sharedSessions()) {
    if (!session.exited) await stopSession(page, session.id);
  }
  const removal = page.evaluate(
    ({ repository, worktree }) =>
      window.desktop.sidebarCommand({ kind: "remove-worktree", repository, worktree }),
    { repository: repo, worktree: agentTree },
  );
  await page.waitForFunction(() => window.confirmationArm !== null);
  await page.waitForTimeout(310);
  await page.evaluate(() => window.desktop.confirmations.confirm(window.confirmationArm));
  await removal;
  assert.deepEqual(await sharedSessions(), []);
  await assert.rejects(realpath(agentTree), { code: "ENOENT" });
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 2);
});

test("click-again repository removal rejects double clicks, cancels, expires and confirms", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const repo = path.join(profile, "remove-fixture");
  await mkdir(repo);
  isolatedGit(["init", "-q", repo]);
  const keptFile = path.join(repo, "keep.txt");
  await writeFile(keptFile, "repository contents");
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const actions = page.getByRole("button", { name: "Actions for remove-fixture", exact: true });
  await actions.click();
  await page.getByRole("menuitem", { name: /Remove from Foom…/ }).dblclick();
  const armed = page.getByRole("menuitem", { name: "Click again to remove" });
  await expect(armed).toBeVisible();
  assert.equal((await page.evaluate(() => window.desktop.workspace())).repositories.length, 1);
  await page.keyboard.press("Escape");
  await actions.click();
  await page.getByRole("menuitem", { name: /Remove from Foom…/ }).click();
  await expect(armed).toBeVisible();
  // The expiration interval itself is under test.
  await page.waitForTimeout(3050);
  await expect(page.getByRole("menuitem", { name: /Remove from Foom…/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /Remove from Foom…/ }).click();
  await expect(armed).toBeVisible();
  await page.waitForTimeout(310);
  await armed.click();
  await expect(actions).toHaveCount(0);
  assert.equal(
    await readFile(keptFile, "utf8"),
    "repository contents",
    "Repository files are kept",
  );
});

test("external Git changes refresh inventory and retain sessions in removed worktrees", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-inventory-watch-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const external = path.join(root, "external");
  await mkdir(repo);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "--allow-empty", "-qm", "init");
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  page.on("console", (message) => {
    if (message.type() === "error") context.diagnostic(`Inventory renderer: ${message.text()}`);
  });
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("button", { name: "Main checkout", exact: true })).toBeVisible();
  git("worktree", "add", "-b", "topic/external", external);
  const actions = page.getByRole("button", { name: "Actions for topic/external", exact: true });
  await actions.click();
  await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.workspace())).terminals.length)
    .toBe(1);
  const terminal = await page.evaluate(async () => (await window.desktop.workspace()).terminals[0]);
  // Windows locks the process cwd, which is separate from PowerShell's location.
  // Move and verify both before removing the worktree, retaining the live session
  // and its original launch location so every platform exercises the same behavior.
  const quoted = `'${repo.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const input =
    process.platform === "win32"
      ? `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${quoted}; [System.IO.Directory]::SetCurrentDirectory((Get-Location).ProviderPath); if ([System.IO.Directory]::GetCurrentDirectory() -eq ${quoted}) { Write-Output ('moved-' + 'ready') } else { throw 'Process cwd did not move' }\r`
      : `cd ${quoted} && printf 'moved-%s\\n' ready\r`;
  await page.evaluate(({ id, input }) => window.desktop.input(id, input), {
    id: terminal.id,
    input,
  });
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), terminal.id))
    .toContain("moved-ready");
  git("worktree", "remove", external);
  const session = page.locator(".board-row").filter({ hasText: "Worktree removed" });
  try {
    await expect(session).toHaveCount(1);
  } catch (error) {
    console.error(
      "Inventory after external removal",
      JSON.stringify(
        await page.evaluate(async () => ({
          workspace: await window.desktop.workspace(),
          inventory: await window.desktop.sidebarInventory(),
        })),
      ),
    );
    console.error("Board after external removal", await page.locator("body").innerText());
    throw error;
  }
  await expect(actions).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals[0].exited, false);
  await page.getByRole("button", { name: "topic/external", exact: true }).click();
  await expect(page.locator(".location-launchers")).toHaveCount(0);
  await assert.rejects(
    page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "shell" }),
      { repository: repo, worktree: external },
    ),
    /foom-error:operation-failed/,
  );
  git("checkout", "-b", "topic/renamed");
  await expect(page.locator(".tree-checkout-branch")).toHaveText("topic/renamed");
  // Focus is an independent backstop, including after the watcher has failed.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .emit("focus");
  });
  await page.evaluate((id) => window.desktop.input(id, "exit\r"), terminal.id);
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.workspace())).terminals[0].exited)
    .toBe(true);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "close", id }), terminal.id);
  await expect(session).toHaveCount(0);
  await expect(page.getByRole("button", { name: "topic/external", exact: true })).toHaveCount(0);
});

test("prunable removal offers a coded modal; Enter is inert, Escape restores focus, and Prune keeps the branch", async (context) => {
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
  const tree = await page.evaluate(async () => {
    const { repositories } = await window.desktop.workspace();
    return window.desktop.createWorktree(repositories[0].path, "error-prune-test", "root");
  });
  const { rm } = require("node:fs/promises");
  // Hold inventory notifications to exercise a stale row deterministically.
  // The separate broken-row test covers normal refresh and direct Clean up.
  await app.evaluate(({ BrowserWindow }) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    if (!board) throw new Error("Missing board");
    const contents = board.webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
      if (channel !== "workspace:changed") send(channel, ...args);
    };
    globalThis.restorePruneInventory = () => {
      contents.send = send;
    };
  });
  // The reload completes its initial inventory while the checkout is still valid.
  await page.reload();
  await boardPage(app);
  await page.getByRole("button", { name: "Actions for error-prune-test", exact: true }).click();
  await rm(path.join(tree.path, ".git"));
  await page.getByRole("menuitem", { name: "Delete worktree…" }).click();
  const modal = page.getByRole("dialog", { name: "Action failed" });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("alert")).toHaveText("This worktree needs pruning.");
  await expect(modal).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Prune" })).not.toBeFocused();
  await assertAccessible(page);
  await page.screenshot({ path: evidencePath("error-modal.png") });
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole("button", { name: "error-prune-test", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Actions for error-prune-test", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete worktree…" }).click();
  await modal.getByRole("button", { name: "Prune" }).click();
  await expect(modal).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Actions for error-prune-test", exact: true }),
  ).toHaveCount(0);
  const branches = await page.evaluate(async () => {
    const { repositories } = await window.desktop.workspace();
    return window.desktop.branches(repositories[0].path);
  });
  assert.ok(branches.local.some((branch) => branch.name === "error-prune-test"));
  await assert.rejects(readFile(path.join(tree.path, ".git")), { code: "ENOENT" });
  await app.evaluate(() => {
    globalThis.restorePruneInventory();
    delete globalThis.restorePruneInventory;
  });
});

test("broken checkout shows Clean up directly and refuses uninspectable leftover content", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  let page = await boardPage(app);
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
  const tree = await page.evaluate(
    async (repository) => window.desktop.createWorktree(repository, "broken-leftovers", "root"),
    repository,
  );
  const { rm } = require("node:fs/promises");
  await mkdir(path.join(tree.path, "node_modules"));
  await writeFile(path.join(tree.path, "node_modules", "leftover"), "fixture content");
  const remote = path.join(path.dirname(repository), "broken-remote.git");
  isolatedGit(["clone", "--bare", repository, remote], { cwd: repository });
  isolatedGit(["remote", "add", "origin", remote], { cwd: repository });
  isolatedGit(["fetch", "origin"], { cwd: repository });
  await rm(path.join(tree.path, ".git"));
  await page.reload();
  page = await boardPage(app);
  await page.getByRole("button", { name: "Actions for broken-leftovers", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "broken-leftovers details and commands" });
  await expect(panel.getByRole("menuitem")).toHaveCount(1);
  await expect(panel.getByRole("menuitem", { name: "Clean up", exact: true })).toBeVisible();
  await expect(panel.getByText("Broken checkout", { exact: true })).toBeVisible();
  for (let refresh = 0; refresh < 2; refresh++) {
    const facts = await page.evaluate(
      async ({ repository, worktree }) => window.desktop.panelFacts(repository, worktree),
      { repository, worktree: tree.path },
    );
    assert.equal(facts.changes, null);
  }
  await mkdir(evidencePath("screenshots-729"), { recursive: true });
  for (const colorMode of ["light", "dark"]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), colorMode);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(colorMode);
    await page.screenshot({
      path: evidencePath(`screenshots-729/broken-${colorMode}.png`),
      animations: "disabled",
    });
  }
  await assertAccessible(page);
  await panel.getByRole("menuitem", { name: "Clean up", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Action failed" })).toBeVisible();
  assert.equal(
    await readFile(path.join(tree.path, "node_modules", "leftover"), "utf8"),
    "fixture content",
  );
  await page.keyboard.press("Escape");
  await rm(path.join(tree.path, "node_modules"), { recursive: true });
  await page.getByRole("button", { name: "Actions for broken-leftovers", exact: true }).click();
  await page.getByRole("menuitem", { name: "Clean up", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Actions for broken-leftovers", exact: true }),
  ).toHaveCount(0);
  await assert.rejects(readFile(path.join(tree.path, "node_modules", "leftover")), {
    code: "ENOENT",
  });
  const branches = await page.evaluate(
    async (repository) => window.desktop.branches(repository),
    repository,
  );
  assert.ok(branches.local.some((branch) => branch.name === "broken-leftovers"));
});
