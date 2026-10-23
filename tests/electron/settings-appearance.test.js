const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  launchApp,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

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

  await page.getByRole("radio", { name: "Dark" }).check();
  // Media emulation from the loop above can linger; wait for the saved source itself.
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  await expect.poll(dark).toBe(true);
  await expect.poll(background).toBe("rgb(5, 4, 10)");
  await assertAccessible(page);
  await page.getByRole("radio", { name: "Light" }).check();
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
    await page.getByRole("button", { name: "Themes", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
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
      const selected = document.querySelector(
        '.interface-theme-choices button[aria-pressed="true"]',
      );
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
        selection: getComputedStyle(selected).outlineColor,
        swatch: getComputedStyle(selected.querySelectorAll("i")[3]).backgroundColor,
        working: getComputedStyle(working).backgroundColor,
        brand: getComputedStyle(document.querySelector(".wordmark")).color,
        inkRgb: cssColor(root.getPropertyValue("--ink").trim()),
      };
    });
    assert.equal(colors.highlight, expectedHighlight ?? colors.accent);
    assert.equal(colors.selection, colors.highlightRgb);
    assert.equal(colors.swatch, colors.highlightRgb);
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
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  await page.getByRole("button", { name: /^System/ }).click();
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
  await page.getByRole("button", { name: "High Contrast", exact: true }).click();
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
          path: path.join(
            __dirname,
            `../../test-results/badges-${colorScheme}-${interfaceScale}.png`,
          ),
        });
    }
  }
  await page.evaluate(() => window.desktop.saveSetup({ interfaceScale: 100 }));
  await assertAccessible(page);
});

test("custom theme files appear live, update selected colors and retain rejected edits", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-custom-theme-"));
  removeAfterApps(context, root);
  const app = await launchApp(context, { fixture: "empty-board", home: root });
  const page = await boardPage(app);
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const { terminalThemes, ansiNames } = require("../../build/shared/terminal-themes.js");
  const file = path.join(root, ".foom/config/themes/custom.json");
  const palette = interfaceThemes["eclipse-dark"];
  const theme = { kind: "theme", name: "Live custom", base: palette.base, colors: palette.colors };
  await writeFile(file, JSON.stringify(theme));
  await page.getByRole("button", { name: "Live custom", exact: true }).click();
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
  await page.getByRole("button", { name: "Themes", exact: true }).click();
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
  await page.getByRole("button", { name: "Live terminal", exact: true }).click();
  const choicesBounds = await page.getByRole("group", { name: "Terminal colors" }).boundingBox();
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
  await page.screenshot({ path: path.join(__dirname, "../../test-results/custom-theme.png") });
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
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  await page.getByRole("button", { name: "Personal v2", exact: true }).click();
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
  await page.getByRole("button", { name: "Tile 1 menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
  await page.evaluate(() => window.desktop.sidebarCommand({ kind: "config-launch", run: "shell" }));
  await page.locator(".config-dock .board-row").press("Enter");
  await expect(page.locator(".xterm-rows:visible")).toHaveCount(2);
  await expect(page.locator(".xterm-helper-textarea").last()).toBeFocused();
  const ids = await page.evaluate(async () =>
    (await window.desktop.workspace()).terminals.map((entry) => entry.id),
  );
  assert.equal(ids.length, 2);
  await app.evaluate(({ ipcMain }) => {
    global.fontResizes = [];
    ipcMain.on("terminal:resize", (_event, id, cols, rows) =>
      global.fontResizes.push({ id, cols, rows }),
    );
    // OS enumeration may legitimately return [] (including after its bounded
    // PowerShell timeout). Exercise font changes with a font bundled on every OS.
    ipcMain.removeHandler("setup:terminal-fonts");
    ipcMain.handle("setup:terminal-fonts", () => ["Geist Mono"]);
  });
  await openSettingsScreen(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Terminal", exact: true })
    .click();
  const picker = page.getByLabel("Terminal font", { exact: true });
  const family = "Geist Mono";
  await expect(picker.getByRole("option", { name: family, exact: true })).toHaveCount(1);
  await picker.selectOption(family);
  const stack = `"${family}", "Hack Nerd Font Mono", "Geist Mono", monospace`;
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFont),
    )
    .toBe(family);
  await page.getByRole("button", { name: "Themes", exact: true }).click();
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
  await expect(picker).toHaveValue(family);
  await picker.selectOption("Hack Nerd Font Mono");
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
