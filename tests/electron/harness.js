const { gitSync: isolatedGit } = require("../helpers/git.js");
const { AxeBuilder } = require("@axe-core/playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { _electron: electron } = require("@playwright/test");
const { deadline, expect } = require("./test-policy.js");
const { auditProcesses } = require("./process-audit.js");
const { isolatedEnvironment } = require("./agent-isolation.js");

// Opt-in native-window evidence on the isolated Linux test display (ImageMagick).
function captureConfirmationDesktop(name) {
  if (process.platform === "linux" && process.env.FOOM_CONFIRMATION_SCREENSHOTS === "1") {
    require("node:child_process").execFileSync("import", [
      "-window",
      "root",
      `test-results/confirmation-${name}-desktop.png`,
    ]);
  }
}

async function assertConfirmationFocus(app, page, locator) {
  try {
    await expect(locator).toBeFocused();
  } catch (error) {
    console.error("Confirmation focus diagnostics:", {
      page: await page.evaluate(() => ({
        focused: document.hasFocus(),
        visibility: document.visibilityState,
        active: document.activeElement?.outerHTML.slice(0, 240),
      })),
      windows: await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          url: window.webContents.getURL(),
          visible: window.isVisible(),
          focused: window.isFocused(),
          contentsFocused: window.webContents.isFocused(),
          enabled: window.isEnabled(),
        })),
      ),
    });
    throw error;
  }
}

async function writeBoardStartupDiagnostics(app, diagnostics) {
  diagnostics.main = await app.evaluate((electron) => {
    const { app } = electron;
    return {
      lifecycle: globalThis.boardStartup?.events,
      compositorReady: [...(globalThis.boardStartup?.compositorReady ?? [])],
      ready: app.isReady(),
      gpu: app.getGPUFeatureStatus(),
      metrics: app.getAppMetrics(),
      resources: process.getActiveResourcesInfo(),
      // Electron's screen module itself needs native app readiness.
      displays: app.isReady() ? electron.screen.getAllDisplays() : [],
      versions: process.versions,
      display: process.env.DISPLAY,
    };
  });
  await mkdir("test-results", { recursive: true });
  await writeFile(
    `test-results/board-startup-${app.process().pid}.json`,
    JSON.stringify(diagnostics, null, 2),
  );
  console.error("Board startup diagnostics:", JSON.stringify(diagnostics));
}

async function flushBoardStartupTrace(app) {
  await mkdir("test-results", { recursive: true });
  await app.evaluate(
    async ({ app, contentTracing }, file) => {
      const state = globalThis.boardStartup;
      if (!state) return;
      state.stopRequested = true;
      // A readiness-gate failure must not hang while flushing diagnostics.
      if (!app.isReady()) return;
      await state.traceReady;
      if (!state?.tracing) return;
      state.tracing = false;
      await contentTracing.stopRecording(file);
    },
    path.resolve(`test-results/board-startup-${app.process().pid}-trace.json`),
  );
}

