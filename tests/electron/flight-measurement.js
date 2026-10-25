const { evidencePath } = require("../helpers/evidence.js");
// Manual isolated measurement, following idle-measurement.js (#697):
// pnpm run build && MEASURE_LABEL=after xvfb-run -a node --test tests/electron/flight-measurement.js
// No real agents or user profiles. Reports/traces/screenshots stay untracked.
const { test } = require("node:test");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { cpus, release } = require("node:os");
const { launchApp, boardPage } = require("./harness.js");
const { expect } = require("./test-policy.js");
const directory = evidencePath("screenshots-725");
mkdirSync(directory, { recursive: true });
const reports = path.resolve("test-results/flight-725");
mkdirSync(reports, { recursive: true });
const label = process.env.MEASURE_LABEL || "after";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("isolated flight CPU and trace measurement", async (t) => {
  const app = await launchApp(t, { fixture: "empty-board", renderer: "webgl" });
  const page = await boardPage(app);
  await page.emulateMedia({ colorScheme: "dark" });
  const capture = async (phase) => {
    // Settle image decode, shader compilation and transition paints before sampling.
    await sleep(1000);
    const file = path.join(reports, `${label}-${phase}-trace.json`);
    await app.evaluate(async ({ contentTracing }) =>
      contentTracing.startRecording({
        included_categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "blink.user_timing",
          "v8.execute",
          "toplevel",
          "cc",
          "gpu",
        ],
      }),
    );
    const before = await app.evaluate(({ app }) => app.getAppMetrics());
    const start = performance.now();
    // Elapsed time is the quantity measured, not a readiness wait.
    await sleep(6000);
    const elapsed = performance.now() - start;
    const after = await app.evaluate(({ app }) => app.getAppMetrics());
    await app.evaluate(
      async ({ contentTracing }, file) => contentTracing.stopRecording(file),
      file,
    );
    const cpu = after.map((p) => ({
      type: p.type,
      pid: p.pid,
      percent:
        (100000 *
          (p.cpu.cumulativeCPUUsage -
            (before.find((b) => b.pid === p.pid)?.cpu.cumulativeCPUUsage || 0))) /
        elapsed,
    }));
    const costs = {};
    for (const e of JSON.parse(readFileSync(file)).traceEvents) {
      if (
        e.ph !== "X" ||
        ![
          "Paint",
          "UpdateLayoutTree",
          "Layout",
          "FunctionCall",
          "TimerFire",
          "FireAnimationFrame",
          "DrawFrame",
        ].includes(e.name)
      )
        continue;
      const cost = (costs[`${e.pid}:${e.name}`] ??= { count: 0, ms: 0 });
      cost.count++;
      cost.ms += (e.dur || 0) / 1000;
    }
    const report = {
      label,
      phase,
      elapsed,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      renderer: "SwiftShader software WebGL under Xvfb",
      platform: `${process.platform}/${process.arch} ${release()}`,
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      gpu: await app.evaluate(({ app }) => app.getGPUFeatureStatus()),
      cpu,
      costs,
    };
    writeFileSync(path.join(reports, `${label}-${phase}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    await page.screenshot({ path: evidencePath(path.join(directory, `${label}-${phase}.png`)) });
  };
  await page.evaluate(() => window.desktop.appMenu.execute("about"));
  await expect(page.getByRole("dialog", { name: "About Foom", exact: true })).toBeVisible();
  await capture("about");
  const rocket = await page.getByRole("button", { name: "Replay launch" }).boundingBox();
  if (!rocket) throw new Error("Missing replay rocket");
  // Click its current centre: the intentional bob keeps its bounds moving.
  await page.mouse.click(rocket.x + rocket.width / 2, rocket.y + rocket.height / 2);
  await expect(page.locator(".launch")).toBeVisible();
  await expect(page.locator(".about-dialog")).not.toBeVisible();
  await capture("launch");
  await page.keyboard.press("Escape");
  await expect(page.locator(".launch")).toHaveCount(0);
  await capture("closed");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.evaluate(() => window.desktop.appMenu.execute("about"));
  await expect(page.getByRole("dialog", { name: "About Foom", exact: true })).toBeVisible();
  await capture("reduced");
});
