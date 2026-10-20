// Run from repository root, under Xvfb. Uses the real guarded Electron fixture.
const { test } = require("node:test");
const { writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { deadline, expect } = require("../../tests/electron/test-policy.js");
const assert = require("node:assert/strict");
const { harness, routeBundle, fillTiles, shells, gpuInfo } = require("./common.cjs");

async function measure(
  context,
  { tiles, renderer: mode, desktop = false, output, preflight = false },
) {
  const { launchApp, boardPage } = harness(desktop);
  const webgl = mode === "webgl";
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await routeBundle(page, mode);
  if (preflight) {
    const gpu = await gpuInfo(app);
    const context = await contextInfo(page);
    const hardware =
      gpu.features.webgl === "enabled" &&
      gpu.features.gpu_compositing === "enabled" &&
      context.available &&
      !/swiftshader|llvmpipe|softpipe|lavapipe|software|microsoft basic render/i.test(
        context.renderer || "",
      );
    const status = {
      hardware,
      gpu,
      context,
      display: process.env.DISPLAY,
      waylandDisplay: process.env.WAYLAND_DISPLAY,
      addedGpuSwitches: [],
      actualGpuSwitches: await app.evaluate(({ app }) => ({
        angle: app.commandLine.getSwitchValue("use-angle"),
        unsafeSwiftShader: app.commandLine.hasSwitch("enable-unsafe-swiftshader"),
        disableGpu: app.commandLine.hasSwitch("disable-gpu"),
      })),
      inactivePolicy: true,
    };
    await writeFile(
      "spikes/xterm-webgl/results/hardware-status.json",
      JSON.stringify(status, null, 2) + "\n",
    );
    if (!hardware) return { hardware: false, status };
  }
  await fillTiles(page, tiles);
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  expect(sessions.length).toBe(tiles);
  await expect
    .poll(() => page.locator(".terminal-tile[data-empty=false] .xterm-screen").count())
    .toBe(tiles);
  const gpu = await gpuInfo(app);
  const renderer = await contextInfo(page);
  const rendererShells = await shells(page);
  assert.equal(rendererShells.length, tiles);
  if (webgl)
    for (const shell of rendererShells) {
      assert.equal(shell.state, "active");
      assert.equal(shell.contexts, 1);
      assert.ok(!/swiftshader|llvmpipe|softpipe|lavapipe|software/i.test(shell.renderer));
    }
  // Keep identical cell counts: DOM and WebGL round fractional cell widths differently.
  const grid = tiles === 4 ? { cols: 40, rows: 18 } : { cols: 20, rows: 6 };
  await page.evaluate(async (grid) => {
    for (const shell of globalThis.__xtermEval.shells.filter(
      (shell) => !shell.disposed && !shell.container.hidden,
    )) {
      shell.terminal.resize(grid.cols, grid.rows);
      await window.desktop.resize(shell.id(), grid.cols, grid.rows);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, grid);
  const normalizedShells = await shells(page);
  for (const shell of normalizedShells) {
    assert.equal(shell.cols, grid.cols);
    assert.equal(shell.rows, grid.rows);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
    );
  const memory = async () => ({
    metrics: await metrics(),
    dom: await cdp.send("Memory.getDOMCounters"),
    processes: await app.evaluate(({ app, BrowserWindow }) => {
      const boardPid = BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getOSProcessId();
      return app
        .getAppMetrics()
        .map(({ pid, type, memory }) => ({ type, board: pid === boardPid, memory }));
    }),
  });
  const idle = await memory();
  const command = `"${process.execPath}" "${path.resolve("tests/electron/tile-flood.js")}"\r`;
  for (const { id } of sessions)
    await page.evaluate(({ id, command }) => window.desktop.input(id, command), { id, command });
  for (const { id } of sessions)
    await expect
      .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 5)).join(""), id))
      .toContain("flood 0123456789");
  if (!webgl || (await page.locator("[data-webgl=active]").count()) === 0)
    await expect
      .poll(() =>
        page
          .locator(".terminal-tile[data-empty=false] .xterm-rows")
          .evaluateAll(
            (nodes) => nodes.filter((node) => node.textContent.includes("flood 0123456789")).length,
          ),
      )
      .toBe(tiles);
  // Elapsed-time windows are the behavior being measured: warm up, then sample.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const until = performance.now() + 1000;
        const tick = () => (performance.now() < until ? requestAnimationFrame(tick) : resolve());
        requestAnimationFrame(tick);
      }),
  );
  const events = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline",
    transferMode: "ReportEvents",
  });
  const before = await metrics();
  const timing = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        let previous = start;
        const intervals = [],
          tasks = [];
        const observer = new PerformanceObserver((list) =>
          tasks.push(...list.getEntries().map((entry) => entry.duration)),
        );
        observer.observe({ type: "longtask" });
        const tick = (now) => {
          intervals.push(now - previous);
          previous = now;
          if (now - start < 8000) requestAnimationFrame(tick);
          else {
            observer.disconnect();
            intervals.sort((a, b) => a - b);
            resolve({
              durationMs: now - start,
              frames: intervals.length,
              frameP50Ms: intervals[Math.floor(intervals.length * 0.5)],
              frameP95Ms: intervals[Math.floor(intervals.length * 0.95)],
              frameMaxMs: intervals.at(-1),
              longTasks: tasks.length,
              longTaskMs: tasks.reduce((a, b) => a + b, 0),
              maxLongTaskMs: Math.max(0, ...tasks),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  const after = await memory();
  for (const shell of await shells(page)) {
    assert.equal(shell.cols, grid.cols);
    assert.equal(shell.rows, grid.rows);
    if (webgl) assert.equal(shell.contexts, 1);
  }
  const complete = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await complete;
  const delta = Object.fromEntries(
    [
      "TaskDuration",
      "ScriptDuration",
      "LayoutDuration",
      "RecalcStyleDuration",
      "LayoutCount",
      "RecalcStyleCount",
    ].map((name) => [name, after.metrics[name] - before[name]]),
  );
  const paint = events.filter((event) => event.name === "Paint" && event.ph === "X");
  const activeWebgl = await page.locator("[data-webgl=active]").count();
  const report = {
    actualRenderer: activeWebgl === tiles ? "webgl" : activeWebgl === 0 ? "dom" : "mixed",
    viewport: await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
    })),
    requestedRenderer: webgl ? "webgl" : "dom",
    tiles,
    gpu,
    renderer,
    grid,
    rendererShells: normalizedShells,
    nativeWindows: await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    ),
    addonStates: await page
      .locator("[data-webgl]")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ state: node.dataset.webgl, error: node.dataset.webglError })),
      ),
    grids: await page
      .locator(".xterm-screen")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ width: node.clientWidth, height: node.clientHeight })),
      ),
    ...timing,
    ...delta,
    paintMs: paint.reduce((sum, event) => sum + event.dur / 1000, 0),
    paintEvents: paint.length,
    memory: { idle, streaming: after },
    versions: await app.evaluate(() => process.versions),
  };
  await mkdir("test-results", { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    "WEBGL_EVALUATION",
    JSON.stringify({
      output,
      renderer,
      ...delta,
      ...timing,
      paintMs: report.paintMs,
      addonStates: report.addonStates,
    }),
  );
  for (const { id } of sessions)
    await expect
      .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join(""), id))
      .toContain("FLOOD_DONE");
  return { hardware: true, report };
}

async function contextInfo(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return { available: false };
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const info = {
      available: true,
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return info;
  });
}
module.exports = { measure };
if (require.main === module)
  test("isolated DOM baseline measurement", { timeout: deadline(60000) }, (context) =>
    measure(context, {
      tiles: Number(process.env.FOOM_WEBGL_TILES || 4),
      renderer: "dom",
      output: process.env.FOOM_WEBGL_REPORT || "test-results/620-dom-baseline.json",
    }),
  );