async function boardPage(app) {
  const nativeState = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        url: window.webContents.getURL(),
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        focused: window.isFocused(),
        contentsFocused: window.webContents.isFocused(),
        backgroundThrottling: window.webContents.getBackgroundThrottling(),
        bounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
      })),
    );
  let page;
  try {
    await expect
      .poll(() => {
        page = app.windows().find((page) => page.url() === "app://bundle/index.html");
        return Boolean(page);
      })
      .toBe(true);
    await page.waitForLoadState("domcontentloaded");
  } catch (error) {
    await writeBoardStartupDiagnostics(app, {
      stage: "board target/document readiness",
      windows: await nativeState(),
      pages: app.windows().map((page) => ({ url: page.url(), closed: page.isClosed() })),
    });
    await flushBoardStartupTrace(app);
    throw error;
  }
  const before = await nativeState();
  // CDP activation alone can mark a native-hidden document visible/focused
  // without starting its compositor. Establish reachability in native code.
  await app.evaluate(({ BrowserWindow }) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    if (board.isMinimized()) board.restore();
    board.show();
    board.focus();
    board.webContents.focus();
  });
  // A delivered compositor frame establishes readiness on both hardware and
  // software rendering paths. Layout/ready-to-show and GPU device metadata can
  // arrive before GPU channel initialization. Subscribe only until the first
  // frame; the independent rAF sentinel below must still run afterward.
  try {
    await page.evaluate(() => performance.mark("foom:board-compositor-requested"));
    // Initialization is an event-driven prerequisite, bounded by launchApp's
    // existing hard watchdog. An assertion timeout here would just move the
    // cold GPU initialization cutoff ahead of the actual frame assertion.
    await app.evaluate(({ BrowserWindow }) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      return globalThis.boardStartup.waitForCompositor(board);
    });
    await page.evaluate(() => performance.mark("foom:board-compositor-ready"));
  } catch (error) {
    await writeBoardStartupDiagnostics(app, {
      stage: "board compositor readiness",
      before,
      windows: await nativeState(),
    });
    await flushBoardStartupTrace(app);
    throw error;
  }
  const frame = await page.evaluateHandle(() => {
    performance.mark("foom:board-frame-requested");
    const state = {
      delivered: false,
      id: 0,
      document: new WeakRef(document),
      url: document.URL,
      readyState: document.readyState,
      timeOrigin: performance.timeOrigin,
    };
    state.id = requestAnimationFrame(() => {
      performance.mark("foom:board-frame-delivered");
      state.delivered = true;
    });
    return state;
  });
  try {
    await expect.poll(nativeState).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "app://bundle/index.html",
          visible: true,
          minimized: false,
          focused: true,
        }),
      ]),
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.visibilityState === "visible" && document.hasFocus()),
      )
      .toBe(true);
    await expect
      .poll(() => frame.evaluate((state) => state.delivered), {
        message: "The shown native board must deliver animation frames before interaction",
      })
      .toBe(true);
  } catch (error) {
    const diagnostics = {
      rendering: (await frame.evaluate((state) => state.delivered))
        ? "frames delivered; native visibility or focus unavailable"
        : "no frames",
      sentinel: await frame.evaluate((state) => ({
        id: state.id,
        url: state.url,
        readyState: state.readyState,
        timeOrigin: state.timeOrigin,
        sameDocument: state.document.deref() === document,
        currentUrl: document.URL,
        currentTimeOrigin: performance.timeOrigin,
      })),
      before,
      windows: await nativeState(),
      renderer: await page.evaluate(() => ({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        rows: document.querySelector(".xterm-rows")?.textContent,
        readyState: document.readyState,
        fonts: document.fonts.status,
        viewport: { width: innerWidth, height: innerHeight },
      })),
    };
    await writeBoardStartupDiagnostics(app, diagnostics);
    throw error;
  } finally {
    await frame.evaluate((state) => cancelAnimationFrame(state.id));
    await frame.dispose();
    await flushBoardStartupTrace(app);
  }
  return page;
}

// Real decoding with a silent output sink: observe the selected recording without speaker output.
async function installSoundSink(page) {
  await page.addInitScript(() => {
    const Decoder = window.AudioContext;
    window.soundTones = [];
    window.soundDecoded = 0;
    window.AudioContext = class {
      decoder = new Decoder();
      currentTime = 0;
      state = "running";
      destination = {};
      async decodeAudioData(bytes) {
        const buffer = await this.decoder.decodeAudioData(bytes);
        window.soundDecoded++;
        return buffer;
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, setTargetAtTime() {} },
          connect() {},
          disconnect() {},
        };
      }
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          disconnect() {},
          start() {
            window.soundTones.push(this.buffer.duration);
          },
          stop() {},
        };
      }
      close() {
        return this.decoder.close();
      }
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.soundDecoded >= 4);
}

async function stopSession(page, id) {
  await page.evaluate(() => {
    window.confirmationArm = null;
    window.stopConfirmationSubscription = window.desktop.confirmations.subscribe((arm) => {
      window.confirmationArm = arm;
    });
  });
  const stopping = page.evaluate((id) => window.desktop.sidebarCommand({ kind: "stop", id }), id);
  await page.waitForFunction(() => window.confirmationArm !== null);
  // The confirmation deliberately requires a minimum interval before the second click.
  await page.waitForTimeout(310);
  await page.evaluate(() => window.desktop.confirmations.confirm(window.confirmationArm));
  await stopping;
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find((t) => t.id === id)
          ?.exited,
    )
    .toBe(true);
  await page.evaluate(() => window.stopConfirmationSubscription());
}

async function confirmationPage(app) {
  let page;
  await expect
    .poll(() => {
      page = app.windows().find((page) => page.url() === "app://confirmation/confirmation.html");
      return Boolean(page);
    })
    .toBe(true);
  return page;
}

