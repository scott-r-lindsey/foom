const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { deadline, expect } = require("../../tests/electron/test-policy.js");
const { harness, routeBundle, gpuInfo, shells, fillTiles } = require("./common.cjs");
const { launchApp, boardPage } = harness(false);
const args = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const resultRoot = "spikes/xterm-webgl/results/software";
const live = () =>
  globalThis.__xtermEval.shells.find((shell) => !shell.disposed && !shell.container.hidden);
async function launch(context, mode = "webgl") {
  const app = await launchApp(context, { fixture: "running-shell", args });
  const page = await boardPage(app);
  await routeBundle(page, mode);
  return { app, page };
}
async function output(page, id, label) {
  const command = `"${process.execPath}" "${path.resolve("spikes/xterm-webgl/output.cjs")}" ${label}\r`;
  await page.evaluate(({ id, command }) => window.desktop.input(id, command), { id, command });
  await expect
    .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 10)).join(""), id))
    .toContain(`${label}_DONE`);
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, label }) => {
          const shell = globalThis.__xtermEval.shells.find(
            (shell) => !shell.disposed && shell.id() === id && !shell.container.hidden,
          );
          if (!shell) return "";
          const b = shell.terminal.buffer.active;
          return Array.from({ length: b.length }, (_, i) =>
            b.getLine(i).translateToString(true),
          ).join("\n");
        },
        { id, label },
      ),
    )
    .toContain(`${label}_DONE`);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const shell = globalThis.__xtermEval.shells.find(
      (shell) => !shell.disposed && !shell.container.hidden,
    );
    const t = shell.terminal,
      b = t.buffer.active;
    return {
      id: shell.id(),
      lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)),
      baseY: b.baseY,
      cursorX: b.cursorX,
      cursorY: b.cursorY,
      events: shell.events.slice(),
      state: shell.state,
      losses: shell.losses,
    };
  });
}
async function report(name, data) {
  await mkdir(resultRoot, { recursive: true });
  await writeFile(`${resultRoot}/${name}.json`, JSON.stringify(data, null, 2) + "\n");
}
test("WebGL forced loss preserves scrollback, attachment order and DOM recovery", {
  timeout: deadline(60000),
}, async (context) => {
  const { app, page } = await launch(context);
  const initial = await shells(page);
  assert.equal(initial[0].contexts, 1);
  assert.match(initial[0].renderer, /SwiftShader/);
  const id = initial[0].id;
  await output(page, id, "BEFORE_LOSS");
  const before = await snapshot(page);
  assert.ok(before.baseY > 100, "fixture must have scrollback");
  await page.evaluate(() => {
    const shell = globalThis.__xtermEval.shells.find((shell) => shell.state === "active");
    globalThis.__originalTerminal = shell.terminal;
    const canvas = [...shell.container.querySelectorAll("canvas")].find((c) =>
      c.getContext("webgl2"),
    );
    canvas.getContext("webgl2").getExtension("WEBGL_lose_context").loseContext();
  });
  await expect.poll(async () => (await shells(page))[0].state).toBe("lost");
  const after = await snapshot(page);
  assert.deepEqual(after.lines, before.lines);
  assert.equal(after.baseY, before.baseY);
  assert.equal(after.cursorX, before.cursorX);
  assert.equal(after.cursorY, before.cursorY);
  assert.deepEqual(
    after.events.filter((event) => event !== "context-loss"),
    before.events,
  );
  assert.equal(
    await page.evaluate(
      () => globalThis.__xtermEval.shells[0].terminal === globalThis.__originalTerminal,
    ),
    true,
  );
  await expect(page.locator(".xterm-rows")).toContainText("BEFORE_LOSS_DONE");
  await output(page, id, "AFTER_LOSS");
  const [first] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  await page.evaluate(
    ({ repository, worktree }) =>
      window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "shell" }),
    first,
  );
  await expect(page.locator(".board-row[data-kind='shell']")).toHaveCount(2);
  await page.locator(".board-row[data-kind='shell']").nth(1).click();
  const second = (await page.evaluate(() => window.desktop.workspace())).terminals[1];
  await expect.poll(async () => (await shells(page))[0].id).toBe(second.id);
  await output(page, second.id, "SECOND");
  await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
    id,
    command: `"${process.execPath}" "${path.resolve("spikes/xterm-webgl/output.cjs")}" HIDDEN\r`,
  });
  await expect
    .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 10)).join(""), id))
    .toContain("HIDDEN_DONE");
  assert.ok(!(await snapshot(page)).lines.some((line) => line.includes("HIDDEN_DONE")));
  await page.locator(".board-row[data-kind='shell']").nth(0).click();
  await expect.poll(async () => (await snapshot(page)).lines.join("\n")).toContain("HIDDEN_DONE");
  const final = await snapshot(page);
  const attaches = final.events
    .map((value, index) => ({ value, index }))
    .filter((event) => event.value.startsWith("attach:"));
  for (const { index } of attaches)
    assert.deepEqual(final.events.slice(index - 3, index), ["drain", "reset", "fit"]);
  assert.equal(
    await page.evaluate(
      () => globalThis.__xtermEval.shells.filter((shell) => !shell.disposed).length,
    ),
    1,
  );
  assert.equal(
    await page.evaluate(
      () => globalThis.__xtermEval.shells[0].terminal === globalThis.__originalTerminal,
    ),
    true,
  );
  await report("loss-attachment", {
    gpu: await gpuInfo(app),
    initial,
    before,
    after,
    final,
    checks: {
      scrollbackPreserved: true,
      sameTerminal: true,
      continuedInputOutput: true,
      hiddenOutputInHost: true,
      freshSnapshotOnReattach: true,
      attachmentOrder: true,
    },
  });
});

