const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  installQuitAcknowledgement,
  quitAndWait,
  launchApp,
  boardPage,
  removeAfterApps,
  fixtureCleanup,
} = require("./harness.js");

test("orchestrated fixture filenames signal complete credentials and console responses", async (context) => {
  const fs = require("node:fs");
  const { runInNewContext } = require("node:vm");
  const root = await mkdtemp(path.join(tmpdir(), "foom-fixture-records-"));
  removeAfterApps(context, root);
  const credentials = path.join(root, "credentials");
  const checkout = path.basename(root);
  const files = [`${credentials}.${checkout}`, `${credentials}.response-1`];
  let writes = 0;
  let onInput;
  runInNewContext(FAKE_ORCHESTRATED_CLAUDE, {
    require: (name) => {
      if (name === "node:child_process")
        return {
          execFile: (_file, _args, _options, callback) => callback(null, '{"result":{}}', ""),
        };
      if (name !== "node:fs") return require(name);
      return {
        ...fs,
        writeFileSync: (file, value) => {
          // Pause at the actual cross-process race boundary: opening with "w"
          // creates an observable empty file before any JSON bytes are written.
          const descriptor = fs.openSync(file, "w");
          try {
            assert.equal(fs.existsSync(files[writes++]), false, "An unfinished record is visible");
            fs.writeFileSync(descriptor, value);
          } finally {
            fs.closeSync(descriptor);
          }
        },
      };
    },
    process: {
      argv: ["node", "fixture"],
      pid: process.pid,
      env: { TEST_FAKE_CREDENTIALS: credentials },
      cwd: () => root,
      stdout: { write() {} },
      stdin: {
        setRawMode() {},
        on: (_event, listener) => {
          onInput = listener;
        },
      },
    },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(files[0], "utf8")).args, []);
  onInput(Buffer.from(`${JSON.stringify({ id: 1, args: ["launch"] })}\n`));
  assert.deepEqual(JSON.parse(fs.readFileSync(files[1], "utf8")), {
    code: 0,
    stdout: '{"result":{}}',
    stderr: "",
  });
  assert.equal(writes, 2);
});

// Exercise the synchronous inspector-call boundary without depending on a slow
// CI runner: final quit must not run until the caller has regained control.
test("final Electron quit unwinds the debugger evaluation before resuming", async () => {
  const { EventEmitter } = require("node:events");
  const app = new EventEmitter();
  let exited = false;
  app.quit = () => {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    app.emit("before-quit", event);
    if (event.defaultPrevented) return;
    app.emit("will-quit", event);
    if (!event.defaultPrevented) exited = true;
  };
  installQuitAcknowledgement({ app });
  const veto = (event) => event.preventDefault();
  app.prependListener("will-quit", veto);
  app.quit();
  assert.equal(globalThis.readyToQuit, false, "A veto must not acknowledge cleanup");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.readyToQuit, false, "A veto must not schedule acknowledgement");
  app.removeListener("will-quit", veto);
  app.quit();
  assert.equal(globalThis.readyToQuit, false, "Native will-quit must unwind before readiness");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globalThis.readyToQuit, true);
  assert.equal(exited, false);
  app.quit(); // Playwright's synchronous inspector evaluation.
  assert.equal(exited, false, "Quit must return before entering native shutdown");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exited, true);
  assert.equal(app.listenerCount("before-quit"), 0);
  assert.equal(app.listenerCount("will-quit"), 0);
  delete globalThis.readyToQuit;
});

test("quit acknowledgement waits for the cancelled native quit to unwind", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  let observed;
  app.on("console", (message) => {
    const prefix = "Native quit handoff: ";
    if (message.text().startsWith(prefix))
      observed = JSON.parse(message.text().slice(prefix.length));
  });
  await quitAndWait(app, () =>
    app.evaluate(({ app }) => {
      let beforeQuit = 0;
      app.on("before-quit", () => beforeQuit++);
      // This observer runs after the harness's acknowledgement observer.
      app.once("will-quit", () => {
        const ready = globalThis.readyToQuit;
        const before = beforeQuit;
        // Electron ignores this reentrant request while native quit is still
        // active. Readiness must not authorize Playwright's final call here.
        if (ready) app.quit();
        console.info(
          "Native quit handoff: " + JSON.stringify({ ready, nativeEntered: beforeQuit !== before }),
        );
      });
      app.quit();
    }),
  );
  assert.deepEqual(observed, { ready: false, nativeEntered: false });
});