async function boardCommand(app, keyCode, shift = true) {
  await app.evaluate(
    ({ BrowserWindow }, { keyCode, mac, shift }) => {
      const contents = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      ).webContents;
      if (!mac && (keyCode === "B" || (/^[1-9]$/.test(keyCode) && !shift))) {
        for (const type of ["keyDown", "keyUp"])
          contents.sendInputEvent({ type, keyCode: "Space", modifiers: ["control", "shift"] });
        for (const type of ["keyDown", "keyUp"]) contents.sendInputEvent({ type, keyCode });
        return;
      }
      for (const type of ["keyDown", "keyUp"])
        contents.sendInputEvent({
          type,
          keyCode,
          modifiers: [mac ? "meta" : "control", ...(shift ? ["shift"] : [])],
        });
    },
    { keyCode, mac: process.platform === "darwin", shift },
  );
}

async function assertAccessible(page) {
  // Electron does not support Target.createTarget. This app has no cross-origin frames.
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    // PTY output has arbitrary user/agent-selected ANSI colors. Keep the app chrome
    // and xterm input in scope. Terminal output and the ANSI/style sample intentionally
    // demonstrate arbitrary palettes, including dim text.
    const results = await new AxeBuilder({ page })
      .setLegacyMode()
      .exclude(".xterm-rows")
      .exclude(".settings-terminal-preview")
      .analyze();
    assert.deepEqual(
      results.violations.filter(({ impact }) => impact === "serious" || impact === "critical"),
      [],
      `Serious or critical accessibility violations in ${colorScheme} mode`,
    );
  }
  await page.emulateMedia({ colorScheme: null });
}

// Playwright closes its Node inspector only after its synchronous app.quit()
// evaluation returns. Cancel that invocation and resume on the event loop so
// Electron cannot wait for debugger disconnect inside the evaluation itself.
function installQuitAcknowledgement({ app }) {
  globalThis.readyToQuit = false;
  const ready = (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    app.removeListener("will-quit", ready);
    app.once("before-quit", (event) => {
      event.preventDefault();
      process.stderr.write("Electron teardown: final quit scheduled\n");
      setImmediate(() => {
        process.stderr.write("Electron teardown: final quit resumed\n");
        app.quit();
      });
    });
    globalThis.readyToQuit = true;
  };
  app.on("will-quit", ready);
}

async function quitAndWait(app, requestQuit, phase = () => {}) {
  phase("install quit acknowledgement");
  await app.evaluate(installQuitAcknowledgement);
  phase("request quit");
  await requestQuit();
  phase("wait for quit acknowledgement");
  await expect
    .poll(() => app.evaluate(() => globalThis.readyToQuit), { timeout: deadline(8000) })
    .toBe(true);
  // Observe stderr rather than debugger console events: the final quit may run
  // after Playwright has already disconnected the inspector.
  const child = app.process();
  const lines = require("node:readline").createInterface({ input: child.stderr });
  lines.on("line", (line) => {
    if (line === "Electron teardown: final quit scheduled")
      phase("return from Playwright quit evaluation");
    if (line === "Electron teardown: final quit resumed") phase("wait for Electron process exit");
    if (line.includes("Waiting for the debugger to disconnect..."))
      phase("wait for Node debugger disconnect");
  });
  const exited = () => phase("finish Playwright connection cleanup");
  child.once("exit", exited);
  try {
    phase("invoke Playwright quit evaluation");
    await app.close();
    phase("closed");
  } finally {
    lines.close();
    child.removeListener("exit", exited);
  }
}

// A test timeout does not cancel Playwright promises or dispose native processes.
// One teardown owns ordering: all apps/PTY hosts quit before any fixture removal.
const fixtureCleanups = new WeakMap();

