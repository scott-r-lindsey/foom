const { gitSync: isolatedGit } = require("../helpers/git.js");
const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_CLAUDE,
  assertAccessible,
  assertConfirmationFocus,
  boardCommand,
  boardPage,
  captureConfirmationDesktop,
  confirmationPage,
  fixtureCleanup,
  installSoundSink,
  launchApp,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
  restartShellFromSidebar,
  stopSession,
  tabTo,
} = require("./harness.js");

test("board starts with live terminals only and focuses rows without opening", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell", shell: "hidden" });
  const page = await boardPage(app);
  const row = page.locator(".board-row");
  await expect(row).toHaveCount(1);
  await expect(row).toBeFocused();
  await expect(page.locator(".tile-terminal")).toBeHidden();
  await page.getByLabel("Filter repositories and sessions").click();
  await row.focus();
  await expect(page.getByRole("complementary", { name: "Terminal peek" })).toHaveCount(0);
  await expect(row).toBeFocused();
  await expect(page.locator(".tile-terminal")).toBeHidden();
  await page.keyboard.press("Escape");
  await assertAccessible(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await restartShellFromSidebar(page);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await boardCommand(app, "B");
  await expect(row).toBeFocused();
});

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
      path: `test-results/confirmation-dirty-${colorMode}.png`,
      animations: "disabled",
    });
    await page.screenshot({
      path: `test-results/confirmation-dirty-board-${colorMode}.png`,
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
      await page.screenshot({ path: path.join(tmpdir(), `foom-main-checkout-${colorScheme}.png`) });
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

test("persistent sidebar keeps Escape in the PTY and routes keyboard navigation", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-input-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "keys");
  await writeFile(marker, "");
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.locator(".xterm-helper-textarea").focus();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  // Establish the startup verdict first, including on faster runners.
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  await page.keyboard.press("Escape");
  await expect.poll(() => readFile(marker, "utf8")).toContain("1b\n");
  for (const [key, hex] of [
    ["c", "03"],
    ["w", "17"],
    ["d", "04"],
    ["q", "11"],
  ]) {
    await page.keyboard.press(`Control+${key}`);
    await expect.poll(() => readFile(marker, "utf8")).toContain(hex);
  }
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+n");
  await expect.poll(() => readFile(marker, "utf8")).toContain("02");
  await expect.poll(() => readFile(marker, "utf8")).toContain("0e");
  await expect(page.locator(".tile-terminal")).toBeVisible();
  await boardCommand(app, "B");
  await expect(page.locator(".board-row")).toBeFocused();
  await expect(page.locator(".board-peek")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const screen = page.locator(".xterm-screen");
  await screen.hover();
  // Earlier keystrokes can clear the initial prompt before slow runners reach here.
  // Ask the probe for fresh evidence rather than relying on its startup debounce.
  await page.keyboard.type("p");
  await expect
    .poll(() => page.locator(".board-row").getAttribute("data-state"))
    .toBe("needs_input");
  const verdictLog = path.join(
    await app.evaluate(({ app }) => app.getPath("userData")),
    "verdicts.jsonl",
  );
  const feedbackBefore = (await readFile(verdictLog, "utf8"))
    .split("\n")
    .filter((line) => line.includes('"action"'));
  await page.mouse.wheel(0, 56);
  await expect.poll(() => readFile(marker, "utf8")).toContain("1b5b42");
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  assert.deepEqual(
    (await readFile(verdictLog, "utf8")).split("\n").filter((line) => line.includes('"action"')),
    feedbackBefore,
  );
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "shell");
  await page.keyboard.type("m");
  await expect(page.locator(".xterm-rows")).toContainText("MOUSE_READY");
  await writeFile(marker, "");
  await page.mouse.wheel(0, -56);
  await expect.poll(() => readFile(marker, "utf8")).toContain("1b5b3c");
  assert.doesNotMatch(await readFile(marker, "utf8"), /1b5b41|1b4f41/);
  await assertAccessible(page);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    // Exercise compact layouts as on a display smaller than the normal minimum.
    window.setMinimumSize(0, 0);
    window.setSize(640, 600);
  });
  await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
  await expect
    .poll(() => page.locator(".board-list").evaluate((el) => el.getBoundingClientRect().width))
    .toBe(64);
  await assertAccessible(page);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("q");
});

test("empty sidebar and terminal pane stay accessible at both widths", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  for (const width of [1000, 640]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.setMinimumSize(0, 0);
      window.setSize(width < 720 ? 960 : width, 600);
      window.webContents.setZoomFactor(width < 720 ? 1.5 : 1);
    }, width);
    await expect.poll(() => page.evaluate(() => innerWidth < 720)).toBe(width < 720);
    await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
    if (width < 720) {
      await expect(page.getByRole("button", { name: "Add repository", exact: true })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "Add repository", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New worktree", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Local shell", exact: true })).toHaveCount(0);
    await expect(page.locator('.terminal-tile[data-empty="true"]')).toBeVisible();
    await assertAccessible(page);
    if (width < 720) await page.keyboard.press("Escape");
  }
  await page.screenshot({ path: path.join(tmpdir(), "foom-132-empty-sidebar.png") });
});

