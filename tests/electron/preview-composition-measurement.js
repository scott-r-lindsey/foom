// After a build: xvfb-run -a node --require ./tests/helpers/setup.js --test tests/electron/preview-composition-measurement.js
// Optional FOOM_PREVIEW_PROFILE_BUNDLE compares another renderer bundle in the same fixture.
// FOOM_PREVIEW_PROFILE_WITH_PREVIEW=1 adds a static native preview and its cached canvas.
// Use the same isolated fixture, agent guard and process audit as Electron tests.
const { test } = require("node:test");
const { writeFile } = require("node:fs/promises");
const path = require("node:path");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage } = require("./harness.js");

test("measure streaming fixture terminal composition", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  if (process.env.FOOM_PREVIEW_PROFILE_BUNDLE) {
    let served = 0;
    await page.route("**/renderer.js", (route) => {
      served++;
      return route.fulfill({
        path: process.env.FOOM_PREVIEW_PROFILE_BUNDLE,
        contentType: "application/javascript",
      });
    });
    await page.reload();
    expect(served).toBe(1);
    await expect(page.getByRole("main", { name: "Board" })).toBeVisible();
    await expect(page.locator(".xterm")).toHaveCount(1);
  }
  const [first] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  for (let index = 0; index < 3; index++) {
    await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
    await page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({
          kind: "launch",
          repository,
          worktree,
          run: "shell",
        }),
      first,
    );
  }
  await expect(page.locator(".xterm")).toHaveCount(4);
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  if (process.env.FOOM_PREVIEW_PROFILE_WITH_PREVIEW === "1") {
    const file = path.join(first.worktree, "profile.html");
    await writeFile(file, "<!doctype html><h1>Preview composition profile</h1>");
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.evaluate((root) => window.desktop.previews.pick(root), first.worktree);
    await page.evaluate(() => window.desktop.appMenu.execute("split-down"));
    await page.locator(".preview-row").click();
    await expect(page.locator(".preview-snapshot")).toHaveCount(1);
    await expect
      .poll(() => page.locator(".preview-snapshot").evaluate((canvas) => canvas.width))
      .toBeGreaterThan(1);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
    );
  const before = await metrics();
  const sample = page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        const tasks = [];
        let frames = 0;
        const observer = new PerformanceObserver((list) =>
          tasks.push(...list.getEntries().map((entry) => entry.duration)),
        );
        observer.observe({ type: "longtask" });
        const tick = () => {
          frames++;
          if (performance.now() - start < 10000) requestAnimationFrame(tick);
          else {
            observer.disconnect();
            resolve({
              durationMs: performance.now() - start,
              frames,
              longTasks: tasks.length,
              longTaskMs: tasks.reduce((sum, value) => sum + value, 0),
              maxLongTaskMs: Math.max(0, ...tasks),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  const command = `"${process.execPath}" "${path.join(__dirname, "tile-flood.js")}"\r`;
  for (const { id } of sessions)
    await page.evaluate(({ id, command }) => window.desktop.input(id, command), { id, command });
  const timing = await sample;
  const after = await metrics();
  const delta = Object.fromEntries(
    [
      "TaskDuration",
      "ScriptDuration",
      "LayoutDuration",
      "RecalcStyleDuration",
      "LayoutCount",
      "RecalcStyleCount",
    ].map((name) => [name, after[name] - before[name]]),
  );
  const report = {
    terminals: sessions.length,
    previews: await page.locator(".preview-snapshot").count(),
    ...timing,
    ...delta,
  };
  console.log("PREVIEW_COMPOSITION_PROFILE", JSON.stringify(report));
  await writeFile(
    process.env.FOOM_PREVIEW_PROFILE_REPORT || "/tmp/619-renderer-profile.json",
    JSON.stringify(report, null, 2),
  );
  for (const { id } of sessions)
    await expect
      .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join(""), id))
      .toContain("FLOOD_DONE");
});
