// Run from repository root, under Xvfb. Uses the real guarded Electron fixture.
const { test } = require("node:test");
const { writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { deadline, expect } = require("../../tests/electron/test-policy.js");
const { launchApp, boardPage } = require("../../tests/electron/harness.js");
const tiles = Number(process.env.FOOM_WEBGL_TILES || 4);
const webgl = process.env.FOOM_WEBGL_RENDERER === "webgl";
if (![4, 9].includes(tiles)) throw new Error("Use 4 or 9 tiles");
test("evaluate streaming tile renderer", { timeout: deadline(60000) }, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  if (webgl) {
    await page.route("**/renderer.js", (route) =>
      route.fulfill({
        path: path.resolve("test-results/620-webgl-renderer.js"),
        contentType: "application/javascript",
      }),
    );
    await page.reload();
    await expect(page.locator(".xterm")).toHaveCount(1);
  }
  const [first] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  for (let index = 1; index < tiles; index++) {
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
    await page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "shell" }),
      first,
    );
    await expect(page.locator(".board-row[data-kind='shell']")).toHaveCount(index + 1);
    await page.locator(".board-row[data-kind='shell']").nth(index).click();
    await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(index + 1);
  }
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  expect(sessions.length).toBe(tiles);
  await expect
    .poll(() => page.locator(".terminal-tile[data-empty=false] .xterm-screen").count())
    .toBe(tiles);
  const gpu = await app.evaluate(async ({ app }) => {
    let info;
    try {
      info = await app.getGPUInfo("complete");
    } catch (error) {
      info = { error: String(error) };
    }
    return { features: app.getGPUFeatureStatus(), info };
  });
  const renderer = await page.evaluate(() => {
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
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return info;
  });
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
  const output =
    process.env.FOOM_WEBGL_REPORT || `test-results/620-${report.requestedRenderer}-${tiles}.json`;
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
});
