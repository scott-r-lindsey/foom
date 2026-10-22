const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { mkdir } = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage } = require("./harness.js");

test("Help Manual opens a contained offline guide and focuses the existing tile", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const openMenu = async () => {
    await page.locator(".wordmark-menu").click();
    await page.getByRole("menuitem", { name: "Help", exact: true }).press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: "Manual", exact: true })).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  await openMenu();
  await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
  const tile = page
    .locator('.terminal-tile[data-kind="preview"]')
    .filter({ hasText: "manual.html" });
  await expect(tile).toBeVisible();
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  assert.equal(inventory.previews.length, 1);
  const { id } = inventory.previews[0];
  const facts = () =>
    app.evaluate(async ({ webContents }, id) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL().startsWith(`foom-preview://${id}/`));
      if (!contents || contents.isLoading()) return null;
      return contents.executeJavaScript(
        `({title: document.title, sections: [...document.querySelectorAll('section')].map(s => s.id), rows: document.querySelectorAll('[data-command]').length, bridge: typeof window.desktop, node: typeof require, dark: matchMedia('(prefers-color-scheme: dark)').matches, background: getComputedStyle(document.documentElement).backgroundColor})`,
      );
    }, id);
  await expect.poll(async () => (await facts())?.title).toBe("Foom manual");
  const document = await facts();
  assert.ok(document.rows > 50);
  assert.equal(document.bridge, "undefined");
  assert.equal(document.node, "undefined");
  assert.equal(new Set(document.sections).size, 12);
  const blocked = await page.evaluate(
    (id) =>
      window.desktop.previews.network(id, true).then(
        () => false,
        () => true,
      ),
    id,
  );
  assert.equal(blocked, true);
  await page.evaluate(() => window.desktop.appMenu.execute("settings"));
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await openMenu();
  await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await openMenu();
  await page.getByRole("menuitem", { name: "Manual", exact: true }).click();
  assert.equal((await page.evaluate(() => window.desktop.sidebarInventory())).previews.length, 1);
  assert.equal(
    await page.locator('.terminal-tile[data-focused="true"]').getAttribute("data-kind"),
    "preview",
  );
  if (process.platform === "darwin") {
    await app.evaluate(({ Menu }) => {
      const manual = Menu.getApplicationMenu()
        .items.find((item) => item.label === "Help")
        .submenu.items.find((item) => item.id === "manual");
      manual.click();
    });
    assert.equal((await page.evaluate(() => window.desktop.sidebarInventory())).previews.length, 1);
  }
  await page.evaluate(() => window.desktop.appMenu.execute("maximize"));
  for (const mode of ["light", "dark"]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
    await expect.poll(async () => (await facts())?.dark).toBe(mode === "dark");
    if (process.env.FOOM_MANUAL_SCREENSHOTS === "1" && process.platform === "linux") {
      await mkdir("screenshots-680", { recursive: true });
      const handle = await app.evaluate(({ BrowserWindow }) => {
        const board = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        board.setBounds({ x: 0, y: 0, width: 1240, height: 850 });
        return board.getNativeWindowHandle().readUInt32LE();
      });
      await page.waitForFunction(() => innerWidth === 1240 && innerHeight === 850);
      await page.waitForFunction((mode) => {
        const canvas = document.querySelector("canvas.preview-snapshot");
        return (
          canvas?.getContext("2d").getImageData(0, 0, 1, 1).data[0] === (mode === "dark" ? 5 : 243)
        );
      }, mode);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      execFileSync("import", ["-window", String(handle), `screenshots-680/manual-${mode}.png`]);
      await openMenu();
      execFileSync("import", ["-window", String(handle), `screenshots-680/menu-${mode}.png`]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
  }
  await page.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(
      () =>
        app.windows().filter((candidate) => candidate.url() === "app://bundle/index.html").length,
    )
    .toBe(2);
  const other = app
    .windows()
    .find((candidate) => candidate !== page && candidate.url() === "app://bundle/index.html");
  assert.ok(other);
  await other.getByRole("navigation", { name: "Terminal sidebar" }).waitFor();
  await other.waitForFunction(() => document.hasFocus());
  await other.evaluate(() => window.desktop.appMenu.execute("manual"));
  assert.equal((await other.evaluate(() => window.desktop.sidebarInventory())).previews.length, 0);
  assert.equal((await page.evaluate(() => window.desktop.sidebarInventory())).previews.length, 1);
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL()))
    .toBe(`foom-preview://${id}/manual.html`);
  await page.evaluate((id) => window.desktop.previews.close(id), id);
  await expect(tile).toHaveCount(0);
  await page.evaluate(() => window.desktop.appMenu.execute("manual"));
  await expect(tile).toBeVisible();
  assert.notEqual(
    (await page.evaluate(() => window.desktop.sidebarInventory())).previews[0].id,
    id,
  );
});
