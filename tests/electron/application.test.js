const { assertBundledTerminalFonts } = require("./font-checks.js");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readFile, mkdir } = require("node:fs/promises");
const { deadline, expect } = require("./test-policy.js");
const { assertAccessible, boardPage, launchApp, launchCheckoutShell } = require("./harness.js");

test("shared board startup restores a native-hidden CDP-visible board and delivers frames", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .hide();
  });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .isVisible(),
    ),
    false,
  );
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getBackgroundThrottling(),
    ),
    false,
    "Board painting must remain enabled across native occlusion transitions",
  );
  await page.bringToFront();
  await expect
    .poll(() => page.evaluate(() => document.visibilityState === "visible" && document.hasFocus()))
    .toBe(true);
  // Require frames while still native-hidden as well as after the shared show.
  // A visible document alone cannot establish that the compositor is running.
  const frame = await page.evaluateHandle(() => {
    const state = { delivered: false, id: 0 };
    state.id = requestAnimationFrame(() => {
      state.delivered = true;
    });
    return state;
  });
  try {
    await expect.poll(() => frame.evaluate((state) => state.delivered)).toBe(true);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "app://bundle/index.html")
          .isVisible(),
      ),
      false,
      "A hidden board must deliver frames without a native show",
    );
  } finally {
    await frame.evaluate((state) => cancelAnimationFrame(state.id));
    await frame.dispose();
  }
  assert.equal(await boardPage(app), page);
  await launchCheckoutShell(app, page);
  await expect(page.locator(".xterm-rows")).toContainText(
    process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/,
  );
});

test("bundled brand fonts and both system themes render in Electron", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.waitForLoadState("domcontentloaded");
  const palettes = {
    dark: [
      "#05040A",
      "#0D0A17",
      "#251D3F",
      "#F4EFFF",
      "#9D93BD",
      "#9B6BFF",
      "#7A3CFF",
      "#FFB23E",
      "#6FE0A3",
      "#FF2E88",
      "#06050B",
    ],
    light: [
      "#F3F0FA",
      "#E9E4F5",
      "#DDD6EE",
      "#14101F",
      "#625A7A",
      "#5B2BD9",
      "#3B1A99",
      "#D98200",
      "#13804A",
      "#D6166E",
      "#06050B",
    ],
  };
  for (const mode of ["dark", "light", "dark"]) {
    const background = mode === "dark" ? "rgb(5, 4, 10)" : "rgb(243, 240, 250)";
    // Use the same setting path as Appearance. It updates nativeTheme/host OSCs
    // and publishes setup:changed, so attachInterfaceTheme applies immediately.
    // CDP media emulation queues a separate frame-dependent change event and can
    // leave the media input and applied palette disagreeing on an idle display.
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
    try {
      // A matching media query is input, not acknowledgement from either listener.
      // Observe both rendered backgrounds and the complete interface palette in one
      // snapshot before inspecting fonts; separate waits can accept different frames.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return {
              dark: matchMedia("(prefers-color-scheme: dark)").matches,
              scheme: document.documentElement.style.colorScheme,
              background: style.backgroundColor,
              terminalBackground: getComputedStyle(
                document.querySelector(".xterm-scrollable-element"),
              ).backgroundColor,
              tokens: [
                "bg",
                "surface",
                "line",
                "ink",
                "muted",
                "accent",
                "accent-deep",
                "attention",
                "done",
                "failed",
                "hole",
              ].map((name) => style.getPropertyValue(`--${name}`).trim().toUpperCase()),
            };
          }),
        )
        .toEqual({
          dark: mode === "dark",
          scheme: mode,
          background,
          terminalBackground: background,
          tokens: palettes[mode],
        });
    } catch (error) {
      console.error("System theme application diagnostics:", {
        requested: mode,
        renderer: await page.evaluate(async (mode) => {
          const root = document.documentElement;
          const style = getComputedStyle(root);
          const { settings } = await window.desktop.setupState();
          return {
            pendingStep:
              settings.colorMode !== mode
                ? "setup persistence"
                : root.style.colorScheme !== mode
                  ? "attachInterfaceTheme setup:changed application"
                  : matchMedia("(prefers-color-scheme: dark)").matches !== (mode === "dark")
                    ? "nativeTheme media propagation"
                    : "rendered interface/terminal palette",
            mediaDark: matchMedia("(prefers-color-scheme: dark)").matches,
            appliedScheme: root.style.colorScheme,
            themeReady: root.dataset.themeReady,
            background: style.backgroundColor,
            tokenBackground: style.getPropertyValue("--bg"),
            terminalBackground: getComputedStyle(
              document.querySelector(".xterm-scrollable-element"),
            ).backgroundColor,
            colorMode: settings.colorMode,
            interfaceTheme: settings.interfaceTheme,
            visibility: document.visibilityState,
            focused: document.hasFocus(),
          };
        }, mode),
        host: await app.evaluate(({ nativeTheme }) => ({
          source: nativeTheme.themeSource,
          dark: nativeTheme.shouldUseDarkColors,
        })),
      });
      throw error;
    }
    const rendered = await page.evaluate(async () => {
      const style = getComputedStyle(document.documentElement);
      const families = ["Archivo Black", "Courier Prime", "Geist", "Geist Mono"];
      const fonts = await Promise.all(
        families.map(async (family) => {
          const faces = await document.fonts.load(`14px "${family}"`);
          return faces.length > 0 && faces.every((face) => face.status === "loaded");
        }),
      );
      return {
        tokens: [
          "bg",
          "surface",
          "line",
          "ink",
          "muted",
          "accent",
          "accent-deep",
          "attention",
          "done",
          "failed",
          "hole",
        ].map((name) => style.getPropertyValue(`--${name}`).trim().toUpperCase()),
        fonts,
        bodyFont: getComputedStyle(document.body).fontFamily,
        displayFont: getComputedStyle(document.querySelector(".wordmark")).fontFamily,
        terminalFont: getComputedStyle(document.querySelector(".xterm-rows")).fontFamily,
        background: style.backgroundColor,
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      };
    });
    assert.deepEqual(rendered.tokens, palettes[mode]);
    assert.deepEqual(rendered.fonts, [true, true, true, true]);
    assert.match(rendered.bodyFont, /Geist/);
    assert.match(rendered.displayFont, /Archivo Black/);
    await expect(page.getByRole("button", { name: "Foom menu" })).toHaveText("foom");
    assert.match(rendered.terminalFont, /^"Hack Nerd Font Mono", "Geist Mono"/);
    assert.equal(rendered.background, background);
    assert.match(rendered.csp, /font-src 'self';/);
    assert.match(rendered.csp, /default-src 'none';/);
  }
  await assertBundledTerminalFonts(page);
  for (const asset of ["archivo-black", "courier-prime", "geist", "geist-mono"]) {
    assert.equal(
      await app.evaluate(
        async ({ net }, name) => (await net.fetch(`app://bundle/fonts/${name}.ttf`)).status,
        asset,
      ),
      200,
    );
  }
  assert.equal(
    await app.evaluate(
      async ({ net }) => (await net.fetch("app://bundle/fonts/unknown.ttf")).status,
    ),
    404,
  );
});

