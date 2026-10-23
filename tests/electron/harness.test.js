const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const {
  FAKE_ORCHESTRATED_CLAUDE,
  installQuitAcknowledgement,
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
  app.removeListener("will-quit", veto);
  app.quit();
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
    assert.deepEqual(directories.slice(1), ["/usr/bin", "/bin"]);
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