function fixtureCleanup(context) {
  let cleanup = fixtureCleanups.get(context);
  if (!cleanup) {
    cleanup = {
      apps: [],
      directories: new Set(),
      probeLogs: [],
      launches: new WeakMap(),
      timing: { start: performance.now(), setup: 0, fixtures: [] },
    };
    fixtureCleanups.set(context, cleanup);
    context.after(async () => {
      const teardownStart = performance.now();
      const failures = [];
      try {
        await cleanup.audit?.capture();
      } catch (error) {
        failures.push(error);
      }
      for (const close of cleanup.apps) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await cleanup.audit?.finish();
      } catch (error) {
        failures.push(error);
      }
      for (const log of cleanup.probeLogs) {
        try {
          assert.equal(
            await readFile(log, "utf8"),
            "",
            "Test attempted to run an agent outside its fixtures",
          );
        } catch (error) {
          failures.push(error);
        }
      }
      for (const directory of cleanup.directories) {
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (error) {
          // Fixture deletion is best effort; keep assertion/quit failures intact.
          console.warn(`Unable to remove test fixture ${directory}:`, error);
        }
      }
      if (cleanup.timing.fixtures.length) {
        const timing = {
          name: context.name,
          fixtures: cleanup.timing.fixtures,
          setupMs: cleanup.timing.setup,
          bodyMs: teardownStart - cleanup.timing.start - cleanup.timing.setup,
          teardownMs: performance.now() - teardownStart,
        };
        context.diagnostic?.(`Fixture timing: ${JSON.stringify(timing)}`);
        await mkdir("test-results", { recursive: true });
        await appendFile(
          `test-results/fixture-timings-${process.pid}.jsonl`,
          `${JSON.stringify(timing)}\n`,
        );
      }
      if (failures.length) throw new AggregateError(failures, "Electron teardown failed");
    });
  }
  return cleanup;
}

function removeAfterApps(context, directory) {
  fixtureCleanup(context).directories.add(directory);
}

// Keep a final worker deadline so even broken cleanup cannot occupy a CI runner.
// Every launch gets its own profile. Unless a test is about first run, preflight is
// already complete so the app opens on the board.
async function prepareProfile(options) {
  const given = options.args?.find((arg) => arg.startsWith("--user-data-dir="));
  const owned = given ? undefined : await mkdtemp(path.join(tmpdir(), "foom-profile-"));
  const profile = given ? given.slice("--user-data-dir=".length) : owned;
  if (options.fixture !== "first-run") {
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "settings.json"),
      JSON.stringify({ version: 1, settings: { setupComplete: true } }),
      { flag: "wx" },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return {
    args: [
      ...(options.args ?? []),
      ...(owned ? [`--user-data-dir=${owned}`] : []),
      // Sounds still decode and play; Chromium drops them at the output device.
      "--mute-audio",
    ],
    owned,
  };
}

async function addFixtureRepository(app, page) {
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const directory = path.join(profile, "shell-fixture");
  await mkdir(directory, { recursive: true });
  const repository = await realpath(directory);
  isolatedGit(["init", "-q", repository]);
  await app.evaluate(({ dialog }, repository) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
  }, repository);
  await page.getByRole("button", { name: "Add repository", exact: true }).press("Enter");
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).repositories.map(
        (entry) => entry.path,
      ),
    )
    .toContain(repository);
  // The first window can still be animating on a cold CI display. Keyboard
  // activation exercises the menu without depending on pointer hit-test stability.
  const fixtureRow = page.getByRole("treeitem", { name: "shell-fixture", exact: true });
  await expect(fixtureRow).toBeVisible();
  const expand = fixtureRow.getByRole("button", { name: "Expand shell-fixture", exact: true });
  if (await expand.count()) await expand.press("Enter");
  return repository;
}

async function launchCheckoutShell(app, page) {
  await addFixtureRepository(app, page);
  await page
    .getByRole("treeitem", { name: "shell-fixture", exact: true })
    .getByRole("button", { name: "Actions for Main checkout", exact: true })
    .press("Enter");
  await page.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
}

async function restartShellFromSidebar(page) {
  await expect(page.getByRole("button", { name: "Restart shell", exact: true })).toHaveCount(0);
  const row = page.locator(".board-row[data-kind='shell']");
  // Sending `exit` only queues PTY input. Wait for the sidebar to consume the
  // exit event before opening its panel, whose actions depend on row.exited.
  await expect(row).toHaveAttribute("data-exited", "true");
  await row.locator(".row-actions").click();
  await page.getByRole("menuitem", { name: "Restart shell", exact: true }).click();
}

// Feature files run in separate workers. Trace each worker's first Linux CI app
// through the existing frame assertion, then flush before interaction or quit.
let firstBoardStartup = true;

