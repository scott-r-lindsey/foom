const { evidencePath } = require("../helpers/evidence.js");
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
const { appendFileSync } = require("node:fs");
const { git } = require("../helpers/git.js");
const { FAKE_GH } = require("../helpers/forge-cli.js");
const { launchApp, boardPage, removeAfterApps } = require("./harness.js");
const { deadline, expect } = require("./test-policy.js");

for (const scenario of [
  ...[0, 5, 15].map((agents) => ({ name: `${agents} streaming fixture agents`, agents })),
  {
    name: "realistic gallery with Forge, two repositories and 20 worktrees",
    agents: 5,
    realistic: true,
  },
].filter((scenario) => !process.env.FOOM_PREVIEW_MOVE_SCENARIO || scenario.realistic)) {
  const { agents, realistic } = scenario;
  test(`preview move measurement with ${scenario.name}`, {
    timeout: deadline(180000),
    skip: process.platform === "win32" && "POSIX fixture executable",
  }, async (context) => {
    const report = (text) => {
      context.diagnostic(text);
      if (process.env.FOOM_PREVIEW_MOVE_REPORT)
        appendFileSync(evidencePath("preview-move-report.log"), `${text}\n`);
    };
    let app;
    context.after(async () => {
      if (!app) return;
      try {
        const pending = await app.evaluate(() => {
          const state = globalThis.moveMeasurement;
          return state?.active
            ? {
                action: "unfinished",
                events: state.events,
                stages: state.stages,
                startedAt: state.startedAt,
              }
            : null;
        });
        if (pending) report(JSON.stringify(pending));
      } catch {
        /* The harness owns app shutdown and process diagnostics. */
      }
    });
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
    const forgeState = path.join(root, "forge.json");
    await writeFile(forgeState, JSON.stringify({ checks: [{ bucket: "pending" }] }));
    if (realistic) await writeFile(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
    app = await launchApp(context, {
      fixture: "repository",
      env: {
        PATH: bin,
        TEST_FORGE_STATE: forgeState,
        ...(process.env.FOOM_PREVIEW_MOVE_REPORT
          ? { FOOM_PREVIEW_MOVE_REPORT: evidencePath("preview-move-report.log") }
          : {}),
      },
    });
    await app.context().addInitScript(() => {
      const events = (window.moveRendererMeasurement = []);
      const mark = (stage) =>
        events.push({ stage, at: performance.timeOrigin + performance.now() });
      mark("renderer-script");
      document.addEventListener("DOMContentLoaded", () => mark("renderer-dom-ready"), {
        once: true,
      });
      const seen = new Set();
      new MutationObserver(() => {
        for (const [stage, selector] of [
          ["renderer-sidebar", ".sidebar-shell"],
          ["renderer-tile", "[data-preview-id]"],
          ["renderer-snapshot", ".preview-snapshot[width]:not([width='0']):not([width='1'])"],
        ]) {
          if (!seen.has(stage) && document.querySelector(selector)) {
            seen.add(stage);
            mark(stage);
          }
        }
      }).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["width"],
      });
    });
    let page = await boardPage(app);
    const agentPage = page;
    if (realistic) await page.evaluate(() => window.desktop.saveSetup({ showPullRequests: false }));
    const sessions = [];
    const repository = (await page.evaluate(() => window.desktop.workspace())).repositories[0].path;
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ],
      { cwd: repository },
    );
    await app.evaluate(
      ({ app, BrowserWindow, webContents }, { modulePath, baselineIdentity }) => {
        const load = process.getBuiltinModule("node:module").createRequire(modulePath);
        if (baselineIdentity)
          Object.assign(load("../workspace/worktree-operations.js"), load(baselineIdentity));
        const { PreviewHost } = load(modulePath);
        const { PreviewRegistry } = load("./registry.js");
        const { PreviewPlacement } = load("./placement.js");
        const children = process.getBuiltinModule("node:child_process");
        const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
        const state = (globalThis.moveMeasurement = {
          stages: [],
          git: [],
          forgeSpawns: 0,
          events: [],
          active: false,
          baselineActive: Boolean(baselineIdentity),
        });
        const mark = (stage, detail = {}) => {
          if (state.active) {
            const event = { stage, at: Date.now(), ...detail };
            state.events.push(event);
            if (process.env.FOOM_PREVIEW_MOVE_REPORT)
              process
                .getBuiltinModule("node:fs")
                .appendFileSync(
                  `${process.env.FOOM_PREVIEW_MOVE_REPORT}.events`,
                  `${JSON.stringify({ startedAt: state.startedAt, ...event })}\n`,
                );
          }
        };
        app.on("browser-window-created", (_event, window) => {
          mark("window-created", { window: window.id });
          const contents = window.webContents;
          contents.on("dom-ready", () => mark("renderer-dom-ready", { window: window.id }));
          contents.on("did-finish-load", () =>
            mark("renderer-did-finish-load", { window: window.id }),
          );
          const send = contents.send.bind(contents);
          contents.send = (channel, ...args) => {
            if (channel === "preview:place") mark("placement-request", { window: window.id });
            if (channel === "preview:snapshots")
              mark("snapshot-ipc", {
                window: window.id,
                bytes: args[0].reduce((sum, snapshot) => sum + snapshot.image.length, 0),
              });
            return send(channel, ...args);
          };
        });
        const { WindowIpcRouter } = load("../window/window-ipc.js");
        const forWindow = WindowIpcRouter.prototype.forWindow;
        WindowIpcRouter.prototype.forWindow = function (contents) {
          const ipc = forWindow.call(this, contents);
          const handle = ipc.handle;
          ipc.handle = (channel, callback) =>
            handle(channel, async (...args) => {
              if (
                [
                  "preview:placed",
                  "preview:bounds",
                  "preview:painted",
                  "workspace:sidebar",
                ].includes(channel)
              )
                mark(`${channel}:request`, { contents: contents.id });
              const result = await callback(...args);
              if (channel === "workspace:sidebar" || channel === "preview:placed")
                mark(`${channel}:response`, { contents: contents.id });
              return result;
            });
          return ipc;
        };
        const measureImage = (image) => {
          const encode = image.toDataURL.bind(image);
          image.toDataURL = (...args) => {
            const start = performance.now();
            const result = encode(...args);
            if (state.active)
              state.stages.push({
                stage: "snapshot-encode",
                ms: performance.now() - start,
                bytes: result.length,
              });
            return result;
          };
          return image;
        };
        for (const contents of webContents.getAllWebContents()) {
          const capture = contents.capturePage.bind(contents);
          contents.capturePage = async (...args) => {
            const start = performance.now();
            const result = await capture(...args);
            if (state.active)
              state.stages.push({ stage: "capture-page", ms: performance.now() - start });
            return measureImage(result);
          };
        }
        state.lag = monitorEventLoopDelay({ resolution: 10 });
        state.lag.enable();
        const spawn = children.ChildProcess.prototype.spawn;
        children.ChildProcess.prototype.spawn = function (options) {
          if (state.active && /(?:^|[/\\])git(?:\.exe)?$/.test(options.file))
            state.git.push(options.args.slice(1, 3).join(" "));
          if (state.active && /(?:^|[/\\])gh(?:\.exe)?$/.test(options.file)) state.forgeSpawns++;
          return spawn.call(this, options);
        };
        const wrap = (owner, key, label) => {
          const original = owner[key];
          owner[key] = async function (...args) {
            const start = performance.now();
            if (label === "sidebar-inventory")
              state.inventoryPending = (state.inventoryPending ?? 0) + 1;
            try {
              return await original.apply(this, args);
            } finally {
              if (label === "sidebar-inventory") state.inventoryPending--;
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
        const { Workspace } = load("../workspace/workspace.js");
        const inventory = Workspace.prototype.sidebarInventory;
        Workspace.prototype.sidebarInventory = function () {
          // The original revision had no app-wide pending-read sharing.
          return state.baselineActive
            ? load("../workspace/sidebar-commands.js").sidebarInventory.call(this.owner)
            : inventory.call(this);
        };
        wrap(Workspace.prototype, "sidebarInventory", "sidebar-inventory");
        wrap(PreviewHost.prototype, "release", "source-release");
        wrap(PreviewHost.prototype, "cover", "cover");
        wrap(PreviewHost.prototype, "capture", "snapshot");
        wrap(PreviewHost.prototype, "moveTo", "host-move");
        wrap(PreviewRegistry.prototype, "save", "registry-save");
        wrap(PreviewPlacement.prototype, "place", "placement");
        const create = PreviewHost.prototype.createView;
        PreviewHost.prototype.createView = function (...args) {
          const start = performance.now();
          mark("view-created");
          const entry = create.apply(this, args);
          const capture = entry.view.webContents.capturePage.bind(entry.view.webContents);
          entry.view.webContents.capturePage = async (...captureArgs) => {
            const start = performance.now();
            const result = await capture(...captureArgs);
            if (state.active)
              state.stages.push({ stage: "capture-page", ms: performance.now() - start });
            return measureImage(result);
          };
          if (state.active)
            entry.view.webContents.once("did-finish-load", () => {
              mark("preview-did-finish-load");
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
        baselineIdentity: realistic
          ? null
          : (process.env.FOOM_PREVIEW_MOVE_IDENTITY_MODULE ?? null),
      },
    );
    const begin = () =>
      app.evaluate(() => {
        const state = globalThis.moveMeasurement;
        state.startedAt = Date.now();
        state.events = [];
        state.stages = [];
        state.git = [];
        state.forgeSpawns = 0;
        state.lag.reset();
        state.active = true;
      });
    const end = (action) =>
      app.evaluate((_electron, action) => {
        const state = globalThis.moveMeasurement;
        state.active = false;
        return {
          action,
          startedAt: state.startedAt,
          events: state.events,
          stages: state.stages,
          gitSpawns: state.git.length,
          forgeSpawns: state.forgeSpawns,
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
      report(JSON.stringify({ agents, index, ...(await end("launch")) }));
      await expect
        .poll(() =>
          page.evaluate(
            (id) => window.desktop.tail(id, 40).then((lines) => lines.join("")),
            session.id,
          ),
        )
        .toContain("fixture output");
      if (realistic && index < 3) {
        if (index > 0) await page.evaluate(() => window.desktop.appMenu.execute("split-down"));
        const expand = page.getByRole("button", { name: `Expand stream-${index}`, exact: true });
        if (await expand.count()) await expand.click();
        await page.locator(`[data-drag-session="${session.id}"]`).click();
      }
    }
    if (realistic) {
      for (let index = agents; index < 18; index++) {
        await page.evaluate(
          ({ repository, index }) =>
            window.desktop.createWorktree(repository, `fleet-${index}`, "adjacent"),
          { repository, index },
        );
      }
      const second = path.join(root, "second");
      await mkdir(second);
      await git(["init", "-q", "-b", "main"], { cwd: second });
      await git(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-qm",
          "init",
        ],
        { cwd: second },
      );
      for (const [index, repo] of [repository, second].entries()) {
        const remote = path.join(root, `remote-${index}.git`);
        await git(["clone", "--bare", repo, remote], { cwd: root });
        await git(["config", `url.${remote}.insteadOf`, "https://github.com/fixture/offline.git"], {
          cwd: repo,
        });
        await git(["remote", "add", "origin", "https://github.com/fixture/offline.git"], {
          cwd: repo,
        });
      }
      await app.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      }, second);
      await page.evaluate(() => window.desktop.addRepository());
      const head = (await git(["rev-parse", "stream-0"], { cwd: repository })).stdout.trim();
      await writeFile(
        forgeState,
        JSON.stringify({
          pr: { headRefName: "stream-0", headRefOid: head },
          checks: [{ bucket: "pending" }],
        }),
      );
      await page.evaluate(() => window.desktop.saveSetup({ showPullRequests: true }));
      await expect(
        page.getByRole("button", { name: "Pull request #340 · running", exact: true }),
      ).toBeVisible();
      const pngBytes = await app.evaluate(({ nativeImage }, repository) => {
        const fs = process.getBuiltinModule("node:fs");
        const pixels = process.getBuiltinModule("node:crypto").randomBytes(960 * 640 * 4);
        for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
        const png = nativeImage.createFromBitmap(pixels, { width: 960, height: 640 }).toPNG();
        for (let index = 0; index < 16; index++)
          fs.writeFileSync(`${repository}/gallery-${index}.png`, png);
        return png.length;
      }, repository);
      report(
        JSON.stringify({
          fixture: "gallery",
          images: 16,
          pngBytes,
          agents,
          visibleTerminalTiles: 3,
        }),
      );
    }
    await begin();
    await page.evaluate(() => window.desktop.sidebarInventory());
    report(JSON.stringify({ agents, ...(await end("sidebar-refresh")) }));
    await begin();
    await page.evaluate(
      (repository) => window.desktop.createWorktree(repository, "measurement", "adjacent"),
      repository,
    );
    report(JSON.stringify({ agents, ...(await end("create-worktree")) }));
    await writeFile(
      path.join(repository, "move.html"),
      "<!doctype html><h1>Move measurement</h1>" +
        (realistic
          ? Array.from(
              { length: 16 },
              (_, index) => `<img width="960" height="640" src="gallery-${index}.png">`,
            ).join("")
          : ""),
    );
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      },
      path.join(repository, "move.html"),
    );
    await page.evaluate((repository) => window.desktop.previews.pick(repository), repository);
    await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
    await page.locator(".preview-row").click();
    let id = (await page.evaluate(() => window.desktop.sidebarInventory())).previews[0].id;
    const samples = realistic && process.env.FOOM_PREVIEW_MOVE_IDENTITY_MODULE ? 1 : 3;
    for (let sample = 0; sample < samples; sample++) {
      const tile = page.locator(`[data-preview-id="${id}"]`);
      await expect(tile).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator(`.preview-snapshot[data-preview="${id}"]`)
            .evaluate((canvas) => canvas.width),
        )
        .toBeGreaterThan(1);
      if (realistic && sample === 0 && process.env.FOOM_PREVIEW_MOVE_IDENTITY_MODULE) {
        // Build fixture inventory first: only the measured operations use the base helper.
        await app.evaluate(
          (_electron, { modulePath, baseline }) => {
            const load = process.getBuiltinModule("node:module").createRequire(modulePath);
            globalThis.moveMeasurement.baselineActive = true;
            globalThis.moveMeasurement.originalOperations = { ...load(modulePath) };
            Object.assign(load(modulePath), load(baseline));
          },
          {
            modulePath: path.resolve("build/main/workspace/worktree-operations.js"),
            baseline: process.env.FOOM_PREVIEW_MOVE_IDENTITY_MODULE,
          },
        );
      }
      await tile.getByRole("button", { name: /Tile \d+ menu/ }).click();
      const before = app.windows();
      await page.evaluate(() => {
        window.moveMenuClicks = [];
        document.addEventListener(
          "click",
          (event) => {
            if (
              event.target.closest('[role="menuitem"]')?.textContent.includes("Move to new window")
            )
              window.moveMenuClicks.push(performance.timeOrigin + performance.now());
          },
          { capture: true },
        );
      });
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
      // The realistic measurement intentionally observes the whole slow path;
      // the case deadline bounds it instead of a short UI assertion deadline.
      if (realistic)
        await target.evaluate(
          (id) =>
            new Promise((resolve) => {
              const observer = new MutationObserver(() => {
                if (document.querySelector(`[data-preview-id="${id}"]`)) {
                  observer.disconnect();
                  resolve();
                }
              });
              observer.observe(document, { childList: true, subtree: true });
              if (document.querySelector(`[data-preview-id="${id}"]`)) {
                observer.disconnect();
                resolve();
              }
            }),
          id,
        );
      await expect(targetTile).toBeVisible();
      await expect
        .poll(() =>
          target
            .locator(`.preview-snapshot[data-preview="${id}"]`)
            .evaluate((canvas) => canvas.width),
        )
        .toBeGreaterThan(1);
      if (realistic)
        await app.evaluate(
          () =>
            new Promise((resolve) => {
              const timer = setInterval(() => {
                if (
                  globalThis.moveMeasurement.events.some(
                    ({ stage }) => stage === "preview:painted:request",
                  )
                ) {
                  clearInterval(timer);
                  resolve();
                }
              }, 10);
            }),
        );
      report(
        JSON.stringify({
          agents,
          realistic: Boolean(realistic),
          menuClickAt: await page.evaluate(() => window.moveMenuClicks.at(-1)),
          rendererEvents: await target.evaluate(() => window.moveRendererMeasurement),
          sample,
          elapsedMs: performance.now() - start,
          ...(await end("move")),
        }),
      );
      if (realistic && process.env.FOOM_PREVIEW_MOVE_IDENTITY_MODULE) {
        await app.evaluate((_electron, modulePath) => {
          const load = process.getBuiltinModule("node:module").createRequire(modulePath);
          Object.assign(load(modulePath), globalThis.moveMeasurement.originalOperations);
          globalThis.moveMeasurement.baselineActive = false;
          return new Promise((resolve) => {
            const timer = setInterval(() => {
              if (!globalThis.moveMeasurement.inventoryPending) {
                clearInterval(timer);
                resolve();
              }
            }, 10);
          });
        }, path.resolve("build/main/workspace/worktree-operations.js"));
      }
      if (realistic) {
        await target.evaluate(() => window.desktop.appMenu.execute("close-window"));
        await expect.poll(() => target.isClosed()).toBe(true);
        if (sample < samples - 1) {
          await page.evaluate((repository) => window.desktop.previews.pick(repository), repository);
          await page.locator(".preview-row").click();
          id = (await page.evaluate(() => window.desktop.sidebarInventory())).previews[0].id;
        }
        continue;
      }
      if (page !== agentPage) {
        await page.evaluate(() => window.desktop.appMenu.execute("close-window"));
        await expect.poll(() => page.isClosed()).toBe(true);
      }
      page = target;
    }
    if (!realistic) {
      await page.evaluate(() => window.desktop.appMenu.execute("close-window"));
      await expect.poll(() => page.isClosed()).toBe(true);
    }
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