test("renderer bundle contains production React without a Node process dependency", async () => {
  const bundle = await readFile(path.join(__dirname, "../../build/renderer/renderer.js"), "utf8");
  assert.doesNotMatch(bundle, /fix\/session-restore|Sample output.*read-only.*Ready to verify/);
  const ts = require("typescript");
  const source = ts.createSourceFile("renderer.js", bundle, ts.ScriptTarget.Latest, true);
  const processReferences = [];
  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === "process" &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      processReferences.push(node.pos);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(processReferences, [], "browser bundle has no Node process references");
  assert.doesNotMatch(
    bundle,
    /react(?:-dom-client)?\.development|Download the React DevTools|not wrapped in act/,
  );
});

test("About command opens the in-board art dialog and its anchored note", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.desktop.appMenu.execute("about"));
  const dialog = page.getByRole("dialog", { name: "About Foom", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("By Scott Lindsey")).toBeVisible();
  await expect(dialog.getByText("Nothing needs you. Yet.")).toBeVisible();
  await expect(dialog.locator(".about-version")).toContainText("Electron");
  assert.equal(
    await dialog.locator("canvas").evaluate((canvas) => {
      const ctx = canvas.getContext("2d");
      return (
        canvas.width > 0 &&
        canvas.height > 0 &&
        ctx
          .getImageData(0, 0, canvas.width, canvas.height)
          .data.some((value, index) => index % 4 === 3 && value > 0)
      );
    }),
    true,
    "Reduced-motion art paints after the modal has real dimensions",
  );
  const bounds = await dialog.boundingBox();
  const viewport =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  assert.ok(bounds && bounds.width > 250 && bounds.height > 200);
  assert.ok(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= viewport.width &&
      bounds.y + bounds.height <= viewport.height,
  );
  const button = dialog.getByRole("button", { name: "A note from Scott" });
  await button.click();
  const note = dialog.getByRole("dialog", { name: "A note from Scott" });
  await expect(note).toBeVisible();
  await expect(note.getByText("— Scott")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(note).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("About rocket replays launch by mouse and keyboard without changing setup", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  const initial = await page.evaluate(async () => (await window.desktop.setupState()).settings);
  const captureTime = new Date("2026-10-21T12:00:00Z");
  await page.clock.install({ time: captureTime });
  // Installing the clock starts it; leave room for Windows transport latency.
  await page.clock.pauseAt(new Date(captureTime.getTime() + 3_600_000));
  await mkdir("test-results/replay-686", { recursive: true });
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion });
    await page.evaluate(() => window.desktop.appMenu.execute("about"));
    const about = page.getByRole("dialog", { name: "About Foom", exact: true });
    const rocket = about.getByRole("button", { name: "Replay launch" });
    await expect(rocket).toHaveCSS("cursor", "crosshair");
    await expect(about.locator(".about-art")).toHaveCSS("cursor", "default");
    if (reducedMotion === "reduce") {
      await rocket.focus();
      await rocket.press("Enter");
    } else {
      await rocket.click();
    }
    const launch = page.getByRole("dialog", { name: "Launch", exact: true });
    await expect(launch).toBeVisible();
    await expect(launch).toHaveAttribute(
      "data-phase",
      reducedMotion === "reduce" ? "liftoff" : "3",
    );
    if (reducedMotion === "no-preference") {
      for (const [label, time] of [
        ["start", 0],
        ["mid", 250],
        ["end", 500],
      ]) {
        await page.locator(".launch-replay-scene").evaluate((element, currentTime) => {
          const animation = element.getAnimations()[0];
          animation.pause();
          animation.currentTime = currentTime;
        }, time);
        await page.screenshot({ path: `test-results/replay-686/iris-${label}.png` });
      }
      await page.clock.runFor(4500);
      await expect(about).not.toBeVisible();
      await expect(launch).toHaveAttribute("data-phase", "liftoff");
      await page.screenshot({ path: "test-results/replay-686/launch.png", animations: "disabled" });
      await page.clock.runFor(9400);
      await expect(launch).toHaveAttribute("data-fading", "true");
      await page.clock.runFor(200);
    } else {
      await page.clock.runFor(200);
      await expect(about).not.toBeVisible();
      await launch.press("Escape");
    }
    await expect(launch).toHaveCount(0);
    await expect(about).toHaveCount(0);
    assert.deepEqual(
      await page.evaluate(async () => (await window.desktop.setupState()).settings),
      initial,
    );
    await expect(page.locator(".board-workspace")).toBeVisible();
  }
  await page.evaluate(() => window.desktop.appMenu.execute("about"));
  await page.getByRole("button", { name: "Replay launch" }).press("Space");
  await page.getByRole("dialog", { name: "Launch", exact: true }).press("Enter");
  await expect(page.locator(".launch-replay")).toHaveCount(0);
});

