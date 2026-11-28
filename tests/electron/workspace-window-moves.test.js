const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
const { deadline, expect } = require("./test-policy.js");
const { evidencePath } = require("../helpers/evidence.js");
const { git } = require("../helpers/git.js");
const { assertAccessible, boardPage, confirmationPage, launchApp } = require("./harness.js");
const { pollPreviewContents, previewViewState } = require("./preview-fixture.js");
const { sizeTileBoard } = require("./tile-fixture.js");

async function newBoard(app, source) {
  const before = app.windows();
  await source.evaluate(() => window.desktop.appMenu.execute("new-window"));
  let board;
  await expect
    .poll(() => {
      board = app
        .windows()
        .find((page) => !before.includes(page) && page.url() === "app://bundle/index.html");
      return Boolean(board);
    })
    .toBe(true);
  await expect(board.locator(".tile-area")).toBeVisible();
  return board;
}
async function menuMove(page, tile, label) {
  await tile.getByRole("button", { name: /Tile \d+ menu/ }).click();
  await page.getByRole("menuitem", { name: "Move to window", exact: true }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function prepareMenuCapture(page) {
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.focus();
  const views = await page.evaluate(() => window.desktop.windows.snapshot());
  const id = views.find((view) => view.window === 0)?.id;
  assert.ok(id);
  const tail = () => page.evaluate(async (id) => (await window.desktop.tail(id, 5)).join("\n"), id);
  await expect.poll(tail).toMatch(/[$#>]\s*$/);
  await page.keyboard.type(
    process.platform === "win32"
      ? "function global:prompt { 'foom> ' }; Clear-Host"
      : "PS1='foom> '; printf '\\033[3J\\033[2J\\033[H'",
  );
  await page.keyboard.press("Enter");
  await expect.poll(tail).toMatch(/foom>\s*$/);
  await page.emulateMedia({ reducedMotion: "reduce" });
}

const waitForMenuFrame = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

// Synthetic DOM gestures exercise the actual source and destination handlers.
// This deliberately makes payload reads throw; no native OS drag is claimed.
async function startDrag(page, selector) {
  await page.locator(selector).evaluate((element) => {
    const dataTransfer = new DataTransfer();
    Object.defineProperty(dataTransfer, "getData", {
      value: () => {
        throw new Error("Drag payload read");
      },
    });
    element.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }),
    );
  });
}
async function over(page, zone = "center", drop = false) {
  await page
    .locator(".terminal-tile")
    .first()
    .evaluate(
      (element, { zone, drop }) => {
        const bounds = element.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        dataTransfer.setData("text/plain", "untrusted external payload");
        Object.defineProperty(dataTransfer, "getData", {
          value: () => {
            throw new Error("Drag payload read");
          },
        });
        const options = {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX:
            bounds.left + bounds.width * (zone === "left" ? 0.1 : zone === "right" ? 0.9 : 0.5),
          clientY: bounds.top + bounds.height * (zone === "up" ? 0.1 : zone === "down" ? 0.9 : 0.5),
        };
        element.dispatchEvent(new DragEvent("dragover", options));
        if (drop) element.dispatchEvent(new DragEvent("drop", options));
      },
      { zone, drop },
    );
}
async function dragMove(from, selector, to, zone = "center") {
  await startDrag(from, selector);
  await expect(to.locator(".board-home")).toHaveAttribute("data-dragging", "true");
  await over(to, zone);
  await expect(to.locator(".tile-drop-preview")).toBeVisible();
  await over(to, zone, true);
  await from.locator(".board-home").dispatchEvent("dragend");
  await expect(to.locator(".tile-drop-preview")).toHaveCount(0);
}

test("terminals move between boards through menus and token-backed sidebar/title drops", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const first = await boardPage(app);
  const second = await newBoard(app, first);
  const third = await newBoard(app, first);
  const labels = await first.evaluate(() => window.desktop.windows.moves.list());
  assert.equal(labels.length, 2);
  const original = (await first.evaluate(() => window.desktop.workspace())).terminals[0].id;
  const sourceLabel = (await second.evaluate(() => window.desktop.windows.moves.list()))[0].label;
  await mkdir("test-results/950-cross-window-drag", { recursive: true });
  for (const theme of ["eclipse-light", "eclipse-dark"]) {
    await first.evaluate((theme) => window.desktop.saveSetup({ interfaceTheme: theme }), theme);
    await first.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
    await first.getByRole("menuitem", { name: "Move to window", exact: true }).click();
    for (const destination of labels)
      await expect(
        first.getByRole("menuitem", { name: destination.label, exact: true }),
      ).toBeVisible();
    await first
      .getByRole("menu", { name: "Move to window", exact: true })
      .evaluate(async (menu) => {
        await Promise.all(
          menu
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
    await first.screenshot({ path: `test-results/950-cross-window-drag/menu-${theme}.png` });
    await first.keyboard.press("Escape");
    await first.keyboard.press("Escape");
    await startDrag(first, ".tile-title");
    await expect(second.locator(".board-home")).toHaveAttribute("data-dragging", "true");
    await over(second);
    await expect(second.locator(".tile-drop-preview")).toBeVisible();
    await second.screenshot({ path: `test-results/950-cross-window-drag/drop-${theme}.png` });
    await first.locator(".board-home").dispatchEvent("dragend");
    await expect(second.locator(".tile-drop-preview")).toHaveCount(0);
  }
  await menuMove(first, first.locator('.terminal-tile[data-empty="false"]'), labels[0].label);
  await expect(second.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await expect(first.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
  await dragMove(second, ".tile-title", first);
  await expect(first.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await expect(second.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
  await dragMove(first, `[data-drag-session="${original}"]`, second);
  await expect(second.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await expect(first.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
  const views = await second.evaluate(() => window.desktop.windows.snapshot());
  assert.deepEqual(
    views.filter((view) => view.id === original).map((view) => view.window),
    [0],
  );
  assert.equal(
    await first.evaluate(async (id) => {
      try {
        await window.desktop.attach(id);
        return "attached";
      } catch {
        return "rejected";
      }
    }, original),
    "rejected",
  );
  assert.equal(
    (await first.evaluate(() => window.desktop.workspace())).terminals.find(
      (row) => row.id === original,
    ).exited,
    false,
  );
  // An unregistered external gesture never highlights or changes an empty board.
  await over(third, "center", true);
  await expect(third.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
  assert.equal(
    (await second.evaluate(() => window.desktop.windows.moves.list()))[0].label,
    sourceLabel,
  );
  await assertAccessible(first);
  await assertAccessible(second);
});

test("pioneer window names remain stable, reuse the lowest free name and show repository hints", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const first = await boardPage(app);
  const second = await newBoard(app, first);
  const list = (page) => page.evaluate(() => window.desktop.windows.moves.list());
  assert.deepEqual(
    (await list(first)).map(({ label, repositories }) => ({ label, repositories })),
    [{ label: "Lovelace", repositories: [] }],
  );
  await expect
    .poll(async () => (await list(second))[0])
    .toMatchObject({
      label: "Turing",
      repositories: ["shell-fixture"],
    });
  await menuMove(first, first.locator('.terminal-tile[data-empty="false"]'), "Lovelace");
  await expect(second.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await expect.poll(async () => (await list(first))[0].repositories).toEqual(["shell-fixture"]);

  await first.evaluate(() => window.desktop.appMenu.execute("close-window"));
  await expect.poll(() => first.isClosed()).toBe(true);
  const replacement = await newBoard(app, second);
  assert.equal((await list(second))[0].label, "Turing");
  assert.equal((await list(replacement))[0].label, "Lovelace");
  const third = await newBoard(app, replacement);
  await third.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
  await third.getByRole("menuitem", { name: /^Shell \(/ }).click();
  await expect(third.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await expect
    .poll(async () => (await list(third)).find(({ label }) => label === "Lovelace")?.repositories)
    .toEqual(["shell-fixture"]);
  await sizeTileBoard(app, third, 1200, 800);
  if (process.env.FOOM_SCREENSHOTS === "1") await prepareMenuCapture(third);
  for (const base of ["light", "dark"]) {
    await third.evaluate(
      (base) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${base}` }),
      base,
    );
    await expect(third.locator("html")).toHaveCSS("color-scheme", base);
    await third.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
    await third.getByRole("menuitem", { name: "Move to window", exact: true }).click();
    await expect(
      third.getByRole("menuitem", { name: "Lovelace · shell-fixture", exact: true }),
    ).toBeVisible();
    await expect(third.getByRole("menuitem", { name: "Turing", exact: true })).toBeVisible();
    if (process.env.FOOM_SCREENSHOTS === "1" && base === "light")
      await third.screenshot({
        path: evidencePath(`screenshots-1370/move-to-window-${base}.png`),
        animations: "disabled",
      });
    await third.keyboard.press("Escape");
    await third.keyboard.press("Escape");
  }
});

test("opening the window picker refreshes repository hints before showing destinations", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const source = await boardPage(app);
  const destination = await newBoard(app, source);
  await sizeTileBoard(app, source, 1100, 700);
  // The menu dismisses on resize, so let Chromium deliver the resize first.
  await waitForMenuFrame(source);
  await source.getByRole("button", { name: "Tile 1 menu", exact: true }).press("Enter");
  const trigger = source.getByRole("menuitem", { name: "Move to window", exact: true });
  const picker = source.getByRole("menu", { name: "Move to window", exact: true });
  await trigger.press("Enter");
  await expect(picker.getByRole("menuitem", { name: "Lovelace", exact: true })).toBeFocused();
  await source.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await destination
    .getByRole("button", { name: "Actions for Main checkout", exact: true })
    .press("Enter");
  await destination.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect
    .poll(() => source.evaluate(() => window.desktop.windows.moves.list()))
    .toMatchObject([{ label: "Lovelace", repositories: ["shell-fixture"] }]);

  // Hold the real IPC handler so stale rows cannot slip through between frames.
  await app.evaluate(({ ipcMain }) => {
    const channel = "windows:list";
    const list = ipcMain._invokeHandlers.get(channel);
    const { promise, resolve } = Promise.withResolvers();
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (...args) => {
      await promise;
      return list(...args);
    });
    globalThis.releaseWindowList = () => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, list);
      resolve();
    };
  });
  try {
    await trigger.press("Enter");
    await expect(picker.getByRole("menuitem", { name: "Loading…", exact: true })).toBeDisabled();
    await expect(picker.getByRole("menuitem", { name: /^Lovelace/ })).toHaveCount(0);
  } finally {
    await app.evaluate(() => globalThis.releaseWindowList());
  }
  await expect(
    picker.getByRole("menuitem", { name: "Lovelace · shell-fixture", exact: true }),
  ).toBeFocused();
});

test("long repository hints leave the window move trigger clickable", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const source = await boardPage(app);
  const destination = await newBoard(app, source);
  const name = "W".repeat(120);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const repository = path.join(profile, name);
  await git(["init", "-q", repository]);
  await app.evaluate(({ dialog }, repository) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
  }, repository);
  await destination.getByRole("button", { name: "Add repository", exact: true }).press("Enter");
  const repo = destination.getByRole("treeitem", { name, exact: true });
  const expand = repo.getByRole("button", { name: `Expand ${name}`, exact: true });
  await expect(repo).toBeVisible();
  if (await expand.count()) await expand.press("Enter");
  await repo.getByRole("button", { name: "Actions for Main checkout", exact: true }).press("Enter");
  await destination.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  const occupied = '.terminal-tile[data-empty="false"]';
  await expect(destination.locator(occupied)).toHaveCount(1);
  await expect
    .poll(() => source.evaluate(() => window.desktop.windows.moves.list()))
    .toMatchObject([{ label: "Lovelace", repositories: [name] }]);

  await sizeTileBoard(app, source, 900, 700);
  await source.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  const trigger = source.getByRole("menuitem", { name: "Move to window", exact: true });
  const choice = source.getByRole("menuitem", { name: `Lovelace · ${name}`, exact: true });
  await expect(trigger).toBeVisible();
  const bounds = await trigger.boundingBox();
  assert.ok(bounds);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await source.mouse.move(x, y);
  await expect(choice).toBeVisible();
  const panel = await source.getByRole("dialog", { name: "Tile 1 menu" }).boundingBox();
  const flyout = await source
    .getByRole("menu", { name: "Move to window", exact: true })
    .boundingBox();
  assert.ok(panel && flyout);
  assert.ok(flyout.x + flyout.width <= panel.x || panel.x + panel.width <= flyout.x);
  // Keep the pointer stationary; a locator click would recheck its target.
  await source.mouse.down();
  await source.mouse.up();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(choice).toBeFocused();
  await expect(source.locator(occupied)).toHaveCount(1);
  await expect(destination.locator(occupied)).toHaveCount(1);
  await choice.click();
  await expect(source.locator(occupied)).toHaveCount(0);
  await expect(destination.locator(occupied)).toHaveCount(2);
});

test("at 300% the window picker drills in without covering tile commands", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const source = await boardPage(app);
  const destination = await newBoard(app, source);
  const occupied = '.terminal-tile[data-empty="false"]';
  await destination
    .getByRole("button", { name: "Actions for Main checkout", exact: true })
    .press("Enter");
  await destination.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(destination.locator(occupied)).toHaveCount(1);
  await expect
    .poll(() => source.evaluate(() => window.desktop.windows.moves.list()))
    .toMatchObject([{ label: "Lovelace", repositories: ["shell-fixture"] }]);
  await source.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "eclipse-dark" }));
  await expect(source.locator("html")).toHaveCSS("color-scheme", "dark");
  if (process.env.FOOM_SCREENSHOTS === "1") await prepareMenuCapture(source);
  await sizeTileBoard(app, source, 1280, 1024);
  // A resize can dismiss the tile menu after innerWidth has already changed.
  const resized = await source.evaluateHandle(() => {
    const state = { complete: false };
    window.addEventListener("resize", () => (state.complete = true), { once: true });
    return state;
  });
  const native = await app.browserWindow(source);
  await native.evaluate((window) => window.webContents.setZoomFactor(3));
  await native.dispose();
  await expect.poll(() => resized.evaluate((state) => state.complete)).toBe(true);
  await resized.dispose();
  await expect.poll(() => source.evaluate(() => innerWidth)).toBeLessThanOrEqual(427);

  await source.getByRole("button", { name: "Tile 1 menu", exact: true }).press("Enter");
  const trigger = source.getByRole("menuitem", { name: "Move to window", exact: true });
  await trigger.evaluate((button) => button.scrollIntoView({ block: "end" }));
  await trigger.hover();
  const neighbor = source.getByRole("menuitem", { name: "Move to new window", exact: true });
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(neighbor).toBeVisible();
  await expect(source.locator(".row-submenu")).toHaveCount(0);
  // Click at the existing pointer position to detect a changed hit target after hover.
  await source.mouse.down();
  await source.mouse.up();
  const panel = source.getByRole("dialog", { name: "Tile 1 menu" });
  const picker = panel.getByRole("menu", { name: "Move to window", exact: true });
  const back = picker.getByRole("menuitem", { name: "Back", exact: true });
  const choice = picker.getByRole("menuitem", { name: "Lovelace · shell-fixture", exact: true });
  await expect(back).toBeFocused();
  await expect(choice).toBeVisible();
  await expect(neighbor).toHaveCount(0);
  await expect(source.locator(".row-submenu")).toHaveCount(0);
  if (process.env.FOOM_SCREENSHOTS === "1") {
    await waitForMenuFrame(source);
    const window = await app.browserWindow(source);
    try {
      const screenshot = await window.evaluate(async (window) =>
        (await window.webContents.capturePage()).toPNG().toString("base64"),
      );
      await writeFile(
        evidencePath("screenshots-1370/move-to-window-dark.png"),
        Buffer.from(screenshot, "base64"),
      );
    } finally {
      await window.dispose();
    }
  }
  await back.click();
  await expect(trigger).toBeFocused();
  await source.keyboard.press("ArrowRight");
  await expect(back).toBeFocused();
  await expect(choice).toBeEnabled();
  await source.keyboard.press("ArrowDown");
  await expect(choice).toBeFocused();
  await source.keyboard.press("ArrowLeft");
  await expect(trigger).toBeFocused();
  await source.keyboard.press("Enter");
  await expect(choice).toBeVisible();
  const bounds = await choice.boundingBox();
  assert.ok(bounds);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  // Use a coordinate click so a missed hit cannot turn into a locator retry.
  await source.mouse.move(x, y, { steps: 30 });
  await source.mouse.down();
  await source.mouse.up();
  await expect(destination.locator(occupied)).toHaveCount(2);
  await expect(source.locator(occupied)).toHaveCount(0);
  assert.equal(app.windows().filter((page) => page.url() === source.url()).length, 2);
});

test("previews move to existing boards at drop edges with identity, network reset and live reload", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const first = await boardPage(app);
  const root = (await first.evaluate(() => window.desktop.workspace())).repositories[0].path;
  const file = path.join(root, "window-move.html");
  await writeFile(file, "<!doctype html><h1>Before transfer</h1>");
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await first.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
  await first.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
  await expect(first.locator('.terminal-tile[data-kind="preview"]')).toBeVisible();
  const id = (await first.evaluate(() => window.desktop.sidebarInventory())).previews[0].id;
  const allowing = first.evaluate((id) => window.desktop.previews.network(id, true), id);
  const dialog = await confirmationPage(app);
  await dialog.getByRole("button", { name: "Allow network", exact: true }).click();
  await allowing;
  const second = await newBoard(app, first);
  const target = (await first.evaluate(() => window.desktop.windows.moves.list()))[0];
  await menuMove(first, first.locator(`[data-preview-id="${id}"]`), target.label);
  await expect(second.locator(`[data-preview-id="${id}"]`)).toBeVisible();
  await expect(first.locator(`[data-preview-id="${id}"]`)).toHaveCount(0);
  await expect
    .poll(
      async () => (await first.evaluate(() => window.desktop.windows.moves.list()))[0].repositories,
    )
    .toEqual(["shell-fixture"]);
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await dragMove(second, `[data-drag-preview="${id}"]`, first);
  await expect(first.locator(`[data-preview-id="${id}"]`)).toBeVisible();
  await expect(second.locator(`[data-preview-id="${id}"]`)).toHaveCount(0);
  // Occupy a destination leaf, then split at its right edge.
  await second.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
  await second.getByRole("menuitem", { name: /^Shell \(/ }).click();
  await expect(second.locator('.terminal-tile[data-empty="false"]')).toHaveCount(1);
  await dragMove(first, ".tile-title", second, "right");
  await expect(second.locator('.terminal-tile[data-empty="false"]')).toHaveCount(2);
  await expect(first.locator(`[data-preview-id="${id}"]`)).toHaveCount(0);
  const moved = (await second.evaluate(() => window.desktop.sidebarInventory())).previews.find(
    (preview) => preview.id === id,
  );
  assert.equal(moved.network, false);
  await writeFile(file, "<!doctype html><h1>After transfer</h1>");
  await pollPreviewContents(app, id, "document.querySelector('h1')?.textContent").toBe(
    "After transfer",
  );
  await assertAccessible(second);
});
