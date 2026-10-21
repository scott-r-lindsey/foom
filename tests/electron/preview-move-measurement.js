// After pnpm run build:
// xvfb-run -a node --require ./tests/helpers/setup.js --test --test-reporter=junit tests/electron/preview-move-measurement.js
// Optional FOOM_PREVIEW_MOVE_IDENTITY_MODULE selects a separately compiled base
// worktree-operations module for an otherwise identical baseline fixture.
// Test-only instrumentation: fixed stage names, durations and Git argument names;
// no terminal content, paths, credentials, or production tracing hooks.
const { test } = require("node:test");
const path = require("node:path");
const { mkdtemp, mkdir, writeFile, chmod } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { launchApp, boardPage, removeAfterApps } = require("./harness.js");
const { deadline, expect } = require("./test-policy.js");

for (const agents of [0, 5, 15]) {
  test(`preview move measurement with ${agents} streaming fixture agents`, {
    timeout: deadline(180000),
    skip: process.platform === "win32" && "POSIX fixture executable",
  }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "foom-move-measurement-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "claude"),
      `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('2.1.300 (Claude Code)'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('  --settings <file-or-json>  Load settings'); process.exit(0); }
process.stdout.write('FIXTURE_STREAM_READY\\r\\n');
let sequence = 0;
setInterval(() => process.stdout.write(('fixture output ' + sequence++ + ' '.repeat(60) + '\\r\\n').repeat(16)), 20);
process.stdin.setRawMode(true);
process.stdin.on("data", () => process.exit(0));
`,
    );
    await chmod(path.join(bin, "claude"), 0o755);
    const app = await launchApp(context, { fixture: "repository", env: { PATH: bin } });
    let page = await boardPage(app);
    const agentPage = page;
    const sessions = [];
    const repository = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
    await app.evaluate(
      ({ BrowserWindow }, { modulePath, baselineIdentity }) => {
        const load = process.getBuiltinModule("node:module").createRequire(modulePath);
        if (baselineIdentity) {
          // A separately compiled helper from the measured base revision lets the
          // same fixture measure the old operation paths without changing app files.
          Object.assign(load("../workspace/worktree-operations.js"), load(baselineIdentity));
        }
        const { PreviewHost } = load(modulePath);
        const { PreviewRegistry } = load("./registry.js");
        const { PreviewPlacement } = load("./placement.js");
        const children = process.getBuiltinModule("node:child_process");
        const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
        const state = (globalThis.moveMeasurement = { stages: [], git: [], active: false });
        state.lag = monitorEventLoopDelay({ resolution: 10 });
        state.lag.enable();
        const spawn = children.ChildProcess.prototype.spawn;
        children.ChildProcess.prototype.spawn = function (options) {
          if (state.active && /(?:^|[/\\])git(?:\.exe)?$/.test(options.file))
            state.git.push(options.args.slice(1, 3).join(" "));
          return spawn.call(this, options);
        };
        const wrap = (owner, key, label) => {
          const original = owner[key];
          owner[key] = async function (...args) {
            const start = performance.now();
            try {
              return await original.apply(this, args);
            } finally {
              if (state.active)
                state.stages.push({
                  stage:
                    label === "board-load" && args[0] !== "app://bundle/index.html"
                      ? "confirmation-load"
                      : label,
                  ms: performance.now() - start,
                });
            }
          };
        };
        wrap(BrowserWindow.prototype, "loadURL", "board-load");
        wrap(PreviewHost.prototype, "release", "source-release");
        wrap(PreviewHost.prototype, "capture", "snapshot");
        wrap(PreviewHost.prototype, "moveTo", "host-move");
        wrap(PreviewRegistry.prototype, "save", "registry-save");
        wrap(PreviewPlacement.prototype, "place", "placement");
        const create = PreviewHost.prototype.createView;
        PreviewHost.prototype.createView = function (...args) {
          const start = performance.now();
          const entry = create.apply(this, args);
          if (state.active)
            entry.view.webContents.once("did-finish-load", () => {
              state.stages.push({ stage: "preview-load", ms: performance.now() - start });
            });
          return entry;
        };
        // Existing and future hosts use the same validation closure; instrument
        // around moveTo without replacing or skipping its checks.
        const move = PreviewHost.prototype.moveTo;
        PreviewHost.prototype.moveTo = function (id, target) {
          const validate = target.validateWorktree;
          target.validateWorktree = async (...args) => {
            const start = performance.now();
            try {
              return await validate(...args);
            } finally {
              if (state.active)
                state.stages.push({ stage: "validation", ms: performance.now() - start });
            }
          };
          return move.call(this, id, target);
        };
      },
      {
        modulePath: path.resolve("build/main/previews/host.js"),
        baselineIdentity: process.env.FOOM_PREVIEW_MOVE_IDENTITY_MODULE ?? null,
      },
    );
    const begin = () =>
      app.evaluate(() => {
        const state = globalThis.moveMeasurement;
        state.stages = [];
        state.git = [];
        state.lag.reset();
        state.active = true;
      });
    const end = (action) =>
      app.evaluate((_electron, action) => {
        const state = globalThis.moveMeasurement;
        state.active = false;
        return {
          action,
          stages: state.stages,
          gitSpawns: state.git.length,
          gitCommands: state.git,
          lagMeanMs: state.lag.mean / 1e6,
          lagMaxMs: state.lag.max / 1e6,
        };
      }, action);
    await page.evaluate(() => window.desktop.scanAgents(false));
    for (let index = 0; index < agents; index++) {
      const tree = await page.evaluate(
        ({ repository, index }) =>
          window.desktop.createWorktree(repository, `stream-${index}`, "adjacent"),
        { repository, index },
      );
      await begin();
      const session = await page.evaluate(
        ({ repository, worktree }) =>
          window.desktop.launchAgent({
            agent: "claude",
            repository,
            worktree,
            cols: 80,
            rows: 24,
          }),
        { repository, worktree: tree.path },
      );
      sessions.push(session.id);
      context.diagnostic(JSON.stringify({ agents, index, ...(await end("launch")) }));
      await expect
        .poll(() =>
          page.evaluate(
            (id) => window.desktop.tail(id, 40).then((lines) => lines.join("")),
            session.id,
          ),
        )
        .toContain("fixture output");
    }
    await begin();
    await page.evaluate(() => window.desktop.sidebarInventory());
    context.diagnostic(JSON.stringify({ agents, ...(await end("sidebar-refresh")) }));
    await begin();
    await page.evaluate(
      (repository) => window.desktop.createWorktree(repository, "measurement", "adjacent"),
      repository,
    );
    context.diagnostic(JSON.stringify({ agents, ...(await end("create-worktree")) }));
    await writeFile(path.join(repository, "move.html"), "<!doctype html><h1>Move measurement</h1>");
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      },
      path.join(repository, "move.html"),
    );
    await page.evaluate((repository) => window.desktop.previews.pick(repository), repository);
    await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
    await page.locator(".preview-row").click();
    const id = (await page.evaluate(() => window.desktop.sidebarInventory())).previews[0].id;
    for (let sample = 0; sample < 3; sample++) {
      const tile = page.locator(`[data-preview-id="${id}"]`);
      await expect(tile).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator(`.preview-snapshot[data-preview="${id}"]`)
            .evaluate((canvas) => canvas.width),
        )
        .toBeGreaterThan(1);
      await tile.getByRole("button", { name: /Tile \d+ menu/ }).click();
      const before = app.windows();
      await begin();
      const start = performance.now();
      await page.getByRole("menuitem", { name: "Move to new window", exact: true }).click();
      let target;
      await expect
        .poll(() => {
          target = app
            .windows()
            .find(
              (candidate) =>
                !before.includes(candidate) && candidate.url() === "app://bundle/index.html",
            );
          return Boolean(target);
        })
        .toBe(true);
      const targetTile = target.locator(`[data-preview-id="${id}"]`);
      await expect(targetTile).toBeVisible();
      await expect
        .poll(() =>
          target
            .locator(`.preview-snapshot[data-preview="${id}"]`)
            .evaluate((canvas) => canvas.width),
        )
        .toBeGreaterThan(1);
      context.diagnostic(
        JSON.stringify({
          agents,
          sample,
          elapsedMs: performance.now() - start,
          ...(await end("move")),
        }),
      );
      if (page !== agentPage) {
        await page.evaluate(() => window.desktop.appMenu.execute("close-window"));
        await expect.poll(() => page.isClosed()).toBe(true);
      }
      page = target;
    }
    await page.evaluate(() => window.desktop.appMenu.execute("close-window"));
    await expect.poll(() => page.isClosed()).toBe(true);
    await app.evaluate(() => globalThis.moveMeasurement.lag.disable());
    for (const id of sessions) await agentPage.evaluate((id) => window.desktop.input(id, "q"), id);
    await expect
      .poll(async () =>
        (await agentPage.evaluate(() => window.desktop.workspace())).terminals.every(
          (session) => session.exitCode !== undefined,
        ),
      )
      .toBe(true);
  });
}
