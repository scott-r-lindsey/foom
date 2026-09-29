const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { _electron: electron } = require("@playwright/test");

test("terminal runs an interactive shell behind an isolated bridge", {
  timeout: 60_000,
}, async (context) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    chromiumSandbox: true,
    colorScheme: null,
    args: [path.join(__dirname, "..")],
    env,
  });
  const child = app.process();
  const abort = () => {
    child.kill();
  };
  context.signal.addEventListener("abort", abort, { once: true });
  console.info("Electron launched");
  try {
    const page = await app.firstWindow();
    console.info("Window opened");
    page.setDefaultTimeout(15_000);
    await page.waitForLoadState("domcontentloaded");
    assert.equal(await page.title(), "Foom");
    await page.waitForFunction(
      () => !document.querySelector("#status").textContent.includes("Starting"),
    );
    console.info("Shell started");
    assert.doesNotMatch(await page.locator("#status").innerText(), /Unable/);
    await page.evaluate(() => {
      window.terminalOutput = "";
      window.desktop.onData((data) => {
        window.terminalOutput += data;
      });
    });
    const input = page.locator(".xterm-helper-textarea");
    await input.focus();
    // The output marker is not present in the echoed command itself.
    const command =
      process.platform === "win32"
        ? 'Write-Output ("FOOM_" + "SHELL_OK")'
        : "printf 'FOOM_%s\\n' SHELL_OK";
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.terminalOutput.includes("FOOM_SHELL_OK"));
    console.info("Shell command returned");
    if (process.platform !== "win32") {
      const readSize = async (label) => {
        await page.keyboard.type(`printf 'SIZE_%s:' ${label}; stty size`);
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          (name) => new RegExp(`SIZE_${name}:\\d+ \\d+`).test(window.terminalOutput),
          label,
        );
        return page.evaluate(
          (name) =>
            window.terminalOutput
              .match(new RegExp(`SIZE_${name}:(\\d+) (\\d+)`))
              .slice(1)
              .map(Number),
          label,
        );
      };
      const before = await readSize("BEFORE");
      const screen = await page.locator(".xterm-screen").boundingBox();
      assert.ok(screen);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setSize(1100, 750),
      );
      await page.waitForFunction((previous) => {
        const current = document.querySelector(".xterm-screen").getBoundingClientRect();
        return current.width > previous.width && current.height > previous.height;
      }, screen);
      const after = await readSize("AFTER");
      assert.ok(after[0] > before[0], `PTY rows grow with the window: ${before} -> ${after}`);
      assert.ok(after[1] > before[1], `PTY columns grow with the window: ${before} -> ${after}`);
      // Print the marker last so the next command isn't typed while this one is still running.
      await page.keyboard.type(
        "test -t 0 && test -t 1 && stty size >/dev/null && printf 'FOOM_%s\\n' TTY_OK",
      );
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.terminalOutput.includes("FOOM_TTY_OK"));
      // exec keeps one process, so once the marker prints, sleep is the foreground job that
      // receives Ctrl+C. Pressing it earlier can signal the shell before sleep starts.
      await page.keyboard.type("sh -c 'printf \"FOOM_%s\\n\" SLEEPING; exec sleep 30'");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.terminalOutput.includes("FOOM_SLEEPING"));
      await page.keyboard.press("Control+c");
      await page.keyboard.type("printf 'FOOM_%s\\n' INTERRUPTED");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.terminalOutput.includes("FOOM_INTERRUPTED"));
    }
    if (process.platform !== "win32") {
      await page.evaluate(() => {
        window.terminalOutput = "";
      });
      await page.keyboard.type("vim -Nu NONE -n -i NONE");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.terminalOutput.includes("[?1049h"));
      await page.keyboard.type("ihello terminal");
      await page.keyboard.press("Control+w");
      await page.keyboard.press("Escape");
      await page.keyboard.type(":q!");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.terminalOutput.includes("[?1049l"));
      await page.evaluate(() => {
        window.terminalOutput = "";
      });
      await page.keyboard.type("top");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => /Tasks:|Processes:/.test(window.terminalOutput));
      await page.keyboard.type("q");
      await page.keyboard.type("printf 'FOOM_%s\\n' FULLSCREEN_OK");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.terminalOutput.includes("FOOM_FULLSCREEN_OK"));
    }
    assert.deepEqual(
      await page.evaluate(() => ({
        node: typeof window.require,
        process: typeof window.process,
        capabilities: Object.keys(window.desktop),
      })),
      {
        node: "undefined",
        process: "undefined",
        capabilities: ["start", "input", "resize", "acknowledge", "onData", "onExit"],
      },
    );
    console.info("Renderer isolated");
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const { sandbox, contextIsolation, nodeIntegration } =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox, contextIsolation, nodeIntegration };
    });
    assert.deepEqual(preferences, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    assert.equal(
      await app.evaluate(async ({ net }) => (await net.fetch("app://bundle/main.js")).status),
      404,
    );
    await page.evaluate(() => window.open("https://example.com"));
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
    );
    console.info("Security checks passed");
    await input.focus();
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: "Shell exited" }).waitFor();
    console.info("Shell exited");
    await page.getByRole("button", { name: "Restart shell" }).click();
    await page.waitForFunction(
      () => !/Starting|exited|Unable/.test(document.querySelector("#status").textContent),
    );
    console.info("Shell restarted");
  } catch (error) {
    const pages = app.windows();
    if (pages[0])
      console.error(
        "Terminal failure state:",
        await pages[0].evaluate(() => ({
          status: document.querySelector("#status")?.textContent,
          output: window.terminalOutput,
        })),
      );
    throw error;
  } finally {
    console.info("Closing app");
    await app.close();
    console.info("App closed");
    context.signal.removeEventListener("abort", abort);
  }
});

test("bundled brand fonts and both system themes render in Electron", {
  timeout: 60_000,
}, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    chromiumSandbox: true,
    colorScheme: null,
    args: [path.join(__dirname, "..")],
    env,
  });
  try {
    const page = await app.firstWindow();
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
      await app.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme;
      }, mode);
      await page.waitForFunction(
        (dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark,
        mode === "dark",
      );
      const background = mode === "dark" ? "rgb(5, 4, 10)" : "rgb(243, 240, 250)";
      await page.waitForFunction(
        (expected) =>
          getComputedStyle(document.querySelector(".xterm-scrollable-element")).backgroundColor ===
          expected,
        background,
      );
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
          displayFont: getComputedStyle(document.querySelector("strong")).fontFamily,
          terminalFont: getComputedStyle(document.querySelector(".xterm-rows")).fontFamily,
          background: style.backgroundColor,
          csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
        };
      });
      assert.deepEqual(rendered.tokens, palettes[mode]);
      assert.deepEqual(rendered.fonts, [true, true, true, true]);
      assert.match(rendered.bodyFont, /Geist/);
      assert.match(rendered.displayFont, /Archivo Black/);
      assert.match(rendered.terminalFont, /Geist Mono/);
      assert.equal(rendered.background, background);
      assert.match(rendered.csp, /font-src 'self';/);
      assert.match(rendered.csp, /default-src 'none';/);
      await page.screenshot({ path: path.join(__dirname, "..", "out", `brand-${mode}.png`) });
    }
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
  } finally {
    await app.close();
  }
});