test("agent discovery uses the fixture login shell and controlled PATH", async (context) => {
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  const scan = await page.evaluate(() => window.desktop.scanAgents(true));
  const environment = await app.evaluate(() => ({
    path: process.env.PATH,
    shell: process.env.SHELL,
  }));
  assert.equal(scan.warning, null);
  assert.ok(
    scan.agents.every((agent) => agent.path === null),
    "Default fixtures expose no agents",
  );
  const directories = environment.path.split(path.delimiter);
  assert.ok(directories[0].includes("foom-agent-isolation-"));
  if (process.platform !== "win32") {
    assert.deepEqual(directories.slice(1), []);
    assert.ok(environment.shell.includes("foom-agent-isolation-"));
  }
});

test("fixture cleanup closes every app before removing directories and retains quit failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-cleanup-order-"));
  let teardown;
  const context = {
    after: (callback) => {
      teardown = callback;
    },
  };
  removeAfterApps(context, root);
  const cleanup = fixtureCleanup(context);
  const failure = new Error("quit failed");
  let secondClosed = false;
  cleanup.apps.push(async () => {
    await realpath(root);
    throw failure;
  });
  cleanup.apps.push(async () => {
    await realpath(root);
    secondClosed = true;
  });
  await assert.rejects(
    teardown,
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
  assert.equal(secondClosed, true);
  await assert.rejects(realpath(root), { code: "ENOENT" });
});

// First-paint readiness must not replace the independent ongoing-frame check.
test("a compositor-ready board still fails when animation callbacks are withheld", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  const original = await page.evaluateHandle(() => window.requestAnimationFrame);
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  try {
    await assert.rejects(boardPage(app), /The shown native board must deliver animation frames/);
  } finally {
    await original.evaluate((callback) => {
      window.requestAnimationFrame = callback;
    });
    await original.dispose();
  }
});

// A controlled callback reproduces the missing readiness boundary without a
// slow GPU, a sleep, or changing any assertion deadline.
test("document readiness awaits native navigation and releases listeners on success or failure", async () => {
  const { EventEmitter } = require("node:events");
  const { waitForBoardDocument } = require("./board-startup.js");
  for (const outcome of ["loaded", "already-loaded", "closed", "crashed", "failed"]) {
    const window = new EventEmitter();
    const contents = new EventEmitter();
    window.webContents = contents;
    let url = outcome === "already-loaded" ? "app://bundle/index.html" : "";
    let loading = false;
    contents.getURL = () => url;
    contents.isLoadingMainFrame = () => loading;
    let settled = false;
    const waiting = waitForBoardDocument(window).then(() => {
      settled = true;
    });
    if (outcome === "loaded") {
      await Promise.resolve();
      assert.equal(settled, false, "A native window alone is not a loaded document");
      contents.emit("did-finish-load");
      url = "app://bundle/index.html";
      loading = true;
      contents.emit("did-navigate");
      await Promise.resolve();
      assert.equal(settled, false);
      // did-finish-load is authoritative even before the native loading flag
      // clears; checking that flag inside its callback can miss readiness.
      contents.emit("did-finish-load");
    }
    if (outcome === "closed") window.emit("closed");
    if (outcome === "crashed") contents.emit("render-process-gone", {}, { reason: "crashed" });
    if (outcome === "failed")
      contents.emit("did-fail-load", {}, -2, "failed", "app://bundle/index.html", true);
    if (["loaded", "already-loaded"].includes(outcome)) await waiting;
    else await assert.rejects(waiting, /closed|crashed|navigation failed/);
    assert.equal(window.listenerCount("closed"), 0);
    for (const event of ["did-finish-load", "render-process-gone", "did-fail-load"])
      assert.equal(contents.listenerCount(event), 0);
  }
});

test("fixture records await atomic writes, surface errors and abort with their case", async (context) => {
  const { writeFile, rename } = require("node:fs/promises");
  const { waitForFixtureRecord } = require("./fixture-records.js");
  const root = await mkdtemp(path.join(tmpdir(), "foom-record-wait-"));
  removeAfterApps(context, root);
  const file = path.join(root, "ready");
  const error = path.join(root, "error");
  const waiting = waitForFixtureRecord(file, [error], context.signal);
  await writeFile(file + ".tmp", "ready");
  await rename(file + ".tmp", file);
  await waiting;
  await waitForFixtureRecord(file, [], context.signal);
  const failed = waitForFixtureRecord(path.join(root, "missing"), [error], context.signal);
  const rejected = assert.rejects(failed, /fixture failed/);
  await writeFile(error + ".tmp", "fixture failed");
  await rename(error + ".tmp", error);
  await rejected;
  const controller = new AbortController();
  const aborted = waitForFixtureRecord(path.join(root, "never"), [], controller.signal);
  const abortError = new Error("Case ended");
  controller.abort(abortError);
  await assert.rejects(aborted, (error) => error === abortError);
  await assert.rejects(
    waitForFixtureRecord(file, [], controller.signal),
    (error) => error === abortError,
  );
});

