const { evidencePath } = require("../helpers/evidence.js");
const { gitSync } = require("../helpers/git.js");
// Manual: xvfb-run -a -s "-screen 0 2000x1400x24" node tests/electron/tiles-measurement.js (after pnpm run make).
// Six real tiles, two bounded output floods, DOM renderer, packaged sandbox intact.
const { chromium, expect } = require("@playwright/test");
const { isolatedEnvironment, isolatedLoginProfiles } = require("./agent-isolation.js");
const { auditProcesses } = require("./process-audit.js");
const { electronLaunch } = require("./display-isolation.js");
const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir, cpus } = require("node:os");
const path = require("node:path");
async function measure() {
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), "foom-tiles-measure-")));
  const profile = path.join(directory, "profile"),
    repository = path.join(directory, "repo");
  mkdirSync(profile);
  mkdirSync(repository);
  gitSync(["init", "-q", repository]);
  writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        agents: { codex: true },
        setupComplete: true,
        checkForUpdates: false,
        agentHooks: { codex: false },
      },
    }),
  );
  writeFileSync(
    path.join(profile, "worktrees.json"),
    JSON.stringify({ version: 1, repositories: [repository], managed: [] }),
  );
  writeFileSync(
    path.join(profile, "window-size.json"),
    JSON.stringify({ width: 1800, height: 1200 }),
  );
  const root = path.join(__dirname, "../..", "out", `Foom-${process.platform}-${process.arch}`);
  const executable =
    process.platform === "darwin"
      ? path.join(root, "Foom.app", "Contents", "MacOS", "Foom")
      : path.join(root, process.platform === "win32" ? "Foom.exe" : "Foom");
  const env = { ...process.env, ...(await isolatedEnvironment(profile)) };
  await isolatedLoginProfiles(profile, env.PATH);
  env.HOME = profile;
  env.USERPROFILE = profile;
  env.ZDOTDIR = profile;
  const audit = await auditProcesses({ diagnostic: (message) => console.info(message) });
  audit.forbidAgentsOutside(new Set([profile]));
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  let browser;
  let watchdog;
  try {
    const display = electronLaunch({
      env,
      args: [
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--mute-audio",
        "--disable-gpu",
        "--disable-software-rasterizer",
      ],
    });
    child = spawn(executable, display.args, {
      env: display.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (child.pid) audit.add(child.pid);
    watchdog = setTimeout(() => child.kill("SIGKILL"), 45000);
    const endpoint = await new Promise((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Package exited ${code}: ${output}`)));
      child.stderr.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-16000);
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) resolve(match[1]);
      });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    let page;
    await expect
      .poll(() => {
        page = context.pages().find((candidate) => candidate.url() === "app://bundle/index.html");
        return Boolean(page);
      })
      .toBe(true);
    // Electron's CDP endpoint has no Browser window-management domain. The
    // disposable profile seeds native geometry; Xvfb must provide enough space.
    await expect
      .poll(() => page.evaluate(() => innerWidth), {
        message: 'Use xvfb-run -a -s "-screen 0 2000x1400x24" for the six-tile measurement',
      })
      .toBeGreaterThan(1700);
    page.setDefaultTimeout(15000);
    await page.getByRole("main", { name: "Board" }).waitFor();
    await page.evaluate(async (repository) => {
      for (let index = 0; index < 6; index++)
        await window.desktop.sidebarCommand({
          kind: "launch",
          repository,
          worktree: repository,
          run: "shell",
        });
    }, repository);
    const rows = page.locator(".board-row");
    await expect(rows).toHaveCount(6);
    // Place a session in each new leaf before splitting again. Launching six
    // sessions only creates sidebar rows, and a refused split never creates a leaf.
    await rows.nth(0).click();
    await expect(page.locator(".xterm")).toHaveCount(1);
    const split = async (tile, direction, count) => {
      await page.getByRole("button", { name: `Tile ${tile} menu`, exact: true }).click();
      await page
        .getByRole("menuitem", { name: `Split terminal ${direction}`, exact: true })
        .click();
      await expect(page.locator(".terminal-tile")).toHaveCount(count);
      await rows.nth(count - 1).click();
      await expect(page.locator(".xterm")).toHaveCount(count);
    };
    await split(1, "right", 2);
    await split(2, "down", 3);
    await split(1, "up", 4);
    await split(2, "up", 5);
    await split(3, "up", 6);
    const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
    for (const session of sessions) {
      await page.evaluate(
        (id) => window.desktop.input(id, "echo FOOM_MEASURE_READY\r"),
        session.id,
      );
      await expect
        .poll(async () =>
          (await page.evaluate((id) => window.desktop.tail(id, 10), session.id)).some(
            (line) => line.trim() === "FOOM_MEASURE_READY",
          ),
        )
        .toBe(true);
    }
    const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "tile-flood.js")}"\r`;
    for (const session of sessions.slice(0, 2))
      await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
        id: session.id,
        command,
      });
    const frames = page.evaluate(
      () =>
        new Promise((resolve) => {
          const samples = [],
            longTasks = [];
          let previous = performance.now();
          const started = previous;
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTasks.push(entry.duration);
          });
          observer.observe({ type: "longtask", buffered: false });
          const frame = (now) => {
            samples.push(now - previous);
            previous = now;
            if (now - started < 10000) requestAnimationFrame(frame);
            else {
              observer.disconnect();
              samples.sort((a, b) => a - b);
              resolve({
                durationMs: now - started,
                frames: samples.length,
                frameP95Ms: samples[Math.floor(samples.length * 0.95)],
                frameMaxMs: Math.max(...samples),
                longTasks: longTasks.length,
                longTaskMaxMs: Math.max(0, ...longTasks),
              });
            }
          };
          requestAnimationFrame(frame);
        }),
    );
    const latency = [];
    for (let index = 0; index < 10; index++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const token = `TILE_PING_${index}`;
      const start = performance.now();
      await page.evaluate(({ id, token }) => window.desktop.input(id, `echo ${token}\r`), {
        id: sessions[2].id,
        token,
      });
      await expect(
        page
          .locator(".terminal-tile")
          .filter({ has: page.locator(".xterm-rows", { hasText: token }) }),
      ).toContainText(token);
      latency.push(performance.now() - start);
    }
    const timing = await frames;
    for (const session of sessions.slice(0, 2))
      await expect
        .poll(
          () =>
            page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), session.id),
          { timeout: 15000 },
        )
        .toContain("FLOOD_DONE");
    const tails = await page.evaluate(
      async (ids) => Promise.all(ids.map((id) => window.desktop.tail(id, 4))),
      sessions.slice(0, 2).map((session) => session.id),
    );
    const report = {
      platform: `${process.platform}/${process.arch}`,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      tiles: 6,
      flooding: 2,
      renderer: "xterm DOM",
      graphics: "GPU disabled; software compositor, no hardware GPU latency or memory attribution",
      grids: await page
        .locator(".terminal-links")
        .evaluateAll((elements) => elements.map((element) => element.dataset.grid)),
      sandbox: true,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      ...timing,
      inputToRenderedP95Ms: latency.sort((a, b) => a - b)[9],
      floodTails: tails,
    };
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(evidencePath("tiles-measurement-1065.json"), JSON.stringify(report, null, 2));
    await page.screenshot({ path: evidencePath("screenshots-1065/measurement-six-tiles.png") });
    for (const session of sessions)
      await page.evaluate((id) => window.desktop.input(id, "exit\r"), session.id);
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.every(
          (session) => session.exited,
        ),
      )
      .toBe(true);
  } finally {
    try {
      await browser?.close();
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 1000);
        await exited;
        clearTimeout(force);
      }
      clearTimeout(watchdog);
      try {
        await audit.finish();
      } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  }
}
measure().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
