const { sizeTileBoard } = require("./tile-fixture.js");
const { evidencePath } = require("../helpers/evidence.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { afterEach } = require("node:test");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  confirmationPage,
  launchApp,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

let previousTest;
afterEach((context) => {
  previousTest = context.name;
});

async function chooseTheme(page, name, label = "Theme") {
  await page.getByRole("button", { name: new RegExp(`^${label} `) }).click();
  await page
    .getByRole("menuitemradio", {
      name: name === "Default" ? /^Default(?: · |$)/ : name,
      exact: true,
    })
    .click();
}

test("appearance switches light and dark, and zoom shortcuts resize the interface", async (context) => {
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Start preflight" }).waitFor();
  // Exercise theme changes after the rows appear, independently of CI startup speed.
  await page.locator('.welcome-noise[data-phase="settled"]').waitFor();
  for (const [colorScheme, surface] of [
    ["light", "rgb(233, 228, 245)"],
    ["dark", "rgb(13, 10, 23)"],
  ]) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(
        () =>
          page
            .locator(".welcome-sidebar")
            .evaluateAll((tiles) => tiles.map((tile) => getComputedStyle(tile).backgroundColor)),
        { message: "Row backgrounds must switch with text" },
      )
      .toEqual([surface]);
  }
  await page.emulateMedia({ colorScheme: null });
  const dark = () => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const background = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

  await chooseTheme(page, "Eclipse Dark");
  // Media emulation from the loop above can linger; wait for the saved source itself.
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  await expect.poll(dark).toBe(true);
  await expect.poll(background).toBe("rgb(5, 4, 10)");
  await assertAccessible(page);
  await chooseTheme(page, "Eclipse Light");
  await expect.poll(dark).toBe(false);
  await expect.poll(background).toBe("rgb(243, 240, 250)");

  const zoom = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getZoomFactor(),
    );
  const press = (keyCode, shift) =>
    app.evaluate(
      ({ BrowserWindow }, { keyCode, shift, mac }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        window.focus();
        const modifiers = mac ? ["meta"] : ["control", ...(shift ? ["shift"] : [])];
        for (const type of ["keyDown", "keyUp"])
          window.webContents.sendInputEvent({ type, keyCode, modifiers });
      },
      { keyCode, shift, mac: process.platform === "darwin" },
    );
  const size = () =>
    app.evaluate(({ BrowserWindow }) => {
      const { width, height } = BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getBounds();
      return { width, height };
    });
  const start = await size();
  const grown = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    const bounds = window.getBounds();
    const content = window.getContentBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const [minimumWidth, minimumHeight] = window.getMinimumSize();
    // Native frames don't zoom; the scaled minimum and display constrain the result.
    return {
      width: Math.min(
        Math.max(
          Math.round(content.width * 1.1) + bounds.width - content.width,
          Math.round(minimumWidth * 1.1),
        ),
        area.width,
      ),
      height: Math.min(
        Math.max(
          Math.round(content.height * 1.1) + bounds.height - content.height,
          Math.round(minimumHeight * 1.1),
        ),
        area.height,
      ),
    };
  });
  await press("=", true);
  await expect.poll(zoom).toBeCloseTo(1.1);
  await page.getByText("110%").waitFor();
  // The window grows with the interface while the screen has room.
  await expect.poll(size).toEqual(grown);
  await page.getByRole("button", { name: "Larger" }).click();
  await expect.poll(zoom).toBeCloseTo(1.2);
  await press("0", true);
  await expect.poll(zoom).toBeCloseTo(1);
  await page.getByText("100%").waitFor();
  // And returns to exactly its starting size.
  await expect.poll(size).toEqual(start);
  await assertAccessible(page);
});

