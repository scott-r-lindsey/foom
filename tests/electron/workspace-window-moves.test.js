const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");
const { deadline, expect } = require("./test-policy.js");
const { assertAccessible, boardPage, confirmationPage, launchApp } = require("./harness.js");
const { previewContents, previewViewState } = require("./preview-fixture.js");

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
    await first.locator(".row-submenu").evaluate(async (menu) => {
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
  await expect
    .poll(() =>
      previewContents(app, id, "document.querySelector('h1')?.textContent", {
        requireAttached: true,
      }),
    )
    .toBe("After transfer");
  await assertAccessible(second);
});