test("sidebar menus escape the scroll area, stay in the window and launch from a worktree", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-sidebar-"));
  removeAfterApps(context, root);
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
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await app.evaluate(({ dialog, BrowserWindow }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1000, 700);
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "repo", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const repository = (await window.desktop.workspace()).repositories[0];
    if (!repository) throw new Error("Missing registered repository");
    for (let i = 0; i < 18; i++)
      await window.desktop.createWorktree(
        repository.path,
        `feature/row-${String(i).padStart(2, "0")}`,
        "adjacent",
      );
  });
  // A reload also verifies the registered repository and its empty worktrees survive.
  await page.reload();
  const bottom = page.getByRole("button", { name: "Actions for feature/row-17", exact: true });
  await bottom.scrollIntoViewIfNeeded();
  await bottom.click();
  const menu = page.getByRole("dialog", { name: /details and commands/ });
  await expect(menu).toBeVisible();
  // Visibility begins during the opening transform; measure the settled menu.
  await menu.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
  const box = await menu.boundingBox();
  const anchor = await bottom.boundingBox();
  assert.ok(box && anchor);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box.x >= anchor.x + anchor.width, "menu opens to the right over the pane");
  assert.ok(
    box.y >= 0 && box.y + box.height <= viewport.height && box.x + box.width <= viewport.width,
    JSON.stringify({ box, anchor, viewport }),
  );
  assert.equal(await menu.evaluate((element) => element.closest(".board-list")), null);
  await assertAccessible(page);
  const launchItem = page.getByRole("menuitem", { name: /^Shell \(/ });
  const badge = launchItem.locator(".board-agent");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await launchItem.hover();
    await expect(badge).toHaveCSS(
      "background-color",
      colorScheme === "light" ? "rgb(59, 26, 153)" : "rgb(122, 60, 255)",
    );
    await expect(badge).toHaveCSS("transition-duration", "0s");
    await expect
      .poll(() => launchItem.evaluate((element) => getComputedStyle(element, "::before").transform))
      .toBe("matrix(1, 0, 0, 1, 0, 0)");
    if (process.env.FOOM_SCREENSHOTS)
      await page.screenshot({ path: path.join(tmpdir(), `foom-sidebar-${colorScheme}.png`) });
  }
  await assertAccessible(page);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
  await launchItem.evaluate((element) => element.blur());
  await page.mouse.move(0, 0);
  await expect
    .poll(() => launchItem.evaluate((element) => getComputedStyle(element, "::before").transform))
    .toBe("matrix(1, 0, 0, 0, 0, 0)");
  await expect
    .poll(() =>
      launchItem.evaluate((element) => getComputedStyle(element, "::before").transitionDuration),
    )
    .toBe("0.16s");
  await launchItem.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "Preview file…", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("menuitem", { name: "Resume conversation…", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(launchItem).toBeFocused();
  await expect(badge).toHaveCSS("background-color", "rgb(122, 60, 255)");
  await expect
    .poll(() => launchItem.evaluate((element) => getComputedStyle(element, "::before").transform))
    .toBe("matrix(1, 0, 0, 1, 0, 0)");

  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Delete worktree…" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "Preview file…", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("menuitem", { name: "Resume conversation…", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: /^Shell \(/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("button", { name: "feature/row-17", exact: true })).toBeFocused();
  await bottom.click();
  await page.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(page.locator(".board-row").filter({ hasText: "feature/row-17" })).toBeVisible();
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.equal(snapshot.terminals[0].branch, "feature/row-17");
  for (const name of ["repo", "Main checkout", "feature/row-17"]) {
    const label = page.getByRole("button", { name, exact: true });
    const panel = page.getByRole("dialog", { name: `${name} details and commands` });
    // Scrolling the sidebar closes panels, so settle the scroll before opening one.
    await label.scrollIntoViewIfNeeded();
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await label.click();
    await expect(panel).toBeVisible();
    await label.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".tile-terminal")).toBeVisible();
    await expect(page.locator(".terminal-tile")).not.toHaveAttribute("inert");
    await expect(page.locator(".location-launchers")).toHaveCount(0);
  }
  const launchedRow = page.locator(".board-row");
  const filter = page.getByLabel("Filter repositories and sessions");
  await filter.fill("row");
  const label = page
    .getByRole("button", { name: "feature/row-17", exact: true })
    .locator(".tree-label");
  await expect(label).toHaveText("feature/row-17");
  await expect(label.locator("mark")).toHaveText("row");
  // Highlight fragments flow as text within one label, without flex gaps.
  await expect(label).toHaveCSS("display", "block");
  await filter.fill("");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await launchedRow.focus();
    const accent = colorScheme === "light" ? "rgb(91, 43, 217)" : "rgb(155, 107, 255)";
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await expect(launchedRow).toHaveCSS("outline-color", accent);
    await expect(launchedRow).toHaveCSS("outline-style", "solid");
    await expect(page.getByRole("complementary", { name: "Terminal peek" })).toHaveCount(0);
    await assertAccessible(page);
    await launchedRow.press("Enter");
    await page.mouse.move(0, 0);
    await page.getByRole("region", { name: "Terminal pane" }).focus();
    await expect(launchedRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator('.board-entry[data-selected="true"]')).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    const rowBox = await launchedRow.boundingBox();
    const headerBox = await page.locator(".sidebar-shell .board-top").boundingBox();
    assert.ok(rowBox && rowBox.height <= 50, "shell session keeps a compact readable line");
    assert.ok(headerBox && headerBox.height <= 100, "header preserves tree space");
    await expect(launchedRow.locator(".board-reason")).toHaveCount(0);
    if (process.env.FOOM_SCREENSHOTS)
      await page.screenshot({
        path: path.join(tmpdir(), `foom-review-session-${colorScheme}.png`),
      });
  }

  await bottom.click();
  await page.locator(".board-list").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  await page.getByRole("button", { name: "Collapse repo", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand repo", exact: true })).toBeVisible();
  await expect(page.getByLabel("Pinned")).toBeVisible();
  await page.getByRole("button", { name: "Expand repo", exact: true }).click();
  const session = page.locator(".board-row");
  await session.locator(".session-name").dblclick();
  await assertAccessible(page);
  await page.getByRole("textbox", { name: "Session name", exact: true }).fill("Build helper");
  await page.getByRole("textbox", { name: "Session name", exact: true }).press("Enter");
  await page.reload();
  await page.getByLabel("Filter repositories and sessions").fill("build helper");
  await expect(page.locator(".board-row")).toContainText("Build helper");
  await assertAccessible(page);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    // Use interface scaling: macOS can retain the native minimum window width.
    window.setSize(960, 700);
    window.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(720);
  await expect(page.getByRole("button", { name: "Actions for repo", exact: true })).toHaveCount(0);
  await expect(page.locator(".board-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Actions for Build helper in feature/row-17" }).focus();
  const compactAction = await page
    .getByRole("button", { name: "Actions for Build helper in feature/row-17" })
    .boundingBox();
  const compactLight = await page.locator(".board-row .board-light").boundingBox();
  assert.ok(
    compactAction && compactLight && compactAction.x >= compactLight.x + compactLight.width + 4,
    "compact action clears the light and its attention halo",
  );
  if (process.env.FOOM_SCREENSHOTS)
    await page.screenshot({ path: path.join(tmpdir(), "foom-review-compact.png") });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Stop shell" })).toBeFocused();
  await page.keyboard.press("Escape");
  await assertAccessible(page);
});

