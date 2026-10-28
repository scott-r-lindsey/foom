const { evidencePath } = require("../helpers/evidence.js");
const { gitSync: isolatedGit } = require("../helpers/git.js");

const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
  tabTo,
} = require("./harness.js");

test("Settings transitions restore background fullscreen output repeatedly", {
  timeout: deadline(45000),
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-view-probe-"));
  removeAfterApps(context, directory);
  const marker = path.join(directory, "stage");
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const hide = page.locator(".config-gear");
  const open = page.locator(".board-row[data-kind='shell']");
  await expect(hide).toBeEnabled();
  await page.evaluate(() => {
    window.viewChunks = 0;
    window.desktop.onData((id) => {
      window.viewId = id;
      window.viewChunks++;
    });
  });
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "view-probe.js")}" "${marker}"`;
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  const rows = page.locator(".xterm-rows");
  await expect(rows).toContainText("NORMAL_VIEW_READY");
  await openSettingsScreen(page);
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await expect(open).toBeEnabled();
  await expect(page.locator(".tile-terminal")).toBeHidden();
  await page.evaluate(() => {
    window.viewChunks = 0;
    window.desktop.input(window.viewId, "a");
  });
  await expect.poll(() => readFile(marker, "utf8").catch(() => "pending")).toBe("alternate");
  assert.equal(await page.evaluate(() => window.viewChunks), 0);
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await open.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(hide).toBeEnabled();
    await expect(rows).toContainText("ALTERNATE_HIDDEN_OUTPUT");
    await expect(rows).not.toContainText("NORMAL_VIEW_READY");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await openSettingsScreen(page);
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(open).toBeEnabled();
  }
  await page.evaluate(() => window.desktop.input(window.viewId, "n"));
  await expect.poll(() => readFile(marker, "utf8")).toBe("normal");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
  await open.click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(hide).toBeEnabled();
  await expect(rows).toContainText("NORMAL_VIEW_READY");
  await expect(rows).toContainText("NORMAL_HIDDEN_OUTPUT");
  await expect(rows).not.toContainText("ALTERNATE_HIDDEN_OUTPUT");
  // Continue scrolling after restoration, including origin-relative positioning,
  // repeated attachments, and transitions between both buffers.
  for (const mode of ["a", "n", "a", "n"]) {
    await openSettingsScreen(page);
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(open).toBeEnabled();
    await page.evaluate((key) => window.desktop.input(window.viewId, key), mode);
    await expect.poll(() => readFile(marker, "utf8")).toBe(mode === "a" ? "alternate" : "normal");
    for (const setup of ["s", "o"]) {
      await page.evaluate((key) => window.desktop.input(window.viewId, key), setup);
      await expect.poll(() => readFile(marker, "utf8")).toBe(setup);
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
        await open.click();
        await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
        await expect(hide).toBeEnabled();
        await expect(rows).toContainText("FOOTER");
        await page.keyboard.type("j");
        const expected = [
          "HEADER",
          ...Array(3 - Math.min(cycle, 3)).fill(""),
          ...Array(Math.min(cycle, 3)).fill("NEXT"),
          "NEXT",
          "FOOTER",
        ];
        if (cycle < 3) expected[3 - cycle] = "bottom";
        await expect
          .poll(() =>
            rows
              .locator(":scope > div")
              .evaluateAll((elements) =>
                elements.slice(0, 6).map((element) => element.textContent.trimEnd()),
              ),
          )
          .toEqual(expected);
        const tail = await page.evaluate(() => window.desktop.tail(window.viewId, 10000));
        assert.deepEqual(tail.slice(-6), expected);
        await openSettingsScreen(page);
        await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
        await expect(open).toBeEnabled();
      }
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await open.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(hide).toBeEnabled();
  }
  // Reopening restores interactive input as well as the screen.
  await page.keyboard.type("q");
});

