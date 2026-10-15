const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, realpath } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const {
  installQuitAcknowledgement,
  launchApp,
  boardPage,
  removeAfterApps,
  fixtureCleanup,
} = require("./harness.js");

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
  const app = await launchApp(context, false, { firstRun: true });
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
