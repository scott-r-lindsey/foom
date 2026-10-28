const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  installSoundSink,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
} = require("./harness.js");

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
  await page.screenshot({ path: evidencePath("foom-132-tiles.png") });
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
  await expect(page.getByRole("menuitem", { name: "Grow right", exact: true })).toBeDisabled();
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
  await page.screenshot({ path: evidencePath("foom-220-tile-panel.png") });
  await menu.press("Escape");
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await expect(empty.locator(".tile-title")).toHaveCount(0);
    await assertAccessible(page);
  }
  await page.screenshot({ path: evidencePath("foom-tile-bug-fixes.png") });
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
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: /^Colors / }).click();
  await page.getByRole("menuitemradio", { name: "Dracula", exact: true }).click();
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
  await page.screenshot({ path: evidencePath("foom-132-bars-fixed.png") });
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
    await page.screenshot({ path: evidencePath(`foom-133-preview-${theme}.png`) });
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
  await page.screenshot({ path: evidencePath("foom-133-tiles.png") });
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
  await page.screenshot({ path: evidencePath("foom-264-tiles.png") });
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
  await page.screenshot({ path: evidencePath("foom-265-tidy-tiles.png") });
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
      network: false,
      repository: repository.path,
      worktree: repository.worktrees[0].path,
      relativePath: "docs/previews.md",
      kind: "markdown",
    },
    {
      id: "html-preview",
      network: false,
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
      ({ theme, scale }) =>
        window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}`, interfaceScale: scale }),
      { theme, scale },
    );
    await assertAccessible(page);
    await page.screenshot({
      path: evidencePath(`preview-tiles-${theme}-${scale}.png`),
      animations: "disabled",
    });
  }
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

for (const location of ["home", "config", "checkout"]) {
  for (const surface of ["tile", "sidebar"]) {
    test(`${location} shell closes from the ${surface} without a session error`, async (context) => {
      const app = await launchApp(context, { fixture: "repository" });
      const page = await boardPage(app);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(async (location) => {
        const repository = (await window.desktop.workspace()).repositories[0].path;
        await window.desktop.sidebarCommand(
          location === "home"
            ? { kind: "home-shell" }
            : location === "config"
              ? { kind: "config-launch", run: "shell" }
              : { kind: "launch", repository, worktree: repository, run: "shell" },
        );
      }, location);
      const row = page.locator(".board-row");
      await expect(row).toHaveCount(1);
      const session = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
      assert.ok(session);
      await row.click();
      await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      if (surface === "tile") {
        // A running tile offers Hide: closing its view must keep the shell alive.
        await page.getByRole("button", { name: "Hide", exact: true }).click();
        await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
        const running = (await page.evaluate(() => window.desktop.workspace())).terminals;
        assert.equal(running.find((entry) => entry.id === session.id)?.exited, false);
        await row.click();
        await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
      }
      await page.evaluate((id) => window.desktop.input(id, "exit\r"), session.id);
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await window.desktop.workspace()).terminals.find((entry) => entry.id === id)?.exited,
            session.id,
          ),
        )
        .toBe(true);
      if (surface === "tile") {
        await page.getByRole("button", { name: "Close", exact: true }).click();
      } else {
        await page.getByRole("button", { name: /Actions for Shell in/ }).press("Enter");
        await page.getByRole("menuitem", { name: "Close", exact: true }).press("Enter");
      }
      await expect
        .poll(async () => ({
          sessions: (await page.evaluate(() => window.desktop.workspace())).terminals.map(
            (entry) => entry.id,
          ),
          errors: await page.getByText("Unable to close session.", { exact: true }).count(),
        }))
        .toEqual({ sessions: [], errors: 0 });
      await expect(row).toHaveCount(0);
      await expect(page.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
    });
  }
}

test("directional pads and empty-space menu split, grow, launch and close", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1500, 900);
  });
  const menuButton = page.getByRole("button", { name: "Tile 1 menu", exact: true });
  const spaces = page.locator('.terminal-tile[data-empty="true"]');
  for (const direction of ["left", "up", "right", "down"]) {
    await menuButton.click();
    const split = page.getByRole("group", { name: "Split", exact: true });
    const grow = page.getByRole("group", { name: "Grow", exact: true });
    const named = direction[0].toUpperCase() + direction.slice(1);
    await split.getByRole("menuitem", { name: "Split right", exact: true }).press(`Arrow${named}`);
    await expect(
      split.getByRole("menuitem", { name: `Split ${direction}`, exact: true }),
    ).toBeFocused();
    await expect(
      grow.getByRole("menuitem", { name: `Grow ${direction}`, exact: true }),
    ).toBeDisabled();
    await split.getByRole("menuitem", { name: `Split ${direction}`, exact: true }).click();
    await expect(spaces).toHaveCount(1);
    await expect(
      page.locator('.terminal-tile[data-empty="false"] .xterm-helper-textarea').first(),
    ).toBeFocused();
    await menuButton.click();
    await expect(
      grow.getByRole("menuitem", { name: `Grow ${direction}`, exact: true }),
    ).toBeEnabled();
    await grow.getByRole("menuitem", { name: `Grow ${direction}`, exact: true }).click();
    await expect(spaces).toHaveCount(0);
  }
  await menuButton.click();
  await page.getByRole("menuitem", { name: "Split down", exact: true }).click();
  for (const colorScheme of ["light", "dark"]) {
    await page.evaluate(
      (base) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${base}` }),
      colorScheme,
    );
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveCSS(
      "--bg",
      colorScheme === "light" ? "#f3f0fa" : "#05040a",
    );
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await menuButton.click();
    const panel = page.getByRole("dialog", { name: "Tile 1 menu", exact: true });
    const refused = panel.getByRole("menuitem", { name: "Grow up", exact: true });
    await refused.focus();
    await expect(refused).toBeFocused();
    await expect(refused).toHaveAccessibleDescription("At the top edge");
    await expect(panel.getByText("At the top edge", { exact: true })).toBeVisible();
    const arrow = panel.getByRole("menuitem", { name: "Split up", exact: true });
    await expect(arrow).toHaveCSS("width", "28px");
    await expect(arrow).toHaveCSS("height", "28px");
    await arrow.focus();
    await expect(panel.getByText("At the top edge", { exact: true })).toBeHidden();
    await assertAccessible(page);
    await page.screenshot({ path: evidencePath(`screenshots-889/tile-panel-${colorScheme}.png`) });
    await arrow.press("Escape");
    await spaces.first().click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Empty space", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("group", { name: "Grow", exact: true })).toHaveCount(0);
    await assertAccessible(page);
    await page.screenshot({ path: evidencePath(`screenshots-889/empty-space-${colorScheme}.png`) });
    await menu.getByRole("menuitem", { name: "Split right", exact: true }).press("Escape");
    await expect(menu).toHaveCount(0);
  }
  await spaces.first().click({ button: "right" });
  await spaces.first().click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole("menu", { name: "Empty space", exact: true })).toHaveCount(0);
  await spaces.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split left", exact: true }).click();
  await expect(spaces).toHaveCount(2);
  await spaces.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close space", exact: true }).click();
  await expect(spaces).toHaveCount(1);
  const target = await spaces.first().getAttribute("data-tile");
  await spaces.first().click({ button: "right" });
  await page.locator(".tile-title").first().click();
  await expect(page.getByRole("menu", { name: "Empty space", exact: true })).toHaveCount(0);
  await spaces.first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "New shell here", exact: true }).click();
  await expect(spaces).toHaveCount(0);
  await expect(page.locator(`[data-tile="${target}"]`)).toHaveAttribute("data-empty", "false");
  await expect(page.locator(".board-row")).toHaveCount(2);
  await page.getByRole("button", { name: "Tile 2 menu", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Grow up", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .webContents.setZoomFactor(3);
  });
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(600);
  await page.getByRole("button", { name: "Tile 2 menu", exact: true }).press("Enter");
  const narrow = page.getByRole("dialog", { name: "Tile 2 menu", exact: true });
  await expect
    .poll(() =>
      narrow.evaluate((panel) => {
        const commands = panel.querySelector(".row-menu-items")?.getBoundingClientRect();
        const facts = panel.querySelector(".panel-facts")?.getBoundingClientRect();
        return Boolean(commands && facts && facts.top >= commands.bottom - 1);
      }),
    )
    .toBe(true);
  await expect(narrow.getByRole("menuitem", { name: "Split right", exact: true })).toHaveCSS(
    "width",
    "28px",
  );
  await narrow.press("Escape");
});
