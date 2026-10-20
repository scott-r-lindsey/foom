const { gitSync: isolatedGit } = require("../helpers/git.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  assertAccessible,
  boardPage,
  confirmationPage,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

test("worktree panel previews pick contained Markdown and HTML, persist v2 tiles and close on removal", async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-panel-previews-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "checkout");
  const profile = path.join(root, "profile");
  await mkdir(repo);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  await writeFile(path.join(repo, "guide.md"), "# Panel Markdown\n\nLocal preview.\n");
  await writeFile(path.join(repo, "page.html"), "<!doctype html><h1>Panel HTML</h1>");
  git("add", ".");
  git("commit", "-qm", "preview fixtures");
  git("worktree", "add", "-b", "topic/preview", checkout);
  const options = {
    fixture: "empty-board",
    args: [`--user-data-dir=${profile}`],
    home: path.join(root, "home"),
  };
  let app = await launchApp(context, options);
  let page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Actions for topic/preview", exact: true }),
  ).toBeVisible();
  // A deliberate split establishes the landing spot before the first open.
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  const landing = await page.locator('[data-landing="true"]').getAttribute("data-tile");
  const ids = [];
  for (const file of ["guide.md", "page.html"]) {
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async (_window, options) => {
          globalThis.previewPickerOptions = options;
          // Native pickers can blur the pending command before their IPC resolves.
          await _window.webContents.executeJavaScript("document.activeElement?.blur()");
          return { canceled: false, filePaths: [file] };
        };
      },
      path.join(checkout, file),
    );
    await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    const tile = page.locator('.terminal-tile[data-kind="preview"]').filter({ hasText: file });
    await expect(tile).toBeVisible();
    if (file === "guide.md") assert.equal(await tile.getAttribute("data-tile"), landing);
    const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
    const preview = inventory.previews.find((preview) => preview.relativePath === file);
    assert.ok(preview);
    ids.push(preview.id);
    assert.equal(await app.evaluate(() => globalThis.previewPickerOptions.defaultPath), checkout);
    await expect(page.locator(".row-menu")).toHaveCount(0);
    await expect.poll(async () => (await previewViewState(app, preview.id)).attached).toBe(true);
    await expect
      .poll(() => previewContents(app, preview.id, "document.body.innerText"))
      .toContain(file === "guide.md" ? "Panel Markdown" : "Panel HTML");
    assert.equal((await previewViewState(app, preview.id)).focused, false);
  }
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)),
  );
  assert.equal(saved.version, 2);
  assert.equal(JSON.stringify(saved).includes(checkout), false);
  for (const id of ids) assert.ok(JSON.stringify(saved).includes(id));
  await writeFile(path.join(checkout, ".hidden.html"), "hidden");
  await writeFile(path.join(checkout, "unsupported.txt"), "unsupported");
  await writeFile(path.join(root, "outside.html"), "outside");
  for (const file of [
    path.join(root, "outside.html"),
    path.join(checkout, ".hidden.html"),
    path.join(checkout, "unsupported.txt"),
  ]) {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  }
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
  await page.getByRole("menuitem", { name: "Preview file…", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  app = await launchApp(context, { ...options, fixture: "restored" });
  page = await boardPage(app);
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
  for (const id of ids)
    await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await page.getByRole("button", { name: "Actions for topic/preview", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete worktree…", exact: true }).click();
  const removal = await confirmationPage(app);
  await removal.getByRole("button", { name: "Discard 2 changes and remove", exact: true }).click();
  await expect(page.locator(".preview-row")).toHaveCount(0);
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(0);
  await expect
    .poll(
      async () => (await page.evaluate(() => window.desktop.sidebarInventory())).previews.length,
    )
    .toBe(0);
  assert.equal(
    await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL().startsWith("foom-preview:")).length,
    ),
    0,
  );
});

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

test("Markdown previews render hostile documents safely, follow native theme and navigate to a sibling", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  // The malformed remote image port also exercises Chromium's rejected-resource
  // path. Electron 44's development security warnings may throw Invalid URL for
  // that performance entry; it does not invalidate the preview's document URL.
  const hostile = await readFile(path.join(__dirname, "../fixtures/previews/hostile.md"), "utf8");
  await writeFile(
    path.join(root, "document.md"),
    `${hostile}\n\n- [x] Done\n\n[Sibling](sibling.md)\n\n[External](https://example.com)`,
  );
  await writeFile(
    path.join(root, "sibling.md"),
    "# Sibling document\n\n```js\nconst answer = 42;\n```\n",
  );
  const id = await previewStep("open Markdown document", () =>
    pickPreviewFile(app, page, root, "document.md"),
  );
  const read = (code) => previewContents(app, id, code, { requireAttached: true });
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 350,
        y: 100,
        width: 400,
        height: 250,
        visible: true,
      }),
    id,
  );
  await expect
    .poll(
      async () => {
        const state = await previewViewState(app, id);
        return state.attached && !state.loading;
      },
      { message: "Markdown document attached and loaded" },
    )
    .toBe(true);
  assert.equal(await read('document.querySelector("h1")?.textContent'), "Hostile Markdown");
  assert.deepEqual(
    await read(
      `({
    pwned: window.__pwned ?? null,
    frames: document.querySelectorAll("iframe").length,
    handlers: [...document.querySelectorAll("*")].flatMap(element => element.getAttributeNames()).filter(name => /^on/i.test(name)),
    unsafe: [...document.querySelectorAll("a")].filter(link => /^(javascript|vbscript|data|file):/i.test(link.getAttribute("href"))).length,
    scripts: document.scripts.length,
    task: document.querySelector('input[type="checkbox"]')?.disabled,
    external: document.querySelector('a[href="https://example.com"]')?.className,
  })`,
    ),
    {
      pwned: null,
      frames: 0,
      handlers: [],
      unsafe: 0,
      scripts: 2,
      task: true,
      external: "external",
    },
  );
  for (const [mode, background] of [
    ["dark", "rgb(5, 4, 10)"],
    ["light", "rgb(243, 240, 250)"],
  ]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
    await expect
      .poll(() => read("getComputedStyle(document.documentElement).backgroundColor"))
      .toBe(background);
  }
  const oldContents = (await previewViewState(app, id)).contentsId;
  await read(`document.querySelector('a[href="sibling.md"]').click()`);
  await expect
    .poll(
      async () => {
        const state = await previewViewState(app, id);
        return state.attached && !state.loading && state.contentsId !== oldContents;
      },
      { message: "Sibling Markdown replacement attached and loaded" },
    )
    .toBe(true);
  assert.equal(await read('document.querySelector("h1")?.textContent'), "Sibling document");
  assert.equal(await read("location.pathname"), "/sibling.md");
  assert.equal(await read('document.querySelector(".hljs-keyword")?.textContent'), "const");
  assert.equal((await previewViewState(app, id)).focused, false);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
});

