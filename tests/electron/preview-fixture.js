const assert = require("node:assert/strict");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
const { deadline, expect } = require("./test-policy.js");
const { boardPage, launchApp } = require("./harness.js");

// Shared preview helpers register no tests; each caller owns its isolated app and cleanup.
async function pickPreviewFile(app, page, root, file) {
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    },
    path.join(root, file),
  );
  return page.evaluate((root) => window.desktop.previews.pick(root), root);
}

// app.evaluate has no operation timeout. Bound native probes as well as renderer
// commands so a stranded Electron promise reports its phase before the watchdog.
async function previewStep(name, run) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Preview step timed out: ${name}`)),
          deadline(10_000),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function previewContents(app, id, code, { requireAttached = false } = {}) {
  return previewStep(`evaluate ${id}: ${code}`, () =>
    app.evaluate(
      async ({ BrowserWindow, webContents }, { id, code, requireAttached }) => {
        const current = () =>
          webContents
            .getAllWebContents()
            .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
        const contents = current();
        const ready = () => {
          return (
            !contents.isDestroyed() &&
            current() === contents &&
            !contents.isLoading() &&
            BrowserWindow.getAllWindows().some((board) =>
              board.contentView.children.some((view) => view.webContents === contents),
            )
          );
        };
        if (!contents) {
          if (requireAttached) return undefined;
          throw new Error("Missing preview contents");
        }
        if (requireAttached && !ready()) return undefined;
        let onDestroyed;
        const onNavigation = (event) => {
          if (event.isMainFrame && !event.isSameDocument) onDestroyed();
        };
        const destroyed = new Promise((resolve) => {
          onDestroyed = () => resolve(undefined);
          contents.once("destroyed", onDestroyed);
          contents.on("did-start-navigation", onNavigation);
        });
        try {
          // The host replaces contents on navigation; executeJavaScript can stay
          // pending forever when its IPC reply target is destroyed.
          const evaluate = () => {
            if (!contents.isLoading()) return contents.executeJavaScript(code);
            contents.debugger.attach("1.3");
            return contents.debugger
              .sendCommand("Runtime.evaluate", { expression: code, returnByValue: true })
              .then((result) => result.result.value)
              .finally(() => {
                if (!contents.isDestroyed() && contents.debugger.isAttached())
                  contents.debugger.detach();
              });
          };
          const value = await Promise.race([evaluate(), destroyed]);
          // Replacement can happen while the renderer command is in flight. The
          // next poll resolves the new contents and its main-process load signal.
          if (contents.isDestroyed() || current() !== contents || (requireAttached && !ready()))
            return undefined;
          return value;
        } catch (error) {
          // A command can reject as navigation starts, before destruction fires.
          if (contents.isDestroyed() || current() !== contents || (requireAttached && !ready()))
            return undefined;
          throw error;
        } finally {
          contents.removeListener("destroyed", onDestroyed);
          contents.removeListener("did-start-navigation", onNavigation);
        }
      },
      { id, code, requireAttached },
    ),
  );
}

async function previewViewState(app, id) {
  return previewStep(`native view state ${id}`, () =>
    app.evaluate(({ BrowserWindow, webContents }, id) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
      const view = board.contentView.children.find((view) => view.webContents === contents);
      return {
        contentsId: contents?.id,
        attached: Boolean(view),
        visible: view?.getVisible(),
        focused: contents?.isFocused(),
        loading: contents?.isLoading(),
        bounds: view?.getBounds(),
        zoom: contents?.getZoomFactor(),
      };
    }, id),
  );
}

// Resolve the native first responder for every key. Targeting the board via CDP
// would conceal a WebContentsView stealing focus. The events then traverse xterm
// and the real PTY; the page also counts every key it receives.
async function typeIntoFocusedContents(app, text, allowNoFocus = false) {
  for (const key of text) {
    await app.evaluate(
      ({ webContents }, { key, allowNoFocus }) => {
        const contents = webContents.getFocusedWebContents();
        if (!contents && allowNoFocus) return;
        if (!contents) throw new Error("No native keyboard target");
        contents.sendInputEvent({ type: "keyDown", keyCode: key });
        contents.sendInputEvent({ type: "char", keyCode: key });
        contents.sendInputEvent({ type: "keyUp", keyCode: key });
      },
      { key, allowNoFocus },
    );
  }
}

async function composedPreview(context, borderWidth = 1, content, file = "overlay.html") {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
  await writeFile(
    path.join(terminal.worktree, file),
    content ??
      `<style>html,body{margin:0;background:#123456;height:100%}</style><input style="height:70px;width:90%"><script>window.pointerCount=0;addEventListener('pointerdown',()=>window.pointerCount++);window.keys=[];addEventListener('keydown',e=>window.keys.push(e.key));</script>`,
  );
  const id = await pickPreviewFile(app, page, terminal.worktree, file);
  await page.evaluate(
    ({ id, session }) => {
      localStorage.setItem(
        `foom.tiles.v1.${window.desktop.windows.id}`,
        JSON.stringify({
          version: 2,
          focused: "preview",
          tree: {
            kind: "split",
            id: "columns",
            direction: "horizontal",
            ratio: 0.5,
            first: { kind: "tile", id: "shell", content: { kind: "terminal", session } },
            second: { kind: "tile", id: "preview", content: { kind: "preview", preview: id } },
          },
        }),
      );
    },
    { id, session: terminal.id },
  );
  await page.reload();
  const tile = page.locator('[data-tile="preview"]');
  await expect(tile).toHaveAttribute("data-kind", "preview");
  await tile.evaluate((element, width) => {
    element.style.borderWidth = `${width}px`;
  }, borderWidth);
  const bounds = await tile.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const title = element.querySelector(".tile-title").getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight);
    const bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
    return {
      x: rect.left + left,
      y: title.bottom,
      width: rect.width - left - right,
      height: rect.bottom - title.bottom - bottom,
      visible: true,
    };
  });
  await page.evaluate(({ id, bounds }) => window.desktop.previews.bounds(id, bounds), {
    id,
    bounds,
  });
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  return { app, page, id, tile, bounds };
}