test("tiles build irregular layouts, preserve views and replace explicitly for attention", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-tiles-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  isolatedGit(["init", "-q", repo]);
  const app = await launchApp(context, {
    fixture: "empty-board",
    env: { HOME: path.join(root, "home") },
  });
  const page = await boardPage(app);
  await installSoundSink(page);
  await app.evaluate(({ dialog, BrowserWindow }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1500, 900);
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).repositories.map(
        (entry) => entry.path,
      ),
    )
    .toContain(repo);
  await page.evaluate(async (repo) => {
    for (let i = 0; i < 4; i++)
      await window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "shell",
      });
  }, repo);
  const rows = page.locator(".board-row");
  await expect(rows).toHaveCount(4);
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  await rows.nth(0).click();
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  await page.evaluate(() => {
    window.tileElements = [document.querySelector(".terminal-tile")];
    window.attachments = [];
    window.desktop.onData((id, token) => {
      if (!window.attachments.some((item) => item.id === id && item.token === token))
        window.attachments.push({ id, token });
    });
  });
  await page.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Split right", exact: true })).toBeFocused();
  await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
  await expect(page.locator('[data-empty="true"]')).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  await rows.nth(1).click();
  await page.getByRole("button", { name: "Tile 2 menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split down", exact: true }).click();
  await rows.nth(2).click();
  const tiles = page.locator(".terminal-tile");
  await expect(tiles).toHaveCount(3);
  await expect(page.locator(".xterm-helper-textarea").nth(2)).toBeFocused();
  assert.equal(
    await page.evaluate(() => window.tileElements[0] === document.querySelector(".terminal-tile")),
    true,
  );
  await page.evaluate(() => {
    window.soundTones = [];
  });
  const gutter = page.getByRole("separator", { name: "Resize tiles" }).first();
  const box = await gutter.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + box.height / 4, { steps: 8 });
  await page.mouse.up();
  await expect(gutter).not.toHaveAttribute("aria-valuenow", "50");
  await boardCommand(app, "1", false);
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  await page.evaluate(() => {
    window.tileElements = [...document.querySelectorAll(".terminal-tile")];
    window.xterms = [...document.querySelectorAll(".xterm")];
  });
  for (const session of sessions.slice(0, 3))
    await page.evaluate((id) => window.desktop.input(id, "echo VIEW_TOKEN_READY\r"), session.id);
  await expect.poll(() => page.evaluate(() => window.attachments.length)).toBe(3);
  const attachments = await page.evaluate(() => window.attachments);
  await boardCommand(app, "Enter");
  await expect(tiles.first()).toHaveAttribute("data-maximized", "true");
  await expect(tiles.nth(1)).toHaveAttribute("inert", "");
  await boardCommand(app, "Enter");
  await expect(tiles.first()).toHaveAttribute("data-maximized", "false");
  assert.equal(
    await page.evaluate(() =>
      window.xterms.every((element, i) => element === document.querySelectorAll(".xterm")[i]),
    ),
    true,
  );
  for (const session of sessions.slice(0, 3))
    await page.evaluate((id) => window.desktop.input(id, "echo VIEW_TOKEN_STABLE\r"), session.id);
  await expect(page.locator(".xterm-rows").first()).toContainText("VIEW_TOKEN_STABLE");
  assert.deepEqual(await page.evaluate(() => window.attachments), attachments);
  await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
    id: sessions[3].id,
    command:
      process.platform === "win32"
        ? "Read-Host 'Continue? (y/n)'\r"
        : "printf 'Continue? (y/n)'; read answer\r",
  });
  await expect(rows.nth(3)).toHaveAttribute("data-state", "needs_input");
  await boardCommand(app, "N");
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)).tree.first
          .content.session,
    ),
    sessions[3].id,
  );
  await page.getByRole("button", { name: "Hide", exact: true }).first().click();
  await rows.nth(0).click();
  await page.evaluate(() => window.desktop.appMenu.execute("split-down"));
  await expect(tiles).toHaveCount(4);
  assert.equal(
    await page.evaluate(() =>
      window.tileElements.slice(1).every((element) => document.body.contains(element)),
    ),
    true,
  );
  await assertAccessible(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(tiles.first()).toHaveCSS("transition-duration", "0s");
  await page.screenshot({ path: path.join(tmpdir(), "foom-132-tiles.png") });
  await page.getByRole("button", { name: "Hide", exact: true }).first().click();
  assert.equal(
    (await page.evaluate(() => window.desktop.workspace())).terminals.filter((t) => !t.exited)
      .length,
    4,
  );
  const persisted = await page.evaluate(() =>
    localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`),
  );
  await page.reload();
  await expect(tiles).toHaveCount(4);
  assert.equal(
    await page.evaluate(() => localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)),
    persisted,
  );
});

test("launching into a narrow full tile uses the focused fallback and empty tiles support mouse controls", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const original = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
  // The first window can still be animating on a cold CI display. Keyboard
  // activation exercises the menu without depending on pointer hit-test stability.
  await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).press("Enter");
  await page.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(page.locator(".board-row")).toHaveCount(2);
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  const created = sessions.find((session) => session.id !== original.id);
  assert.ok(created);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)).tree
            .content.session,
      ),
    )
    .toBe(created.id);
  await expect(page.locator('.board-row[data-refused="true"]')).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  assert.equal(sessions.find((session) => session.id === original.id).exited, false);

  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(page.locator(".terminal-tile")).toHaveCount(2);
  await page.evaluate(() => window.desktop.appMenu.execute("split-down"));
  await expect(page.locator(".terminal-tile")).toHaveCount(3);
  const empty = page.locator('.terminal-tile[data-empty="true"]').last();
  await expect(empty).toHaveAttribute("aria-hidden", "true");
  await expect(empty.locator(".tile-title")).toHaveCount(0);
  await expect(empty.locator("button")).toHaveCount(0);
  await page.getByRole("separator", { name: "Resize tiles" }).first().press("End");
  await expect(page.locator(".terminal-tile")).toHaveCount(2);
  await page.getByRole("separator", { name: "Resize tiles" }).press("End");
  await expect(page.locator(".terminal-tile")).toHaveCount(1);
  await page.locator(".tile-title").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Split right", exact: true })).toBeFocused();
  await expect(page.getByRole("menuitem", { name: /Grow sideways/ })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Split right", exact: true }).press("Escape");
  await expect(page.getByRole("button", { name: "Tile 1 menu", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
  const gutter = page.getByRole("separator", { name: "Resize tiles" });
  const bounds = await page.locator(".tile-area").boundingBox();
  const handle = await gutter.boundingBox();
  assert.ok(bounds && handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.96, handle.y + handle.height / 2, { steps: 8 });
  await expect(empty).toHaveAttribute("data-collapsing", "true");
  await page.mouse.up();
  await expect(page.locator(".terminal-tile")).toHaveCount(1);
  await page.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Tile 1 menu", exact: true });
  await expect(menu).toContainText(/\d+ × \d+/);
  await assertAccessible(page);
  await page.screenshot({ path: path.join(tmpdir(), "foom-220-tile-panel.png") });
  await menu.press("Escape");
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await expect(empty.locator(".tile-title")).toHaveCount(0);
    await assertAccessible(page);
  }
  await page.screenshot({ path: path.join(tmpdir(), "foom-tile-bug-fixes.png") });
  await page.evaluate((id) => window.desktop.input(id, "exit\r"), created.id);
  // Exit reaches the renderer before main finishes its queued exit bookkeeping.
  // Close is a main-owned command, so wait for its authoritative session state.
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.desktop.workspace()).terminals.find((session) => session.id === id)?.exited,
        created.id,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).terminals.some(
        (session) => session.id === created.id,
      ),
    )
    .toBe(false);
});

test("tile leader avoids AltGr chords and cancels unmatched keys", {
  skip: process.platform === "darwin" && "macOS retains Command tile bindings",
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const leader = async (keyCode) => {
    await boardCommand(app, "Space");
    await app.evaluate(({ BrowserWindow }, keyCode) => {
      for (const type of ["keyDown", "keyUp"])
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "app://bundle/index.html")
          .webContents.sendInputEvent({ type, keyCode });
    }, keyCode);
  };
  const tiles = page.locator(".terminal-tile");
  await page.keyboard.press("Control+Alt+Shift+r");
  await expect(tiles).toHaveCount(1);
  await leader("R");
  await expect(tiles).toHaveCount(2);
  await leader("1");
  await expect(tiles.first()).toHaveAttribute("data-focused", "true");
  await leader("Escape");
  await page.keyboard.press("r");
  await expect(tiles).toHaveCount(2);
  await leader("W");
  await expect(tiles).toHaveCount(2);
  await expect(page.locator('.terminal-tile[data-empty="true"]')).toHaveCount(2);
});

test("tile terminal viewport has no native overflow bars", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  await page.getByRole("button", { name: "Dracula", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalTheme),
    )
    .toBe("dracula");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(page.locator(".terminal-tile")).toHaveCount(2);
  await page.evaluate(() => window.desktop.appMenu.execute("split-down"));
  await expect(page.locator(".terminal-tile")).toHaveCount(3);
  await expect(page.locator(".terminal-tile").first()).toHaveCSS(
    "background-color",
    "rgb(40, 42, 54)",
  );
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    const viewport = page.locator(".tile-terminal .xterm-viewport").first();
    await expect(viewport).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(viewport).toHaveCSS("overflow", "hidden");
    // The bottom strip below the last whole character row comes from the tile's
    // terminal theme, while xterm's current viewport still owns scrollback.
    await expect(page.locator(".xterm-scrollable-element").first()).toBeVisible();
  }
  await page.screenshot({ path: path.join(tmpdir(), "foom-132-bars-fixed.png") });
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

test("profile lock focuses the first app, exits duplicates and permits another profile", {
  timeout: deadline(45000),
}, async (context) => {
  const first = await launchApp(context, {
    fixture: "empty-board",
    env: {
      FOOM_SESSION: "parent-session",
      FOOM_TOKEN: "parent-token",
      FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
      CLAUDECODE: "1",
    },
  });
  const page = await boardPage(first);
  await expect(page.locator(".dev-profile")).toHaveText("Dev");
  assert.equal(
    await first.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getTitle(),
    ),
    "Foom Dev",
  );
  assert.deepEqual(
    await first.evaluate(() =>
      Object.keys(process.env).filter((key) => key.startsWith("FOOM_") || key === "CLAUDECODE"),
    ),
    [],
  );
  const profile = await first.evaluate(({ app }) => app.getPath("userData"));
  const second = await launchApp(context, { fixture: "empty-board" });
  assert.notEqual(await second.evaluate(({ app }) => app.getPath("userData")), profile);
  await first.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    globalThis.duplicateFocused = false;
    window.on("focus", () => {
      globalThis.duplicateFocused = true;
    });
    window.hide();
  });
  const { entry, env } = fixtureCleanup(context).launches.get(first);
  let child;
  let exited;
  fixtureCleanup(context).apps.push(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  child = require("node:child_process").spawn(
    require("electron"),
    [entry, `--user-data-dir=${profile}`, "--mute-audio"],
    { env, stdio: "ignore" },
  );
  exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  fixtureCleanup(context).audit.add(child.pid);
  await expect.poll(() => child.exitCode, { timeout: deadline(10000) }).toBe(0);
  assert.deepEqual(await exited, { code: 0, signal: null });
  await expect
    .poll(() =>
      first.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        return globalThis.duplicateFocused && window.isVisible() && window.isFocused();
      }),
    )
    .toBe(true);
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

test("application menu uses the command registry and supports native keyboard access", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  const mac = process.platform === "darwin";
  await page.evaluate(() =>
    window.desktop.saveSetup({ agents: { claude: false, codex: false, agy: false } }),
  );
  const entries = await page.evaluate(() => window.desktop.appMenu.commands());
  const developer = entries.find((entry) => entry?.id === "developer-menu");
  assert.ok(developer.items.some((entry) => entry?.id === "reload"));
  assert.ok(!entries.some((entry) => entry?.id === "reload"));
  assert.ok(!JSON.stringify(entries).includes("via-"));
  assert.equal(entries.find((entry) => entry?.id === "new-window").enabled, true);
  await page.evaluate(() => window.desktop.appMenu.execute("action-log"));
  await expect(page.getByRole("heading", { name: "Action log" })).toBeVisible();
  await page.getByRole("button", { name: "Close action log" }).click();
  // Closing Action log restores terminal focus through the view operation queue.
  // Let that restoration finish before focusing the clipboard edit target.
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  if (process.platform === "darwin") {
    const labels = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items.map((item) => item.label),
    );
    assert.deepEqual(labels, ["Foom", "File", "Edit", "View", "Window", "Help", "Developer"]);
    const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
    const focusEditTarget = async (target) => {
      // CDP can edit a DOM input without making its native window the first responder.
      // The trusted child is preloaded too; activate the board before a native role.
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
            return board.isFocused() && board.webContents.isFocused();
          }),
        )
        .toBe(true);
      await target.focus();
      await expect(target).toBeFocused();
      await page.waitForFunction(() => document.hasFocus());
    };
    await app.evaluate(({ clipboard }) => clipboard.writeText("menu clipboard sentinel"));
    await filter.fill("menu edit probe");
    await focusEditTarget(filter);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      for (const type of ["keyDown", "keyUp"])
        window.webContents.sendInputEvent({ type, keyCode: "A", modifiers: ["meta"] });
    });
    await expect
      .poll(() =>
        filter.evaluate(
          (input) => input.selectionStart === 0 && input.selectionEnd === input.value.length,
        ),
      )
      .toBe(true);
    await app.evaluate(({ Menu }) => {
      // Exercise the native Cut responder, matching the native Paste role below.
      // Synthetic renderer key events can edit the input without native clipboard evidence.
      if (Menu.getApplicationMenu().getMenuItemById("cut").role !== "cut")
        throw new Error("Missing Cut role");
      Menu.sendActionToFirstResponder("cut:");
    });
    await expect(filter).toHaveValue("");
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("menu edit probe");
    const paste = async (target) => {
      await focusEditTarget(target);
      await app.evaluate(({ Menu }) => {
        // macOS roles execute natively; MenuItem.click() intentionally skips them.
        // https://github.com/electron/electron/blob/v44.4.5/lib/browser/api/menu-item-roles.ts
        if (Menu.getApplicationMenu().getMenuItemById("paste").role !== "paste")
          throw new Error("Missing Paste role");
        Menu.sendActionToFirstResponder("paste:");
      });
    };
    await paste(filter);
    await expect(filter).toHaveValue("menu edit probe");
    await filter.fill("");
    await page.locator(".session-name").dblclick();
    await paste(page.getByRole("textbox", { name: "Session name", exact: true }));
    await expect(page.getByRole("textbox", { name: "Session name", exact: true })).toHaveValue(
      "menu edit probe",
    );
    await page.keyboard.press("Escape");
  }
  if (!mac) assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null);
  const trigger = page.getByRole("button", { name: "Foom menu" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Foom" });
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.querySelectorAll(".row-menu, .row-menu button")).flatMap((element) =>
        element.getAnimations().map((animation) => animation.finished),
      ),
    ),
  );
  await assertAccessible(page);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await page.screenshot({
      path: `test-results/application-menu-${colorScheme}.png`,
      animations: "disabled",
    });
  }
  await expect(page.getByRole("menuitem", { name: /^New window/ })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: /orchestrator/i })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Developer", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Action log", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: /^(Paste|Focus|Swap|Two by two)/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: /^Quit Foom/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("menuitem", { name: /^New window/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  const settings = page.getByRole("menuitem", { name: /^Settings…/ });
  for (const key of mac ? ["click"] : ["F10", "Alt"]) {
    if (key === "click") await trigger.click();
    else
      await app.evaluate(({ BrowserWindow }, keyCode) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        window.focus();
        for (const type of ["keyDown", "keyUp"])
          window.webContents.sendInputEvent({ type, keyCode });
      }, key);
    await expect(menu).toBeVisible();
    // New window, New worktree, Add repository, then Settings.
    for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowDown");
    await expect(settings).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(menu).toHaveCount(0);
    await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  }
  // Size steps the interface size and the menu stays open.
  const zoom = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getZoomFactor(),
    );
  await trigger.click();
  const size = page.getByRole("group", { name: /^Size/ });
  await expect(size).toContainText("100%");
  await page.getByRole("menuitem", { name: "Bigger interface" }).click();
  await expect(size).toContainText("110%");
  await expect.poll(zoom).toBeCloseTo(1.1);
  await expect(menu).toBeVisible();
  await page.getByRole("menuitem", { name: "Smaller interface" }).click();
  await expect(size).toContainText("100%");
  await expect.poll(zoom).toBeCloseTo(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // The shortcut sheet opens from its binding and from the menu, and returns focus.
  const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
  await filter.focus();
  await boardCommand(app, "/", !mac);
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: /^Tiles/ })).toBeVisible();
  await expect(sheet).toContainText(mac ? "⌘/" : "Ctrl+Shift+/");
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(filter).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitem", { name: /^Keyboard shortcuts/ }).click();
  await expect(sheet).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(sheet).toHaveCount(0);
  await expect(filter).toBeFocused();
  if (!mac)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
      ),
      false,
    );
});

test("commands removed from the wordmark menu keep their shortcuts", {
  timeout: deadline(45000),
  skip: process.platform === "darwin",
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
  await filter.fill("before");
  await filter.evaluate((input) => input.setSelectionRange(2, 5));
  await app.evaluate(({ clipboard }) => clipboard.writeText("AFTER"));
  await boardCommand(app, "V");
  await expect(filter).toHaveValue("beAFTERe");
  await filter.evaluate((input) => input.setSelectionRange(2, 7));
  await app.evaluate(({ clipboard }) => clipboard.writeText("STALE"));
  await boardCommand(app, "C");
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("AFTER");
  await filter.fill("");
  await boardCommand(app, "B");
  await expect(page.locator(".board-row")).toBeFocused();
  await boardCommand(app, "1", false);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
});

test("tile drag drops replace, split every edge, swap and move without reattachment; keyboard swaps and Escape", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-drag-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  isolatedGit(["init", "-q", repo]);
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await app.evaluate(({ dialog, BrowserWindow }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1500, 900);
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.workspace())).repositories.length)
    .toBe(1);
  await page.evaluate(async (repo) => {
    for (let i = 0; i < 3; i++)
      await window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "shell",
      });
  }, repo);
  const rows = page.locator(".board-row");
  await expect(rows).toHaveCount(3);
  await rows.nth(0).click();
  await expect(
    page.locator(".terminal-tile[data-focused='true'] .xterm-helper-textarea"),
  ).toBeFocused();
  const tiles = page.locator(".terminal-tile");
  const drag = async (source, target, x, y, cancel = false) => {
    const before = await saved();
    const from = await source.boundingBox(),
      to = await target.boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width * x, to.y + to.height * y, { steps: 12 });
    await expect(page.locator(".tile-drop-preview")).toBeVisible();
    await expect(page.locator(".tile-drop-preview")).toHaveCSS("border-top-style", "dashed");
    const theme = await page
      .locator("html")
      .evaluate((element) => getComputedStyle(element).colorScheme);
    await page.screenshot({ path: path.join(tmpdir(), `foom-133-preview-${theme}.png`) });
    await expect(page.locator('.tile-area > [role="status"]')).toContainText("Escape cancels");
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".tile-drop-preview")).toHaveCount(0);
    if (!cancel && before !== (await saved()))
      await expect(
        page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea'),
      ).toBeFocused();
  };
  const saved = () =>
    page.evaluate(() => localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`));
  const singleTile = async () => {
    let occupied = await page.locator('.terminal-tile[data-empty="false"]').count();
    while (occupied > 1) {
      await page.evaluate(async () => {
        await window.desktop.appMenu.execute("tile-2");
        await window.desktop.appMenu.execute("hide-session");
      });
      occupied--;
      await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(occupied);
    }
    await page.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
    await expect(tiles).toHaveCount(1);
  };
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Tile 1 menu" }).click();
    await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
    await page.getByRole("button", { name: "Tile 1 menu" }).click();
    await page.getByRole("menuitem", { name: "Split down", exact: true }).click();
    const landing = page.locator('.terminal-tile[data-landing="true"]');
    const other = page.locator('.terminal-tile[data-empty="true"][data-landing="false"]');
    const appearance = (element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.borderColor, style.borderStyle];
    };
    await expect(landing).toHaveCount(1);
    await expect(other).toHaveCount(1);
    assert.deepEqual(await landing.evaluate(appearance), await other.evaluate(appearance));
    await expect(landing).toHaveCSS("border-top-style", "dashed");
    await expect(page.locator(".tile-drop-preview")).toHaveCount(0);
    for (const source of [rows.nth(1), tiles.first().locator(".tile-title")]) {
      const before = await saved();
      const from = await source.boundingBox(),
        to = await landing.boundingBox();
      assert.ok(from && to);
      await page.mouse.move(from.x + 10, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      const preview = page.locator(".tile-drop-preview");
      await expect(preview).toBeVisible();
      await expect(preview).toHaveText("Place here");
      await expect(preview).toHaveCSS("border-top-style", "dashed");
      await expect(page.locator('.tile-area > [role="status"]')).toContainText(
        "Drop to place here",
      );
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(preview).toHaveCount(0);
      assert.equal(await saved(), before);
      assert.deepEqual(await landing.evaluate(appearance), await other.evaluate(appearance));
    }
    await singleTile();
  }
  const initial = await saved();
  await drag(rows.nth(1), tiles.first(), 0.5, 0.5, true);
  assert.equal(await saved(), initial);
  await drag(rows.nth(1), tiles.first(), 0.5, 0.5);
  const ids = await rows.evaluateAll((rows) => rows.map((row) => row.dataset.dragSession));
  assert.equal(JSON.parse(await saved()).tree.content.session, ids[1]);
  for (const [zone, x, y, theme] of [
    ["left", 0.1, 0.5, "light"],
    ["right", 0.9, 0.5, "dark"],
    ["up", 0.5, 0.1, "light"],
    ["down", 0.5, 0.9, "dark"],
  ]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
    await singleTile();
    await drag(rows.nth(1), tiles.first(), 0.5, 0.5);
    await drag(rows.nth(2), tiles.first(), x, y);
    await expect(tiles).toHaveCount(2);
    const tree = JSON.parse(await saved()).tree;
    assert.equal(tree.direction, zone === "left" || zone === "right" ? "horizontal" : "vertical");
    assert.equal(
      (zone === "left" || zone === "up" ? tree.first : tree.second).content.session,
      ids[2],
    );
    // Restore the other session for the next edge's source/target pair.
    await drag(rows.nth(1), tiles.first(), 0.5, 0.5);
  }
  await singleTile();
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await rows.nth(0).click();
  await expect(tiles).toHaveCount(2);
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(2);
  await expect(
    page.locator(".terminal-tile[data-focused='true'] .xterm-helper-textarea"),
  ).toBeFocused();
  await page.evaluate(() => {
    window.dragTiles = [...document.querySelectorAll(".terminal-tile")];
    window.dragXterms = [...document.querySelectorAll(".xterm")];
    window.dragTokens = new Map();
    window.desktop.onData((id, token) => window.dragTokens.set(id, token));
  });
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  const pulse = async () => {
    await page.evaluate(() => window.dragTokens.clear());
    for (const session of sessions)
      await page.evaluate((id) => window.desktop.input(id, "echo DRAG_TOKEN\r"), session.id);
    await expect.poll(() => page.evaluate(() => window.dragTokens.size)).toBe(2);
  };
  await pulse();
  const tokens = await page.evaluate(() => [...window.dragTokens].sort());
  await drag(tiles.first().locator(".tile-title"), tiles.nth(1), 0.5, 0.5);
  assert.equal(
    await page.evaluate(
      () => document.querySelectorAll(".terminal-tile")[1] === window.dragTiles[0],
    ),
    true,
  );
  for (const [x, y] of [
    [0.1, 0.5],
    [0.9, 0.5],
    [0.5, 0.1],
    [0.5, 0.9],
  ]) {
    const moving = page.locator(
      `[data-tile="${await page.evaluate(() => window.dragTiles[0].dataset.tile)}"]`,
    );
    const other = page.locator(
      `[data-tile="${await page.evaluate(() => window.dragTiles[1].dataset.tile)}"]`,
    );
    await drag(moving.locator(".tile-title"), other, x, y);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    ).webContents;
    if (process.platform !== "darwin")
      for (const type of ["keyDown", "keyUp"])
        contents.sendInputEvent({ type, keyCode: "Space", modifiers: ["control", "shift"] });
    for (const type of ["keyDown", "keyUp"])
      contents.sendInputEvent({
        type,
        keyCode: "Up",
        modifiers: process.platform === "darwin" ? ["meta", "alt"] : ["shift"],
      });
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector(".terminal-tile") === window.dragTiles[0]),
    )
    .toBe(true);
  await pulse();
  assert.deepEqual(await page.evaluate(() => [...window.dragTokens].sort()), tokens);
  assert.equal(
    await page.evaluate(() => window.dragXterms.every((node) => node.isConnected)),
    true,
  );
  await page.screenshot({ path: path.join(tmpdir(), "foom-133-tiles.png") });
});

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
  await confirmation.screenshot({ path: path.join(tmpdir(), "foom-122-confirmation.png") });
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
  const cleanupStarted = performance.now();
  await confirmation.getByRole("button", { name: "Delete 2", exact: true }).click();
  try {
    await expect(confirmation.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await expect(confirmation.locator('[data-cleanup="removed"]')).toHaveCount(2);
    assert.equal(
      (await page.evaluate((repository) => window.desktop.worktrees(repository), repository))
        .length,
      2,
    );
  } finally {
    context.diagnostic(
      `Merged cleanup: ${JSON.stringify({
        elapsedMs: performance.now() - cleanupStarted,
        checklist: await confirmation.locator(".cleanup").innerText(),
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

test("sidebar preferences sync between windows without losing independent edits", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const first = await boardPage(app);
  await expect(first.locator(".board-row")).toHaveCount(1);
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
  await expect(second.locator(".board-row")).toHaveCount(1);
  await first.getByRole("button", { name: "Actions for shell-fixture", exact: true }).click();
  await first.getByRole("menuitem", { name: "Pin to top", exact: true }).click();
  await expect(second.getByLabel("Pinned", { exact: true })).toBeVisible();
  await second.locator(".board-row .session-name").dblclick();
  await second.getByRole("textbox", { name: "Session name", exact: true }).fill("Shared helper");
  await second.getByRole("textbox", { name: "Session name", exact: true }).press("Enter");
  await expect(first.locator(".board-row")).toContainText("Shared helper");
  for (const page of [first, second]) {
    await expect(page.getByLabel("Pinned", { exact: true })).toBeVisible();
    await expect(page.locator(".board-row")).toContainText("Shared helper");
  }
  await first.getByRole("button", { name: "Collapse shell-fixture", exact: true }).click();
  await expect(
    second.getByRole("button", { name: "Expand shell-fixture", exact: true }),
  ).toBeVisible();
  await second.getByRole("button", { name: "Expand shell-fixture", exact: true }).click();
  await expect(first.locator(".board-row")).toContainText("Shared helper");
  // Tile layouts remain independent while metadata is shared.
  await first.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(first.locator(".terminal-tile")).toHaveCount(2);
  await expect(second.locator(".terminal-tile")).toHaveCount(1);
  await second.reload();
  await expect(second.getByLabel("Pinned", { exact: true })).toBeVisible();
  await expect(second.locator(".board-row")).toContainText("Shared helper");
  await second.evaluate(() => window.desktop.appMenu.execute("close-window"));
  await expect.poll(() => second.isClosed()).toBe(true);
});

test("multiple windows share sessions, keep views exclusive and retain terminals on close", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const first = await boardPage(app);
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  const original = (await first.evaluate(() => window.desktop.workspace())).terminals[0].id;
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
  await expect(
    second.getByRole("button", { name: "Actions for Main checkout", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Actions for Main checkout", exact: true })
    .press("Enter");
  await second.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(second.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  await expect
    .poll(async () => (await first.evaluate(() => window.desktop.workspace())).terminals.length)
    .toBe(2);
  await expect(second.getByLabel("Shown in another window", { exact: true })).toHaveCount(1);
  assert.equal(await second.evaluate((id) => window.desktop.windows.select(id), original), false);
  await expect.poll(() => first.evaluate(() => document.hasFocus())).toBe(true);
  assert.equal(
    await second.evaluate(async (id) => {
      try {
        await window.desktop.attach(id);
        return "attached";
      } catch {
        return "rejected";
      }
    }, original),
    "rejected",
  );
  await first.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await first.getByRole("menuitem", { name: "Split right", exact: true }).click();
  await first
    .getByRole("button", { name: "Actions for Main checkout", exact: true })
    .press("Enter");
  await first.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(2);
  const firstLayout = () =>
    first.evaluate(() =>
      JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)),
    );
  const beforeSelection = await firstLayout();
  assert.equal(await second.evaluate((id) => window.desktop.windows.select(id), original), false);
  await expect.poll(async () => (await firstLayout()).focused).toBe(beforeSelection.tree.first.id);
  assert.deepEqual((await firstLayout()).tree, beforeSelection.tree);
  await assertAccessible(first);
  await assertAccessible(second);
  await first
    .locator(".terminal-tile[data-focused=true]")
    .getByRole("button", { name: /Tile \d+ menu/ })
    .press("Enter");
  await first.getByRole("menuitem", { name: "Move to new window", exact: true }).press("Enter");
  await expect
    .poll(() => app.windows().filter((page) => page.url() === "app://bundle/index.html").length)
    .toBe(3);
  const third = app
    .windows()
    .find((page) => page !== first && page !== second && page.url() === "app://bundle/index.html");
  await expect(third.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  await third.evaluate(() => window.desktop.appMenu.execute("close-window"));
  await expect.poll(() => third.isClosed()).toBe(true);
  const sessions = await first.evaluate(() => window.desktop.workspace());
  assert.equal(sessions.terminals.find((item) => item.id === original).exited, false);
  assert.equal(await first.evaluate((id) => window.desktop.windows.select(id), original), true);
  await assertAccessible(first);
  await assertAccessible(second);
});

test("multiple windows restore independent layouts, bounds and interface size", {
  timeout: deadline(60000),
}, async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-window-restore-"));
  removeAfterApps(context, profile);
  const options = {
    args: [`--user-data-dir=${profile}`],
    home: path.join(profile, "home"),
    fixture: "empty-board",
  };
  const app = await launchApp(context, options);
  const first = await boardPage(app);
  await expect(first.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await first.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(first.locator(".terminal-tile")).toHaveCount(2);
  await first.evaluate(() => window.desktop.saveSetup({ interfaceScale: 110 }));
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
  await expect(second.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await expect(second.locator(".terminal-tile")).toHaveCount(1);
  await second.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(second.locator(".terminal-tile")).toHaveCount(2);
  await second.evaluate(() => window.desktop.appMenu.execute("split-down"));
  await expect(second.locator(".terminal-tile")).toHaveCount(3);
  await second.evaluate(() => window.desktop.saveSetup({ interfaceScale: 90 }));
  assert.equal(
    (await first.evaluate(() => window.desktop.setupState())).settings.interfaceScale,
    90,
  );
  const firstId = await first.evaluate(() => window.desktop.windows.id);
  const secondId = await second.evaluate(() => window.desktop.windows.id);
  await expect(first.locator(".terminal-tile")).toHaveCount(2);
  await expect(second.locator(".terminal-tile")).toHaveCount(3);
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  const placements = JSON.parse(await readFile(path.join(profile, "windows.json"), "utf8"));
  assert.equal(placements.length, 2);
  assert.deepEqual(
    placements.map((item) => "scale" in item),
    [false, false],
  );
  const restored = await launchApp(context, { ...options, fixture: "restored" });
  await expect
    .poll(
      () => restored.windows().filter((page) => page.url() === "app://bundle/index.html").length,
    )
    .toBe(2);
  for (const page of restored
    .windows()
    .filter((page) => page.url() === "app://bundle/index.html")) {
    const id = await page.evaluate(() => window.desktop.windows.id);
    assert.ok(id === firstId || id === secondId);
    await expect(page.locator(".terminal-tile")).toHaveCount(id === firstId ? 2 : 3);
    assert.equal(
      (await page.evaluate(() => window.desktop.setupState())).settings.interfaceScale,
      90,
    );
    await assertAccessible(page);
  }
});

test("sidebar panels hover, pin, rename and launch a home shell", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-home-panel-"));
  removeAfterApps(context, root);
  // Exercise soft-wrapped cwd output even on platforms with short temporary paths.
  const fixtureHome = path.join(root, `home-${"x".repeat(80)}`);
  await mkdir(fixtureHome);
  const app = await launchApp(context, { fixture: "empty-board", home: fixtureHome });
  const page = await boardPage(app);
  const home = page.getByRole("treeitem", { name: "Home shell", exact: true });
  await home.hover();
  const panel = page.getByRole("dialog", { name: /details and commands/ });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-pinned", "false");
  await page.getByRole("button", { name: "Actions for Home shell" }).click();
  await expect(panel).toHaveAttribute("data-pinned", "true");
  await page.mouse.move(0, 0);
  await expect(panel).toBeVisible();
  await assertAccessible(page);
  // Home shells use the OS home directory; the harness gives Electron a private one.
  const expectedHome = (await page.evaluate(() => window.desktop.sidebarInventory())).home
    .directory;
  await panel.getByRole("button", { name: expectedHome, exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(expectedHome);
  for (const [panelColor, tint] of [
    ["vivid", "1"],
    ["subtle", "0.5"],
    ["plain", "0"],
  ]) {
    await page.evaluate((panelColor) => window.desktop.saveSetup({ panelColor }), panelColor);
    await expect(panel).toHaveCSS("--panel-tint", tint);
  }
  await page.evaluate(() =>
    window.desktop.saveSetup({ panelColor: "vivid", interfaceTheme: "high-contrast" }),
  );
  await expect(panel).toHaveCSS("--panel-tint", "0");
  await expect(panel).toHaveCSS("--panel-chip-line", "100%");
  await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "follow" }));
  await page.emulateMedia({ contrast: "more" });
  await expect(panel).toHaveCSS("--panel-tint", "0");
  await page.emulateMedia({ contrast: "no-preference" });
  await page.getByRole("menuitem", { name: "New shell" }).click();
  const row = page.locator(".board-row");
  await expect(row).toHaveCount(1);
  const homeDirectory = expectedHome;
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.equal(snapshot.terminals[0].worktree, homeDirectory);
  assert.equal(snapshot.terminals[0].home, true);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(process.platform === "win32" ? "(Get-Location).Path" : "pwd");
  await page.keyboard.press("Enter");
  // Tail returns physical screen rows; a canonical home path can soft-wrap.
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.desktop.tail(id, 40)).join(""),
        snapshot.terminals[0].id,
      ),
    )
    .toContain(homeDirectory);
  await row.click({ button: "right" });
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: /^Rename / }).click();
  await page.getByRole("textbox", { name: "Session name" }).fill("Home helper");
  await page.getByRole("textbox", { name: "Session name" }).press("Enter");
  await expect(row).toContainText("Home helper");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(row).toBeFocused();
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

test("wide blank tiles start as columns, full boards grow right, and hide refills without moving siblings", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(3200, 900);
  });
  const launch = async () => {
    const count = await page.locator(".board-row").count();
    // Keep the pointer out of rows while navigating menus with the keyboard.
    // Selection can leave a hover panel open; a pinned panel blocks another panel.
    await page.mouse.move(0, 0);
    const actions = page.getByRole("button", { name: "Actions for Home shell", exact: true });
    await actions.press("Escape");
    await expect(page.locator(".row-menu")).toHaveCount(0);
    await actions.press("Enter");
    await page.getByRole("menuitem", { name: "New shell", exact: true }).press("Enter");
    await expect(page.locator(".board-row")).toHaveCount(count + 1);
    await expect(
      page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea'),
    ).toBeFocused();
  };
  await launch();
  const tiles = page.locator(".terminal-tile");
  await expect(tiles).toHaveCount(3);
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await launch();
  await launch();
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(3);
  const geometry = () =>
    tiles.evaluateAll((items) =>
      items.map((item) => ({
        left: item.style.left,
        width: item.style.width,
        top: item.style.top,
        height: item.style.height,
      })),
    );
  const before = await geometry();
  await page.getByRole("button", { name: "Hide", exact: true }).first().click();
  await expect(page.locator('.terminal-tile[data-empty="true"]')).toHaveCount(1);
  assert.deepEqual(await geometry(), before);
  await page.locator(".board-row").first().click();
  await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(3);
  assert.deepEqual(await geometry(), before);
  // Explicitly exercise the already-open panel state that caused the CI timeout.
  await page.getByRole("button", { name: "Actions for Home shell", exact: true }).press("Escape");
  await expect(page.locator(".row-menu")).toHaveCount(0);
  await page
    .locator(".board-row")
    .first()
    .getByRole("button", { name: /Actions for/ })
    .press("Enter");
  await expect(page.locator('.row-menu[data-pinned="true"]')).toBeVisible();
  await launch();
  await expect(tiles).toHaveCount(4);
  const after = await geometry();
  for (const item of after) assert.ok(Math.abs(parseFloat(item.width) - 25) < 0.01);
  await page.getByRole("button", { name: "Hide", exact: true }).last().click();
  await page.getByRole("separator", { name: "Resize tiles" }).first().press("End");
  await expect(tiles).toHaveCount(3);
  await page.locator(".board-row").last().click();
  await expect(tiles).toHaveCount(4);
  assert.deepEqual(await geometry(), after);
  await page.screenshot({ path: path.join(tmpdir(), "foom-264-tiles.png") });
});

test("gutter double-click evens three columns and Tidy tiles removes holes through the menu", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(3200, 900);
  });
  for (let count = 1; count <= 3; count++) {
    await page.mouse.move(0, 0);
    const actions = page.getByRole("button", { name: "Actions for Home shell", exact: true });
    await actions.press("Escape");
    await expect(page.locator(".row-menu")).toHaveCount(0);
    await actions.press("Enter");
    await page.getByRole("menuitem", { name: "New shell", exact: true }).press("Enter");
    await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(count);
    // Occupancy is published before attachment finishes focusing xterm. Drain
    // that focus transfer before sending keyboard input to the gutter.
    await expect(
      page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea'),
    ).toBeFocused();
  }
  const tiles = page.locator(".terminal-tile");
  await expect(tiles).toHaveCount(3);
  const widths = () =>
    tiles.evaluateAll((items) =>
      items.map((item) => Math.round(parseFloat(item.style.width) * 100)),
    );
  const ids = await tiles.evaluateAll((items) => items.map((item) => item.dataset.tile));
  await page.getByRole("separator", { name: "Resize tiles" }).first().press("Home");
  await expect.poll(widths).not.toEqual([3333, 3333, 3333]);
  await page.getByRole("separator", { name: "Resize tiles" }).last().dblclick();
  await expect.poll(widths).toEqual([3333, 3333, 3333]);
  await page.getByRole("separator", { name: "Resize tiles" }).first().press("End");
  await page.getByRole("separator", { name: "Resize tiles" }).last().press("Enter");
  await expect.poll(widths).toEqual([3333, 3333, 3333]);
  await page.getByRole("button", { name: "Hide", exact: true }).nth(1).click();
  await expect(page.locator('.terminal-tile[data-empty="true"]')).toHaveCount(1);
  const focused = await page
    .locator('.terminal-tile[data-focused="true"]')
    .getAttribute("data-tile");
  await page
    .locator('.terminal-tile[data-focused="true"]')
    .getByRole("button", { name: "Maximize tile", exact: true })
    .click();
  if (process.platform === "darwin") {
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const item = Menu.getApplicationMenu().getMenuItemById("tidy-tiles");
      item.click(undefined, BrowserWindow.getFocusedWindow());
    });
  } else {
    await page.getByRole("button", { name: "Foom menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "View", exact: true }).hover();
    const view = page.getByRole("menu", { name: "View", exact: true });
    await expect(view).toBeVisible();
    await view.getByRole("menuitem", { name: /^Tidy tiles/ }).click();
    await expect(view).toHaveCount(0);
  }
  await expect(tiles).toHaveCount(2);
  await expect.poll(widths).toEqual([5000, 5000]);
  await expect(page.locator('[data-maximized="true"]')).toHaveCount(0);
  assert.deepEqual(await tiles.evaluateAll((items) => items.map((item) => item.dataset.tile)), [
    ids[0],
    ids[2],
  ]);
  await expect(page.locator('.terminal-tile[data-focused="true"]')).toHaveAttribute(
    "data-tile",
    focused,
  );
  await page.screenshot({ path: path.join(tmpdir(), "foom-265-tidy-tiles.png") });
  // The same action travels through each platform's real keyboard dispatcher.
  await page.getByRole("separator", { name: "Resize tiles" }).press("Home");
  await page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea').focus();
  await app.evaluate(({ BrowserWindow }, mac) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    ).webContents;
    if (!mac)
      for (const type of ["keyDown", "keyUp"])
        contents.sendInputEvent({ type, keyCode: "Space", modifiers: ["control", "shift"] });
    for (const type of ["keyDown", "keyUp"])
      contents.sendInputEvent({
        type,
        keyCode: "T",
        modifiers: mac ? ["meta", "alt", "shift"] : [],
      });
  }, process.platform === "darwin");
  await expect.poll(widths).toEqual([5000, 5000]);
  await assertAccessible(page);
});

test("sidebar collapses at any width, refits once and opens a narrow overlay without reflow", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const input = page.locator(".xterm-helper-textarea");
  await expect(input).toBeFocused();
  await app.evaluate(({ ipcMain }) => {
    global.sidebarResizes = [];
    ipcMain.on("terminal:resize", (_event, id, cols, rows) =>
      global.sidebarResizes.push({ id, cols, rows }),
    );
  });
  const expectOneResize = async () => {
    try {
      await expect.poll(() => app.evaluate(() => global.sidebarResizes.length)).toBe(1);
    } catch (error) {
      console.error(
        "Sidebar resize measurements:",
        await app.evaluate(() => global.sidebarResizes),
      );
      throw error;
    }
  };
  const toggle = () =>
    app.evaluate(({ BrowserWindow }, mac) => {
      const contents = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      ).webContents;
      for (const type of ["keyDown", "keyUp"])
        contents.sendInputEvent({
          type,
          keyCode: "B",
          modifiers: mac ? ["meta"] : ["control", "shift"],
        });
    }, process.platform === "darwin");
  await input.press("Control+b");
  await expect(page.getByRole("button", { name: "Collapse sidebar", exact: true })).toBeVisible();
  await toggle();
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  await expectOneResize();
  const compactColumns = await app.evaluate(() => global.sidebarResizes[0].cols);
  await app.evaluate(() => {
    global.sidebarResizes = [];
  });
  await toggle();
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  await expectOneResize();
  assert.ok((await app.evaluate(() => global.sidebarResizes[0].cols)) < compactColumns);
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeFocused();
  await page.screenshot({ path: "test-results/sidebar-collapsed.png", animations: "disabled" });
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Collapse sidebar", exact: true })).toBeFocused();
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  await page.getByRole("button", { name: "Foom menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "View", exact: true }).hover();
  await page.getByRole("menuitem", { name: /^Collapse sidebar/ }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.setSize(960, 700);
    window.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(720);
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  const bounds = await page.locator(".board-terminal").boundingBox();
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeVisible();
  assert.deepEqual(await page.locator(".board-terminal").boundingBox(), bounds);
  await page.screenshot({ path: "test-results/sidebar-overlay.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
  assert.deepEqual(await page.locator(".board-terminal").boundingBox(), bounds);
  await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  await page.locator(".config-gear").click();
  await page
    .getByRole("dialog")
    .getByRole("menuitem", { name: /^Settings/ })
    .click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeVisible();
  await toggle();
  await expect(page.getByRole("button", { name: "Open sidebar", exact: true })).toBeVisible();
  await assertAccessible(page);
});

test("sidebar choice restores after restart and new windows start expanded", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-sidebar-restore-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`], fixture: "empty-board" };
  const app = await launchApp(context, options);
  const page = await boardPage(app);
  await page.getByRole("separator", { name: "Sidebar width" }).press("Home");
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  const restoredApp = await launchApp(context, { ...options, fixture: "restored" });
  const restored = await boardPage(restoredApp);
  await expect(restored.getByRole("button", { name: "Expand sidebar", exact: true })).toBeVisible();
  await restored.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(restored.getByRole("separator", { name: "Sidebar width" })).toHaveAttribute(
    "aria-valuenow",
    "240",
  );
  await expect
    .poll(async () => Math.round((await restored.locator(".sidebar-shell").boundingBox()).width))
    .toBe(240);
  await restored.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(
      () => restoredApp.windows().filter((page) => page.url() === "app://bundle/index.html").length,
    )
    .toBe(2);
  const second = restoredApp
    .windows()
    .find((page) => page !== restored && page.url() === "app://bundle/index.html");
  await expect(second.getByRole("button", { name: "Collapse sidebar", exact: true })).toBeVisible();
  await expect(second.getByRole("separator", { name: "Sidebar width" })).toHaveAttribute(
    "aria-valuenow",
    "300",
  );
  await assertAccessible(restored);
});