test("WebGL cap, visible-only budget, hidden disposal and unmount", {
  timeout: deadline(80000),
}, async (context) => {
  const { app, page } = await launch(context);
  assert.equal((await shells(page))[0].contexts, 1);
  const cap = await page.evaluate(async () => {
    const contexts = [];
    let losses = 0;
    for (let index = 0; index < 24; index++) {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext("webgl2");
      if (!gl) throw new Error("Cap probe could not create WebGL2");
      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        losses++;
      });
      contexts.push({ canvas, gl });
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    globalThis.__capProbe = contexts;
    return {
      created: contexts.length,
      live: contexts.filter(({ gl }) => !gl.isContextLost()).length,
      losses,
    };
  });
  assert.ok(cap.live < cap.created, "must exceed actual context cap");
  await expect.poll(async () => (await shells(page))[0].state).toBe("lost");
  await page.evaluate(() => {
    for (const { gl } of globalThis.__capProbe)
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    globalThis.__capProbe = [];
  });
  // Fresh renderer controllers, same live host; the cap probe's lost terminal was usable DOM.
  await routeBundle(page, "webgl");
  const count = cap.live + 2;
  await fillTiles(page, count);
  await expect
    .poll(async () => (await shells(page)).filter((shell) => shell.contexts === 1).length)
    .toBe(12);
  const loaded = await shells(page);
  assert.equal(loaded.length, count);
  assert.equal(loaded.filter((shell) => shell.state === "dom-budget").length, count - 12);
  assert.equal(
    loaded.filter((shell) => shell.losses > 0).length,
    0,
    "budget must prevent browser-driven losses",
  );
  assert.equal(await page.locator(".xterm").count(), count);
  const fallback = loaded.find((shell) => shell.state === "dom-budget");
  await output(page, fallback.id, "CAP_FALLBACK");
  // Settings hides attachments without destroying xterms; all GPU addons must release.
  await page.evaluate(() => window.desktop.appMenu.execute("settings"));
  await expect.poll(() => page.evaluate(() => globalThis.__xtermEval.active)).toBe(0);
  assert.equal(
    await page.evaluate(
      () => globalThis.__xtermEval.shells.filter((shell) => !shell.disposed).length,
    ),
    count,
  );
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect.poll(() => page.evaluate(() => globalThis.__xtermEval.active)).toBe(12);
  const beforeUnmount = await page.evaluate(() =>
    globalThis.__xtermEval.shells.map((shell) => ({
      state: shell.state,
      disposals: shell.disposals,
    })),
  );
  await page.getByRole("button", { name: "Hide", exact: true }).first().click();
  await page.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
  await expect(page.locator(".terminal-tile")).toHaveCount(count - 1);
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.__xtermEval.shells.filter((shell) => shell.disposed).length),
    )
    .toBe(1);
  const disposal = await page.evaluate(() =>
    globalThis.__xtermEval.shells
      .filter((shell) => shell.disposed)
      .map((shell) => ({
        state: shell.state,
        terminalDisposals: shell.terminalDisposals,
        disposals: shell.disposals,
        hasAddon: !!shell.addon,
        connected: shell.container.isConnected,
        events: shell.events.slice(-5),
      })),
  );
  assert.equal(disposal[0].terminalDisposals, 1);
  assert.equal(disposal[0].hasAddon, false);
  assert.equal(disposal[0].connected, false);
  await report("cap-disposal", {
    gpu: await gpuInfo(app),
    observedCap: cap,
    openedTiles: count,
    budget: 12,
    loaded,
    beforeUnmount,
    disposal,
    checks: {
      actualContexts: true,
      exceededCap: true,
      domBudgetFallback: true,
      hiddenDisposesAddons: true,
      hiddenKeepsXterms: true,
      unmountDisposes: true,
    },
  });
});