test("preview host loads and reloads detached, never steals terminal keystrokes, and focuses on a click", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
  const root = terminal.worktree;
  await writeFile(
    path.join(root, "grabby.html"),
    `<input id="grab" autofocus style="width:100%;height:100px"><img src="gate.svg"><script>
    window.stolen=""; window.attempts=0;
    addEventListener("keydown", event => { if(event.key.length===1) window.stolen+=event.key; });
    setInterval(()=>{window.attempts++; window.focus(); document.getElementById("grab").focus();},20);
  </script>`,
  );
  // Hold a real subresource response so typing demonstrably overlaps loading.
  await app.evaluate(({ app }) => {
    globalThis.previewFocusEvents = { focus: 0, blur: 0 };
    app.on("web-contents-created", (_event, contents) => {
      contents.on("focus", () => globalThis.previewFocusEvents.focus++);
      contents.on("blur", () => globalThis.previewFocusEvents.blur++);
    });
    app.on("session-created", (partition) => {
      const handle = partition.protocol.handle.bind(partition.protocol);
      partition.protocol.handle = (scheme, handler) =>
        handle(scheme, (request) => {
          if (!request.url.endsWith("/gate.svg")) return handler(request);
          globalThis.previewGateRequested = true;
          return new Promise((resolve) => {
            globalThis.releasePreviewGate = () =>
              resolve(
                new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
                  headers: { "content-type": "image/svg+xml", "cache-control": "no-store" },
                }),
              );
          });
        });
    });
  });
  await expect
    .poll(() => page.locator(".xterm-rows").innerText())
    .toMatch(process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/);
  await page.locator(".xterm-helper-textarea").focus();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.focus();
    window.webContents.focus();
  });
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe("app://bundle/index.html");
  const id = await pickPreviewFile(app, page, root, "grabby.html");
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 500,
        y: 150,
        width: 250,
        height: 200,
        visible: true,
      }),
    id,
  );
  await expect.poll(() => app.evaluate(() => globalThis.previewGateRequested)).toBe(true);
  assert.equal((await previewViewState(app, id)).attached, false);

  await expect.poll(() => previewContents(app, id, "window.attempts")).toBeGreaterThan(0);
  const keys = "a".repeat(100);
  await typeIntoFocusedContents(app, keys);
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id)).join(""),
    )
    .toContain(keys);
  assert.equal(await previewContents(app, id, "window.stolen"), "");
  await app.evaluate(() => globalThis.releasePreviewGate());
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await typeIntoFocusedContents(app, "b".repeat(100));
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id)).join(""),
    )
    .toContain(keys + "b".repeat(100));
  assert.equal(await previewContents(app, id, "window.stolen"), "");
  // A real mouse event on the native view grants focus; no focus IPC exists.
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents
      .getAllWebContents()
      .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
    contents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
  }, id);
  await expect.poll(async () => (await previewViewState(app, id)).focused).toBe(true);
  await typeIntoFocusedContents(app, "human");
  await expect.poll(() => previewContents(app, id, "window.stolen")).toBe("human");
  // Return native focus to the board first, then the terminal input inside it. macOS
  // moves native focus asynchronously, and the page may not restore its own focus.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .webContents.focus();
  });
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe("app://bundle/index.html");
  await page.locator(".xterm-helper-textarea").focus();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const oldContentsId = (await previewViewState(app, id)).contentsId;
  await app.evaluate(({ webContents }, id) => {
    globalThis.previewGateRequested = false;
    webContents
      .getAllWebContents()
      .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`))
      .reload();
  }, id);
  await expect.poll(() => app.evaluate(() => globalThis.previewGateRequested)).toBe(true);
  assert.equal((await previewViewState(app, id)).attached, false);
  assert.notEqual((await previewViewState(app, id)).contentsId, oldContentsId);
  const focusedUrl = () =>
    app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? "none");
  const focusBefore = await focusedUrl();
  await typeIntoFocusedContents(app, "c".repeat(100));
  const focusAfter = await focusedUrl();
  const reloadState = await previewViewState(app, id);
  const focusEvents = await app.evaluate(() => globalThis.previewFocusEvents);
  context.diagnostic(
    `reload state ${JSON.stringify(reloadState)}, focus events ${JSON.stringify(focusEvents)}, native focus ${focusBefore} -> ${focusAfter}`,
  );
  const boardActive = await page.evaluate(() => document.activeElement?.className ?? "none");
  await app.evaluate(() => globalThis.releasePreviewGate());
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await expect
    .poll(
      async () => (await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id)).join(""),
      {
        message: `keys typed during reload; native focus ${focusBefore} -> ${focusAfter}, board active element ${boardActive}`,
      },
    )
    .toContain(keys + "b".repeat(100) + "c".repeat(100));
  assert.equal(await previewContents(app, id, "window.stolen"), "");
  await page.evaluate((id) => window.desktop.previews.close(id), id);
});

test("preview host keeps keyboard focus after a user-clicked link navigation", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
  const root = terminal.worktree;
  await writeFile(
    path.join(root, "links.html"),
    '<a href="destination.md" style="display:block;width:200px;height:100px">Continue</a>',
  );
  await writeFile(path.join(root, "destination.md"), "Destination");
  await app.evaluate(({ app }) => {
    app.on("session-created", (partition) => {
      const handle = partition.protocol.handle.bind(partition.protocol);
      partition.protocol.handle = (scheme, handler) =>
        handle(scheme, (request) => {
          if (!request.url.endsWith("/destination.md")) return handler(request);
          globalThis.previewLinkRequested = true;
          return new Promise((resolve) => {
            globalThis.releasePreviewLink = () => resolve(handler(request));
          });
        });
    });
  });
  await page.locator(".xterm-helper-textarea").focus();
  const id = await pickPreviewFile(app, page, root, "links.html");
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 350,
        y: 100,
        width: 400,
        height: 250,
        visible: true,
      }),
    id,
  );
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  const oldContentsId = (await previewViewState(app, id)).contentsId;
  await expect
    .poll(() => page.locator(".xterm-rows").innerText())
    .toMatch(process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/);
  const terminalBefore = await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id);
  // Click the actual link with native mouse input, rather than invoking page script.
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents
      .getAllWebContents()
      .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
    contents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
  }, id);
  await expect.poll(() => app.evaluate(() => globalThis.previewLinkRequested)).toBe(true);
  assert.equal((await previewViewState(app, id)).attached, false);
  const nativeFocus = await app.evaluate(({ webContents }) =>
    webContents.getFocusedWebContents()?.getURL(),
  );
  const domFocus = await page.evaluate(() => document.activeElement?.className);
  context.diagnostic(`handoff native focus ${nativeFocus}, board DOM focus ${domFocus}`);
  await typeIntoFocusedContents(app, "gap", true);
  // Exercise native board fallback even on platforms which leave no responder.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .webContents.focus();
  });
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe("app://bundle/index.html");
  await typeIntoFocusedContents(app, "blocked");
  await app.evaluate(() => globalThis.releasePreviewLink());
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await expect
    .poll(async () => (await previewViewState(app, id)).contentsId)
    .not.toBe(oldContentsId);
  await expect.poll(async () => (await previewViewState(app, id)).focused).toBe(true);
  assert.equal(await previewContents(app, id, "location.pathname"), "/destination.md");
  await previewContents(
    app,
    id,
    'window.received=""; addEventListener("keydown", event => { window.received+=event.key; });',
  );
  await typeIntoFocusedContents(app, "preview");
  await expect.poll(() => previewContents(app, id, "window.received")).toBe("preview");
  assert.deepEqual(
    await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id),
    terminalBefore,
  );
  // A deliberate terminal click during another handoff restores ordinary input.
  await app.evaluate(({ webContents }, id) => {
    globalThis.previewLinkRequested = false;
    webContents
      .getAllWebContents()
      .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`))
      .reload();
  }, id);
  await expect.poll(() => app.evaluate(() => globalThis.previewLinkRequested)).toBe(true);
  const terminalBounds = await page.locator(".xterm-screen").boundingBox();
  assert.ok(terminalBounds);
  await app.evaluate(({ BrowserWindow }, bounds) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    ).webContents;
    contents.focus();
    const mouse = {
      x: Math.round(bounds.x + 10),
      y: Math.round(bounds.y + bounds.height - 10),
      button: "left",
      clickCount: 1,
    };
    contents.sendInputEvent({ type: "mouseDown", ...mouse });
    contents.sendInputEvent({ type: "mouseUp", ...mouse });
  }, terminalBounds);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe("app://bundle/index.html");
  await typeIntoFocusedContents(app, "cancelled");
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id)).join(""),
    )
    .toContain("cancelled");
  await app.evaluate(() => globalThis.releasePreviewLink());
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  assert.equal((await previewViewState(app, id)).focused, false);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
});