test("compositor readiness awaits output and releases subscriptions on output or failure", async () => {
  const { EventEmitter } = require("node:events");
  const { waitForBoardCompositor } = require("./board-startup.js");
  for (const outcome of ["frame", "closed", "crashed", "subscribe-error"]) {
    const window = new EventEmitter();
    window.id = 1;
    const contents = new EventEmitter();
    window.webContents = contents;
    contents.isDestroyed = () => false;
    let deliver;
    let subscriptions = 0;
    let ended = 0;
    contents.beginFrameSubscription = (_dirty, callback) => {
      subscriptions++;
      if (outcome === "subscribe-error") throw new Error("capture unavailable");
      deliver = callback;
    };
    contents.endFrameSubscription = () => ended++;
    const ready = new Set();
    const waiting = waitForBoardCompositor(window, ready);
    assert.equal(ready.has(1), false, "Subscribing alone cannot establish readiness");
    if (outcome === "frame") {
      await Promise.resolve();
      assert.equal(ready.has(1), false, "Readiness must await the compositor callback");
      deliver();
      await waiting;
      assert.equal(ready.has(1), true);
      await waitForBoardCompositor(window, ready);
      assert.equal(subscriptions, 1, "The native window retains its observed readiness");
    } else {
      if (outcome === "closed") window.emit("closed");
      if (outcome === "crashed") contents.emit("render-process-gone", {}, { reason: "crashed" });
      await assert.rejects(waiting, /closed|crashed|capture unavailable/);
      assert.equal(ready.has(1), false);
    }
    assert.equal(ended, 1);
    assert.equal(window.listenerCount("closed"), 0);
    assert.equal(contents.listenerCount("render-process-gone"), 0);
  }
});

test("Linux launch forces X11 despite inherited Wayland settings", {
  skip: process.platform !== "linux",
}, async (context) => {
  const app = await launchApp(context, {
    fixture: "empty-board",
    env: {
      WAYLAND_DISPLAY: "foom-fake-wayland",
      WAYLAND_SOCKET: "9876",
      XDG_SESSION_TYPE: "wayland",
      ELECTRON_OZONE_PLATFORM_HINT: "wayland",
    },
    args: ["--ozone-platform=wayland"],
  });
  assert.deepEqual(
    await app.evaluate(({ app }) => ({
      platform: app.commandLine.getSwitchValue("ozone-platform"),
      wayland: process.env.WAYLAND_DISPLAY ?? null,
      socket: process.env.WAYLAND_SOCKET ?? null,
      session: process.env.XDG_SESSION_TYPE,
      hint: process.env.ELECTRON_OZONE_PLATFORM_HINT,
      explicit: process.argv.includes("--ozone-platform=x11"),
    })),
    {
      platform: "x11",
      wayland: null,
      socket: null,
      session: "x11",
      hint: "x11",
      explicit: true,
    },
  );
});

test("Linux launch rejects absent or foreign displays before fixture creation", {
  skip: process.platform !== "linux",
}, async (context) => {
  for (const DISPLAY of ["", ":0", "desktop-host:0"]) {
    await assert.rejects(
      launchApp(context, { fixture: "empty-board", env: { DISPLAY } }),
      /own xvfb-run display/,
    );
  }
});

test("startup tracing waits for the board document and skips cancelled or failed navigation", async (context) => {
  const { EventEmitter } = require("node:events");
  const { recordBoardStartup } = require("./board-startup.js");
  const previous = globalThis.boardStartup;
  context.after(() => {
    if (previous === undefined) delete globalThis.boardStartup;
    else globalThis.boardStartup = previous;
  });
  for (const outcome of ["loaded", "cancelled", "failed", "disabled"]) {
    const app = new EventEmitter();
    app.whenReady = () => Promise.resolve();
    const window = new EventEmitter();
    const contents = new EventEmitter();
    window.id = 1;
    window.webContents = contents;
    window.isDestroyed = () => false;
    window.isVisible = window.isFocused = () => true;
    window.getBounds = window.getContentBounds = () => ({});
    contents.getURL = () => "app://bundle/index.html";
    let loading = true;
    contents.isLoadingMainFrame = () => loading;
    let starts = 0;
    const acknowledged = Promise.withResolvers();
    recordBoardStartup(
      {
        app,
        contentTracing: {
          startRecording: () => {
            starts++;
            return acknowledged.promise;
          },
        },
      },
      outcome !== "disabled",
    );
    const state = globalThis.boardStartup;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 0, "App readiness must not race cold renderer registration");
    app.emit("browser-window-created", {}, window);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 0, "Creating the native window is not document readiness");
    if (outcome === "cancelled") state.stopRequested = true;
    if (outcome === "failed") {
      const rejected = assert.rejects(state.waitForDocument(), /navigation failed/);
      contents.emit("did-fail-load", {}, -1, "fixture failure", contents.getURL(), true);
      await rejected;
    } else {
      loading = false;
      contents.emit("did-finish-load");
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, outcome === "loaded" ? 1 : 0);
    assert.equal(state.tracing, false, "Recording must await the native acknowledgement");
    acknowledged.resolve();
    await state.traceReady;
    assert.equal(state.tracing, outcome === "loaded");
    assert.equal(contents.listenerCount("did-fail-load"), 0);
    assert.equal(contents.listenerCount("render-process-gone"), 0);
  }
});