test("the board stays usable at 300% in a small window", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const shellRow = page.locator(".board-row[data-kind='shell']");
  await shellRow.waitFor({ timeout: deadline(10000) });
  await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 300 }));
  // CI displays vary, so size the window rather than the screen. The scaled minimum
  // would otherwise hold the window at the work area.
  const content = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.setMinimumSize(1, 1);
    window.setContentSize(1280, 720);
    return { zoom: window.webContents.getZoomFactor(), ...window.getContentBounds() };
  });
  assert.equal(content.zoom, 3);
  await expect
    .poll(() =>
      page.evaluate(({ width, height }) => {
        const css = [
          Math.abs(window.innerWidth - width / 3),
          Math.abs(window.innerHeight - height / 3),
        ];
        return Math.max(...css);
      }, content),
    )
    .toBeLessThanOrEqual(1);
  // Boxes in CSS pixels that must stay inside the window, or across a scrolling container.
  const outside = (selector, container) =>
    page.evaluate(
      ({ selector, container }) => {
        const outer = container
          ? document.querySelector(container).getBoundingClientRect()
          : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
        return [...document.querySelectorAll(selector)]
          .filter((element) => element.getClientRects().length > 0)
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return (
              box.left < outer.left - 1 ||
              box.right > outer.right + 1 ||
              (!container && (box.top < outer.top - 1 || box.bottom > outer.bottom + 1))
            );
          })
          .map((element) => element.className || element.textContent);
      },
      { selector, container },
    );
  const pageScrolls = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
  const scrollsWithin = (locator) =>
    locator.evaluate((root) => {
      const scroller = [root, ...root.querySelectorAll("*")].find(
        (element) =>
          element.scrollHeight > element.clientHeight + 1 &&
          /auto|scroll/.test(getComputedStyle(element).overflowY),
      );
      if (!scroller) return false;
      scroller.scrollTop = scroller.scrollHeight;
      return scroller.scrollTop > 0;
    });

  assert.equal(await pageScrolls(), false, "The page never scrolls horizontally");
  await expect(page.locator(".sidebar-shell")).toBeInViewport();
  await expect(shellRow).toBeInViewport();
  await expect(page.locator(".tile-terminal").first()).toBeInViewport({ ratio: 0.5 });
  assert.deepEqual(await outside(".sidebar-footer *", ".sidebar-shell"), []);

  // The row's sidebar panel opens inside the window.
  await shellRow.locator(".row-actions").click();
  await expect(page.locator(".row-menu")).toBeVisible();
  assert.deepEqual(await outside(".row-menu"), []);
  await page.keyboard.press("Escape");
  await expect(page.locator(".row-menu")).toHaveCount(0);

  // The shortcut sheet fits and scrolls within itself.
  await shellRow.focus();
  await expect(shellRow).toBeFocused();
  await boardCommand(app, "/", process.platform !== "darwin");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  assert.deepEqual(await outside(".shortcut-sheet"), []);
  assert.deepEqual(await outside(".shortcut-columns dl > div", ".shortcut-sheet"), []);
  assert.equal(await scrollsWithin(sheet), true, "The shortcut sheet scrolls within itself");
  assert.equal(await pageScrolls(), false, "The shortcut sheet does not widen the page");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // Settings opens and scrolls within itself.
  await openSettingsScreen(page);
  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings).toBeVisible();
  assert.equal(await pageScrolls(), false, "Settings does not widen the page");
  assert.deepEqual(await outside(".settings-view"), []);
  assert.equal(await scrollsWithin(settings), true, "Settings scrolls within itself");
  await expect(settings.getByRole("button", { name: "Close settings (Esc)" })).toBeVisible();
  // Teardown quits through the real confirmation, which must settle at this size.
});