// Each response stays pending until app teardown: no network or elapsed-time mock.
async function stuckPreviewHandoff(context, cancellation) {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
  await writeFile(
    path.join(terminal.worktree, "stuck.html"),
    '<a href="never.md" style="display:block;width:200px;height:100px">Continue</a>',
  );
  await writeFile(path.join(terminal.worktree, "never.md"), "Never loaded");
  await app.evaluate(({ app }) => {
    app.on("session-created", (partition) => {
      const handle = partition.protocol.handle.bind(partition.protocol);
      partition.protocol.handle = (scheme, handler) =>
        handle(scheme, (request) => {
          if (!request.url.endsWith("/never.md")) return handler(request);
          globalThis.stuckPreviewRequested = true;
          return new Promise(() => {});
        });
    });
  });
  await expect
    .poll(() => page.locator(".xterm-rows").innerText())
    .toMatch(process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/);
  await page.locator(".xterm-helper-textarea").focus();
  const before = await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id);
  const id = await pickPreviewFile(app, page, terminal.worktree, "stuck.html");
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 350,
        y: 100,
        width: 400,
        height: 250,
        visible: true,
      }),
    id,
  );
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents
      .getAllWebContents()
      .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
    contents.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 });
  }, id);
  await expect.poll(() => app.evaluate(() => globalThis.stuckPreviewRequested)).toBe(true);
  // Exercise board fallback while its terminal textarea still holds DOM focus.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .webContents.focus();
  });
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe("app://bundle/index.html");
  await typeIntoFocusedContents(app, "gap");
  if (cancellation === "Escape") {
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getFocusedWebContents();
      contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    });
  }
  await expect(page.locator(".xterm-helper-textarea")).not.toBeFocused();
  assert.equal((await previewViewState(app, id)).attached, false);
  await typeIntoFocusedContents(app, "after");
  // A real main-process shortcut works without any intervening mouse click.
  const collapsed = await page
    .locator(".sidebar-shell")
    .evaluate((element) => element.getAttribute("data-compact") === "true");
  await app.evaluate(({ webContents }) => {
    const contents = webContents.getFocusedWebContents();
    const modifiers = process.platform === "darwin" ? ["meta"] : ["control", "shift"];
    contents.sendInputEvent({ type: "keyDown", keyCode: "B", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "B", modifiers });
  });
  await expect
    .poll(() =>
      page
        .locator(".sidebar-shell")
        .evaluate((element) => element.getAttribute("data-compact") === "true"),
    )
    .toBe(!collapsed);
  assert.deepEqual(await page.evaluate((id) => window.desktop.tail(id, 20), terminal.id), before);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
}

test("preview handoff Escape restores board keyboard input during a never-finishing local load", async (context) => {
  await stuckPreviewHandoff(context, "Escape");
});

test("preview handoff deadline restores board keyboard input during a never-finishing local load", async (context) => {
  await stuckPreviewHandoff(context, "deadline");
});

test("preview host isolates hostile pages, blocks network and navigation, scales bounds and clears closed partitions", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  const server = require("node:http").createServer((_request, response) =>
    response.end("unwanted"),
  );
  let connections = 0;
  server.on("connection", () => connections++);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const external = `http://127.0.0.1:${server.address().port}/`;
  await writeFile(
    path.join(root, "hostile.html"),
    `<input id="input"><a id="external" href="${external}">external</a><a id="html" href="other.html">html</a><script>
    window.probes={ bridge: typeof window.desktop, require: typeof require, process: typeof process, electron: typeof electron, ipc: typeof ipcRenderer, top: top===window };
    window.popup=window.open("${external}")===null;
    window.networkFinished=false; Promise.allSettled([fetch("${external}"), fetch("file:///etc/passwd"), fetch("app://bundle/index.html")]).then(()=>window.networkFinished=true);
    window.geo="pending"; navigator.geolocation.getCurrentPosition(()=>window.geo="allowed", error=>window.geo=error.code);
    localStorage.setItem("private", "secret");
  </script>`,
  );
  await writeFile(
    path.join(root, "clean.html"),
    '<input><script>window.privateValue=localStorage.getItem("private")</script>',
  );
  const baseline = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  const id = await pickPreviewFile(app, page, root, "hostile.html");
  const clean = await pickPreviewFile(app, page, root, "clean.html");
  for (const preview of [id, clean]) {
    await page.evaluate(
      (id) =>
        window.desktop.previews.bounds(id, {
          x: 400,
          y: 100,
          width: 250,
          height: 180,
          visible: true,
        }),
      preview,
    );
  }
  // The hostile page's window.open asks for review at once; the trusted scrim
  // covers previews (#292) until it is answered, so answer before attaching.
  const linkDialog = await confirmationPage(app);
  await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toBeVisible();
  await linkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
  for (const preview of [id, clean])
    await expect.poll(async () => (await previewViewState(app, preview)).attached).toBe(true);
  assert.deepEqual(await previewContents(app, id, "window.probes"), {
    bridge: "undefined",
    require: "undefined",
    process: "undefined",
    electron: "undefined",
    ipc: "undefined",
    top: true,
  });
  assert.equal(await previewContents(app, id, "window.popup"), true);
  assert.equal(await previewContents(app, clean, "window.privateValue"), null);
  await expect.poll(() => previewContents(app, id, "window.networkFinished")).toBe(true);
  await expect.poll(() => previewContents(app, id, "window.geo")).toBe(1);
  assert.equal(connections, 0);
  // Observe actual navigation prevention, rather than waiting an arbitrary interval.
  for (const link of ["external", "html"]) {
    const prevented = await app.evaluate(
      ({ webContents }, { id, link }) => {
        const wc = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
        return new Promise((resolve) => {
          wc.once("will-frame-navigate", (event) => resolve(event.defaultPrevented));
          void wc.executeJavaScript(`document.getElementById(${JSON.stringify(link)}).click()`);
        });
      },
      { id, link },
    );
    assert.equal(prevented, true);
    if (link === "external") {
      await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toBeVisible();
      await linkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(linkDialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
    }
  }
  assert.equal(connections, 0);
  assert.deepEqual((await previewViewState(app, id)).bounds, {
    x: 400,
    y: 100,
    width: 250,
    height: 180,
  });
  await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 150 }));
  await expect
    .poll(async () => (await previewViewState(app, id)).bounds)
    .toEqual({ x: 600, y: 150, width: 375, height: 270 });
  assert.equal((await previewViewState(app, id)).zoom, 1.5);
  // The scaled minimum window size prevents shrinking the window, so move the
  // preview past the right edge instead; main clamps it to the content bounds.
  const contentWidth = await app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getContentBounds().width,
  );
  const edge = Math.floor(contentWidth / 1.5) - 100;
  await page.evaluate(
    ({ id, edge }) =>
      window.desktop.previews.bounds(id, {
        x: edge,
        y: 100,
        width: 250,
        height: 180,
        visible: true,
      }),
    { id, edge },
  );
  assert.equal(
    (await previewViewState(app, id)).bounds?.width,
    contentWidth - Math.round(edge * 1.5),
  );
  const count = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  assert.equal(count, baseline + 2);
  await app.evaluate(({ session }, id) => {
    globalThis.closedPreviewPartition = session.fromPartition(`preview-${id}`);
  }, id);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  assert.equal(
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().length),
    baseline + 1,
  );
  assert.equal(
    await app.evaluate(() =>
      globalThis.closedPreviewPartition.protocol.isProtocolHandled("foom-preview"),
    ),
    false,
  );
  assert.deepEqual(
    await app.evaluate(async () => {
      const cookies = await globalThis.closedPreviewPartition.cookies.get({});
      return { cookies, usage: await globalThis.closedPreviewPartition.getStoragePath() };
    }),
    { cookies: [], usage: null },
  );
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  assert.deepEqual(
    inventory.previews.map((entry) => entry.id),
    [clean],
  );
  await page.evaluate((id) => window.desktop.previews.close(id), clean);
  assert.equal(
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().length),
    baseline,
  );
});