test("window size defaults to 60 percent and survives a normal quit and relaunch", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-window-size-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`], fixture: "empty-board" };
  const app = await launchApp(context, options);
  const initial = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    const area = screen.getPrimaryDisplay().workAreaSize;
    return { size: window.getSize(), area };
  });
  assert.deepEqual(initial.size, [
    Math.min(initial.area.width, Math.max(900, Math.round(initial.area.width * 0.6))),
    Math.min(initial.area.height, Math.max(640, Math.round(initial.area.height * 0.6))),
  ]);
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workAreaSize;
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(Math.min(1200, area.width), Math.min(850, area.height));
  });
  const size = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .getSize(),
  );
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, "window-size.json"), "utf8")), {
    width: size[0],
    height: size[1],
  });
  const restored = await launchApp(context, { ...options, fixture: "restored" });
  assert.deepEqual(
    await restored.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getSize(),
    ),
    size,
  );
  await quitAndWait(restored, () => restored.evaluate(({ app }) => app.quit()));
});

test("every interface theme applies live to native chrome and passes axe on board and Settings", {
  timeout: deadline(55000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const choices = [
    ["eclipse-light", "Eclipse Light", "light", "#f3f0fa"],
    ["eclipse-dark", "Eclipse Dark", "dark", "#05040a"],
    ["high-contrast", "High Contrast", "dark", "#000000"],
    ["deep-field", "Deep Field", "dark", "#080f1e"],
    ["moonlight", "Moonlight", "light", "#f5f7fc"],
    ["graphite", "Graphite", "dark", "#18181b"],
    ["midnight-indigo", "Midnight Indigo", "dark", "#101027"],
  ];
  for (const [id, name, base, background] of choices) {
    await boardCommand(app, ",", process.platform !== "darwin");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await chooseTheme(page, name);
    await expect(page.getByRole("button", { name: `Theme ${name}`, exact: true })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceTheme),
      )
      .toBe(id);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
      .toBe(background);
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), base);
    assert.equal(
      (
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL() === "app://bundle/index.html")
            .getBackgroundColor(),
        )
      ).toLowerCase(),
      background,
    );
    await expect(
      page.getByRole("list", { name: "Terminal status previews" }).getByRole("listitem"),
    ).toHaveCount(5);
    const expectedHighlight = {
      "deep-field": "#6cc7ff",
      graphite: "#9fb1c7",
      moonlight: "#2f5fbf",
    }[id];
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const preview = document.querySelector(".interface-theme-preview");
      const working = preview.querySelector('[data-state="working"] .board-light');
      const cssColor = (hex) => {
        const node = document.createElement("span");
        node.style.color = hex;
        return node.style.color;
      };
      const accent = root.getPropertyValue("--accent").trim();
      const highlight = root.getPropertyValue("--highlight").trim();
      return {
        accent,
        highlight,
        highlightRgb: cssColor(highlight),
        accentRgb: cssColor(accent),
        working: getComputedStyle(working).backgroundColor,
        brand: getComputedStyle(document.querySelector(".wordmark")).color,
        inkRgb: cssColor(root.getPropertyValue("--ink").trim()),
      };
    });
    assert.equal(colors.highlight, expectedHighlight ?? colors.accent);
    assert.equal(colors.working, colors.accentRgb);
    assert.equal(colors.brand, colors.inkRgb);
    await assertAccessible(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tile-terminal")).toBeVisible();
    await expect(page.locator('.terminal-tile[data-focused="true"]')).toHaveCSS(
      "border-color",
      colors.highlightRgb,
    );
    await assertAccessible(page);
  }
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await chooseTheme(page, "Default");
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe("system");
  for (const [colorScheme, expected] of [
    ["dark", "#05040a"],
    ["light", "#f3f0fa"],
  ]) {
    await page.emulateMedia({ colorScheme });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
      .toBe(expected);
  }
  await page.emulateMedia({ colorScheme: null });
  await chooseTheme(page, "High Contrast");
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    window.setMinimumSize(0, 0);
    window.setSize(640, 640);
  });
  await assertAccessible(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test("neutral identity badges keep labels and geometry across themes and interface scales", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const basePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  const row = page.locator('.board-row[data-kind="shell"]');
  await expect(row).toBeVisible();
  await row.press("F2");
  await page.getByRole("textbox", { name: "Session name" }).fill("Build helper");
  await page.getByRole("textbox", { name: "Session name" }).press("Enter");
  await expect(row).toHaveAccessibleName(/Build helper · Shell \(.+\)/);
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(row.locator(".board-agent")).toHaveCount(1);
  await expect(row.locator(".board-agent")).toBeVisible();
  await row.press("F2");
  await expect(page.getByRole("textbox", { name: "Session name", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Session name", exact: true }).press("Escape");
  await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const interfaceScale of [80, 90, 100, 110, 120, 130, 140, 150]) {
      await page.evaluate(
        (interfaceScale) => window.desktop.saveSetup({ interfaceScale }),
        interfaceScale,
      );
      // Saving settings acknowledges main; Chromium applies zoom asynchronously.
      // Observe the renderer's actual zoom before checking geometry or advancing again.
      await expect
        .poll(() => page.evaluate(() => window.devicePixelRatio), {
          message: `${colorScheme} theme at ${interfaceScale}% renderer zoom`,
        })
        .toBeCloseTo((basePixelRatio * interfaceScale) / 100, 5);
      await row.focus();
      await expect(page.getByRole("complementary", { name: "Terminal peek" })).toHaveCount(0);
      await expect(row).toHaveAccessibleName(/Build helper · Shell \(.+\)/);
      const badge = row.locator(".board-agent");
      await expect(badge).toHaveText(">_");
      await expect(badge).toBeVisible();
      await expect
        .poll(
          () =>
            badge.evaluate((element) =>
              Math.max(
                Math.abs(parseFloat(getComputedStyle(element).height) - 20),
                Math.abs(parseFloat(getComputedStyle(element.firstElementChild).height) - 16),
              ),
            ),
          { message: `${colorScheme} badge geometry at ${interfaceScale}%` },
        )
        .toBeLessThan(0.1);
      await expect
        .poll(
          () =>
            badge.evaluate((element) => {
              const style = getComputedStyle(element);
              return (
                element.clientWidth >= element.scrollWidth &&
                style.backgroundColor ===
                  getComputedStyle(document.querySelector(".tile-title .board-agent"))
                    .backgroundColor &&
                style.fontFamily.includes("Geist Mono") &&
                element.querySelectorAll("img, svg").length === 0
              );
            }),
          { message: `${colorScheme} badge layout and styling at ${interfaceScale}%` },
        )
        .toBe(true);
      if (process.env.FOOM_SCREENSHOTS && [80, 100, 150].includes(interfaceScale))
        await page.screenshot({
          path: evidencePath(
            path.join(__dirname, `../../test-results/badges-${colorScheme}-${interfaceScale}.png`),
          ),
        });
    }
  }
  await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 100 }));
  await assertAccessible(page);
});

test("Appearance refuses a custom palette changed after it was offered", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-theme-selection-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "empty-board", home: root });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const { base, colors } = interfaceThemes["eclipse-dark"];
  const file = path.join(root, ".foom/config/themes/review.json");
  const original = { kind: "theme", name: "Review palette", base, colors };
  await writeFile(file, JSON.stringify(original));
  await page.getByRole("button", { name: /^Theme / }).click();
  const choice = page.getByRole("menuitemradio", { name: original.name, exact: true });
  await expect(choice).toBeVisible();
  const before = await page.evaluate(
    async () => (await window.desktop.setupState()).settings.interfaceTheme,
  );
  // Change the bytes inside the save, after the renderer has chosen the offered palette.
  await app.evaluate(
    ({ app }, { file, weakened }) => {
      const load = process
        .getBuiltinModule("node:module")
        .createRequire(app.getAppPath() + "/package.json");
      const { writeFile } = process.getBuiltinModule("node:fs/promises");
      const { ConfigService } = load("./build/main/config/service.js");
      const write = ConfigService.prototype.write;
      ConfigService.prototype.write = async function (patch, ...args) {
        if (patch.interfaceTheme === "user:review.json") {
          ConfigService.prototype.write = write;
          await writeFile(file, weakened);
        }
        return write.call(this, patch, ...args);
      };
    },
    {
      file,
      weakened: JSON.stringify({ ...original, colors: { ...colors, attention: colors.ink } }),
    },
  );
  await choice.click();
  await expect(
    page
      .getByText("The theme changed. Choose it again after the theme list refreshes.", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceTheme),
    before,
  );
  const settings = JSON.parse(
    await readFile(path.join(root, ".foom/config/settings.json"), "utf8"),
  );
  assert.notEqual(settings.interfaceTheme, "user:review.json");
});

test("custom theme files appear live, update selected colors and retain rejected edits", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-custom-theme-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "empty-board", home: root });
  const page = await boardPage(app);
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const { terminalThemes, ansiNames } = require("../../build/shared/terminal-themes.js");
  const file = path.join(root, ".foom/config/themes/custom.json");
  const palette = interfaceThemes["eclipse-dark"];
  const theme = { kind: "theme", name: "Live custom", base: palette.base, colors: palette.colors };
  await writeFile(file, JSON.stringify(theme));
  await chooseTheme(page, "Live custom");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceTheme),
    )
    .toBe("user:custom.json");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
    .toBe(palette.colors.bg);
  theme.colors = interfaceThemes.graphite.colors;
  await writeFile(file, JSON.stringify(theme));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")))
    .toBe(theme.colors.bg);
  await writeFile(
    file,
    JSON.stringify({ ...theme, colors: { ...theme.colors, accent: "url(https://example.org)" } }),
  );
  await expect(page.getByRole("status").filter({ hasText: "Rejected custom.json" })).toContainText(
    "$.colors.accent: not-a-color",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.style.getPropertyValue("--bg")),
    theme.colors.bg,
  );
  assert.equal(
    await page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceTheme),
    "user:custom.json",
  );
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const terminal = terminalThemes.dracula;
  const terminalFile = path.join(root, ".foom/config/terminal-themes/custom.json");
  const terminalTheme = {
    kind: "terminal-theme",
    name: "Live terminal",
    background: terminal.background,
    foreground: terminal.foreground,
    cursor: terminal.cursor,
    ansi: ansiNames.map((key) => terminal[key]),
  };
  await writeFile(terminalFile, JSON.stringify(terminalTheme));
  await chooseTheme(page, "Live terminal", "Colors");
  const choicesBounds = await page.locator(".terminal-theme-picker-column").boundingBox();
  const previewBounds = await page.getByLabel("Terminal theme preview").boundingBox();
  assert.ok(choicesBounds && previewBounds);
  assert.ok(previewBounds.x > choicesBounds.x, "terminal preview stays beside the picker");
  assert.ok(
    Math.abs(previewBounds.y - choicesBounds.y) < 2,
    "preview and picker share the top row",
  );
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS(
    "background-color",
    "rgb(40, 42, 54)",
  );
  terminalTheme.background = "#101010";
  await writeFile(terminalFile, JSON.stringify(terminalTheme));
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS(
    "background-color",
    "rgb(16, 16, 16)",
  );
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--terminal-background")),
    )
    .toBe("#101010");
  await writeFile(terminalFile, "{");
  await expect(
    page
      .locator(".terminal-theme-picker-column")
      .getByRole("status")
      .filter({ hasText: "Rejected custom.json" }),
  ).toContainText("malformed-json");
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS(
    "background-color",
    "rgb(16, 16, 16)",
  );
  await page.screenshot({
    path: evidencePath("custom-theme.png"),
  });
});

test("version 2 themes scope portaled colors, shape and warnings and hold attention edits", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-v2-theme-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "running-shell", home: root });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const theme = {
    ...interfaceThemes["eclipse-dark"],
    version: 2,
    name: "Personal v2",
    colors: { ...interfaceThemes["eclipse-dark"].colors, ink: "#ffb23e" },
    areas: {
      sidebar: { bg: "#010203", surface: "#010203" },
      tiles: { surface: "#141414" },
      panels: { surface: "#202020" },
      menus: { surface: "#161616" },
    },
    shape: { radius: 0 },
  };
  const file = path.join(root, ".foom/config/themes/personal.json");
  await writeFile(file, JSON.stringify(theme));
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await chooseTheme(page, "Personal v2");
  await page.getByRole("button", { name: "Theme Personal v2", exact: true }).click();
  await expect(page.locator(".theme-menu-options:popover-open")).toHaveCSS("--surface", "#161616");
  await page.keyboard.press("Escape");
  await expect(page.locator(".sidebar-shell")).toHaveCSS("background-color", "rgb(1, 2, 3)");
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect(page.locator(".tile-title").first()).toHaveCSS("--surface", "#141414");
  await expect(page.locator(".board-row").first()).toHaveCSS("border-radius", "0px");
  await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).press("Enter");
  await expect(page.locator(".sidebar-panel")).toHaveCSS("--surface", "#202020");
  await expect(page.locator(".sidebar-panel")).toHaveCSS("border-radius", "0px");
  await page.keyboard.press("Escape");
  await page.locator(".wordmark-menu").click();
  await expect(page.locator(".app-menu")).toHaveCSS("--surface", "#161616");
  await page.keyboard.press("Escape");
  // First restore distinct attention; the next edit must newly introduce the warning.
  theme.colors.ink = "#f4efff";
  await writeFile(file, JSON.stringify(theme));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ink")))
    .toBe("#f4efff");
  const original = JSON.stringify(theme);
  theme.colors.attention = theme.colors.ink;
  await writeFile(file, JSON.stringify(theme));
  await boardCommand(app, ",", process.platform !== "darwin");
  await page
    .getByRole("region", { name: "Settings", exact: true })
    .getByRole("button", { name: "Foom config", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Change waiting for approval" })).toContainText(
    "needs-you is hard to tell apart",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.style.getPropertyValue("--attention")),
    "#ffb23e",
  );
  await page.getByRole("button", { name: "Keep it on", exact: true }).click();
  // Wait for the write to finish before opening the file on Windows.
  await expect(page.getByRole("region", { name: "Change waiting for approval" })).toHaveCount(0);
  assert.equal(await readFile(file, "utf8"), original);
});

test("terminal font picker updates open shells and config shells and refits their grids", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await sizeTileBoard(app, page, 2400);
  await page.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split terminal left", exact: true }).click();
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "config-launch", run: "shell" }));
  await page.locator(".config-dock .board-row").press("Enter");
  await expect(page.locator(".xterm-rows:visible")).toHaveCount(2);
  await expect(page.locator(".xterm-helper-textarea").last()).toBeFocused();
  const ids = await page.evaluate(async () =>
    (await window.desktop.workspace()).terminals.map((entry) => entry.id),
  );
  assert.equal(ids.length, 2);
  await app.evaluate(({ app, ipcMain }) => {
    global.fontResizes = [];
    ipcMain.on("terminal:resize", (_event, id, cols, rows) =>
      global.fontResizes.push({ id, cols, rows }),
    );
    // OS enumeration may legitimately return [] (including after its bounded
    // PowerShell timeout). Exercise font changes with a font bundled on every OS.
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    // Keep enumeration pending until Terminal has mounted. Typing before this
    // reply used to leave Geist present but inactive when it arrived later.
    global.fontList = new Promise((resolve) => {
      global.releaseFontList = resolve;
    });
    // Inject at the main-owned catalog so the real subscription/projection is exercised.
    load("./build/main/fonts/terminal-fonts.js").listTerminalFonts = () => global.fontList;
  });
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  const picker = page.getByRole("button", { name: /^Terminal font (?!size)/ });
  const family = "Geist Mono";
  // Section markup precedes the effect that moves focus to its heading, and
  // families arrive over IPC independently. Both must be ready before typing.
  await expect(page.getByRole("heading", { name: "Terminal", exact: true })).toBeFocused();
  const option = page.getByRole("menuitemradio", {
    name: family,
    exact: true,
    includeHidden: true,
  });
  await expect(option).toHaveCount(0);
  await app.evaluate(() => global.releaseFontList(["Geist Mono"]));
  await expect(option).toHaveCount(1);
  await picker.focus();
  await page.keyboard.type("Geist");
  await expect(page.getByRole("menuitemradio", { name: family, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const sizePicker = page.getByRole("button", { name: /^Terminal font size / });
  await sizePicker.focus();
  await page.keyboard.type("24");
  await expect(page.getByRole("menuitemradio", { name: "24 px", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFontSize),
    )
    .toBe(24);
  const stack = `"${family}", "Hack Nerd Font Mono", "Geist Mono", monospace`;
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFont),
    )
    .toBe(family);
  await expect(page.getByLabel("Terminal theme preview")).toHaveCSS("font-family", stack);
  await app.evaluate(() => {
    global.fontResizes = [];
  });
  await page.keyboard.press("Escape");
  for (const rows of await page.locator(".xterm-rows").all())
    await expect(rows).toHaveCSS("font-family", stack);
  await expect
    .poll(() =>
      app.evaluate(() =>
        [
          ...new Set(
            global.fontResizes
              .filter((entry) => entry.cols > 0 && entry.rows > 0)
              .map((entry) => entry.id),
          ),
        ].sort(),
      ),
    )
    .toEqual(ids.sort());
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  await expect(picker).toHaveText(`${family}⌄`);
  await picker.click();
  await page
    .getByRole("menuitemradio", { name: "Hack Nerd Font Mono (bundled)", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFont),
    )
    .toBe("Hack Nerd Font Mono");
  await page.keyboard.press("Escape");
  for (const rows of await page.locator(".xterm-rows").all())
    await expect(rows).toHaveCSS("font-family", '"Hack Nerd Font Mono", "Geist Mono", monospace');
});

test("interface zoom follows the shared setting in every window", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const first = await boardPage(app);
  await first.evaluate(() => window.desktop.appMenu.execute("new-window"));
  await expect
    .poll(() => app.windows().filter((page) => page.url() === "app://bundle/index.html").length)
    .toBe(2);
  const second = app
    .windows()
    .find((page) => page !== first && page.url() === "app://bundle/index.html");
  const zoomButton = (page, scale) =>
    page.getByRole("button", {
      name: scale === 100 ? "Zoom 100%" : `Zoom ${scale}%, reset to 100%`,
      exact: true,
    });
  await expect(zoomButton(second, 100)).toBeVisible();
  await first.getByRole("button", { name: "Zoom in", exact: true }).click();
  const assertScale = async (scale) => {
    for (const page of [first, second]) {
      await expect(zoomButton(page, scale)).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
        )
        .toBe(scale);
    }
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((window) => window.webContents.getURL() === "app://bundle/index.html")
            .map((window) => window.webContents.getZoomFactor()),
        ),
      )
      .toEqual([scale / 100, scale / 100]);
  };
  await assertScale(110);
  await second.evaluate(() => window.desktop.appMenu.execute("zoom-in"));
  await assertScale(120);
  await zoomButton(first, 120).click();
  await assertScale(100);
});

test("Default themes follow native appearance live and Settings theme menus share the config launcher", async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await app.evaluate(({ BrowserWindow }) => {
    const board = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    board.setSize(1200, 900);
  });
  for (const [mode, bg] of [
    ["light", "rgb(243, 240, 250)"],
    ["dark", "rgb(5, 4, 10)"],
  ]) {
    // Preference previews can settle before their serialized save applies the native source.
    // Finish those writes before simulating the next OS update.
    const saved = await page.evaluate(() => window.desktop.saveSetup({}));
    assert.equal(saved.settings.interfaceTheme, "follow");
    assert.equal(saved.settings.terminalTheme, "follow");
    // Simulate the native OS appearance update, including Chromium media and host palettes.
    // No settings save occurs: both choices must remain Default across the change.
    await app.evaluate(({ nativeTheme }, mode) => {
      nativeTheme.themeSource = mode;
    }, mode);
    await expect(page.locator(".xterm-scrollable-element")).toHaveCSS("background-color", bg);
    await expect(page.locator("html")).toHaveCSS("background-color", bg);
    const settings = await page.evaluate(async () => (await window.desktop.setupState()).settings);
    assert.equal(settings.interfaceTheme, "follow");
    assert.equal(settings.terminalTheme, "follow");
    assert.equal(Object.hasOwn(settings, "colorMode"), false);
    await openSettingsScreen(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByRole("button", { name: "Themes", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: `Theme Default · Eclipse ${mode === "dark" ? "Dark" : "Light"}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Theme Default · Eclipse / }).click();
    await expect(page.getByRole("menuitemradio", { name: /^Default · Eclipse / })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await assertAccessible(page);
    await page.screenshot({ path: evidencePath(`screenshots-878/appearance-${mode}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.locator(".interface-theme-picker-column > .custom-theme-hint")).toBeVisible();
    await page.screenshot({ path: evidencePath(`screenshots-878/appearance-${mode}-closed.png`) });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .setSize(900, 640);
    });
    const pickerBox = await page
      .locator(".interface-theme-picker-column .theme-menu")
      .boundingBox();
    const hintBox = await page
      .locator(".interface-theme-picker-column > .custom-theme-hint")
      .boundingBox();
    assert.ok(pickerBox && hintBox && hintBox.y >= pickerBox.y + pickerBox.height);
    assert.ok(hintBox.y + hintBox.height <= (await page.evaluate(() => innerHeight)));
    await page.screenshot({
      path: evidencePath(`screenshots-878/appearance-${mode}-closed-default-size.png`),
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .setSize(1200, 900);
    });

    await page.getByRole("button", { name: "config agent", exact: true }).click();
    await expect(page.locator(".sidebar-panel:not(.session-panel-preview)")).toContainText(
      "Foom config",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.getByLabel("Terminal theme preview")).toHaveCSS("background-color", bg);
    await expect(page.getByLabel("Terminal theme preview").locator("[title]")).toHaveCount(16);
    await expect(
      page.getByRole("button", {
        name: `Colors Default · Foom ${mode === "dark" ? "Dark" : "Light"}`,
        exact: true,
      }),
    ).toBeVisible();
    await assertAccessible(page);
    await page.screenshot({ path: evidencePath(`screenshots-878/terminal-${mode}.png`) });
    await page.getByRole("button", { name: /^Colors Default/ }).click();
    await expect(
      page.getByRole("menuitemradio", {
        name: `Default · Foom ${mode === "dark" ? "Dark" : "Light"}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-checked", "true");
    if (mode === "dark")
      await page.screenshot({
        path: evidencePath("screenshots-878/terminal-dark-colors-open.png"),
      });
    await page.keyboard.press("Escape");
    await chooseTheme(page, "Dracula", "Colors");
    await expect(page.getByLabel("Terminal theme preview")).toHaveCSS(
      "background-color",
      "rgb(40, 42, 54)",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(".xterm-scrollable-element")).toHaveCSS(
      "background-color",
      "rgb(40, 42, 54)",
    );
    await openSettingsScreen(page);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await chooseTheme(page, "Default", "Colors");
    await page.getByRole("button", { name: "config agent", exact: true }).click();
    await expect(page.locator(".sidebar-panel:not(.session-panel-preview)")).toContainText(
      "Foom config",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: /^Colors Default/ }).click();
  for (const base of ["light", "dark"]) {
    await page.evaluate(
      (base) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${base}` }),
      base,
    );
    const name = `Default · Foom ${base === "dark" ? "Dark" : "Light"}`;
    await expect(page.getByRole("button", { name: `Colors ${name}`, exact: true })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Colors Default · Foom Dark", exact: true }),
  ).toBeFocused();
});

test("first-run rail shares the Theme menu and saves its live selection", async (context) => {
  const app = await launchApp(context, { fixture: "first-run" });
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Start preflight", exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1200, 900);
  });
  await expect
    .poll(() =>
      page.locator(".preflight-rail").evaluate((rail) => rail.scrollWidth - rail.clientWidth),
    )
    .toBe(0);
  await page.getByRole("button", { name: /^Theme / }).focus();
  await page.keyboard.type("Moon");
  await expect(page.getByRole("menuitemradio", { name: "Moonlight", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceTheme),
    )
    .toBe("moonlight");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  // A fixed base controls Chromium media, not the OS appearance Default will use.
  await page.getByRole("button", { name: "Theme Moonlight", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Default", exact: true })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Default", exact: true }).click();
  await expect
    .poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe("system");
  // Electron can discover the OS preference after startup. Sample it after restoring
  // system appearance, rather than assuming the launch-time value remains current.
  const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await expect(page.locator("html")).toHaveCSS("color-scheme", systemDark ? "dark" : "light");
  // Force the opposite base and verify that Default remains unqualified there too.
  await chooseTheme(page, systemDark ? "Eclipse Light" : "Eclipse Dark");
  await page.getByRole("button", { name: /^Theme Eclipse / }).click();
  await expect(page.getByRole("menuitemradio", { name: "Default", exact: true })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Default", exact: true }).click();
  // Config publishes the choice before its baseline write and final setup apply.
  // Drain the serialized save queue before overriding nativeTheme: that final
  // apply would otherwise reset the test's forced source back to system.
  const saved = await page.evaluate(() => window.desktop.saveSetup({}));
  assert.equal(saved.settings.interfaceTheme, "follow");
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), "system");
  await expect(page.locator("html")).toHaveCSS("color-scheme", systemDark ? "dark" : "light");
  // The main-process save barrier does not drain renderer IPC or React updates.
  // Observe Default in the picker too before simulating the next native change.
  await expect(
    page.getByRole("button", {
      name: `Theme Default · Eclipse ${systemDark ? "Dark" : "Light"}`,
      exact: true,
    }),
  ).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await app.evaluate(({ nativeTheme }, mode) => {
      nativeTheme.themeSource = mode;
    }, mode);
    await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
    await expect(
      page.getByRole("button", {
        name: `Theme Default · Eclipse ${mode === "dark" ? "Dark" : "Light"}`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Theme Default · Eclipse / }).click();
    // Native media changes and the menu's React label commit asynchronously.
    // Assert the complete live menu with the same readiness policy as its trigger.
    await expect(page.getByRole("menuitemradio")).toHaveText([
      `✓Default · Eclipse ${mode === "dark" ? "Dark" : "Light"}`,
      "Eclipse Light",
      "Eclipse Dark",
      "High Contrast",
      "Deep Field",
      "Moonlight",
      "Graphite",
      "Midnight Indigo",
    ]);
    await expect(page.getByRole("button", { name: "config agent", exact: true })).toHaveCount(0);
    await page.screenshot({ path: evidencePath(`screenshots-878/first-run-${mode}.png`) });
    await page.keyboard.press("Escape");
  }
});

test("extended user themes apply through both bridges and reject malformed theme data", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-extended-theme-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "running-shell", home: root });
  const page = await boardPage(app);
  const dialog = await confirmationPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const file = path.join(root, ".foom/config/themes/extended.json");
  let theme;
  const terminal = await page.locator(".xterm-rows").evaluate((node) => ({
    size: getComputedStyle(node).fontSize,
    family: getComputedStyle(node).fontFamily,
  }));
  for (const base of ["dark", "light"]) {
    const palette = interfaceThemes[`eclipse-${base}`];
    const bg = base === "dark" ? "#000000" : "#ffffff";
    const end = base === "dark" ? "#080410" : "#f8f5ff";
    const gradient = {
      angle: 120,
      stops: [
        [bg, 0],
        [end, 100],
      ],
    };
    theme = {
      ...palette,
      version: 2,
      name: "Extended theme",
      type: { family: "system", scale: 1.1, weight: 450, "strong-weight": 650 },
      areas: {
        sidebar: { bg, gradient, scrollbar: "#665588" },
        titlebar: { bg, gradient },
        "tile-headers": { surface: bg },
        board: { bg, gradient },
        badges: { "badge-fill": palette.colors["badge-fill"] },
        wordmark: { ink: palette.colors.ink },
        "dialog-headers": { bg, gradient },
      },
    };
    await writeFile(file, JSON.stringify(theme));
    if (base === "dark") {
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await chooseTheme(page, theme.name);
      await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
    }
    await expect(page.locator(".sidebar-shell")).toHaveCSS(
      "background-color",
      base === "dark" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
    );
    const transported = await page.evaluate(
      async () =>
        (await window.desktop.setupState()).themes.interface.find(
          (entry) => entry.id === "user:extended.json",
        ).theme,
    );
    assert.deepEqual(transported, theme, "Every bounded theme field survives the board bridge");
    await expect(page.locator(".sidebar-shell")).toHaveCSS(
      "background-image",
      /linear-gradient\(120deg/,
    );
    assert.match(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--theme-sidebar-gradient"),
      ),
      /120deg in srgb/,
    );
    await expect(page.locator(".board-list")).toHaveCSS(
      "scrollbar-color",
      "rgb(102, 85, 136) rgba(0, 0, 0, 0)",
    );
    await expect(page.locator(".tile-title").first()).toHaveCSS("--surface", bg);
    await expect(page.locator(".wordmark")).toHaveCSS("--ink", palette.colors.ink);
    await expect(page.locator(".tile-title").first()).toHaveCSS("font-size", "12.1px");
    assert.deepEqual(
      await page.locator(".xterm-rows").evaluate((node) => ({
        size: getComputedStyle(node).fontSize,
        family: getComputedStyle(node).fontFamily,
      })),
      terminal,
      "Interface typography leaves terminal typography unchanged",
    );
    await page.screenshot({
      path: evidencePath(`1188-gradient-${base}.png`),
      animations: "disabled",
    });
  }
  // Rejected file edits must retain the complete last-good theme through the watcher.
  const good = structuredClone(theme);
  await writeFile(file, JSON.stringify({ ...theme, type: { scale: 2 } }));
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Rejected extended.json" }),
  ).toContainText("invalid-value");
  assert.deepEqual(
    await page.evaluate(
      async () =>
        (await window.desktop.setupState()).themes.interface.find(
          (entry) => entry.id === "user:extended.json",
        ).theme,
    ),
    good,
  );

  // Main-authored fixtures exercise validation independently of the file parser.
  const state = await page.evaluate(() => window.desktop.setupState());
  const malformed = [
    { ...good, type: { family: "url(private)" } },
    ...[0.84, 1.26, null].map((scale) => ({ ...good, type: { scale } })),
    { ...good, type: { weight: 601 } },
    { ...good, type: { "strong-weight": 499 } },
    ...[
      {
        angle: 360,
        stops: [
          ["#ffffff", 0],
          ["#ffffff", 100],
        ],
      },
      { angle: 0, stops: [] },
      { angle: 0, stops: [["#ffffff", 0]] },
      {
        angle: 0,
        stops: [
          ["url(private)", 0],
          ["#ffffff", 100],
        ],
      },
      {
        angle: 0,
        stops: [
          ["#ffffff", 50],
          ["#ffffff", 50],
        ],
      },
      {
        angle: 0,
        stops: [
          ["#ffffff", -1],
          ["#ffffff", 100],
        ],
      },
      {
        angle: 0,
        stops: [
          ["#ffffff", 0, 1],
          ["#ffffff", 100],
        ],
      },
    ].map((gradient) => ({ ...good, areas: { sidebar: { bg: "#ffffff", gradient } } })),
    { ...good, areas: { tiles: good.areas.sidebar } },
    { ...good, areas: { sidebar: { gradient: good.areas.sidebar.gradient } } },
    { ...good, areas: { wordmark: { scrollbar: "url(private)" } } },
  ];
  const request = {
    id: "theme-bridge",
    presented: false,
    title: "Theme bridge",
    accept: "Continue",
    theme: good,
  };
  await dialog.evaluate(() => {
    window.themeRequests = [];
    window.confirmation.render((request) => {
      if (request) window.themeRequests.push(request);
    });
  });
  await app.evaluate(
    ({ BrowserWindow }, requests) => {
      const child = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
      );
      for (const request of requests) child.webContents.send("confirmation:render", request);
    },
    [
      request,
      ...malformed.map((theme) => ({ ...request, id: "invalid", theme })),
      { ...request, id: "last-valid" },
    ],
  );
  await expect
    .poll(() => dialog.evaluate(() => window.themeRequests.at(-1)?.id))
    .toBe("last-valid");
  assert.deepEqual(
    await dialog.evaluate(() => window.themeRequests),
    [request, { ...request, id: "last-valid" }],
    "Confirmation bridge copies valid extensions and drops malformed requests",
  );
  for (const theme of malformed) {
    await app.evaluate(
      ({ ipcMain }, state) => {
        ipcMain.removeHandler("setup:state");
        ipcMain.handle("setup:state", () => state);
      },
      { ...state, themes: { ...state.themes, interface: [{ id: "user:extended.json", theme }] } },
    );
    assert.equal(
      await page.evaluate(() =>
        window.desktop.setupState().then(
          () => false,
          () => true,
        ),
      ),
      true,
      "Malformed theme replies reject at the real board bridge",
    );
  }
});

test("sample user themes paint visible sidebar and board gradients in light and dark", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-gradient-samples-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "repository", home: root });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await sizeTileBoard(app, page, 1200, 800);
  for (const base of ["dark", "light"]) {
    const text = await readFile(
      path.join(__dirname, `../fixtures/themes/gradient-${base}.json`),
      "utf8",
    );
    const sample = JSON.parse(text);
    await writeFile(path.join(root, `.foom/config/themes/gradient-${base}.json`), text);
    await openSettingsScreen(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await chooseTheme(page, sample.name);
    await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
    const [first, second] =
      base === "dark" ? ["0, 60, 82", "71, 22, 79"] : ["144, 233, 242", "229, 181, 252"];
    const gradient = (angle, start, end) =>
      expect.stringMatching(
        new RegExp(
          String.raw`^linear-gradient\(${angle}deg(?: in srgb)?, rgb\(${start}\) 0%, rgb\(${end}\) 100%\)$`,
        ),
      );
    // Both palettes use the same angles. Wait for the selected colors to reach both surfaces.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const backgroundImage = (selector) => {
              const element = document.querySelector(selector);
              return element ? getComputedStyle(element).backgroundImage : null;
            };
            return {
              palette: document.documentElement.style.colorScheme,
              sidebar: backgroundImage(".sidebar-shell"),
              board: backgroundImage(".tile-area"),
            };
          }),
        { message: `${sample.name} after ${previousTest ?? "no earlier test in this worker"}` },
      )
      .toEqual({
        palette: base,
        sidebar: gradient(160, first, second),
        board: gradient(125, second, first),
      });
    await expect(page.locator(".tile-area")).toBeVisible();
    await expect(page.locator(".xterm:visible")).toHaveCount(0);
    await assertAccessible(page);
    await page.screenshot({
      path: evidencePath(`1188-gradient-visible-${base}.png`),
      animations: "disabled",
    });
  }
});

test("nested theme inks stay readable over parent gradients and trusted header paint", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-nested-theme-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "empty-board", home: root });
  const page = await boardPage(app);
  const dialog = await confirmationPage(app);
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const { contrast } = require("../../build/shared/theme-colors.js");
  const light = interfaceThemes["eclipse-light"].colors;
  const header = {
    ...light,
    bg: "#ffffff",
    gradient: {
      angle: 0,
      stops: [
        ["#ffffff", 0],
        ["#ffffff", 100],
      ],
    },
  };
  const sample = {
    ...interfaceThemes["eclipse-dark"],
    version: 2,
    name: "Nested palette",
    areas: { titlebar: header },
  };
  const file = path.join(root, ".foom/config/themes/nested.json");
  await writeFile(file, JSON.stringify(sample));
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await chooseTheme(page, sample.name);
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect(page.locator(".board-top")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".wordmark-menu")).toHaveCSS("color", "rgb(20, 16, 31)");
  assert.ok(
    contrast("#f4efff", "#ffffff") < 1.13,
    "Original white-on-white reproduction is unreadable",
  );
  await writeFile(
    file,
    JSON.stringify({ ...sample, areas: { ...sample.areas, wordmark: { ink: "#f4efff" } } }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.desktop.setupState()).themes.errors.find(
            (entry) => entry.file === "nested.json",
          )?.reason,
      ),
    )
    .toBe("contrast");
  await expect(page.locator(".wordmark-menu")).toHaveCSS("color", "rgb(20, 16, 31)");
  await app.evaluate(
    ({ BrowserWindow }, theme) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://confirmation/confirmation.html")
        .webContents.send("confirmation:render", {
          id: "header-ink-regression",
          title: "Header palette regression",
          accept: "Continue",
          presented: false,
          theme,
        });
    },
    { ...sample, areas: { "dialog-headers": header } },
  );
  // This main-authored render fixture is deliberately hidden and grants no native consent.
  // Read computed styles without a locator action that expects a presented native dialog.
  await expect
    .poll(() =>
      dialog.evaluate(() => {
        const header = document.querySelector(".dlg-head");
        const title = document.querySelector(".dlg-head h1");
        return header && title
          ? {
              background: getComputedStyle(header).backgroundColor,
              ink: getComputedStyle(title).color,
            }
          : null;
      }),
    )
    .toEqual({ background: "rgb(255, 255, 255)", ink: "rgb(20, 16, 31)" });
  assert.ok(contrast(light.ink, "#ffffff") >= 4.5);
});

test("theme artwork paints separate empty regions and tile headers with a narrow CSP", {
  timeout: deadline(45000),
}, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "foom-theme-bitmaps-"));
  removeAfterApps(context, home);
  const app = await launchApp(context, { fixture: "empty-board", home });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await sizeTileBoard(app, page, 1200, 800);
  const fixturePrompt = "fixture>";
  await app.evaluate(({ app }, prompt) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { TerminalHostClient } = load("./build/main/terminals/terminal-host-client.js");
    const create = TerminalHostClient.prototype.create;
    const home = app.getPath("home");
    const windows = process.platform === "win32";
    TerminalHostClient.prototype.create = function (spec) {
      if (
        !spec.shellIntegration ||
        spec.remote ||
        spec.cwd !== home ||
        process.env.HOME !== home ||
        spec.command !== (windows ? "powershell.exe" : process.env.SHELL)
      )
        throw new Error("Expected the local test shell in the fixture home");
      // The harness shell stays alive on the PTY while the test places its tile.
      // Print the fixture text ourselves so no startup file or shell prompt can
      // add account, machine or platform-specific text to a capture.
      return create.call(this, {
        ...spec,
        shellIntegration: false,
        args: windows
          ? [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "[Console]::Clear(); [Console]::Write($env:FIXTURE_PROMPT + ' '); [void][Console]::ReadLine()",
            ]
          : [
              "--norc",
              "-c",
              String.raw`printf '\033[2J\033[H%s ' "$FIXTURE_PROMPT"; IFS= read -r fixture_input`,
            ],
        env: {
          ...spec.env,
          HOME: home,
          USERPROFILE: home,
          PATH: process.env.PATH,
          FIXTURE_PROMPT: prompt,
          HISTFILE: "",
          BASH_ENV: "",
          ENV: "",
        },
      });
    };
  }, fixturePrompt);
  const sharp = require("sharp");
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const themes = path.join(home, ".foom/config/themes");
  const bitmap = async (slot, color, base) => {
    const width = slot === "sidebar" ? 160 : 640;
    const height = slot === "sidebar" ? 168 : slot === "header" ? 36 : 420;
    const orbit = `<ellipse cx="80" cy="60" rx="59" ry="24" transform="rotate(-24 80 60)"/>
        <ellipse cx="80" cy="60" rx="59" ry="24" transform="rotate(24 80 60)"/>
        <circle cx="80" cy="60" r="22" fill="${color}" fill-opacity=".3"/>
        <path d="M80 30v60M50 60h60" stroke-dasharray="2 4"/>`;
    const field = `<path d="M33 71 56 35l49 10 22 40-51 5Z M33 71l72-26m-49-10 20 55m0 0 29-45" stroke-dasharray="2 3"/>
        <g fill="${color}"><circle cx="33" cy="71" r="3"/><circle cx="56" cy="35" r="2"/>
        <circle cx="105" cy="45" r="4"/><circle cx="127" cy="85" r="2"/><circle cx="76" cy="90" r="3"/></g>`;
    const header = `<path d="M-4 26Q100 9 210 24T433 13 640 19M-5 34Q100 14 207 29T430 19 645 23M-10 42Q100 21 201 34T428 25 650 27" stroke-opacity=".8"/>
        <path d="M240 13h65m59 17h74m110-21h51" stroke-opacity=".5" stroke-dasharray="2 6"/>`;
    const svg =
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${slot === "header" ? "0 0 640 36" : "0 0 160 120"}">
      <g fill="none" stroke="${color}" stroke-width="1.5">
        ${slot === "header" ? header : slot === "field" ? field : orbit}
      </g>
    </svg>`);
    await sharp(svg)
      .withExif({ IFD0: { Artist: "Private source metadata" } })
      .png()
      .toFile(path.join(themes, `${base}-${slot}.png`));
  };
  for (const base of ["light", "dark"]) {
    for (const [slot, color] of Object.entries(
      base === "light"
        ? { orbit: "#35218a", field: "#005975", sidebar: "#075f79", header: "#35218a" }
        : { orbit: "#a2baff", field: "#74ecd8", sidebar: "#8eb6ff", header: "#a2baff" },
    ))
      await bitmap(slot, color, base);
    await writeFile(
      path.join(themes, `bitmap-${base}.json`),
      JSON.stringify({
        ...interfaceThemes[`eclipse-${base}`],
        version: 2,
        name: `Bitmap ${base}`,
        images: {
          empty: { files: [`${base}-orbit.png`, `${base}-field.png`], opacity: 0.6 },
          "tile-header": { file: `${base}-header.png`, opacity: 0.6, fit: "cover" },
          sidebar: { file: `${base}-sidebar.png`, opacity: 0.55, anchor: "bottom" },
        },
      }),
    );
  }
  const tileArea = page.locator(".tile-area");
  const select = async (base) => {
    await openSettingsScreen(page);
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await chooseTheme(page, `Bitmap ${base}`);
    await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-bitmaps",
      "empty sidebar tile-header",
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe(base);
  };
  const slots = () =>
    page.evaluate(async () => (await window.desktop.setupState()).themes.activeBitmaps.slots);
  const capture = async (target, label) =>
    target.screenshot({
      path: evidencePath(`screenshots-1367/${label}.png`),
      animations: "disabled",
      // Fixture paths can contain an account name on some platforms.
      style: ".tile-location { display: none; }",
    });
  const source = (paint) => `foom-theme://bitmap/${paint.id}`;
  const paintsImage = (url) =>
    page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      try {
        await image.decode();
        return image.naturalWidth > 0;
      } catch {
        return false;
      }
    }, url);

  await select("light");
  const oldBoard = source((await slots()).empty[0]);
  const policyPage = await confirmationPage(app);
  const csp = (target) =>
    target.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  const confirmationPolicy = await csp(policyPage);
  assert.match(confirmationPolicy, /; img-src 'self';/u);
  assert.equal(
    await csp(page),
    confirmationPolicy.replace("img-src 'self';", "img-src 'self' foom-theme://bitmap data:;"),
  );
  const previewPng = (
    await sharp({ create: { width: 1, height: 1, channels: 3, background: "#3366bb" } })
      .png()
      .toBuffer()
  ).toString("base64");
  assert.equal(await paintsImage(`data:image/png;base64,${previewPng}`), true);
  const violations = [];
  await page.exposeFunction("captureThemeCspViolation", (uri) =>
    violations.push(uri.split(":")[0]),
  );
  await page.evaluate(async (png) => {
    const blob = URL.createObjectURL(
      new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], { type: "image/png" }),
    );
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective === "img-src")
        void window.captureThemeCspViolation(event.blockedURI);
    });
    try {
      await Promise.all(
        [
          blob,
          "file:///bitmap.png",
          "https://theme-test.invalid/art.png",
          "foom-theme://unapproved/anything",
        ].map(async (url) => {
          const image = new Image();
          image.src = url;
          await image.decode().then(
            () => {
              throw Error("CSP unexpectedly loaded a source");
            },
            () => {},
          );
        }),
      );
    } finally {
      URL.revokeObjectURL(blob);
    }
  }, previewPng);
  // Chromium can reject file URLs before dispatching a policy violation.
  await expect
    .poll(() => [...new Set(violations.filter((uri) => uri !== "file"))].sort())
    .toEqual(["blob", "foom-theme", "https"]);
  assert.equal(await paintsImage(oldBoard), true);
  assert.equal(await paintsImage(`foom-theme://bitmap/${"0".repeat(64)}`), false);
  const delivered = await app.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url);
    return [...new Uint8Array(await response.arrayBuffer())];
  }, oldBoard);
  const normalized = await sharp(Buffer.from(delivered)).metadata();
  assert.equal(normalized.format, "png");
  assert.equal(normalized.exif, undefined);
  assert.doesNotMatch(JSON.stringify(await slots()), /\.png|Private source metadata/u);

  const spaces = page.locator('.terminal-tile[data-empty="true"]');
  const emptyArt = spaces.locator('[data-theme-art="empty"]');
  const header = page.locator(".tile-title");
  const terminal = tileArea.locator(".xterm:visible");
  const paint = (target) => target.evaluate((element) => getComputedStyle(element).backgroundImage);
  const opaque = (target) =>
    target.evaluate((element) => /^rgb\(/u.test(getComputedStyle(element).backgroundColor));

  for (const base of ["light", "dark"]) {
    if (base === "dark") await select(base);
    const images = await slots();
    assert.equal(images.empty.length, 2);
    for (const piece of [...images.empty, ...images.sidebar, ...images["tile-header"]])
      assert.equal(await paintsImage(source(piece)), true);
    await expect(emptyArt).toHaveCount(1);
    const blankPaint = await paint(emptyArt);
    assert.ok(images.empty.some((piece) => blankPaint === `url("${source(piece)}")`));
    await expect(page.locator(".sidebar-bitmap")).toHaveCSS(
      "background-image",
      `url("${source(images.sidebar[0])}")`,
    );
    await capture(page, `blank-${base}`);

    await page.getByRole("button", { name: "Actions for Home shell", exact: true }).press("Enter");
    await page.getByRole("menuitem", { name: "New shell", exact: true }).press("Enter");
    await expect(page.getByRole("button", { name: "Tile 1 menu", exact: true })).toBeEnabled();
    await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
    await expect(spaces).toHaveCount(1);
    await page.evaluate(() => window.desktop.appMenu.execute("split-down"));
    await expect(spaces).toHaveCount(2);
    const regions = await emptyArt.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const tile = element.parentElement.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          contained:
            box.left >= tile.left &&
            box.top >= tile.top &&
            box.right <= tile.right &&
            box.bottom <= tile.bottom,
          image: style.backgroundImage,
          fit: style.backgroundSize,
          anchor: style.backgroundPosition,
          pointerEvents: style.pointerEvents,
        };
      }),
    );
    assert.equal(regions.length, 2);
    assert.notDeepEqual([regions[0].x, regions[0].y], [regions[1].x, regions[1].y]);
    for (const region of regions) {
      assert.ok(region.contained && region.width > 0 && region.height > 0);
      assert.equal(region.fit, "contain");
      assert.equal(region.anchor, "50% 50%");
      assert.equal(region.pointerEvents, "none");
      assert.ok(images.empty.some((piece) => region.image === `url("${source(piece)}")`));
    }
    const seam = tileArea.locator(".tile-gutter-art").first();
    await expect(seam).toBeVisible();
    const stable = [...regions.map((region) => region.image), await paint(seam)];
    await page.getByRole("separator", { name: "Resize tiles" }).first().press("ArrowRight");
    assert.deepEqual(
      [await paint(emptyArt.first()), await paint(emptyArt.last()), await paint(seam)],
      stable,
    );

    const titleArt = header.locator('[data-theme-art="tile-header"]');
    await expect(titleArt).toHaveCSS(
      "background-image",
      `url("${source(images["tile-header"][0])}")`,
    );
    await expect(titleArt).toHaveCSS("pointer-events", "none");
    for (const selector of [".tile-number", ".tile-controls", ".tile-light-backing"])
      assert.equal(await opaque(header.locator(selector)), true);

    await expect(terminal).toHaveCount(1);
    await expect
      .poll(async () => (await terminal.locator(".xterm-rows").textContent())?.trim())
      .toBe(fixturePrompt);
    await expect(terminal.locator("[data-theme-art]")).toHaveCount(0);
    await expect(terminal.locator(".xterm-screen")).toHaveCSS("background-image", "none");
    await header.click();
    await capture(page, `tiles-${base}`);
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(spaces).toHaveCount(3);
    for (const remaining of [2, 1]) {
      await spaces.first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Close space", exact: true }).click();
      await expect(spaces).toHaveCount(remaining);
    }
  }

  assert.equal(await paintsImage(oldBoard), false);
  await rm(path.join(themes, "dark-orbit.png"));
  await rm(path.join(themes, "dark-field.png"));
  await expect(page.locator("html")).toHaveAttribute("data-theme-bitmaps", "sidebar tile-header");
  await expect(emptyArt).toHaveCount(0);
});