// Each fixture gets a fresh app/profile. "restored" adds no inventory: the test
// owns the persisted profile and must assert the restored sessions itself.
// The default is retained only for the menu test owned by #509/#511.
async function launchApp(context, options = { fixture: "running-shell" }) {
  assert.ok(
    ["first-run", "empty-board", "repository", "running-shell", "agent", "restored"].includes(
      options.fixture,
    ),
    "Choose an explicit Electron fixture",
  );
  if (options.fixture === "agent")
    assert.ok(options.env?.PATH, "Agent fixtures require a controlled CLI directory");
  if (options.fixture === "restored")
    assert.ok(
      options.args?.some((arg) => arg.startsWith("--user-data-dir=")),
      "Restore fixtures require their persisted profile",
    );
  assert.ok(
    options.shell === undefined ||
      (options.fixture === "running-shell" && options.shell === "hidden"),
    "Only a running shell can be hidden",
  );
  const setupStart = performance.now();
  const traceStartup =
    firstBoardStartup && process.platform === "linux" && process.env.CI === "true";
  firstBoardStartup = false;
  // CI prepares the binary separately. Direct runs also resolve it before the
  // Playwright launch deadline/audit, without downloading during test discovery.
  // Do not supply executablePath: that skips Playwright's Electron loader.
  require("electron");
  const cleanup = fixtureCleanup(context);
  cleanup.timing.start = Math.min(cleanup.timing.start, setupStart);
  cleanup.audit ??= await auditProcesses(context);
  const profile = await prepareProfile(options);
  if (profile.owned) removeAfterApps(context, profile.owned);
  const watchdog = setTimeout(() => {
    console.error("Electron test exceeded its hard deadline; terminating worker");
    // Playwright's exit handler kills the process groups it launched.
    process.exit(1);
  }, deadline(90_000));
  watchdog.unref();
  let entry = path.join(__dirname, "../..");
  // Foom config lives under home and is a git repository Foom commits to. Never let a
  // test write the developer's real ~/.foom/config.
  if (!options.home) {
    options = {
      ...options,
      home: options.env?.HOME ?? (await mkdtemp(path.join(tmpdir(), "foom-home-"))),
    };
    if (!options.env?.HOME) removeAfterApps(context, options.home);
  }
  // Match native shells' canonical spelling (Windows TEMP may use an 8.3 path).
  await mkdir(options.home, { recursive: true });
  options = { ...options, home: await realpath(options.home) };
  const isolation = await mkdtemp(path.join(tmpdir(), "foom-agent-isolation-"));
  removeAfterApps(context, isolation);
  const isolated = await isolatedEnvironment(isolation, options.env?.PATH);
  const probeLog = path.join(isolation, "forbidden-agent-probes.log");
  await writeFile(probeLog, "");
  cleanup.probeLogs.push(probeLog);
  cleanup.audit.forbidAgentsOutside(cleanup.directories);
  if (options.home) {
    // Electron resolves home from native OS APIs on macOS/Windows, not HOME.
    // A fixture package sets it before application modules construct services.
    const fixture = await mkdtemp(path.join(tmpdir(), "foom-entry-"));
    removeAfterApps(context, fixture);
    const manifest = JSON.parse(await readFile(path.join(entry, "package.json"), "utf8"));
    await writeFile(
      path.join(fixture, "package.json"),
      JSON.stringify({
        name: manifest.name,
        productName: manifest.productName,
        version: manifest.version,
        main: "bootstrap.cjs",
      }),
    );
    await writeFile(
      path.join(fixture, "bootstrap.cjs"),
      [
        'const { app } = require("electron");',
        `require(${JSON.stringify(path.join(__dirname, "board-startup.js"))}).recordBoardStartup(require("electron"), ${traceStartup});`,
        `require(${JSON.stringify(path.join(__dirname, "agent-isolation.js"))}).guardAgentProbes(${JSON.stringify([...cleanup.directories])}, ${JSON.stringify(probeLog)});`,
        ...(process.platform === "win32"
          ? []
          : [
              'const os = require("node:os");',
              "const userInfo = os.userInfo;",
              `os.userInfo = (...args) => ({ ...userInfo(...args), shell: ${JSON.stringify(isolated.SHELL)} });`,
            ]),
        ...(options.probeWaitingMs === undefined
          ? []
          : [
              `const workspaceModule = require(${JSON.stringify(path.join(entry, "build/main/workspace/workspace.js"))});`,
              `const ProductionWorkspace = workspaceModule.Workspace;`,
              `workspaceModule.Workspace = class extends ProductionWorkspace { constructor(deps) { super({ ...deps, probeWaitingMs: ${JSON.stringify(options.probeWaitingMs)} }); } };`,
            ]),
        `app.setPath("home", ${JSON.stringify(options.home)});`,
        `app.setAppPath(${JSON.stringify(entry)});`,
        `require(${JSON.stringify(path.join(entry, "build/main/main.js"))});`,
      ].join("\n"),
    );
    entry = fixture;
  }
  const env = {
    ...process.env,
    HOME: options.home,
    USERPROFILE: options.home,
    ...options.env,
    ...isolated,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron
    .launch({
      chromiumSandbox: true,
      colorScheme: null,
      timeout: deadline(15_000),
      args: [
        entry,
        ...profile.args,
        // Existing pixel/cursor assertions exercise the DOM fallback. The WebGL
        // boundary tests request SwiftShader, or native Metal on macOS; hardware probes
        // add no GPU switches. No shipped app flags are changed.
        ...(options.renderer === "webgl"
          ? process.platform === "darwin"
            ? ["--use-gl=angle", "--use-angle=metal"]
            : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
          : options.renderer === "hardware"
            ? []
            : ["--disable-gpu", "--disable-software-rasterizer"]),
        ...(traceStartup
          ? [
              "--enable-logging=file",
              `--log-file=${path.resolve(`test-results/board-startup-${process.pid}-chromium.log`)}`,
            ]
          : []),
      ],
      env,
    })
    .catch((error) => {
      clearTimeout(watchdog);
      throw error;
    });
  cleanup.launches.set(app, { entry, env });
  const child = app.process();
  cleanup.audit.add(child.pid);
  // Tests must never play through the developer's speakers, even under Xvfb.
  assert.equal(await app.evaluate(({ app }) => app.commandLine.hasSwitch("mute-audio")), true);
  app.context().setDefaultTimeout(deadline(10_000));
  const staleTerminalErrors = [];
  app.on("window", (page) => {
    page.on("pageerror", (error) => console.error("Renderer error:", error));
  });
  app.on("console", (message) => {
    if (message.text().includes("Unknown or foreign terminal ID"))
      staleTerminalErrors.push(message.text());
    if (message.text().startsWith("Terminal host diagnostic:")) context.diagnostic(message.text());
    if (message.type() === "error") console.error("Electron:", message.text());
  });
  fixtureCleanup(context).apps.push(async () => {
    console.info("Closing app");
    let timer;
    let shutdownPhase = "starting";
    try {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.equal(child.exitCode, 0, "Electron must exit normally");
        clearTimeout(watchdog);
        return;
      }
      await Promise.race([
        (async () => {
          // Use the real quit dialog, including when the board has crashed.
          await quitAndWait(
            app,
            async () => {
              await app.evaluate(({ app }) => app.quit());
              shutdownPhase = "wait for quit dialog or acknowledgement";
              await expect
                .poll(async () => {
                  if (await app.evaluate(() => globalThis.readyToQuit)) return true;
                  const dialog = app
                    .windows()
                    .find((page) => page.url() === "app://confirmation/confirmation.html");
                  return Boolean(
                    dialog &&
                      (await dialog
                        .getByRole("button", { name: "Stop all and quit" })
                        .count()
                        .catch((error) => {
                          if (dialog.isClosed()) return 0;
                          throw error;
                        })),
                  );
                })
                .toBe(true);
              if (!(await app.evaluate(() => globalThis.readyToQuit))) {
                const dialog = await confirmationPage(app);
                shutdownPhase = "accept quit dialog";
                await dialog.getByRole("button", { name: "Stop all and quit" }).click();
              }
            },
            (phase) => {
              shutdownPhase = phase;
            },
          );
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`Electron shutdown exceeded its deadline during ${shutdownPhase}`)),
            deadline(10000),
          );
        }),
      ]);
      assert.equal(child.exitCode, 0, "Electron must exit normally");
      console.info("App closed");
      assert.deepEqual(staleTerminalErrors, [], "Normal flows must not use revoked terminal IDs");
      clearTimeout(watchdog);
    } catch (error) {
      console.error("Electron shutdown diagnostics:", {
        phase: shutdownPhase,
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        windows: app.windows().map((page) => ({ url: page.url(), closed: page.isClosed() })),
      });
      throw error;
    } finally {
      clearTimeout(timer);
      // If graceful shutdown failed, fail the test and terminate the process tree.
      // The watchdog stays armed while teardown runs, but must not outlive it.
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          require("node:child_process").execFileSync(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { timeout: deadline(5000) },
          );
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      }
      clearTimeout(watchdog);
    }
  });
  // The shell markup now arrives with React’s first commit.
  const page = await boardPage(app);
  const ready = () => {
    cleanup.timing.setup += performance.now() - setupStart;
    cleanup.timing.fixtures.push(options.shell === "hidden" ? "hidden-shell" : options.fixture);
    return app;
  };
  if (options.fixture === "first-run" || options.fixture === "restored") return ready();
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.workspace())).terminals,
    [],
    "Fixtures must start without implicit terminals",
  );
  if (options.fixture === "empty-board" || options.fixture === "agent") return ready();
  if (options.fixture === "repository") {
    await addFixtureRepository(app, page);
    assert.deepEqual(
      (await page.evaluate(() => window.desktop.workspace())).terminals,
      [],
      "Registering a repository must not launch a shell",
    );
    return ready();
  }
  await launchCheckoutShell(app, page);
  await page.locator(".board-row[data-kind='shell']").waitFor();
  // Report startup errors directly instead of timing out on a permanently disabled control.
  await expect
    .poll(() => page.locator(".tile-status").textContent(), { timeout: deadline(10000) })
    .not.toBe("Starting shell…");
  assert.doesNotMatch(await page.locator(".tile-status").textContent(), /Unable|failed/);
  assert.equal(
    (await page.evaluate(() => window.desktop.workspace())).terminals[0].exited,
    false,
    "Running-shell fixtures require a live terminal",
  );
  if (options.shell === "hidden") {
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await boardCommand(app, "B");
    await expect(page.locator(".tile-terminal")).toBeHidden();
    await expect(page.locator(".board-row[data-kind='shell']")).toBeFocused();
  }
  if (options.shell !== "hidden") {
    // Use the board's keyboard action for setup; pointer clicks wait for layout
    // stability and can stall during the first window's startup on a CI display.
    await page.locator(".board-row[data-kind='shell']").press("Enter");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  }
  return ready();
}