test("tile layouts restore v1 terminal content and v2 mixed content after inventory", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell", shell: "hidden" });
  const page = await boardPage(app);
  await expect(page.locator(".board-row").first()).toBeVisible();
  const id = await page.locator(".board-row").first().getAttribute("data-drag-session");
  assert.ok(id);
  for (const version of [1, 2]) {
    await page.evaluate(
      ({ version, id }) => {
        const terminal = {
          kind: "tile",
          id: "restored-terminal",
          ...(version === 1 ? { session: id } : { content: { kind: "terminal", session: id } }),
        };
        const space = {
          kind: "tile",
          id: "restored-preview",
          ...(version === 1
            ? { session: null }
            : { content: { kind: "preview", preview: "missing-preview" } }),
        };
        localStorage.setItem(
          `foom.tiles.v1.${window.desktop.windows.id}`,
          JSON.stringify({
            version,
            focused: terminal.id,
            tree: {
              kind: "split",
              id: "restored-split",
              direction: "horizontal",
              ratio: 0.4,
              first: terminal,
              second: space,
            },
          }),
        );
      },
      { version, id },
    );
    await page.reload();
    await expect(page.locator('[data-tile="restored-terminal"]')).toHaveAttribute(
      "data-empty",
      "false",
    );
    await expect(page.locator('[data-tile="restored-preview"]')).toHaveAttribute(
      "data-empty",
      "true",
    );
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)),
    );
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.tree.first.content, { kind: "terminal", session: id });
    assert.equal(saved.tree.second.content, null);
    assert.equal(saved.tree.ratio, 0.4);
    await assertAccessible(page);
  }
  // Exercise the future host's typed inventory without implementing a view host.
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  const repository = inventory.repositories[0];
  assert.ok(repository);
  inventory.previews = [
    {
      id: "markdown-preview",
      repository: repository.path,
      worktree: repository.worktrees[0].path,
      relativePath: "docs/previews.md",
      kind: "markdown",
    },
    {
      id: "html-preview",
      repository: repository.path,
      worktree: repository.worktrees[0].path,
      relativePath: "docs/mockups/preview-tiles.html",
      kind: "html",
    },
  ];
  await app.evaluate(({ ipcMain }, inventory) => {
    ipcMain.removeHandler("workspace:sidebar");
    ipcMain.handle("workspace:sidebar", () => inventory);
    ipcMain.removeHandler("preview:bounds");
    ipcMain.handle("preview:bounds", () => {});
  }, inventory);
  await page.evaluate((id) => {
    const leaf = (id, content) => ({ kind: "tile", id, content });
    localStorage.setItem(
      `foom.tiles.v1.${window.desktop.windows.id}`,
      JSON.stringify({
        version: 2,
        focused: "terminal",
        tree: {
          kind: "split",
          id: "columns",
          direction: "horizontal",
          ratio: 1 / 3,
          first: leaf("terminal", { kind: "terminal", session: id }),
          second: {
            kind: "split",
            id: "previews",
            direction: "horizontal",
            ratio: 0.5,
            first: leaf("markdown", { kind: "preview", preview: "markdown-preview" }),
            second: leaf("html", { kind: "preview", preview: "html-preview" }),
          },
        },
      }),
    );
  }, id);
  await page.reload();
  await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(3);
  await expect(page.locator('[data-tile="markdown"] .board-agent')).toHaveText("MD");
  await expect(page.locator('[data-tile="html"] .board-agent')).toHaveText("HTML");
  await expect(page.locator(".preview-row")).toHaveCount(2);
  assert.equal(await page.locator('.terminal-tile[data-kind="preview"] .board-light').count(), 0);
  await page.getByRole("button", { name: /docs\/previews.md/ }).click();
  await expect(page.locator('[data-tile="markdown"]')).toBeFocused();
  for (const [theme, scale] of [
    ["dark", 100],
    ["light", 150],
  ]) {
    await page.evaluate(
      ({ theme, scale }) => window.desktop.saveSetup({ colorMode: theme, interfaceScale: scale }),
      { theme, scale },
    );
    await assertAccessible(page);
    await page.screenshot({
      path: `test-results/preview-tiles-${theme}-${scale}.png`,
      animations: "disabled",
    });
  }
});