test("an agent fixture opens full-board previews in columns, retains focus and respects human close", {
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { chmod, symlink } = require("node:fs/promises");
  const { existsSync } = require("node:fs");
  const root = await mkdtemp(path.join(tmpdir(), "foom-agent-preview-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const home = path.join(root, "home");
  for (const directory of [bin, repo, home]) await mkdir(directory);
  await writeFile(path.join(bin, "claude"), FAKE_ORCHESTRATED_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  await symlink(process.execPath, path.join(bin, "node"));
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(
    path.join(repo, "grabby.html"),
    `<input autofocus><script>window.stolen=""; window.attempts=0; addEventListener("keydown", event => window.stolen+=event.key); setInterval(() => { window.attempts++; window.focus(); document.querySelector("input").focus(); },20);</script>`,
  );
  await writeFile(path.join(repo, "notes.md"), "# Agent notes");
  await writeFile(path.join(repo, "narrow.md"), "# Narrow notes");
  const credentials = path.join(root, "credentials");
  const app = await launchApp(context, {
    fixture: "running-shell",
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    env: {
      HOME: home,
      PATH: bin,
      TEST_FAKE_CREDENTIALS: credentials,
    },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  await page.evaluate(async () => {
    const repo = await window.desktop.addRepository();
    await window.desktop.sidebarCommand({
      kind: "launch",
      repository: repo.path,
      worktree: repo.path,
      run: "claude",
    });
  });
  await expect.poll(() => existsSync(`${credentials}.app`)).toBe(true);
  let terminals;
  await expect
    .poll(async () => {
      terminals = (await page.evaluate(() => window.desktop.workspace())).terminals;
      return terminals.some((row) => row.agent === "claude");
    })
    .toBe(true);
  const agent = terminals.find((row) => row.agent === "claude");
  const shell = terminals.find((row) => row.kind === "shell");
  assert.ok(agent && shell);
  await expect
    .poll(async () => (await page.evaluate((id) => window.desktop.tail(id, 20), agent.id)).join(""))
    .toContain("FOOM_AGENT_READY");
  await page.evaluate(
    ({ shellId }) => {
      const key = `foom.tiles.v1.${window.desktop.windows.id}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          tree: {
            kind: "split",
            id: "pair",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              kind: "tile",
              id: "terminal",
              content: { kind: "terminal", session: shellId },
            },
            second: { kind: "tile", id: "landing", content: null },
          },
          focused: "terminal",
          maximized: null,
          landing: "landing",
        }),
      );
    },
    { shellId: shell.id },
  );
  await page.reload();
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeVisible();
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  await app.evaluate(({ BrowserWindow }) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    board.setContentSize(2400, 900);
    board.focus();
    board.webContents.focus();
  });
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe("app://bundle/index.html");
  await page.evaluate(
    ({ id }) =>
      window.desktop.input(
        id,
        JSON.stringify({ id: "preview", args: ["open-preview", "grabby.html", "--json"] }) + "\n",
      ),
    { id: agent.id },
  );
  await expect.poll(() => existsSync(`${credentials}.response-preview`)).toBe(true);
  const response = JSON.parse(await readFile(`${credentials}.response-preview`, "utf8"));
  assert.equal(response.code, 0, response.stderr);
  const result = JSON.parse(response.stdout).result;
  assert.equal(result.placement, "landing");
  assert.equal(result.reused, false);
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-kind", "preview");
  await expect(page.locator('[data-tile="terminal"]')).toHaveAttribute("data-focused", "true");
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-arrived", "true");
  await expect(page.locator('[data-tile="landing"] .preview-opener')).toHaveText("opened byCC");
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute(
    "aria-label",
    /opened by Claude Code/,
  );
  const requestPreview = async (requestId, file) => {
    await page.evaluate(
      ({ id, requestId, file }) =>
        window.desktop.input(
          id,
          JSON.stringify({ id: requestId, args: ["open-preview", file, "--json"] }) + "\n",
        ),
      { id: agent.id, requestId, file },
    );
    await expect.poll(() => existsSync(`${credentials}.response-${requestId}`)).toBe(true);
    const response = JSON.parse(await readFile(`${credentials}.response-${requestId}`, "utf8"));
    assert.equal(response.code, 0, response.stderr);
    return JSON.parse(response.stdout).result;
  };
  await expect
    .poll(() => page.locator(".tile-area").evaluate((area) => area.clientWidth))
    .toBeGreaterThan(2000);
  const before = await page.locator('[data-tile="terminal"]').boundingBox();
  const columnResult = await requestPreview("notes", "notes.md");
  assert.equal(columnResult.placement, "column");
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
  await expect
    .poll(async () => (await previewViewState(app, columnResult.previewId)).attached)
    .toBe(true);
  await expect
    .poll(() =>
      previewContents(app, columnResult.previewId, "document.querySelector('h1')?.textContent"),
    )
    .toBe("Agent notes");
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  const notesTile = page.locator(`[data-preview-id="${columnResult.previewId}"]`);
  await expect(notesTile).toHaveAttribute("data-arrived", "true");
  const after = await page.locator('[data-tile="terminal"]').boundingBox();
  const added = await notesTile.boundingBox();
  assert.ok(
    before && after && added && after.width < before.width && added.x > after.x + after.width,
  );
  assert.equal((await requestPreview("existing", "notes.md")).placement, "existing");
  const notesRow = page.getByRole("treeitem", {
    name: "Markdown preview: notes.md, opened by Claude Code",
  });
  await expect(notesRow).toBeVisible();
  const glyphBounds = await notesRow.locator(".preview-glyph").boundingBox();
  const openerBounds = await page
    .locator('.board-row[data-kind="agent"] .board-light')
    .boundingBox();
  assert.ok(glyphBounds && openerBounds && glyphBounds.x >= openerBounds.x + 16);
  await page.screenshot({ path: "test-results/preview-attribution.png" });
  assert.ok(
    await notesRow.evaluate(
      (row) => row.parentElement.querySelector('.board-row[data-kind="agent"]') !== null,
    ),
  );
  await page.getByRole("button", { name: "Actions for Claude Code in main" }).click();
  await expect(page.getByText("Opened preview grabby.html", { exact: true })).toBeVisible();
  await expect(page.getByText("Opened preview notes.md", { exact: true })).toHaveCount(2);
  await expect(page.getByText("Opened preview notes.md", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  // Exercise the existing bounds bridge; overlay composition supplies these reports in #292.
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 500,
        y: 150,
        width: 250,
        height: 200,
        visible: true,
      }),
    result.previewId,
  );
  await expect
    .poll(async () => (await previewViewState(app, result.previewId)).attached)
    .toBe(true);
  await expect
    .poll(() => previewContents(app, result.previewId, "window.attempts"))
    .toBeGreaterThan(0);
  const keys = "a".repeat(100);
  await typeIntoFocusedContents(app, keys);
  await expect
    .poll(async () => (await page.evaluate((id) => window.desktop.tail(id, 20), shell.id)).join(""))
    .toContain(keys);
  assert.equal(await previewContents(app, result.previewId, "window.stolen"), "");
  // A restored sidebar preview is placed again with its original identity.
  await page.evaluate((id) => {
    const key = `foom.tiles.v1.${window.desktop.windows.id}`;
    const layout = JSON.parse(localStorage.getItem(key));
    const clear = (node) => {
      if (node.kind === "tile") {
        if (node.content?.kind === "preview" && node.content.preview === id) node.content = null;
      } else {
        clear(node.first);
        clear(node.second);
      }
    };
    clear(layout.tree);
    localStorage.setItem(key, JSON.stringify(layout));
  }, columnResult.previewId);
  await page.reload();
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  await expect(
    page.getByRole("treeitem", {
      name: "Markdown preview: notes.md, opened by Claude Code, not shown",
    }),
  ).toBeVisible();
  await page.evaluate(
    (id) => window.desktop.previews.bounds(id, { x: 0, y: 0, width: 0, height: 0, visible: false }),
    columnResult.previewId,
  );
  await expect
    .poll(async () => (await previewViewState(app, columnResult.previewId)).attached)
    .toBe(false);
  const reused = await requestPreview("reshow", "notes.md");
  assert.equal(reused.previewId, columnResult.previewId);
  assert.equal(reused.reused, true);
  assert.equal(reused.placement, "empty");
  await expect
    .poll(async () => (await previewViewState(app, reused.previewId)).attached)
    .toBe(true);
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  await page
    .locator('[data-tile="landing"]')
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-empty", "true");
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.sidebarInventory())).previews.some(
        (preview) => preview.id === result.previewId,
      ),
    )
    .toBe(false);
  const reopened = await requestPreview("reopen", "grabby.html");
  assert.equal(reopened.placement, "sidebar");
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(1);
  const reopenedRow = page.getByRole("treeitem", {
    name: "HTML preview: grabby.html, opened by Claude Code, not shown",
  });
  await expect(reopenedRow).toBeVisible();
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-empty", "true");
  await reopenedRow.getByRole("button").click();
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-kind", "preview");
  await expect(page.locator('[data-tile="landing"]')).toHaveAttribute("data-arrived", "false");
  await page.locator('[data-tile="terminal"] .xterm-helper-textarea').focus();
  // At minimum width, use terminal replacement fallback and protect the focused shell.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(900, 640);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900);
  const narrow = await requestPreview("narrow", "narrow.md");
  assert.equal(narrow.placement, "replace");
  await expect(page.locator('.terminal-tile[data-kind="preview"]')).toHaveCount(2);
  await expect
    .poll(async () => (await previewViewState(app, narrow.previewId)).attached)
    .toBe(true);
  await expect
    .poll(() => previewContents(app, narrow.previewId, "document.querySelector('h1')?.textContent"))
    .toBe("Narrow notes");
  await expect(page.locator('[data-tile="terminal"] .xterm-helper-textarea')).toBeFocused();
  await page
    .locator(`[data-preview-id="${narrow.previewId}"]`)
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await assertAccessible(page);
  // Agent ownership follows the preview across windows, including list and close.
  await movePreviewTile(app, page, reopened.previewId, async (target) => {
    await expect(
      target.getByRole("treeitem", { name: "HTML preview: grabby.html, opened by Claude Code" }),
    ).toBeVisible();
    const actor = JSON.parse(await readFile(`${credentials}.app`, "utf8"));
    const call = async (method, params) => {
      const response = await fetch(actor.controlUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${actor.controlToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ version: 1, instanceId: actor.instanceId, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    assert.ok(
      (await call("list_previews", {})).previews.some(
        (preview) => preview.previewId === reopened.previewId && preview.visible,
      ),
    );
    await writeFile(path.join(repo, "grabby.html"), "<h1>Moved agent preview reloaded</h1>");
    await expect
      .poll(() =>
        previewContents(app, reopened.previewId, "document.querySelector('h1')?.textContent", {
          requireAttached: true,
        }),
      )
      .toBe("Moved agent preview reloaded");
    assert.equal((await call("close_preview", { previewId: reopened.previewId })).closed, true);
    await expect(target.locator(`[data-preview-id="${reopened.previewId}"]`)).toHaveCount(0);
  });
});

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

async function expectPreviewSnapshot(page, id) {
  const snapshot = page.locator(`.preview-snapshot[data-preview="${id}"]`);
  await expect(snapshot).toBeVisible();
  await expect
    .poll(() =>
      snapshot.evaluate((canvas) =>
        Array.from(
          canvas.getContext("2d").getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
        ),
      ),
    )
    .toEqual([18, 52, 86, 255]);
  await expect(snapshot).toHaveCSS("pointer-events", "none");
}

test("preview composition keeps tile and row panels visible and usable above captured pages", async (context) => {
  const { app, page, id, tile, bounds } = await composedPreview(context, 2);
  await tile.getByRole("button", { name: "Tile 2 menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Split down" })).toBeVisible();
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
  await expectPreviewSnapshot(page, id);
  await expect(page.locator(".preview-snapshot")).toHaveCSS("left", `${bounds.x}px`);
  await expect(page.locator(".preview-snapshot")).toHaveCSS("width", `${bounds.width}px`);
  await page.screenshot({
    path: "test-results/preview-overlays-panel.png",
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "Split down" }).click();
  await expect(page.locator(".terminal-tile")).toHaveCount(3);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  await page.locator(".board-row").first().click({ button: "right" });
  await expect(page.locator(".row-menu")).toBeVisible();
  await expectPreviewSnapshot(page, id);
  await page.reload();
  await expect(page.locator(".row-menu")).toHaveCount(0);
  await expectPreviewSnapshot(page, id);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
});

test("preview composition puts the trusted confirmation scrim above previews and restores on cancel", async (context) => {
  const { app, page, id } = await composedPreview(context);
  await app.evaluate(({ app }) => app.quit());
  const dialog = await confirmationPage(app);
  await expect(page.locator(".board-confirmation-scrim:popover-open")).toBeVisible();
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
  await expectPreviewSnapshot(page, id);
  await page.screenshot({
    path: "test-results/preview-overlays-scrim.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".board-confirmation-scrim")).toHaveCount(0);
  await expectPreviewSnapshot(page, id);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  assert.equal((await previewViewState(app, id)).focused, false);
});

test("preview composition keeps maximize and restore live and excludes preview hit testing throughout tile drags", async (context) => {
  const { app, page, id, tile, bounds } = await composedPreview(context);
  // Lengthen only the product animation being observed, never a test deadline.
  await page.addStyleTag({ content: ".terminal-tile { transition-duration: 1s; }" });
  await tile.getByRole("button", { name: "Maximize tile" }).click();
  await expectPreviewSnapshot(page, id);
  assert.equal((await previewViewState(app, id)).visible, true);
  await tile.getByRole("button", { name: "Restore tile" }).click();
  await expectPreviewSnapshot(page, id);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  const title = await page.locator('[data-tile="shell"] .tile-title').boundingBox();
  assert.ok(title);
  await page.mouse.move(title.x + 10, title.y + 10);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 12 });
  await expect(page.locator(".tile-drop-preview")).toBeVisible();
  await expectPreviewSnapshot(page, id);
  assert.equal((await previewViewState(app, id)).visible, false);
  await page.screenshot({ path: "test-results/preview-overlays-drag.png", animations: "disabled" });
  assert.equal(await previewContents(app, id, "window.pointerCount"), 0);
  await page.mouse.up();
  await expect(page.locator(".tile-drop-preview")).toHaveCount(0);
  await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
});

// A frame is covered by either the visible native child or opaque decoded pixels.
// Sample throughout each action, including its first frame, rather than waiting
// for a snapshot to eventually appear (which concealed the original black gap).
async function assertPreviewFrames(app, page, id, action, liveOnly = false) {
  const frames = [];
  let finished = false;
  const operation = action().finally(() => {
    finished = true;
  });
  try {
    do {
      frames.push(
        await app.evaluate(async ({ BrowserWindow }, id) => {
          const board = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
          const view = board.contentView.children.find((view) =>
            view.webContents?.getURL().startsWith(`foom-preview://${id}/`),
          );
          const live = Boolean(view?.getVisible());
          const opaque = await board.webContents.executeJavaScript(`(() => {
          const canvas = document.querySelector('.preview-snapshot[data-preview="${id}"]');
          if (!canvas || !canvas.width || !canvas.height || getComputedStyle(canvas).visibility === 'hidden') return false;
          return [[.1,.1],[.5,.5],[.9,.9]].every(([x,y]) => canvas.getContext('2d').getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data[3] === 255);
        })()`);
          return { live, opaque, attached: Boolean(view) };
        }, id),
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    } while (!finished);
  } finally {
    await operation;
  }
  assert.ok(frames.length);
  for (const frame of frames) {
    assert.ok(frame.live || frame.opaque, `Empty preview frame: ${JSON.stringify(frame)}`);
    assert.ok(frame.attached, "Composition must not remove the native child");
    if (liveOnly) assert.ok(frame.live, "Geometry animations must keep the preview live");
  }
}

async function previewFrameRegression(context, file, content) {
  const { app, page, id, tile } = await composedPreview(context, 1, content, file);
  const settle = () =>
    tile.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
  await assertPreviewFrames(
    app,
    page,
    id,
    async () => {
      await tile.getByRole("button", { name: "Maximize tile" }).click();
      await settle();
    },
    true,
  );
  await assertPreviewFrames(
    app,
    page,
    id,
    async () => {
      await tile.getByRole("button", { name: "Restore tile" }).click();
      await settle();
    },
    true,
  );
  await assertPreviewFrames(app, page, id, async () => {
    await tile.getByRole("button", { name: "Tile 2 menu" }).click();
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  });
  await assertPreviewFrames(app, page, id, async () => {
    await app.evaluate(({ app }) => app.quit());
    const dialog = await confirmationPage(app);
    await expect(page.locator(".board-confirmation-scrim:popover-open")).toBeVisible();
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(false);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(async () => (await previewViewState(app, id)).visible).toBe(true);
  });
}

test("preview composition has no empty frames for a realistic HTML page", async (context) => {
  const content = `<!doctype html><html><head><style>
    html { background:#edf1f8; color:#243149; font:16px system-ui; }
    body { margin:0; } header { padding:32px; background:#263953; color:white; }
    main { padding:24px; display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:20px; }
    article { background:white; padding:24px; border-radius:12px; box-shadow:0 2px 8px #abc; }
    svg { width:100%; height:100px; } code { background:#edf1f8; }
  </style></head><body><header><h1>Release dashboard</h1><p>Build progress across active projects</p><input placeholder="Filter projects"></header><main>
  ${Array.from({ length: 24 }, (_, i) => `<article><h2>Project ${i + 1}</h2><p>Review the latest build and deployment notes.</p><svg viewBox="0 0 200 100"><path d="M0 90 L40 60 L80 75 L130 20 L200 10" fill="none" stroke="#5679a5" stroke-width="5"/></svg><code>build ${i + 100}</code><ul><li>Assets compiled</li><li>Checks complete</li></ul></article>`).join("")}
  </main></body></html>`;
  await previewFrameRegression(context, "dashboard.html", content);
});

test("preview composition has no empty frames for a Markdown page", async (context) => {
  await previewFrameRegression(
    context,
    "notes.md",
    "# Release notes\n\n" +
      Array.from(
        { length: 80 },
        (_, i) =>
          `## Project ${i + 1}\n\nReview **compiled assets**, deployment notes, and \`build checks\`.\n\n- Ready for review\n- Documentation updated\n`,
      ).join("\n"),
  );
});

test("preview gutter drags keep the native view attached and resize it in place", async (context) => {
  const { app, page, id, tile, bounds } = await composedPreview(context);
  const gutter = page.getByRole("separator", { name: "Resize tiles" });
  const handle = await gutter.boundingBox();
  assert.ok(handle);
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await expect(gutter).toHaveAttribute("data-dragging", "true");
  // Every step leaves the view attached: no hide/show churn and no snapshot swap.
  for (const offset of [20, 40, 60, 80]) {
    await page.mouse.move(handle.x - offset, y);
    await expect(gutter).not.toHaveAttribute("aria-valuenow", "50");
    assert.equal((await previewViewState(app, id)).attached, true);
  }
  assert.equal((await previewViewState(app, id)).visible, true);
  await page.mouse.up();
  await expect(gutter).toHaveAttribute("data-dragging", "false");
  const finalBounds = await tile.locator(".tile-shell:not([hidden])").boundingBox();
  assert.ok(finalBounds);
  assert.ok(finalBounds.width > bounds.width);
  await expect
    .poll(async () => (await previewViewState(app, id)).bounds)
    .toEqual({
      x: Math.round(finalBounds.x),
      y: Math.round(finalBounds.y),
      width: Math.round(finalBounds.width),
      height: Math.round(finalBounds.height),
    });
  assert.equal((await previewViewState(app, id)).attached, true);
});

test("preview focused native input reaches board shortcuts including the tile leader and leaves ordinary keys in the page", async (context) => {
  const { app, page, id } = await composedPreview(context);
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents
      .getAllWebContents()
      .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
    contents.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
  }, id);
  await expect.poll(async () => (await previewViewState(app, id)).focused).toBe(true);
  await typeIntoFocusedContents(app, "x");
  await expect.poll(() => previewContents(app, id, "window.keys")).toEqual(["x"]);
  const send = async (keyCode, modifiers) =>
    app.evaluate(
      ({ webContents }, { keyCode, modifiers }) => {
        const contents = webContents.getFocusedWebContents();
        if (!contents) throw new Error("No native input target");
        for (const type of ["keyDown", "keyUp"])
          contents.sendInputEvent({ type, keyCode, modifiers });
      },
      { keyCode, modifiers },
    );
  const mac = process.platform === "darwin";
  await send("B", mac ? ["meta"] : ["control", "shift"]);
  await expect(page.getByRole("button", { name: /Expand sidebar/ })).toBeVisible();
  if (!mac) await send("Space", ["control", "shift"]);
  await send("1", mac ? ["meta"] : []);
  await expect(page.locator('[data-tile="shell"]')).toHaveAttribute("data-focused", "true");
  assert.equal(
    await previewContents(app, id, "window.keys.includes('B') || window.keys.includes('1')"),
    false,
  );
});

test("preview live reload handles saves, assets, missing files, scroll and closes watchers", async (context) => {
  const { rename, unlink } = require("node:fs/promises");
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  const document = (text) =>
    `<link rel="stylesheet" href="live.css"><div style="height:4000px">${text}</div>`;
  await writeFile(path.join(root, "live.html"), document("first"));
  await writeFile(path.join(root, "live.css"), "body { color: rgb(1, 2, 3); }");
  // Count native subscriptions and load starts, including replacement contents.
  await app.evaluate(({ app }, root) => {
    const fs = process.getBuiltinModule("node:fs");
    const original = fs.watch;
    globalThis.liveStats = { watchers: 0, burst: undefined };
    fs.watch = function (filename, ...args) {
      if (String(filename).startsWith(root)) {
        const callback = args.pop();
        args.push((event, name) => {
          const burst = globalThis.liveStats.burst;
          if (burst && (name === null || String(name) === "live.html")) {
            burst.lastEvent = performance.now();
            burst.firstEvent ??= burst.lastEvent;
          }
          callback(event, name);
        });
      }
      const watch = original.call(this, filename, ...args);
      if (String(filename).startsWith(root)) {
        globalThis.liveStats.watchers++;
        const close = watch.close.bind(watch);
        let closed = false;
        watch.close = () => {
          if (!closed) {
            closed = true;
            globalThis.liveStats.watchers--;
          }
          return close();
        };
      }
      return watch;
    };
    app.on("web-contents-created", (_event, contents) => {
      contents.on("did-start-loading", () => {
        if (!contents.getURL().startsWith("foom-preview://")) return;
        const burst = globalThis.liveStats.burst;
        if (burst) {
          burst.lastLoad = performance.now();
          burst.firstLoad ??= burst.lastLoad;
          burst.loads++;
        }
      });
    });
  }, root);
  const id = await pickPreviewFile(app, page, root, "live.html");
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 400,
        y: 100,
        width: 250,
        height: 180,
        visible: true,
      }),
    id,
  );
  const loaded = async (text) => {
    await expect
      .poll(async () => {
        return previewContents(app, id, "document.body.textContent", { requireAttached: true });
      })
      .toContain(text);
    assert.equal((await previewViewState(app, id)).focused, false);
  };
  await loaded("first");
  // Force replacement while a read is pending, through both Electron's
  // executeJavaScript and CDP paths. Neither may strand or reject the poll.
  for (const [useDebugger, requireAttached] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    await app.evaluate(
      ({ webContents }, { id, useDebugger }) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
        const execute = contents.executeJavaScript.bind(contents);
        contents.executeJavaScript = (code) => {
          contents.executeJavaScript = execute;
          let result;
          if (useDebugger) {
            contents.debugger.attach("1.3");
            result = contents.debugger.sendCommand("Runtime.evaluate", {
              expression: code,
              awaitPromise: true,
              returnByValue: true,
            });
          } else {
            result = execute(code);
          }
          contents.reload();
          return result;
        };
      },
      { id, useDebugger },
    );
    assert.equal(
      await previewContents(app, id, "new Promise(() => {})", { requireAttached }),
      undefined,
    );
    await loaded("first");
  }
  // A script error on the current contents is still a test failure.
  await assert.rejects(
    previewContents(app, id, "throw new Error('preview read failed')", { requireAttached: true }),
    /Script failed to execute/,
  );
  await previewContents(app, id, "window.scrollTo(0, 1200)");
  await expect.poll(() => previewContents(app, id, "window.scrollY")).toBe(1200);
  // Page-world overrides cannot spoof the isolated-world scroll capture.
  await previewContents(
    app,
    id,
    'Object.defineProperty(window, "scrollY", { value: 13 }); window.scrollTo = () => {}; undefined;',
  );
  await writeFile(path.join(root, "live.html"), document("direct"));
  await loaded("direct");
  assert.equal(await previewContents(app, id, "window.scrollY"), 1200);
  await writeFile(path.join(root, "live.tmp"), document("atomic"));
  await rename(path.join(root, "live.tmp"), path.join(root, "live.html"));
  await loaded("atomic");
  await app.evaluate(() => {
    globalThis.liveStats.burst = {
      loads: 0,
      firstEvent: undefined,
      firstLoad: undefined,
      lastEvent: undefined,
      lastLoad: undefined,
    };
  });
  // A burst may span several trailing/max-wait windows on a busy filesystem.
  // Test delayed reload, final content and eventual quiet, not a total load count.
  for (let index = 0; index < 20; index++)
    await writeFile(path.join(root, "live.html"), document(`burst ${index}`));
  await loaded("burst 19");
  // An earlier reload can read the final bytes while the last event is still
  // pending. Wait for a completed reload that started after that event.
  await expect
    .poll(() =>
      app.evaluate(({ webContents }, id) => {
        const contents = webContents
          .getAllWebContents()
          .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
        const burst = globalThis.liveStats.burst;
        return contents && !contents.isLoading() && burst.lastLoad >= burst.lastEvent;
      }, id),
    )
    .toBe(true);
  const burst = await app.evaluate(() => globalThis.liveStats.burst);
  assert.ok(burst.firstEvent !== undefined, "observed a native file event");
  assert.ok(burst.firstLoad !== undefined, "observed a reload after the writes");
  // Leave 20 ms for real timer precision around the 120 ms trailing delay.
  assert.ok(
    burst.firstLoad - burst.firstEvent >= 100,
    `reload waited for debounce: ${burst.firstLoad - burst.firstEvent} ms`,
  );
  // Elapsed quiet time is the behavior under test. Once the final page finishes,
  // no pending trailing or maximum-wait timer should cause another reload.
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
  assert.equal(await app.evaluate(() => globalThis.liveStats.burst.loads), burst.loads);
  await app.evaluate(() => {
    globalThis.liveStats.burst = undefined;
  });
  await writeFile(path.join(root, "live.css"), "body { color: rgb(4, 5, 6); }");
  await expect
    .poll(async () => {
      return previewContents(app, id, "getComputedStyle(document.body).color", {
        requireAttached: true,
      });
    })
    .toBe("rgb(4, 5, 6)");
  await unlink(path.join(root, "live.html"));
  await loaded("File not found. Waiting for it to appear.");
  await writeFile(path.join(root, "live.html"), document("recreated"));
  await loaded("recreated");
  assert.equal(await app.evaluate(() => globalThis.liveStats.watchers), 1);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  assert.equal(await app.evaluate(() => globalThis.liveStats.watchers), 0);
});