test("Settings shares live preflight values, sizes the terminal and restores keyboard focus", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-settings-repositories-"));
  removeAfterApps(context, root);
  const repository = path.join(root, "settings-example");
  await mkdir(repository);
  isolatedGit(["init", "-q", repository]);
  const app = await launchApp(context, { fixture: "running-shell" });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  const page = await boardPage(app);
  const shortcut = async () => {
    await boardCommand(app, ",", process.platform !== "darwin");
    // Native input dispatch returns before React's mount effects finish. Visibility
    // alone does not mean the Escape listener is installed or focus has moved.
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeFocused();
  };
  const row = page.locator('.board-row[data-kind="shell"]');
  await boardCommand(app, "B");
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await shortcut();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Terminal pane" })).toBeHidden();
  const tabToControl = async (control) => {
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    for (let step = 0; step < 50; step++) {
      await page.keyboard.press("Tab");
      if (await control.evaluate((element) => document.activeElement === element)) return;
    }
    throw new Error("Settings control is not reachable with Tab");
  };

  const section = async (name) => {
    await tabTo(page, name);
    await page.keyboard.press("Enter");
  };
  await section("Agents");
  const hooks = page.getByLabel("Attach hooks", { exact: false });
  await tabToControl(hooks);
  await page.keyboard.press("Space");
  await expect
    .poll(() => page.evaluate(async () => (await window.desktop.setupState()).settings.hooks))
    .toBe(false);
  await section("Repositories");
  await page.getByRole("button", { name: "Choose folder…" }).waitFor();
  await tabTo(page, "Choose folder…");
  await page.keyboard.press("Enter");
  const added = page.getByRole("checkbox", { name: /settings-example/ });
  await expect(added).not.toBeChecked();
  await tabToControl(added);
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.desktop.workspace()).repositories.map((repo) => repo.name),
      ),
    )
    .toContain("settings-example");
  await section("General");
  await tabToControl(page.getByRole("radio", { name: /Keep worktrees/ }));
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.worktreeLocation),
    )
    .toBe("adjacent");
  await section("Appearance");
  await tabToControl(page.getByRole("button", { name: /^Theme Default · Eclipse / }));
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await tabTo(page, "+", "Larger");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "110%" })).toBeVisible();
  await section("Terminal");
  const font = page.getByRole("button", { name: "Terminal font size 14 px", exact: true });
  await tabToControl(font);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Terminal font size 15 px", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFontSize),
    )
    .toBe(15);
  await page.keyboard.press("Escape");

  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "15px");
  await shortcut();
  await section("Appearance");
  await expect(page.getByRole("button", { name: "Theme Eclipse Dark", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "110%" })).toBeVisible();
  await page.getByRole("button", { name: /^Theme / }).click();
  await page.getByRole("menuitemradio", { name: "Eclipse Light", exact: true }).click();
  await page.getByRole("button", { name: "Larger", exact: true }).click();
  await page.keyboard.press("Escape");
  await shortcut();
  await section("Appearance");
  await expect(
    page.getByRole("button", { name: "Theme Eclipse Light", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "120%" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  // The close control stays at the top right in both layouts and scales with zoom.
  for (const scale of [100, 150, 300]) {
    await page.evaluate((interfaceScale) => window.desktop.saveSetup({ interfaceScale }), scale);
    const bounds = await app.evaluate(({ BrowserWindow }, scale) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.setMinimumSize(1, 1);
      window.setContentSize(scale === 100 ? 1400 : 1000, 720);
      return window.getContentBounds();
    }, scale);
    await expect
      .poll(() => page.evaluate(() => window.innerWidth))
      .toBeCloseTo(bounds.width / (scale / 100), 0);
    await shortcut();
    const close = page.getByRole("button", { name: "Close settings (Esc)", exact: true });
    await expect(close).toHaveCount(1);
    await expect(close).toHaveAttribute("title", "Close settings (Esc)");
    await expect(close).toBeInViewport();
    if (scale > 100) {
      const navigation = page.getByRole("navigation", { name: "Settings sections" });
      assert.equal(
        await navigation.evaluate((element) => element.scrollHeight > element.clientHeight + 1),
        false,
        "Compact Settings sections scroll with the page",
      );
    }
    const geometry = await close.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const root = element.closest(".settings-view");
      const settings = root.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        top: box.top - settings.top,
        right: settings.left + root.clientLeft + root.clientWidth - box.right,
      };
    });
    assert.ok(geometry.width >= 32 && geometry.height >= 32);
    assert.ok(geometry.top >= 0 && geometry.top <= 12);
    assert.ok(geometry.right >= 0 && geometry.right <= 16);
    const firstSection = page.getByRole("button", { name: "General", exact: true });
    await expect(firstSection).toBeEnabled();
    await firstSection.focus();
    await expect(firstSection).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    assert.equal(await close.evaluate((element) => element.matches(":focus-visible")), true);
    const focus = await close.evaluate((element) => {
      const style = getComputedStyle(element);
      const ink = getComputedStyle(element.closest(".settings-view")).color;
      return { color: style.color, ink, outline: style.outlineStyle, width: style.outlineWidth };
    });
    assert.equal(focus.color, focus.ink);
    assert.notEqual(focus.outline, "none");
    assert.notEqual(focus.width, "0px");
    await page.keyboard.press("Tab");
    await expect(firstSection).toBeFocused();
    await close.hover();
    await expect(close).toHaveCSS("color", focus.ink);
    await page.mouse.move(0, 0);
    assert.notEqual(await close.evaluate((element) => getComputedStyle(element).color), focus.ink);
    const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      return (await window.webContents.capturePage()).toPNG().toString("base64");
    });
    await writeFile(evidencePath(`settings-close-${scale}.png`), Buffer.from(screenshot, "base64"));
    await close.click();
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await shortcut();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  }
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .map((window) => ({ url: window.webContents.getURL(), visible: window.isVisible() }))
        .sort((a, b) => a.url.localeCompare(b.url)),
    ),
    [
      { url: "app://bundle/index.html", visible: true },
      { url: "app://confirmation/confirmation.html", visible: false },
    ],
  );
});

test("every Settings section passes axe in light and dark, including the narrow layout", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  for (const name of ["General", "Agents", "Repositories", "Appearance", "Terminal", "Sound"]) {
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true })
      .click();
    await assertAccessible(page);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    // Exercise compact layouts as on a display smaller than the normal minimum.
    window.setMinimumSize(0, 0);
    window.setSize(640, 640);
  });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await assertAccessible(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});