test("sidebar border resizes live, persists per window and refits the terminal once", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const handle = page.getByRole("separator", { name: "Sidebar width", exact: true });
  const sidebar = page.locator(".sidebar-shell");
  await expect(handle).toHaveAttribute("aria-valuenow", "300");
  await app.evaluate(({ ipcMain }) => {
    global.borderResizes = [];
    ipcMain.on("terminal:resize", (_event, id, cols, rows) =>
      global.borderResizes.push({ id, cols, rows }),
    );
  });
  const bounds = await handle.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 50, bounds.y + bounds.height / 2, {
    steps: 8,
  });
  await expect(handle).toHaveAttribute("aria-valuenow", "250");
  assert.equal(Math.round((await sidebar.boundingBox()).width), 250);
  assert.equal(await app.evaluate(() => global.borderResizes.length), 0);
  await page.mouse.up();
  await expect.poll(() => app.evaluate(() => global.borderResizes.length)).toBe(1);
  const savedWidth = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.startsWith("foom.tiles.v1."));
      return JSON.parse(localStorage.getItem(key)).sidebarWidth;
    });
  await expect.poll(savedWidth).toBe(250);
  await page.screenshot({ path: "test-results/sidebar-resized.png", animations: "disabled" });
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(handle).toHaveCount(0);
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-valuenow", "250");
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  assert.equal(Math.round((await sidebar.boundingBox()).width), 250);
  await handle.focus();
  await handle.press("ArrowRight");
  await expect.poll(savedWidth).toBe(260);
  await handle.press("End");
  assert.equal(
    await handle.getAttribute("aria-valuenow"),
    await handle.getAttribute("aria-valuemax"),
  );
  await handle.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "240");
  await page.waitForFunction(
    () => document.querySelector(".sidebar-shell").getAnimations().length === 0,
  );
  await handle.dblclick();
  await expect.poll(savedWidth).toBe(300);
  await expect(handle).toHaveAttribute("aria-valuenow", "300");
  await assertAccessible(page);
});