test("preview live reload follows retargeted symlinks and junctions", async (context) => {
  const { symlink, rename } = require("node:fs/promises");
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  for (const name of ["one", "two"]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "index.html"), `<p>${name}</p>`);
  }
  const kind = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.join(root, "one"), path.join(root, "alias"), kind);
  const id = await pickPreviewFile(app, page, root, "alias/index.html");
  await page.evaluate(
    (id) =>
      window.desktop.previews.bounds(id, {
        x: 400,
        y: 100,
        width: 250,
        height: 180,
        visible: true,
      }),
    id,
  );
  const text = async () =>
    previewContents(app, id, "document.body.textContent", { requireAttached: true });
  await expect.poll(text).toContain("one");
  await symlink(path.join(root, "two"), path.join(root, "next-alias"), kind);
  // Windows does not rename over an existing directory junction. Move the old
  // entry aside, then rename the replacement, within the debounce window.
  await rename(path.join(root, "alias"), path.join(root, "old-alias"));
  await rename(path.join(root, "next-alias"), path.join(root, "alias"));
  await expect.poll(text).toContain("two");
  await writeFile(path.join(root, "two", "index.html"), "<p>new target changed</p>");
  await expect.poll(text).toContain("new target changed");
  await page.evaluate((id) => window.desktop.previews.close(id), id);
});

