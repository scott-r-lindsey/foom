const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { deadline, expect } = require("./test-policy.js");
const { assertAccessible, boardCommand, boardPage, launchApp } = require("./harness.js");

test("application menu uses the command registry and supports native keyboard access", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  const mac = process.platform === "darwin";
  await page.evaluate(() =>
    window.desktop.saveSetup({ agents: { claude: false, codex: false, agy: false } }),
  );
  const entries = await page.evaluate(() => window.desktop.appMenu.commands());
  const developer = entries.find((entry) => entry?.id === "developer-menu");
  assert.ok(developer.items.some((entry) => entry?.id === "reload"));
  assert.ok(!entries.some((entry) => entry?.id === "reload"));
  assert.ok(!JSON.stringify(entries).includes("via-"));
  assert.equal(entries.find((entry) => entry?.id === "new-window").enabled, true);
  await page.evaluate(() => window.desktop.appMenu.execute("action-log"));
  await expect(page.getByRole("heading", { name: "Action log" })).toBeVisible();
  await page.getByRole("button", { name: "Close action log" }).click();
  // Closing Action log restores terminal focus through the view operation queue.
  // Let that restoration finish before focusing the clipboard edit target.
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  if (process.platform === "darwin") {
    const labels = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items.map((item) => item.label),
    );
    assert.deepEqual(labels, ["Foom", "File", "Edit", "View", "Window", "Help", "Developer"]);
    const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
    const focusEditTarget = async (target) => {
      // CDP can edit a DOM input without making its native window the first responder.
      // The trusted child is preloaded too; activate the board before a native role.
      await app.evaluate(({ app, BrowserWindow }) => {
        const board = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        app.focus({ steal: true });
        board.focus();
        board.webContents.focus();
      });
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => {
            const board = BrowserWindow.getAllWindows().find(
              (window) => window.webContents.getURL() === "app://bundle/index.html",
            );
            return board.isFocused() && board.webContents.isFocused();
          }),
        )
        .toBe(true);
      await target.focus();
      await expect(target).toBeFocused();
      await page.waitForFunction(() => document.hasFocus());
    };
    await app.evaluate(({ clipboard }) => clipboard.writeText("menu clipboard sentinel"));
    await filter.fill("menu edit probe");
    await focusEditTarget(filter);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      for (const type of ["keyDown", "keyUp"])
        window.webContents.sendInputEvent({ type, keyCode: "A", modifiers: ["meta"] });
    });
    await expect
      .poll(() =>
        filter.evaluate(
          (input) => input.selectionStart === 0 && input.selectionEnd === input.value.length,
        ),
      )
      .toBe(true);
    await app.evaluate(({ Menu }) => {
      // Exercise the native Cut responder, matching the native Paste role below.
      // Synthetic renderer key events can edit the input without native clipboard evidence.
      if (Menu.getApplicationMenu().getMenuItemById("cut").role !== "cut")
        throw new Error("Missing Cut role");
      Menu.sendActionToFirstResponder("cut:");
    });
    await expect(filter).toHaveValue("");
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("menu edit probe");
    const paste = async (target) => {
      await focusEditTarget(target);
      await app.evaluate(({ Menu }) => {
        // macOS roles execute natively; MenuItem.click() intentionally skips them.
        // https://github.com/electron/electron/blob/v44.4.5/lib/browser/api/menu-item-roles.ts
        if (Menu.getApplicationMenu().getMenuItemById("paste").role !== "paste")
          throw new Error("Missing Paste role");
        Menu.sendActionToFirstResponder("paste:");
      });
    };
    await paste(filter);
    await expect(filter).toHaveValue("menu edit probe");
    await filter.fill("");
    await page.locator(".session-name").dblclick();
    await paste(page.getByRole("textbox", { name: "Session name", exact: true }));
    await expect(page.getByRole("textbox", { name: "Session name", exact: true })).toHaveValue(
      "menu edit probe",
    );
    await page.keyboard.press("Escape");
  }
  if (!mac) assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null);
  const trigger = page.getByRole("button", { name: "Foom menu" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Foom" });
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.querySelectorAll(".row-menu, .row-menu button")).flatMap((element) =>
        element.getAnimations().map((animation) => animation.finished),
      ),
    ),
  );
  await assertAccessible(page);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await page.screenshot({
      path: `test-results/application-menu-${colorScheme}.png`,
      animations: "disabled",
    });
  }
  await expect(page.getByRole("menuitem", { name: /^New window/ })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: /orchestrator/i })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Developer", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Action log", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: /^(Paste|Focus|Swap|Two by two)/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: /^Quit Foom/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("menuitem", { name: /^New window/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  const settings = page.getByRole("menuitem", { name: /^Settings…/ });
  for (const key of mac ? ["click"] : ["F10", "Alt"]) {
    if (key === "click") await trigger.click();
    else
      await app.evaluate(({ BrowserWindow }, keyCode) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        window.focus();
        for (const type of ["keyDown", "keyUp"])
          window.webContents.sendInputEvent({ type, keyCode });
      }, key);
    await expect(menu).toBeVisible();
    // New window, New worktree, Add repository, then Settings.
    for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowDown");
    await expect(settings).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(menu).toHaveCount(0);
    await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  }
  // Size steps the interface size and the menu stays open.
  const zoom = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getZoomFactor(),
    );
  await trigger.click();
  const size = page.getByRole("group", { name: /^Size/ });
  await expect(size).toContainText("100%");
  await page.getByRole("menuitem", { name: "Bigger interface" }).click();
  await expect(size).toContainText("110%");
  await expect.poll(zoom).toBeCloseTo(1.1);
  await expect(menu).toBeVisible();
  await page.getByRole("menuitem", { name: "Smaller interface" }).click();
  await expect(size).toContainText("100%");
  await expect.poll(zoom).toBeCloseTo(1);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // The shortcut sheet opens from its binding and from the menu, and returns focus.
  const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
  await filter.focus();
  await boardCommand(app, "/", !mac);
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: /^Tiles/ })).toBeVisible();
  await expect(sheet).toContainText(mac ? "⌘/" : "Ctrl+Shift+/");
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(filter).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitem", { name: /^Keyboard shortcuts/ }).click();
  await expect(sheet).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(sheet).toHaveCount(0);
  await expect(filter).toBeFocused();
  if (!mac)
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMenuBarVisible(),
      ),
      false,
    );
});

test("commands removed from the wordmark menu keep their shortcuts", {
  timeout: deadline(45000),
  skip: process.platform === "darwin",
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
  await filter.fill("before");
  await filter.evaluate((input) => input.setSelectionRange(2, 5));
  await app.evaluate(({ clipboard }) => clipboard.writeText("AFTER"));
  await boardCommand(app, "V");
  await expect(filter).toHaveValue("beAFTERe");
  await filter.evaluate((input) => input.setSelectionRange(2, 7));
  await app.evaluate(({ clipboard }) => clipboard.writeText("STALE"));
  await boardCommand(app, "C");
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("AFTER");
  await filter.fill("");
  await boardCommand(app, "B");
  await expect(page.locator(".board-row")).toBeFocused();
  await boardCommand(app, "1", false);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
});