test("background layout failures preserve terminal focus and typed input", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const input = page.locator(".xterm-helper-textarea");
  await expect(input).toBeFocused();
  await page.keyboard.type("echo FOOM_");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    window.restoreErrorTestStorage = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = () => {
      throw new Error("private path and raw details");
    };
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .webContents.send("board:command", "tidy-tiles");
  });
  await expect(page.getByRole("button", { name: "Show failure" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Action failed" })).toHaveCount(0);
  await expect(input).toBeFocused();
  await page.keyboard.type("BACKGROUND_FOCUS");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { terminals } = await window.desktop.workspace();
        return (await window.desktop.tail(terminals[0].id, 100)).some(
          (line) => line.trim() === "FOOM_BACKGROUND_FOCUS",
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.restoreErrorTestStorage();
    delete window.restoreErrorTestStorage;
  });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .webContents.send("board:command", "tidy-tiles");
  });
  await expect(page.getByRole("button", { name: "Show failure" })).toHaveCount(0);
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
  await rm(path.join(tree.path, ".git"));
  await page.getByRole("button", { name: "Actions for error-prune-test", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete worktree…" }).click();
  const modal = page.getByRole("dialog", { name: "Action failed" });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("alert")).toHaveText("This worktree needs pruning.");
  await expect(modal).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Prune" })).not.toBeFocused();
  await assertAccessible(page);
  await page.screenshot({ path: path.join("test-results", "error-modal.png") });
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
});