test("preview external links always use trusted review and drop scripted requests while pending", async (context) => {
  const app = await launchApp(context, { fixture: "repository" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  await writeFile(path.join(root, "links.html"), "<p>Links</p>");
  await app.evaluate(({ shell }) => {
    globalThis.previewExternalOpened = [];
    shell.openExternal = async (url) => {
      globalThis.previewExternalOpened.push(url);
    };
  });
  const id = await pickPreviewFile(app, page, root, "links.html");
  await expect.poll(async () => (await previewViewState(app, id)).loading).toBe(false);
  const dialog = await confirmationPage(app);
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
    ).webContents;
    const send = contents.send.bind(contents);
    globalThis.previewLinkReviews = [];
    contents.send = (channel, ...args) => {
      if (channel === "confirmation:render" && args[0]) globalThis.previewLinkReviews.push(args[0]);
      send(channel, ...args);
    };
  });
  const url = "https://example.com/full/path?query=shown%20in%20full#fragment";
  await previewContents(
    app,
    id,
    `window.open(${JSON.stringify(url)}); window.open('http://example.com/dropped'); location.href='https://example.com/also-dropped';`,
  );
  await expect(dialog.getByRole("heading", { name: "Open this link?" })).toBeVisible();
  await expect(dialog.locator(".facts dd")).toHaveText(url);
  assert.equal(await app.evaluate(() => globalThis.previewLinkReviews.length), 1);
  assert.deepEqual(await app.evaluate(() => globalThis.previewExternalOpened), []);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => globalThis.previewExternalOpened), []);
  await previewContents(
    app,
    id,
    "window.open('file:///tmp/never'); window.open('javascript:alert(1)'); window.open('data:text/plain,never')",
  );
  assert.equal(await app.evaluate(() => globalThis.previewLinkReviews.length), 1);
  await previewContents(app, id, "window.open('mailto:hello@example.com?subject=Preview')");
  await expect(dialog.locator(".facts dd")).toHaveText("mailto:hello@example.com?subject=Preview");
  await dialog.getByRole("button", { name: "Open in browser", exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.previewExternalOpened))
    .toEqual(["mailto:hello@example.com?subject=Preview"]);
  await previewContents(app, id, "window.open('http://example.com/cancel-on-close')");
  await expect(dialog.locator(".facts dd")).toHaveText("http://example.com/cancel-on-close");
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  await expect(dialog.getByRole("heading", { name: "Open this link?" })).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => globalThis.previewExternalOpened), [
    "mailto:hello@example.com?subject=Preview",
  ]);
});

