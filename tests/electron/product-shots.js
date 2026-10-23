// Invoked only by pnpm run start:samples --screenshots, outside feature discovery.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { git } = require("../helpers/git.js");
const { launchApp, boardPage, removeAfterApps } = require("./harness.js");
const { expect } = require("./test-policy.js");

const directory = path.resolve("screenshots-582");
const instant = new Date("2026-01-01T12:00:00Z");
const leaf = (session) => ({
  kind: "tile",
  id: `shot-${session}`,
  content: { kind: "terminal", session },
});
const column = (id, first, second) => ({
  kind: "split",
  id,
  direction: "vertical",
  ratio: 0.5,
  first: leaf(first),
  second: leaf(second),
});

for (const [theme, background] of [
  ["eclipse-dark", "#05040a"],
  ["eclipse-light", "#f3f0fa"],
]) {
  test(`product screenshots: ${theme}`, async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), "foom-product-shots-"));
    removeAfterApps(t, home);
    // Only these disposable checkouts may be discovered. Samples themselves use
    // synthetic inventory and read-only strings; no PTY or agent is launched.
    for (const name of ["foom", "observatory", "launchpad"]) {
      const repository = path.join(home, "code", name);
      await mkdir(repository, { recursive: true });
      await git(["init", "-q", repository]);
    }
    const app = await launchApp(t, {
      fixture: "empty-board",
      home,
      args: ["--force-device-scale-factor=1"],
    });
    const page = await boardPage(app);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: null });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith("app://bundle/"),
      );
      if (!window) throw new Error("Missing board window");
      window.setContentSize(1440, 900);
      window.webContents.setZoomFactor(1);
    });
    await page.evaluate(async (interfaceTheme) => {
      await window.desktop.saveSetup({ interfaceTheme, interfaceScale: 100 });
    }, theme);
    const layout = {
      version: 2,
      tree: {
        kind: "split",
        id: "shot-board",
        direction: "horizontal",
        ratio: 0.5,
        first: column("shot-left", "build", "done"),
        second: column("shot-right", "approve", "failed"),
      },
      focused: "shot-build",
      sidebarWidth: 360,
      sidebarCollapsed: false,
    };
    await page.evaluate((layout) => {
      localStorage.setItem("foom.tiles.v1", JSON.stringify(layout));
    }, layout);
    // Fixed Date makes sample timestamps and wait labels independent of wall time.
    // Virtual timers settle the complete eight-second activity history, then stop.
    await page.clock.install({ time: instant });
    await page.reload();
    await expect(page.locator('.terminal-tile[data-kind="sample"]')).toHaveCount(4);
    await page.getByRole("button", { name: "Collapse launchpad", exact: true }).press("Enter");
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.clock.pauseAt(new Date(instant.getTime() + 10000));
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
      .toBe(background);
    assert.deepEqual(
      await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]),
      [1440, 900, 1],
    );
    assert.deepEqual((await page.evaluate(() => window.desktop.workspace())).terminals, []);
    for (const state of ["working", "quiet_ok", "done", "failed", "needs_input"]) {
      await expect(page.locator(`.board-row[data-state="${state}"]`).first()).toBeInViewport({
        ratio: 1,
      });
    }
    const verdict = page.locator('.terminal-tile[data-state="needs_input"]');
    await expect(verdict.locator(".tile-attention")).toContainText(
      "Waiting for approval · pattern: (y/n)",
    );
    await expect(verdict.locator(".sample-terminal")).toContainText("Continue? (y/n)");
    await page.mouse.move(1439, 899);
    await mkdir(directory, { recursive: true });
    const shots = [
      ["board", page],
      ["sidebar", page.locator(".sidebar-shell")],
      ["needs-you", verdict],
    ];
    for (const [name, target] of shots) {
      const options = { animations: "disabled", caret: "hide", scale: "css" };
      const bytes = await target.screenshot(options);
      // Detect unsettled pixels in every capture, rather than silently emitting
      // changing marketing assets. Independent reruns are also compared manually.
      assert.equal(
        Buffer.compare(await target.screenshot(options), bytes),
        0,
        `${name} must be settled`,
      );
      await writeFile(path.join(directory, `${theme}-${name}.png`), bytes);
    }
  });
}
