// Manual Linux measurement: pnpm run build, then xvfb-run -a node --test tests/electron/idle-measurement.js.
// Six isolated DOM tiles; five bounded streams. Never attaches to another app.
const { test } = require("node:test");
const { writeFileSync, readFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { cpus, release } = require("node:os");
const { launchApp, boardPage } = require("./harness.js");
const { expect } = require("@playwright/test");
mkdirSync("test-results", { recursive: true });
const label = process.env.MEASURE_LABEL || "before";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("isolated idle and five-stream measurement", async (t) => {
  const app = await launchApp(t, { fixture: "running-shell", renderer: "dom" });
  const page = await boardPage(app);
  const repository = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  await page.evaluate(async (repository) => {
    for (let i = 0; i < 5; i++)
      await window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "shell",
      });
  }, repository);
  await expect(page.locator(".board-row")).toHaveCount(6);
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL() === "app://bundle/index.html")
      .setSize(1800, 1200),
  );
  const rows = page.locator(".board-row");
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(page.locator(".terminal-tile")).toHaveCount(2);
  await page.evaluate(() => window.desktop.appMenu.execute("split-down"));
  await expect(page.locator(".terminal-tile")).toHaveCount(3);
  for (let i = 0; i < 3; i++) await rows.nth(i).click();
  const split = async (tile, count) => {
    await page.getByRole("button", { name: `Tile ${tile} menu`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Split terminal up", exact: true }).click();
    await expect(page.locator(".terminal-tile")).toHaveCount(count);
  };
  await split(3, 4);
  await rows.nth(3).click();
  await split(2, 5);
  await rows.nth(4).click();
  await split(5, 6);
  await rows.nth(5).click();
  await expect(page.locator(".xterm")).toHaveCount(6);
  await page.locator(`[data-drag-session="${sessions[5].id}"]`).press("Enter");
  await expect(page.locator(".xterm-helper-textarea:focus")).toHaveCount(1);
  const metrics = () => app.evaluate(({ app }) => app.getAppMetrics());
  const capture = async (phase, during) => {
    const file = path.resolve(`test-results/${label}-${phase}-trace.json`);
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
    const before = await metrics();
    const start = performance.now();
    const latency = during ? await during() : (await sleep(6000), []);
    const elapsed = performance.now() - start;
    const after = await metrics();
    await app.evaluate(
      async ({ contentTracing }, file) => contentTracing.stopRecording(file),
      file,
    );
    const cpu = after.map((p) => ({
      type: p.type,
      name: p.name,
      pid: p.pid,
      percent:
        (100000 *
          (p.cpu.cumulativeCPUUsage -
            (before.find((b) => b.pid === p.pid)?.cpu.cumulativeCPUUsage || 0))) /
        elapsed,
    }));
    const events = JSON.parse(readFileSync(file)).traceEvents;
    const costs = {};
    for (const e of events)
      if (
        e.ph === "X" &&
        [
          "Paint",
          "UpdateLayoutTree",
          "Layout",
          "CompositeLayers",
          "FunctionCall",
          "TimerFire",
          "FireAnimationFrame",
          "DrawFrame",
          "RunTask",
        ].includes(e.name)
      ) {
        const key = `${e.pid}:${e.name}`;
        const c = (costs[key] ??= { count: 0, ms: 0 });
        c.count++;
        c.ms += (e.dur || 0) / 1000;
      }
    const report = {
      label,
      phase,
      elapsed,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      platform: `${process.platform}/${process.arch} ${release()}`,
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      tiles: 6,
      streaming: phase === "streaming" ? 5 : 0,
      renderer: "DOM (GPU disabled)",
      cpu,
      latency,
      costs,
    };
    console.log(JSON.stringify(report));
    writeFileSync(`test-results/${label}-${phase}.json`, JSON.stringify(report, null, 2));
  };
  await sleep(22000);
  await capture("idle");
  const flood = path.resolve("test-results/idle-flood.cjs");
  writeFileSync(
    flood,
    `let n=0;const t=setInterval(()=>{process.stdout.write(('flood '+ '0123456789'.repeat(7)+'\\r\\n').repeat(100));if(++n===800){clearInterval(t);process.stdout.write('FLOOD_DONE\\r\\n');}},20);`,
  );
  for (const s of sessions.slice(0, 5))
    await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
      id: s.id,
      command: `"${process.execPath}" "${flood}"\r`,
    });
  await expect
    .poll(async () => {
      const tails = await page.evaluate(
        async (ids) => Promise.all(ids.map((id) => window.desktop.tail(id, 4))),
        sessions.slice(0, 5).map((s) => s.id),
      );
      return tails.every((lines) => lines.join("\n").includes("flood "));
    })
    .toBe(true);
  await sleep(1000);
  await capture("streaming", async () => {
    const latency = [];
    for (let i = 0; i < 10; i++) {
      const token = String.fromCharCode(65 + i);
      const echo = await page.evaluateHandle((token) => {
        const ready = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            observer.disconnect();
            reject(new Error("Echo timeout"));
          }, 3000);
          const screen = document.activeElement
            .closest(".terminal-tile")
            .querySelector(".xterm-rows");
          const observer = new MutationObserver(() => {
            if (screen.textContent.includes(token)) {
              clearTimeout(timeout);
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        });
        return { ready };
      }, token);
      const start = performance.now();
      await page.keyboard.press(token);
      await echo.evaluate(async (state) => {
        await state.ready;
      });
      await echo.dispose();
      latency.push(performance.now() - start);
      await page.keyboard.press("Control+U");
      await sleep(500);
    }
    return latency;
  });
  console.log("GPU", JSON.stringify(await app.evaluate(({ app }) => app.getGPUFeatureStatus())));
});