test("preview network permission allows local HTTPS only and resets after restart", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-preview-network-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`] };
  const certificateRoot = path.join(__dirname, "../fixtures/preview-network");
  const secure = require("node:https").createServer(
    {
      key: await readFile(path.join(certificateRoot, "key.pem")),
      cert: await readFile(path.join(certificateRoot, "cert.pem")),
    },
    (_request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.end("secure");
    },
  );
  const plain = require("node:http").createServer((_request, response) => response.end("blocked"));
  let secureConnections = 0,
    plainConnections = 0;
  secure.on("connection", () => secureConnections++);
  plain.on("connection", () => plainConnections++);
  context.after(async () => {
    for (const server of [secure, plain]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  for (const server of [secure, plain])
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const secureUrl = `https://127.0.0.1:${secure.address().port}/`;
  const plainUrl = `http://127.0.0.1:${plain.address().port}/`;
  const app = await launchApp(context, { ...options, fixture: "running-shell" });
  const page = await boardPage(app);
  const root = (await page.evaluate(() => window.desktop.workspace())).terminals[0].worktree;
  await writeFile(
    path.join(root, "network.html"),
    `<p>Network probe</p><script>
    window.results=null;
    Promise.all([${JSON.stringify(secureUrl)}, ${JSON.stringify(plainUrl)}].map(url => fetch(url).then(response=>response.text()).catch(()=>"blocked"))).then(results => window.results=results);
  </script>`,
  );
  await app.evaluate(({ app }) => {
    app.on("session-created", (partition) => {
      // Trust only this test's loopback certificate; never disable app-wide verification.
      partition.setCertificateVerifyProc((request, callback) =>
        callback(request.hostname === "127.0.0.1" ? 0 : -3),
      );
    });
  });
  const id = await pickPreviewFile(app, page, root, "network.html");
  const bounds = { x: 400, y: 100, width: 250, height: 180, visible: true };
  await page.evaluate(({ id, bounds }) => window.desktop.previews.bounds(id, bounds), {
    id,
    bounds,
  });
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await expect
    .poll(() => previewContents(app, id, "window.results"))
    .toEqual(["blocked", "blocked"]);
  assert.equal(secureConnections, 0);
  assert.equal(plainConnections, 0);
  const dialog = await confirmationPage(app);
  await page.evaluate((id) => {
    window.previewNetworkChange = window.desktop.previews.network(id, true);
  }, id);
  await expect(
    dialog.getByRole("heading", { name: "Allow network for this preview?" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("This page can send files from this worktree to the internet", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.previewNetworkChange);
  assert.equal(
    (await page.evaluate(() => window.desktop.sidebarInventory())).previews.find(
      (preview) => preview.id === id,
    ).network,
    false,
  );
  await page.evaluate((id) => {
    window.previewNetworkChange = window.desktop.previews.network(id, true);
  }, id);
  await dialog.getByRole("button", { name: "Allow network", exact: true }).click();
  await page.evaluate(() => window.previewNetworkChange);
  await expect.poll(async () => (await previewViewState(app, id)).attached).toBe(true);
  await expect
    .poll(() => previewContents(app, id, "window.results"))
    .toEqual(["secure", "blocked"]);
  assert.ok(secureConnections > 0);
  assert.equal(plainConnections, 0);
  assert.equal(
    (await page.evaluate(() => window.desktop.sidebarInventory())).previews.find(
      (preview) => preview.id === id,
    ).network,
    true,
  );
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await dialog.getByRole("button", { name: "Stop all and quit", exact: true }).click();
  });
  const restored = await launchApp(context, { ...options, fixture: "restored" });
  const restoredPage = await boardPage(restored);
  // Board startup can finish before the persisted previews have been restored.
  await expect
    .poll(async () =>
      (await restoredPage.evaluate(() => window.desktop.sidebarInventory())).previews.some(
        (preview) => preview.id === id,
      ),
    )
    .toBe(true);
  const restoredInventory = await restoredPage.evaluate(() => window.desktop.sidebarInventory());
  assert.equal(restoredInventory.previews.find((preview) => preview.id === id).network, false);
  const before = secureConnections;
  await restoredPage.evaluate(({ id, bounds }) => window.desktop.previews.bounds(id, bounds), {
    id,
    bounds,
  });
  await expect.poll(async () => (await previewViewState(restored, id)).attached).toBe(true);
  await expect
    .poll(() => previewContents(restored, id, "window.results"))
    .toEqual(["blocked", "blocked"]);
  assert.equal(secureConnections, before);
  assert.equal(plainConnections, 0);
});

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
    await page.evaluate(() => window.desktop.saveSetup({ colorMode: "dark" }));
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
