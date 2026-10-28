const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
const { expect } = require("./test-policy.js");
const { boardPage, confirmationPage, launchApp } = require("./harness.js");
const { previewContents, previewViewState, movePreviewTile } = require("./preview-fixture.js");

async function movedPreviewPixels(app, id) {
  return app.evaluate(async ({ BrowserWindow, desktopCapturer, screen }, id) => {
    const board = BrowserWindow.getAllWindows().find((board) =>
      board.contentView.children.some((view) =>
        view.webContents.getURL().startsWith(`foom-preview://${id}/`),
      ),
    );
    if (!board) return [];
    const view = board.contentView.children.find((view) =>
      view.webContents.getURL().startsWith(`foom-preview://${id}/`),
    );
    const bounds = board.getContentBounds(),
      rect = view.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      },
    });
    const image = sources.find((source) => source.display_id === String(display.id))?.thumbnail;
    if (!image || image.isEmpty()) return [];
    const scale = image.getSize().width / display.bounds.width;
    return Array.from(
      image
        .crop({
          x: Math.round((bounds.x + rect.x + rect.width / 2 - display.bounds.x) * scale),
          y: Math.round((bounds.y + rect.y + rect.height / 2 - display.bounds.y) * scale),
          width: 1,
          height: 1,
        })
        .toBitmap(),
    ).slice(0, 3);
  }, id);
}

for (const kind of ["html", "markdown"]) {
  test(`user ${kind} preview moves to a fresh window, resets network and keeps live reload`, async (context) => {
    const app = await launchApp(context, { fixture: "repository" });
    const page = await boardPage(app);
    await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "eclipse-dark" }));
    const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
    const file = kind === "html" ? "move.html" : "move.md";
    const document = (text) =>
      kind === "html"
        ? `<style>html,body{margin:0;background:#123456;height:100%}</style><h1>${text}</h1><input autofocus>`
        : `# ${text}\n`;
    await writeFile(path.join(root, file), document("Before move"));
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      },
      path.join(root, file),
    );
    await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    await expect(page.locator('.terminal-tile[data-kind="preview"]')).toBeVisible();
    const id = (await page.evaluate(() => window.desktop.sidebarInventory())).previews.find(
      (preview) => preview.relativePath === file,
    ).id;
    await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
    const allowing = page.evaluate((id) => window.desktop.previews.network(id, true), id);
    const dialog = await confirmationPage(app);
    await dialog.getByRole("button", { name: "Allow network", exact: true }).click();
    await allowing;
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.desktop.sidebarInventory())).previews.find(
            (preview) => preview.id === id,
          )?.network,
      )
      .toBe(true);
    await movePreviewTile(app, page, id, async (target) => {
      assert.equal(
        (await target.evaluate(() => window.desktop.sidebarInventory())).previews.find(
          (preview) => preview.id === id,
        ).network,
        false,
      );
      await expect
        .poll(() =>
          previewContents(app, id, "document.querySelector('h1')?.textContent", {
            requireAttached: true,
          }),
        )
        .toBe("Before move");
      await expect
        .poll(() => movedPreviewPixels(app, id))
        .toEqual(kind === "html" ? [86, 52, 18] : [10, 4, 5]);
      await writeFile(path.join(root, file), document("After move"));
      await expect
        .poll(() =>
          previewContents(app, id, "document.querySelector('h1')?.textContent", {
            requireAttached: true,
          }),
        )
        .toBe("After move");
      await expect
        .poll(() => movedPreviewPixels(app, id))
        .toEqual(kind === "html" ? [86, 52, 18] : [10, 4, 5]);
      await target.evaluate((id) => window.desktop.previews.close(id), id);
      await expect(target.locator(`[data-preview-id="${id}"]`)).toHaveCount(0);
    });
  });
}

for (const scenario of ["never arriving", "delayed", "closed before showing"]) {
  test(`moved HTML preview survives ${scenario} destination placement`, async (context) => {
    const app = await launchApp(context, { fixture: "repository" });
    const source = await boardPage(app);
    const root = (await source.evaluate(() => window.desktop.workspace())).repositories[0].path;
    const file = path.join(root, "recover-move.html");
    await writeFile(file, "<!doctype html><h1>Recoverable move</h1>");
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await source.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
    await source.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    await expect(source.locator('.terminal-tile[data-kind="preview"]')).toBeVisible();
    const id = (await source.evaluate(() => window.desktop.sidebarInventory())).previews[0].id;
    await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
    const boards = app.windows();
    // Delay only the placement message. The destination still boots a real board,
    // publishes inventory, validates IPC and hosts an isolated native preview.
    await app.evaluate(({ app }) => {
      app.once("browser-window-created", (_event, board) => {
        const send = board.webContents.send.bind(board.webContents);
        const held = [];
        board.webContents.send = (channel, ...args) => {
          if (channel === "preview:place") held.push([channel, ...args]);
          else send(channel, ...args);
        };
        globalThis.releaseMovedPlacement = () => {
          for (const args of held.splice(0)) send(...args);
        };
      });
    });
    await source
      .locator(`[data-preview-id="${id}"]`)
      .getByRole("button", { name: /Tile \d+ menu/ })
      .click();
    await source.getByRole("menuitem", { name: "Move to new window", exact: true }).click();
    let target;
    await expect
      .poll(() => {
        target = app
          .windows()
          .find((page) => !boards.includes(page) && page.url() === "app://bundle/index.html");
        return Boolean(target);
      })
      .toBe(true);
    await expect
      .poll(async () =>
        (await target.evaluate(() => window.desktop.sidebarInventory())).previews.some(
          (preview) => preview.id === id,
        ),
      )
      .toBe(true);
    await expect(source.locator(`[data-preview-id="${id}"]`)).toHaveCount(0);
    if (scenario === "closed before showing") {
      await target.evaluate(() => window.desktop.appMenu.execute("close-window"));
      await expect.poll(() => target.isClosed()).toBe(true);
      await expect(source.locator(`[data-preview-id="${id}"]`)).toBeVisible();
      await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
      assert.equal(
        (await source.evaluate(() => window.desktop.sidebarInventory())).previews[0].id,
        id,
      );
    } else {
      // No renderer bounds can arrive without placement. Main must display a
      // loaded view after its own deadline, independently of the renderer.
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }, id) => {
            return BrowserWindow.getAllWindows().some((board) =>
              board.contentView.children.some(
                (view) =>
                  view.webContents.getURL().startsWith(`foom-preview://${id}/`) &&
                  !view.webContents.isLoading() &&
                  view.getVisible() &&
                  view.getBounds().width > 0,
              ),
            );
          }, id),
        )
        .toBe(true);
      assert.equal(
        await app.evaluate(async ({ webContents }, id) => {
          const preview = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(`foom-preview://${id}/`));
          return preview?.executeJavaScript("document.body.innerText");
        }, id),
        "Recoverable move",
      );
      if (scenario === "delayed") {
        await app.evaluate(() => globalThis.releaseMovedPlacement());
        await expect(target.locator(`[data-preview-id="${id}"]`)).toBeVisible();
      }
      await target.evaluate(() => window.desktop.appMenu.execute("close-window"));
      await expect.poll(() => target.isClosed()).toBe(true);
      await expect
        .poll(
          async () =>
            (await source.evaluate(() => window.desktop.sidebarInventory())).previews.length,
        )
        .toBe(0);
    }
  });
}