test("app fixtures isolate inherited Foom variables and retain explicit overrides", async (context) => {
  const names = [
    "FOOM_REMOTE_HELPER",
    "FOOM_REMOTE_SOCKET",
    "FOOM_CONTROL_TOKEN",
    "FOOM_FUTURE_SESSION_VARIABLE",
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  context.after(() => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });
  for (const name of names) process.env[name] = "inherited-session";
  const app = await launchApp(context, {
    fixture: "empty-board",
    env: { FOOM_FIXTURE_OVERRIDE: "explicit-fixture" },
  });
  const launched = fixtureCleanup(context).launches.get(app).env;
  const actual = Object.fromEntries(
    [...names, "FOOM_FIXTURE_OVERRIDE"].map((name) => [name, launched[name] ?? null]),
  );
  assert.deepEqual(actual, {
    FOOM_REMOTE_HELPER: null,
    FOOM_REMOTE_SOCKET: null,
    FOOM_CONTROL_TOKEN: null,
    FOOM_FUTURE_SESSION_VARIABLE: null,
    FOOM_FIXTURE_OVERRIDE: "explicit-fixture",
  });
});

test("quit ordering diagnostics bound records and redact locator actionability", () => {
  const { orderingBuffer, actionabilityEvent } = require("./quit-diagnostics.js");
  const buffer = orderingBuffer();
  for (let index = 0; index < 250; index++) buffer.record("test", { event: "sample", index });
  const snapshot = buffer.snapshot();
  assert.equal(snapshot.events.length, 192);
  assert.equal(snapshot.total, 250);
  assert.equal(snapshot.dropped, 58);
  assert.equal(snapshot.events[0].index, 58);
  snapshot.events.pop();
  assert.equal(buffer.snapshot().events.length, 192);
  buffer.record("test", { event: "private".repeat(1000) });
  assert.equal(buffer.snapshot().events.at(-1).event, "record:oversized");
  assert.equal(
    actionabilityEvent("private selector intercepts pointer events"),
    "intercepts pointer events",
  );
  assert.equal(actionabilityEvent("secret session title"), undefined);
});

test("quit ordering diagnostics observe native presentation, input and answer before quit", async (context) => {
  const { startQuitOrdering } = require("./quit-diagnostics.js");
  const { confirmationPage } = require("./harness.js");
  const app = await launchApp(context, { fixture: "running-shell" });
  const child = app.process();
  const ordering = startQuitOrdering(app);
  try {
    await ordering.install();
    await quitAndWait(app, async () => {
      await app.evaluate(({ app }) => app.quit());
      const dialog = await confirmationPage(app);
      await dialog.getByRole("button", { name: "Stop all and quit" }).click();
    });
    // stderr and console are independent transports. Compare native sequence
    // numbers within main; merged arrival order is not cross-process causality.
    const events = ordering.snapshot().events;
    const answer = events.find((item) => item.event === "native:answer");
    assert.ok(answer);
    assert.equal(answer.presented, true);
    assert.equal(answer.matchingRequest, true);
    assert.equal(answer.topFrame, true);
    assert.equal(answer.accepted, true);
    assert.ok(
      events.some(
        (item) =>
          item.event === "native:render" && item.presented && item.sequence < answer.sequence,
      ),
    );
    for (const event of [
      "native:before-quit",
      "native:will-quit",
      "renderer:pointerdown",
      "renderer:pointerup",
      "renderer:click",
      "click action done",
    ])
      assert.ok(
        events.some((item) => item.event === event),
        event,
      );
    assert.ok(
      events.some(
        (item) => item.event === "renderer:click" && item.trusted && item.button === "accept",
      ),
    );
    assert.equal(child.exitCode, 0);
  } finally {
    ordering.stop();
    context.diagnostic(`Quit ordering: ${JSON.stringify(ordering.snapshot())}`);
  }
});
