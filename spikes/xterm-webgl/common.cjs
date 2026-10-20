const path = require("node:path");
const { readFileSync } = require("node:fs");
const Module = require("node:module");
const { expect } = require("../../tests/electron/test-policy.js");

function harness(desktop) {
  if (!desktop) {
    const original = require("../../tests/electron/harness.js");
    return {
      ...original,
      launchApp: (context, options) =>
        original.launchApp(context, { ...options, renderer: "hardware" }),
    };
  }
  // In-memory fixture-only variant. Preserve isolation/guards/cleanup/audit; replace
  // focus-dependent readiness and inject an inactive-window policy before main.
  const file = require.resolve("../../tests/electron/harness.js");
  let source = readFileSync(file, "utf8");
  const start = source.indexOf("async function boardPage(app) {");
  const end = source.indexOf("// Real decoding", start);
  if (start < 0 || end < 0) throw new Error("Review changed harness");
  source =
    source.slice(0, start) +
    `async function boardPage(app) {
    let page;
    await expect.poll(() => { page = app.windows().find(page => page.url() === 'app://bundle/index.html'); return Boolean(page); }).toBe(true);
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'app://bundle/index.html').showInactive());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return page;
  }\n` +
    source.slice(end);
  const statusNeedle = 'page.locator(".tile-status")';
  if (source.split(statusNeedle).length !== 3) throw new Error("Review fixture status selectors");
  source = source.replaceAll(
    statusNeedle,
    'page.locator(".terminal-tile[data-empty=false] .tile-status").first()',
  );
  source = source.replaceAll(
    'page.locator(".xterm-helper-textarea")',
    'page.locator(".terminal-tile[data-empty=false] .xterm-helper-textarea")',
  );
  const needle = `'const { app } = require("electron");',`;
  if (source.split(needle).length !== 2) throw new Error("Review changed fixture bootstrap");
  const bootstrap = `require(${JSON.stringify(path.resolve("spikes/xterm-webgl/inactive.cjs"))}).install(require('electron')); const { app } = require('electron');`;
  source = source.replace(needle, JSON.stringify(bootstrap) + ",");
  const quitNeedle =
    "      await Promise.race([\n        (async () => {\n          // Use the real quit dialog";
  if (source.split(quitNeedle).length !== 2) throw new Error("Review changed teardown");
  source = source.replace(
    quitNeedle,
    `      const board = await boardPage(app);
      await board.evaluate(async () => {
        for (const terminal of (await window.desktop.workspace()).terminals)
          if (!terminal.exited) window.desktop.input(terminal.id, 'exit' + String.fromCharCode(13));
      });
      await expect.poll(() => board.evaluate(async () => (await window.desktop.workspace()).terminals.every(terminal => terminal.exited))).toBe(true);
` + quitNeedle,
  );
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(source, file);
  const original = mod.exports;
  return {
    ...original,
    launchApp: (context, options) =>
      original.launchApp(context, { ...options, renderer: "hardware" }),
  };
}
const gpuInfo = async (app) =>
  app.evaluate(async ({ app }) => {
    let info;
    try {
      info = await app.getGPUInfo("complete");
    } catch (error) {
      info = { error: String(error) };
    }
    return { features: app.getGPUFeatureStatus(), info };
  });
async function routeBundle(page, renderer) {
  await page.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
  await page.route("**/renderer.js", (route) =>
    route.fulfill({
      path: path.resolve(`test-results/620-${renderer}-renderer.js`),
      contentType: "application/javascript",
    }),
  );
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(
        () => globalThis.__xtermEval?.shells.filter((shell) => !shell.disposed).length || 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect(
    page.locator(".terminal-tile[data-empty=false] .xterm-screen").first(),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        globalThis.__xtermEval.shells.some(
          (shell) =>
            !shell.disposed &&
            !shell.container.hidden &&
            shell.events.some((event) => event.startsWith("attached:")),
        ),
      ),
    )
    .toBe(true);
}
async function fillTiles(page, count) {
  const [first] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  for (let index = 1; index < count; index++) {
    const occupied = await page.locator(".terminal-tile[data-empty=false]").count();
    if (occupied >= count) break;
    const largest = await page.locator(".terminal-tile").evaluateAll(
      (nodes) =>
        nodes
          .map((node, index) => {
            const { width, height } = node.getBoundingClientRect();
            return { index, width, height, area: width * height };
          })
          .sort((a, b) => b.area - a.area)[0],
    );
    await page
      .locator(".terminal-tile")
      .nth(largest.index)
      .getByRole("button", { name: /^Tile \d+ menu$/ })
      .click();
    await page
      .getByRole("menuitem", {
        name: largest.width > largest.height * 1.5 ? "Split right" : "Split down",
        exact: true,
      })
      .click();
    const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
    await page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "shell" }),
      first,
    );
    await expect(page.locator(".board-row[data-kind='shell']")).toHaveCount(sessions.length + 1);
    await page.locator(".board-row[data-kind='shell']").nth(sessions.length).click();
    await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(occupied + 1);
  }
  await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(count);
}
const shells = (page) =>
  page.evaluate(() =>
    globalThis.__xtermEval.shells
      .filter((shell) => !shell.disposed)
      .map((shell) => {
        const canvases = [...shell.container.querySelectorAll("canvas")];
        const canvas = canvases.find((canvas) => {
          try {
            return !!canvas.getContext("webgl2");
          } catch {
            return false;
          }
        });
        const gl = canvas?.getContext("webgl2");
        const debug = gl?.getExtension("WEBGL_debug_renderer_info");
        return {
          id: shell.id(),
          state: shell.state,
          losses: shell.losses,
          disposals: shell.disposals,
          events: shell.events,
          visible: !shell.container.hidden,
          contexts: gl && !gl.isContextLost() ? 1 : 0,
          renderer: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : undefined,
          rows: shell.terminal.rows,
          cols: shell.terminal.cols,
        };
      }),
  );
module.exports = { harness, gpuInfo, routeBundle, fillTiles, shells };