// A stand-in for Claude Code: reports a hook-capable version, prompts in plain text,
// then fires its PermissionRequest hook through the command Foom attached.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log("  --settings <file-or-json>  Load settings"); process.exit(0); }
if (process.cwd().endsWith("finish-ok")) { console.log("Finished successfully"); setTimeout(() => process.exit(0), 100); return; }
if (process.cwd().endsWith("finish-failed")) { console.log("Failed task"); setTimeout(() => process.exit(1), 100); return; }
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const command = settings.hooks.PermissionRequest[0].hooks[0].command;
const env = process.env;
writeFileSync(process.env.TEST_FAKE_CREDENTIALS, JSON.stringify({
  url: env.FOOM_HOOK_URL, session: env.FOOM_SESSION, token: env.FOOM_TOKEN,
  controlUrl: env.FOOM_CONTROL_URL, controlToken: env.FOOM_CONTROL_TOKEN, instanceId: env.FOOM_CONTROL_INSTANCE,
}));
process.stdout.write("FOOM_AGENT_READY\\r\\nContinue? (y/n) ");
process.stdin.setRawMode(true);
process.stdin.on("data", (key) => {
  const input = key.toString();
  if (input === "y") {
    process.stdout.write("y\\r\\n\\x1b[1mAllow Bash(npm test)?\\x1b[0m\\r\\n");
    const hook = spawn("sh", ["-c", command], { stdio: ["pipe", "ignore", "ignore"] });
    hook.stdin.end(JSON.stringify({ session_id: "fake-session", hook_event_name: "PermissionRequest" }));
  } else if (input === "f") {
    const start = spawn("sh", ["-c", settings.hooks.UserPromptSubmit[0].hooks[0].command], { stdio: ["pipe", "ignore", "ignore"] });
    start.stdin.end(JSON.stringify({ session_id: "fake-session", hook_event_name: "UserPromptSubmit" }));
    let count = 0;
    const timer = setInterval(() => {
      process.stdout.write("Working " + "x".repeat(1000) + "\\r\\n");
      if (++count === 50) { clearInterval(timer); process.stdout.write("Continue? (y/n) "); }
    }, 50);
  } else if (input === "a") {
    process.stdout.write("\\x1b[2J\\x1b[HRunning approved command\\r\\n\\x1b]0;◐ Claude Code\\x07");
  } else if (input === "e") {
    process.stdout.write("\\x1b[2J\\x1b[HReady\\r\\n\\x1b]0;✳ Claude Code\\x07");
  } else if (input === "s") {
    const stop = spawn("sh", ["-c", settings.hooks.Stop[0].hooks[0].command], { stdio: ["pipe", "ignore", "ignore"] });
    stop.stdin.end(JSON.stringify({ session_id: "fake-session", hook_event_name: "Stop" }));
  } else if (input === "q") {
    process.exit(3);
  }
});
`;

async function tabTo(page, name, accessibleName = name) {
  const target = page.getByRole("button", { name: accessibleName, exact: true });
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  const tabStops = await page
    .locator(
      'button:visible:not(:disabled), input:visible:not(:disabled), select:visible:not(:disabled), textarea:visible:not(:disabled), [tabindex="0"]:visible',
    )
    .count();
  for (let step = 0; step <= tabStops; step++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (label === name) return;
  }
  throw new Error(`Could not reach "${name}" with Tab`);
}

// A verified-MCP Claude Code stand-in: records its control environment and argv per checkout.
const FAKE_ORCHESTRATED_CLAUDE = `#!/usr/bin/env node
const { readFileSync, writeFileSync, renameSync } = require("node:fs");
const path = require("node:path");
// The final filename is a completion marker for readers in the test process.
// Creating it directly exposes an empty/partial record before writeFileSync returns.
const record = (suffix, value) => {
  const file = process.env.TEST_FAKE_CREDENTIALS + "." + suffix;
  const temporary = file + "." + process.pid + ".tmp";
  writeFileSync(temporary, value);
  renameSync(temporary, file);
};
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.296 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log("  --settings <file-or-json>  Load settings\\n  --mcp-config <configs...>  Load MCP servers"); process.exit(0); }
const config = args.includes("--mcp-config") ? JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")) : null;
record(path.basename(process.cwd()), JSON.stringify({
  controlUrl: process.env.FOOM_CONTROL_URL, controlToken: process.env.FOOM_CONTROL_TOKEN,
  instanceId: process.env.FOOM_CONTROL_INSTANCE, mcp: config, args, cliPath: process.env.PATH,
}));
process.stdout.write("FOOM_AGENT_READY\\r\\n");
const isChild = path.basename(process.cwd()).startsWith("child-");
if (isChild) process.stdout.write(process.env.TEST_CHILD_INPUT === "1"
  ? "\\x1b[?2004h\\x1b]0;Claude Code\\x07Ready for follow-up.\\r\\n"
  : "Which file should I change?\\r\\n");
