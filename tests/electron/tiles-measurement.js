// Manual: xvfb-run -a node tests/electron/tiles-measurement.js (after npm run make).
// Six real tiles, two bounded output floods, DOM renderer, packaged sandbox intact.
const { chromium, expect } = require("@playwright/test");
const { spawn, execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir, cpus } = require("node:os");
const path = require("node:path");
async function measure() {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "foom-tiles-measure-")));
  const profile = path.join(directory, "profile"),
    repository = path.join(directory, "repo");
  mkdirSync(profile);
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({ version: 1, settings: { setupComplete: true } }),
  );
  writeFileSync(
    path.join(profile, "worktrees.json"),
    JSON.stringify({ version: 1, repositories: [repository], managed: [] }),
  );
  const root = path.join(__dirname, "../..", "out", `Foom-${process.platform}-${process.arch}`);
  const executable =
    process.platform === "darwin"
      ? path.join(root, "Foom.app", "Contents", "MacOS", "foom")
      : path.join(root, process.platform === "win32" ? "foom.exe" : "foom");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ["--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let browser;
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 45000);
  try {
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
    const page = context.pages()[0] ?? (await context.waitForEvent("page"));
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
    await page.getByRole("button", { name: "Two by two", exact: true }).click();
    for (let index = 0; index < 4; index++) await rows.nth(index).click();
    await page.getByRole("button", { name: "Split down", exact: true }).nth(1).click();
    await rows.nth(4).click();
    await page.getByRole("button", { name: "Split down", exact: true }).last().click();
    await rows.nth(5).click();
    await expect(page.locator(".xterm")).toHaveCount(6);
    const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
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
      sandbox: true,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      ...timing,
      inputToRenderedP95Ms: latency.sort((a, b) => a - b)[9],
      floodTails: tails,
    };
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(
      path.join(tmpdir(), "foom-132-measurement.json"),
      JSON.stringify(report, null, 2),
    );
    await page.screenshot({ path: path.join(tmpdir(), "foom-132-six-tiles.png") });
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
    await browser?.close();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(watchdog);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}
measure().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