// Screenshots deliberately use public xterm APIs to create identical static cells.
// Real PTY attachment and input ordering are exercised above.
test("WebGL and DOM visual matrix under unchanged security policy", {
  timeout: deadline(80000),
}, async (context) => {
  await mkdir(`${resultRoot}/visual`, { recursive: true });
  const matrix = [
    { name: "dark-default", terminalTheme: "foom-dark", font: 14, scale: 100 },
    { name: "light-selection", terminalTheme: "foom-light", font: 14, scale: 100, selection: true },
    { name: "dracula-large", terminalTheme: "dracula", font: 20, scale: 100 },
    { name: "dark-zoom150", terminalTheme: "foom-dark", font: 14, scale: 150 },
    { name: "light-small80", terminalTheme: "foom-light", font: 10, scale: 80 },
    { name: "geist-font", terminalTheme: "foom-dark", font: 16, scale: 100, family: "Geist Mono" },
  ];
  const reports = [];
  for (const mode of ["dom", "webgl"]) {
    const { app, page } = await launch(context, mode);
    const violations = [],
      requests = [];
    await page.exposeFunction("recordCspViolation", (value) => violations.push(value));
    await page.evaluate(() =>
      document.addEventListener("securitypolicyviolation", (event) =>
        globalThis.recordCspViolation({
          directive: event.violatedDirective,
          blocked: event.blockedURI,
        }),
      ),
    );
    page.on("request", (request) => requests.push(request.url()));
    const [session] = (await page.evaluate(() => window.desktop.workspace())).terminals;
    await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
      id: session.id,
      command: `"${process.execPath}" "${path.resolve("spikes/xterm-webgl/output.cjs")}" visual\r`,
    });
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 10)).join(""), session.id),
      )
      .toContain("VISUAL_IDLE");
    await expect
      .poll(() => snapshot(page).then((value) => value.lines.join("\n")))
      .toContain("VISUAL_IDLE");
    const security = await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getLastWebPreferences();
      return {
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
      };
    });
    assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    const csp = await page
      .locator("meta[http-equiv=Content-Security-Policy]")
      .getAttribute("content");
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /connect-src 'none'/);
    for (const item of matrix) {
      await page.evaluate(
        (item) =>
          window.desktop.saveSetup({
            terminalTheme: item.terminalTheme,
            terminalFontSize: item.font,
            terminalFont: item.family || "Hack Nerd Font Mono",
            interfaceScale: item.scale,
          }),
        item,
      );
      await expect
        .poll(() => page.evaluate(() => devicePixelRatio))
        .toBeCloseTo(item.scale / 100, 3);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              globalThis.__xtermEval.shells.find((shell) => !shell.disposed).terminal.options
                .fontSize,
          ),
        )
        .toBe(item.font);
      // Wait for fitted geometry after settings/zoom, then paint the controlled screen.
      await page.evaluate(async (item) => {
        const shell = globalThis.__xtermEval.shells.find((shell) => !shell.disposed),
          t = shell.terminal;
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        shell.fit.fit();
        await window.desktop.resize(shell.id(), t.cols, t.rows);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        t.reset();
        t.options.cursorBlink = false;
        t.options.cursorStyle = "block";
        t.focus();
        t.clearSelection();
        await new Promise((resolve) =>
          t.write(
            "\x1b[2J\x1b[HRenderer comparison\r\n\x1b[1mBOLD\x1b[0m normal 0123456789\r\n\x1b[31mRED\x1b[32m GREEN\x1b[34m BLUE\x1b[0m\r\nLigature-free: != => === ffi\r\nUnicode: λ café ┌─┐\r\nCursor: \x1b[?25h",
            resolve,
          ),
        );
        if (item.selection) t.select(0, 1, 10);
        t.refresh(0, t.rows - 1);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, item);
      const state = await page.evaluate(() => {
        const s = globalThis.__xtermEval.shells.find((shell) => !shell.disposed),
          t = s.terminal,
          b = t.buffer.active;
        return {
          mode: s.state,
          contexts: s.container.querySelectorAll("canvas").length,
          cols: t.cols,
          rows: t.rows,
          font: t.options.fontFamily,
          fontSize: t.options.fontSize,
          theme: t.options.theme,
          selection: t.getSelection(),
          cursor: [b.cursorX, b.cursorY],
          lines: Array.from({ length: 6 }, (_, i) => b.getLine(i).translateToString(true)),
        };
      });
      if (mode === "webgl") assert.equal(state.mode, "active");
      assert.equal(state.selection, item.selection ? "BOLD norma" : "");
      const rect = await page.locator(".xterm-screen").evaluate((element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: Math.min(550, r.width), height: Math.min(200, r.height) };
      });
      const png = await app.evaluate(async ({ BrowserWindow }, rect) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        const zoom = window.webContents.getZoomFactor();
        return (
          await window.webContents.capturePage({
            x: Math.floor(rect.x * zoom),
            y: Math.floor(rect.y * zoom),
            width: Math.floor(rect.width * zoom),
            height: Math.floor(rect.height * zoom),
          })
        )
          .toPNG()
          .toString("base64");
      }, rect);
      await writeFile(`${resultRoot}/visual/${mode}-${item.name}.png`, Buffer.from(png, "base64"));
      reports.push({ mode, case: item.name, state });
    }
    assert.deepEqual(violations, []);
    assert.ok(
      requests.every((url) => url.startsWith("app://bundle/")),
      "no addon network/blob/worker assets",
    );
    const resources = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name),
    );
    assert.ok(resources.every((url) => url.startsWith("app://bundle/")));
    const unlistedStatus = await app.evaluate(
      async ({ net }) => (await net.fetch("app://bundle/addon-webgl.js")).status,
    );
    assert.equal(unlistedStatus, 404);
    reports.push({
      mode,
      security,
      csp,
      requests,
      resources,
      unlistedStatus,
      violations,
      gpu: await gpuInfo(app),
    });
  }
  await report("visual-security", { matrix: reports });
});

test("inactive desktop fixture policy works on isolated display", {
  timeout: deadline(30000),
}, async (context) => {
  const inactive = harness(true);
  const app = await inactive.launchApp(context, { fixture: "running-shell", args });
  const page = await inactive.boardPage(app);
  await routeBundle(page, "webgl");
  assert.equal((await shells(page))[0].contexts, 1);
  await report("inactive-fixture", {
    checks: {
      guardedFixtureStarted: true,
      realWebglContext: true,
      showInactivePolicyInstalled: true,
    },
  });
});