test("bundled notices and licenses scroll and dismiss from About and menu commands", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  const about = page.getByRole("dialog", { name: "About Foom", exact: true });
  for (const route of ["about", "menu"]) {
    if (route === "about") {
      await page.evaluate(() => window.desktop.appMenu.execute("about"));
      await expect(about).toBeVisible();
    }
    for (const [id, title, file] of [
      ["licenses", "Licenses", "LICENSE"],
      ["notices", "Third-party notices", "build/THIRD_PARTY_NOTICES.txt"],
    ]) {
      if (route === "about") await about.getByRole("button", { name: title, exact: true }).click();
      else if (process.platform === "darwin") {
        await app.evaluate(({ Menu }, id) => {
          const menu = Menu.getApplicationMenu();
          const item = menu.getMenuItemById(id);
          item.click();
        }, id);
      } else {
        // Both native Help entries use this same main-owned command registry.
        await page.evaluate((id) => window.desktop.appMenu.execute(id), id);
      }
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      if (route === "menu") {
        await page.evaluate(() => window.desktop.appMenu.execute("about"));
        await expect(about).toBeVisible();
        await about.getByRole("button", { name: title, exact: true }).click();
        // The same document must re-enter the top layer above the newer About modal.
        await expect(dialog.locator("pre")).toBeFocused();
      }
      const text = dialog.locator("pre");
      const bundled = await readFile(path.join(__dirname, "../..", file), "utf8");
      await expect(text).toHaveText(bundled);
      if (route === "about") await assertAccessible(page);
      await text.focus();
      await text.hover();
      await page.mouse.wheel(0, 1_000_000);
      await expect
        .poll(() =>
          text.evaluate(
            (element) =>
              element.scrollHeight > element.clientHeight &&
              Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
          ),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(about).toBeVisible();
      await expect(about.getByRole("button", { name: title, exact: true })).toBeFocused();
      if (route === "menu") {
        await page.keyboard.press("Escape");
        await expect(about).toHaveCount(0);
      }
    }
    if (route === "about") {
      await page.keyboard.press("Escape");
      await expect(about).toHaveCount(0);
    }
  }
  await page.evaluate(() => window.desktop.appMenu.execute("notices"));
  const notices = page.getByRole("dialog", { name: "Third-party notices", exact: true });
  await expect(notices).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(notices).toHaveCount(0);
  await page.evaluate(() => window.desktop.appMenu.execute("licenses"));
  const licenses = page.getByRole("dialog", { name: "Licenses", exact: true });
  await expect(licenses).toBeVisible();
  await licenses.getByRole("button", { name: "Close", exact: true }).click();
  await expect(licenses).toHaveCount(0);
});
