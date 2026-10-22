// Manual: pnpm run build; MEASURE_LABEL=before xvfb-run -a node --test tests/electron/streaming-measurement.js.
// Nine isolated fixture shells: six tiles, eight bounded streams (three detached).
const { test } = require("node:test");
const { writeFileSync, readFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { cpus, release } = require("node:os");
const { launchApp, boardPage } = require("./harness.js");
const { expect } = require("@playwright/test");
mkdirSync("test-results", { recursive: true });
const label = process.env.MEASURE_LABEL || "before";
const probes = Number(process.env.MEASURE_PROBES || 10);
if (!Number.isInteger(probes) || probes < 1 || probes > 30)
  throw new Error("MEASURE_PROBES must be 1..30");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("isolated visible and hidden streaming measurement", async (t) => {
  const app = await launchApp(t, { fixture: "running-shell", renderer: "dom" });
  const page = await boardPage(app);
  const repository = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
  await page.evaluate(async (repository) => {
    for (let i = 0; i < 8; i++)
      await window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "shell",
      });
  }, repository);
  await expect(page.locator(".board-row")).toHaveCount(9);
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
    await page.getByRole("menuitem", { name: "Split down", exact: true }).click();
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
  for (const name of ["MEASURE_LAYER", "MEASURE_CONTAIN_ROWS", "MEASURE_DIM_OVERLAY"])
    if (process.env[name] !== undefined && !["0", "1"].includes(process.env[name]))
      throw new Error(`${name} must be 0 or 1`);
  if (process.env.MEASURE_LAYER !== undefined) {
    const value = process.env.MEASURE_LAYER === "1" ? "transform" : "auto";
    await page.addStyleTag({
      content: `.tile-terminal .xterm-screen:has(> .xterm-rows) { will-change: ${value}; }`,
    });
    await expect(page.locator(".xterm-screen").first()).toHaveCSS("will-change", value);
  }
  if (process.env.MEASURE_CONTAIN_ROWS === "1") {
    await page.addStyleTag({ content: ".xterm-rows > div { contain: strict; }" });
    await expect(page.locator(".xterm-rows > div").first()).toHaveCSS("contain", "strict");
  }
  if (process.env.MEASURE_DIM_OVERLAY === "1") {
    await page.addStyleTag({
      content: `
      .tile-shell:has(.xterm-screen > .xterm-rows) { position: relative; }
      .terminal-tile:not([data-focused="true"]) .tile-shell:has(.xterm-screen > .xterm-rows) { opacity: 1; }
      .terminal-tile:not([data-focused="true"]) .tile-shell:has(.xterm-screen > .xterm-rows)::after {
        content: ""; position: absolute; inset: 0; pointer-events: none;
        background: color-mix(in srgb, var(--terminal-background, var(--bg)) 20%, transparent);
      }
    `,
    });
    await expect(
      page
        .locator('.terminal-tile:not([data-focused="true"]) .tile-shell:has(.xterm-rows)')
        .first(),
    ).toHaveCSS("opacity", "1");
  }
  const appliedStyles = await page.locator(".xterm-screen").evaluateAll((screens) =>
    screens.map((screen) => ({
      willChange: getComputedStyle(screen).willChange,
      shellOpacity: getComputedStyle(screen.closest(".tile-shell")).opacity,
      dimOverlay: getComputedStyle(screen.closest(".tile-shell"), "::after").backgroundColor,
      rowContain: getComputedStyle(screen.querySelector(".xterm-rows > div")).contain,
    })),
  );
  if (process.env.MEASURE_LAYER !== undefined)
    expect(
      appliedStyles.every(
        (style) => style.willChange === (process.env.MEASURE_LAYER === "1" ? "transform" : "auto"),
      ),
    ).toBe(true);
  const profiler =
    process.env.MEASURE_PROFILE === "1" ? await page.context().newCDPSession(page) : undefined;
  if (profiler) {
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.setSamplingInterval", { interval: 1000 });
  }
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
    await app.evaluate(({ ipcMain }) => {
      globalThis.measureIpc = { ack: 0, input: 0, resize: 0 };
      globalThis.measureListeners = Object.keys(globalThis.measureIpc).map((name) => {
        const listener = () => globalThis.measureIpc[name]++;
        ipcMain.on(`terminal:${name}`, listener);
        return [name, listener];
      });
    });
    const counters = await page.evaluateHandle(() => {
      const counts = { data: 0, units: 0, activity: 0, state: 0, rowReplacements: 0 };
      const rows = [...document.querySelectorAll(".board-row")];
      const off = [
        window.desktop.onData((_id, _token, data) => {
          counts.data++;
          counts.units += data.length;
        }),
        window.desktop.onActivity(() => counts.activity++),
        window.desktop.onState(() => counts.state++),
      ];
      return {
        counts,
        stop: () => {
          for (const stop of off) stop();
          counts.rowReplacements = rows.filter((row) => !row.isConnected).length;
          return counts;
        },
      };
    });
    if (profiler) await profiler.send("Profiler.start");
    const before = await metrics();
    const frames = await page.evaluateHandle(() => {
      const state = { intervals: [], previous: performance.now(), running: true };
      const frame = (now) => {
        state.intervals.push(now - state.previous);
        state.previous = now;
        if (state.running) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      return state;
    });
    const start = performance.now();
    const latency = during ? await during() : (await sleep(6000), []);
    const elapsed = performance.now() - start;
    const after = await metrics();
    if (profiler) {
      const { profile } = await profiler.send("Profiler.stop");
      writeFileSync(`test-results/${label}-${phase}.cpuprofile`, JSON.stringify(profile));
    }
    const messages = await counters.evaluate((state) => state.stop());
    await counters.dispose();
    const ipc = await app.evaluate(({ ipcMain }) => {
      for (const [name, listener] of globalThis.measureListeners)
        ipcMain.removeListener(`terminal:${name}`, listener);
      return globalThis.measureIpc;
    });
    const frameTimes = await frames.evaluate((state) => {
      state.running = false;
      return state.intervals.slice(1);
    });
    await frames.dispose();
    await app.evaluate(
      async ({ contentTracing }, file) => contentTracing.stopRecording(file),
      file,
    );
    const cpu = after.map((p) => ({
      type: p.type,
      name: p.name,
      pid: p.pid,
      workingSetKB: p.memory.workingSetSize,
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
      probes,
      appliedStyles,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      platform: `${process.platform}/${process.arch} ${release()}`,
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      tiles: 6,
      streaming: 8,
      detached: 3,
      covered: phase === "covered" ? 5 : 0,
      dimensions: await page.locator(".terminal-tile").evaluateAll((tiles) =>
        tiles.map((tile) => ({
          bounds: tile.getBoundingClientRect().toJSON(),
          screen: tile.querySelector(".xterm-screen")?.getAttribute("style"),
          rows: tile.querySelector(".xterm-rows")?.childElementCount,
        })),
      ),
      frameTimes,
      messages,
      ipc,
      renderer: "DOM (GPU disabled)",
      cpu,
      latency,
      costs,
    };
    console.log(JSON.stringify({ ...report, frameTimes: frameTimes.length }));
    writeFileSync(`test-results/${label}-${phase}.json`, JSON.stringify(report, null, 2));
  };
  await sleep(3000);
  const flood = path.resolve("test-results/streaming-flood.cjs");
  writeFileSync(
    flood,
    `let n=0;const t=setInterval(()=>{process.stdout.write(('flood '+ '0123456789'.repeat(7)+'\\r\\n').repeat(100));if(++n===1600){clearInterval(t);process.stdout.write('FLOOD_DONE\\r\\n');}},20);`,
  );
  for (const s of sessions.filter((_, i) => i !== 5))
    await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
      id: s.id,
      command: `"${process.execPath}" "${flood}"\r`,
    });
  await expect
    .poll(async () => {
      const tails = await page.evaluate(
        async (ids) => Promise.all(ids.map((id) => window.desktop.tail(id, 4))),
        sessions.filter((_, i) => i !== 5).map((s) => s.id),
      );
      return tails.every((lines) => lines.join("\n").includes("flood "));
    })
    .toBe(true);
  await sleep(1000);
  const probe = async () => {
    const latency = [];
    for (let i = 0; i < probes; i++) {
      const token = String.fromCharCode(65 + (i % 26));
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
            if (screen.textContent.trimEnd().endsWith(token)) {
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
      // Vary the gap so probes do not stay locked to the same 60 Hz phase.
      await sleep([409, 521, 613, 457, 557, 647][i % 6]);
    }
    return latency;
  };
  await capture("streaming", probe);
  if (process.env.MEASURE_VISIBLE_ONLY === "1") return;
  const focused = page.locator('.terminal-tile[data-focused="true"]');
  await focused.getByRole("button", { name: "Maximize tile", exact: true }).click();
  await focused.locator(".xterm-helper-textarea").focus();
  await sleep(500);
  await capture("covered", probe);
  console.log("GPU", JSON.stringify(await app.evaluate(({ app }) => app.getGPUFeatureStatus())));
});
