const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readFile, writeFile } = require("node:fs/promises");
const { expect } = require("./test-policy.js");
const { boardPage, launchApp } = require("./harness.js");
const {
  pickPreviewFile,
  previewContents,
  previewViewState,
  typeIntoFocusedContents,
  composedPreview,
} = require("./preview-fixture.js");

// Record what the PTY actually receives, independently of terminal width/reflow.
async function recordTerminalInput(page, root) {
  const marker = path.join(root, "preview-input-bytes");
  await writeFile(marker, "");
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  return async () => Buffer.from((await readFile(marker, "utf8")).replaceAll("\n", ""), "hex");
}

async function clickTerminal(app, page) {
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
}

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
  const input = await recordTerminalInput(page, root);
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
  assert.deepEqual(await input(), Buffer.alloc(0));
  // A deliberate terminal click during another handoff restores ordinary input.
  await app.evaluate(({ webContents }, id) => {
    globalThis.previewLinkRequested = false;
    webContents
      .getAllWebContents()
      .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`))
      .reload();
  }, id);
  await expect.poll(() => app.evaluate(() => globalThis.previewLinkRequested)).toBe(true);
  await clickTerminal(app, page);
  await typeIntoFocusedContents(app, "cancelledb");
  // The probe records synchronously before emitting this output barrier. Exact
  // bytes also catch delayed forbidden input from the preceding handoff.
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_BARRIER");
  assert.deepEqual(await input(), Buffer.from("cancelledb"));
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
  const input = await recordTerminalInput(page, terminal.worktree);
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
  await page.locator(".xterm-helper-textarea").focus();
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
  assert.deepEqual(await input(), Buffer.alloc(0));
  // A deliberate native terminal click restores input after cancellation, and
  // the barrier proves that the recorder is live and prior input has drained.
  await clickTerminal(app, page);
  await typeIntoFocusedContents(app, "resumedb");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_BARRIER");
  assert.deepEqual(await input(), Buffer.from("resumedb"));
  await page.evaluate((id) => window.desktop.previews.close(id), id);
}

test("preview handoff Escape restores board keyboard input during a never-finishing local load", async (context) => {
  await stuckPreviewHandoff(context, "Escape");
});

test("preview handoff deadline restores board keyboard input during a never-finishing local load", async (context) => {
  await stuckPreviewHandoff(context, "deadline");
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
