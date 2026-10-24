const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardPage,
  fixtureCleanup,
  launchApp,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

test("profile lock focuses the first app, exits duplicates and permits another profile", {
  timeout: deadline(45000),
}, async (context) => {
  const first = await launchApp(context, {
    fixture: "empty-board",
    env: {
      FOOM_SESSION: "parent-session",
      FOOM_TOKEN: "parent-token",
      FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
      CLAUDECODE: "1",
    },
  });
  const page = await boardPage(first);
  await expect(page.locator(".dev-profile")).toHaveText("Dev");
  assert.equal(
    await first.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getTitle(),
    ),
    "Foom Dev",
  );
  assert.deepEqual(
    await first.evaluate(() =>
      Object.keys(process.env).filter((key) => key.startsWith("FOOM_") || key === "CLAUDECODE"),
    ),
    [],
  );
  const profile = await first.evaluate(({ app }) => app.getPath("userData"));
  const second = await launchApp(context, { fixture: "empty-board" });
  assert.notEqual(await second.evaluate(({ app }) => app.getPath("userData")), profile);
  await first.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    globalThis.duplicateFocused = false;
    window.on("focus", () => {
      globalThis.duplicateFocused = true;
    });
    window.hide();
  });
  const { entry, env } = fixtureCleanup(context).launches.get(first);
  let child;
  let exited;
  fixtureCleanup(context).apps.push(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  child = require("node:child_process").spawn(
    require("electron"),
    [entry, `--user-data-dir=${profile}`, "--mute-audio"],
    { env, stdio: "ignore" },
  );
  exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  fixtureCleanup(context).audit.add(child.pid);
  await expect.poll(() => child.exitCode, { timeout: deadline(10000) }).toBe(0);
  assert.deepEqual(await exited, { code: 0, signal: null });
  await expect
    .poll(() =>
      first.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        return globalThis.duplicateFocused && window.isVisible() && window.isFocused();
      }),
    )
    .toBe(true);
});

test("multiple windows share sessions, keep views exclusive and retain terminals on close", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const first = await boardPage(app);
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  const original = (await first.evaluate(() => window.desktop.workspace())).terminals[0].id;
  await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
  let second;
  await expect
    .poll(() => {
      second = app
        .windows()
        .find((page) => page !== first && page.url() === "app://bundle/index.html");
      return Boolean(second);
    })
    .toBe(true);
  await expect(
    second.getByRole("button", { name: "Actions for Main checkout", exact: true }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Actions for Main checkout", exact: true })
    .press("Enter");
  await second.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(second.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  await expect
    .poll(async () => (await first.evaluate(() => window.desktop.workspace())).terminals.length)
    .toBe(2);
  await expect(second.getByLabel("Shown in another window", { exact: true })).toHaveCount(1);
  assert.equal(await second.evaluate((id) => window.desktop.windows.select(id), original), false);
  await expect.poll(() => first.evaluate(() => document.hasFocus())).toBe(true);
  assert.equal(
    await second.evaluate(async (id) => {
      try {
        await window.desktop.attach(id);
        return "attached";
      } catch {
        return "rejected";
      }
    }, original),
    "rejected",
  );
  await first.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await first.getByRole("menuitem", { name: "Split right", exact: true }).click();
  await first
    .getByRole("button", { name: "Actions for Main checkout", exact: true })
    .press("Enter");
  await first.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(2);
  const firstLayout = () =>
    first.evaluate(() =>
      JSON.parse(localStorage.getItem(`foom.tiles.v1.${window.desktop.windows.id}`)),
    );
  const beforeSelection = await firstLayout();
  assert.equal(await second.evaluate((id) => window.desktop.windows.select(id), original), false);
  await expect.poll(async () => (await firstLayout()).focused).toBe(beforeSelection.tree.first.id);
  assert.deepEqual((await firstLayout()).tree, beforeSelection.tree);
  await assertAccessible(first);
  await assertAccessible(second);
  await first
    .locator(".terminal-tile[data-focused=true]")
    .getByRole("button", { name: /Tile \d+ menu/ })
    .press("Enter");
  await first.getByRole("menuitem", { name: "Move to new window", exact: true }).press("Enter");
  await expect
    .poll(() => app.windows().filter((page) => page.url() === "app://bundle/index.html").length)
    .toBe(3);
  const third = app
    .windows()
    .find((page) => page !== first && page !== second && page.url() === "app://bundle/index.html");
  await expect(third.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  await expect(first.locator(".terminal-tile[data-empty=false]")).toHaveCount(1);
  await third.evaluate(() => window.desktop.appMenu.execute("close-window"));
  await expect.poll(() => third.isClosed()).toBe(true);
  const sessions = await first.evaluate(() => window.desktop.workspace());
  assert.equal(sessions.terminals.find((item) => item.id === original).exited, false);
  assert.equal(await first.evaluate((id) => window.desktop.windows.select(id), original), true);
  await assertAccessible(first);
  await assertAccessible(second);
});

test("multiple windows restore independent layouts, bounds and interface size", {
  timeout: deadline(60000),
}, async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-window-restore-"));
  removeAfterApps(context, profile);
  const options = {
    args: [`--user-data-dir=${profile}`],
    home: path.join(profile, "home"),
    fixture: "empty-board",
  };
  const app = await launchApp(context, options);
  const first = await boardPage(app);
  await expect(first.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await first.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(first.locator(".terminal-tile")).toHaveCount(2);
  await first.evaluate(() => window.desktop.saveSetup({ interfaceScale: 110 }));
  await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
  let second;
  await expect
    .poll(() => {
      second = app
        .windows()
        .find((page) => page !== first && page.url() === "app://bundle/index.html");
      return Boolean(second);
    })
    .toBe(true);
  await expect(second.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await expect(second.locator(".terminal-tile")).toHaveCount(1);
  await second.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(second.locator(".terminal-tile")).toHaveCount(2);
  await second.evaluate(() => window.desktop.appMenu.execute("split-down"));
  await expect(second.locator(".terminal-tile")).toHaveCount(3);
  await second.evaluate(() => window.desktop.saveSetup({ interfaceScale: 90 }));
  assert.equal(
    (await first.evaluate(() => window.desktop.setupState())).settings.interfaceScale,
    90,
  );
  const firstId = await first.evaluate(() => window.desktop.windows.id);
  const secondId = await second.evaluate(() => window.desktop.windows.id);
  await expect(first.locator(".terminal-tile")).toHaveCount(2);
  await expect(second.locator(".terminal-tile")).toHaveCount(3);
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  const placements = JSON.parse(await readFile(path.join(profile, "windows.json"), "utf8"));
  assert.equal(placements.length, 2);
  assert.deepEqual(
    placements.map((item) => "scale" in item),
    [false, false],
  );
  const restored = await launchApp(context, { ...options, fixture: "restored" });
  await expect
    .poll(
      () => restored.windows().filter((page) => page.url() === "app://bundle/index.html").length,
    )
    .toBe(2);
  for (const page of restored
    .windows()
    .filter((page) => page.url() === "app://bundle/index.html")) {
    const id = await page.evaluate(() => window.desktop.windows.id);
    assert.ok(id === firstId || id === secondId);
    await expect(page.locator(".terminal-tile")).toHaveCount(id === firstId ? 2 : 3);
    assert.equal(
      (await page.evaluate(() => window.desktop.setupState())).settings.interfaceScale,
      90,
    );
    await assertAccessible(page);
  }
});