async function movePreviewTile(app, source, id, inspect) {
  let before;
  await expect
    .poll(async () => {
      const state = await previewViewState(app, id);
      before = state.contentsId;
      return state.attached && !state.loading;
    })
    .toBe(true);
  const boards = app.windows().filter((page) => page.url() === "app://bundle/index.html");
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
  try {
    await expect(target.locator(`[data-preview-id="${id}"]`)).toBeVisible();
    await expect(source.locator(`[data-preview-id="${id}"]`)).toHaveCount(0);
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow, webContents }, { id, before }) => {
            const contents = webContents
              .getAllWebContents()
              .filter((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
            return (
              contents.length === 1 &&
              contents[0].id !== before &&
              !contents[0].isLoading() &&
              !contents[0].isFocused() &&
              !webContents.fromId(before) &&
              BrowserWindow.getAllWindows().filter((board) =>
                board.contentView.children.some((view) => view.webContents === contents[0]),
              ).length === 1
            );
          },
          { id, before },
        ),
      )
      .toBe(true);
    // The old board cannot close or move a foreign preview after the transfer.
    assert.equal(
      await source.evaluate(async (id) => {
        try {
          await window.desktop.previews.close(id);
          return "accepted";
        } catch {
          return "rejected";
        }
      }, id),
      "rejected",
    );
    await inspect(target);
  } finally {
    if (!target.isClosed()) {
      await target.evaluate(() => window.desktop.appMenu.execute("close-window"));
      await expect.poll(() => target.isClosed()).toBe(true);
    }
  }
}

module.exports = {
  pickPreviewFile,
  previewStep,
  previewContents,
  previewViewState,
  typeIntoFocusedContents,
  composedPreview,
  movePreviewTile,
};
