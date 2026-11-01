const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chmod, mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
  restartShellFromSidebar,
} = require("./harness.js");

// A painted/focused cursor can precede both login and attachment readiness.
async function expectShellReady(page, id, input) {
  await expect
    .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id))
    .toMatch(process.platform === "win32" ? /PS [\s\S]*>\s*$/ : /[$#%>]\s*$/);
  await expect(input).toBeEditable();
}

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
  await page.screenshot({ path: evidencePath("foom-132-empty-sidebar.png") });
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
      await page.screenshot({ path: evidencePath(`foom-sidebar-${colorScheme}.png`) });
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
        path: evidencePath(`foom-review-session-${colorScheme}.png`),
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
    await page.screenshot({ path: evidencePath("foom-review-compact.png") });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Stop shell" })).toBeFocused();
  await page.keyboard.press("Escape");
  await assertAccessible(page);
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

for (const pinned of [false, true]) {
  test(`scrolled shell launcher ${pinned ? "pinned" : "hovered"} creates and focuses on the first click`, {
    skip: process.platform === "win32" && "Fixture CLI discovery uses POSIX executables",
  }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "foom-first-click-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    // Fill the real launcher list without exposing any installed agent CLI.
    for (const [name, version] of [
      ["claude", "2.1.300 (Claude Code)"],
      ["codex", "codex-cli 0.161.0"],
      ["agy", "1.0.0"],
      ["copilot", "GitHub Copilot CLI 1.0.0."],
      ["opencode", "opencode v2.0.32"],
      ["pi", "1.4.0"],
    ]) {
      await writeFile(
        path.join(bin, name),
        `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`,
      );
      await chmod(path.join(bin, name), 0o755);
    }
    const app = await launchApp(context, { fixture: "repository", env: { PATH: bin } });
    const page = await boardPage(app);
    await page.evaluate(async () => {
      await window.desktop.scanAgents(false);
      await window.desktop.saveSetup({
        agents: {
          ...(await window.desktop.setupState()).settings.agents,
          claude: true,
          codex: true,
          agy: true,
        },
      });
    });
    // Model a short screen / large interface: the launcher must scroll to Shell.
    await app.evaluate(({ BrowserWindow }) => {
      const board = BrowserWindow.getAllWindows().find(
        (entry) => entry.webContents.getURL() === "app://bundle/index.html",
      );
      board.setMinimumSize(900, 300);
      board.setSize(900, 300);
    });
    const anchor = page.getByRole("button", { name: "Actions for Main checkout", exact: true });
    if (pinned) await anchor.click();
    else await anchor.hover();
    const panel = page.getByRole("dialog", { name: /details and commands/ });
    await expect(panel).toHaveAttribute("data-pinned", String(pinned));
    await expect(panel.getByRole("menuitem", { name: "Pi", exact: true })).toBeAttached();
    const launcher = panel.getByRole("menuitem", { name: /^Shell \(/ });
    await launcher.scrollIntoViewIfNeeded();
    await expect
      .poll(() => panel.locator(".panel-body").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    // A real press has time between down and up for the pinning layout effect.
    await launcher.click({ delay: 100 });
    await expect(page.locator(".board-row[data-kind='shell']")).toHaveCount(1);
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(page.locator(".xterm-focus .xterm-cursor-blink")).toBeVisible();
    const created = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
    assert.ok(created);
    await expectShellReady(page, created.id, page.locator(".xterm-helper-textarea"));
    await page.keyboard.type("echo FIRST_CLICK_'985'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("FIRST_CLICK_985");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  });
}

test("shell launch paths select the new shell and its blinking input cursor", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  for (const entry of ["checkout", "home-menu", "home-row", "space"]) {
    const before = new Set(
      (await page.evaluate(() => window.desktop.workspace())).terminals.map((entry) => entry.id),
    );
    if (entry === "checkout") {
      await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
    } else if (entry === "home-menu") {
      await page.getByRole("button", { name: "Actions for Home shell", exact: true }).click();
      await page.getByRole("menuitem", { name: "New shell", exact: true }).click();
    } else if (entry === "home-row") {
      await page
        .getByRole("treeitem", { name: "Home shell", exact: true })
        .locator(".tree-name")
        .click();
    } else {
      await page
        .locator(".terminal-tile[data-focused='true']")
        .getByRole("button", { name: /Tile \d+ menu/ })
        .click();
      await page.getByRole("menuitem", { name: "Split terminal left", exact: true }).click();
      // Move away from sidebar rows before opening the space menu.
      await page.mouse.move(0, 0);
      await expect(page.locator(".sidebar-panel")).toHaveCount(0);
      await page.locator(".terminal-tile[data-empty='true']").first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "New shell here", exact: true }).click();
    }
    await expect(page.locator(".board-row[data-kind='shell']")).toHaveCount(before.size + 1);
    const shell = page.locator(".terminal-tile[data-kind='shell'][data-focused='true']");
    await expect(shell.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(shell.locator(".xterm-focus .xterm-cursor-blink")).toBeVisible();
    const created = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (terminal) => !before.has(terminal.id),
    );
    assert.ok(created);
    await expectShellReady(page, created.id, shell.locator(".xterm-helper-textarea"));
    context.diagnostic(`Shell ${entry} is editable with an interactive prompt after focus`);
    await page.keyboard.type(
      process.platform === "win32" ? "echo ('FOCUSED_' + '985')" : "echo FOCUSED_'985'",
    );
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), created.id),
      )
      .toContain("FOCUSED_985");
    await expect(shell.locator(".xterm-helper-textarea")).toBeFocused();
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
  await page.screenshot({
    path: evidencePath("sidebar-collapsed.png"),
    animations: "disabled",
  });
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
  await page.screenshot({
    path: evidencePath("sidebar-overlay.png"),
    animations: "disabled",
  });
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
  await page.screenshot({
    path: evidencePath("sidebar-resized.png"),
    animations: "disabled",
  });
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