process.stdin.setRawMode(true);
let input = "";
let childTurns = 0;
process.stdin.on("data", (key) => {
  if (key.toString() === "q") process.exit(0);
  if (isChild) {
    input += key.toString();
    if (input.includes("\\r")) {
      childTurns++;
      record("reply-" + path.basename(process.cwd()) + (childTurns === 1 ? "" : "-" + childTurns), input);
      process.stdout.write(childTurns === 1
        ? "FOOM_FOLLOWUP_ACTED\\r\\nAllow execution? (y/n)\\r\\n"
        : "FOOM_PERMISSION_ACCEPTED\\r\\n");
      input = "";
    }
    return;
  }
  input += key.toString();
  const newline = input.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(input.slice(0, newline));
  input = input.slice(newline + 1);
  require("node:child_process").execFile("foom", request.args, { timeout: 40000 }, (error, stdout, stderr) => {
    record("response-" + request.id, JSON.stringify({ code: error?.code ?? 0, stdout, stderr }));
  });
});
`;

async function openSettingsScreen(page) {
  // These tests exercise Settings and terminal transitions. The dedicated footer
  // test below covers reaching Settings through the gear's config panel.
  await page.evaluate(() => window.desktop.appMenu.execute("settings"));
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  // Markup is visible before the mount effects install Escape and focus the
  // heading. Wait for that handoff before callers send keyboard input.
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeFocused();
}

module.exports = {
  installQuitAcknowledgement,
  launchApp,
  boardPage,
  removeAfterApps,
  fixtureCleanup,
  captureConfirmationDesktop,
  assertConfirmationFocus,
  installSoundSink,
  stopSession,
  confirmationPage,
  boardCommand,
  assertAccessible,
  quitAndWait,
  launchCheckoutShell,
  restartShellFromSidebar,
  FAKE_CLAUDE,
  tabTo,
  FAKE_ORCHESTRATED_CLAUDE,
  openSettingsScreen,
};
