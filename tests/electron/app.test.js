const { assertBundledTerminalFonts } = require("./font-checks.js");
const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { _electron: electron, expect } = require("@playwright/test");

async function boardCommand(app, keyCode, shift = true) {
  await app.evaluate(
    ({ BrowserWindow }, { keyCode, mac, shift }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      for (const type of ["keyDown", "keyUp"])
        contents.sendInputEvent({
          type,
          keyCode,
          modifiers: [mac ? "meta" : "control", ...(shift ? ["shift"] : [])],
        });
    },
    { keyCode, mac: process.platform === "darwin", shift },
  );
}

async function assertAccessible(page) {
  // Electron does not support Target.createTarget. This app has no cross-origin frames.
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    // PTY output has arbitrary user/agent-selected ANSI colors. Keep the app chrome
    // and xterm input in scope. Terminal output and the ANSI/style sample intentionally
    // demonstrate arbitrary palettes, including dim text.
    const results = await new AxeBuilder({ page })
      .setLegacyMode()
      .exclude(".xterm-rows")
      .exclude(".settings-terminal-preview")
      .analyze();
    assert.deepEqual(
      results.violations.filter(({ impact }) => impact === "serious" || impact === "critical"),
      [],
      `Serious or critical accessibility violations in ${colorScheme} mode`,
    );
  }
  await page.emulateMedia({ colorScheme: null });
}

// Keep the Node debugger available until PTY cleanup finishes. Pausing the final
// quit lets Playwright detach its own connection through app.close(); calling
// inspector.close() inside Electron can block while that connection is active.
async function quitAndWait(app, requestQuit) {
  await app.evaluate(({ app }) => {
    globalThis.readyToQuit = false;
    const ready = (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      app.removeListener("will-quit", ready);
      globalThis.readyToQuit = true;
    };
    app.on("will-quit", ready);
  });
  await requestQuit();
  await expect.poll(() => app.evaluate(() => globalThis.readyToQuit), { timeout: 8000 }).toBe(true);
  await app.close();
}

// A test timeout does not cancel Playwright promises or dispose native processes.
// Keep a final worker deadline so even broken cleanup cannot occupy a CI runner.
// Every launch gets its own profile. Unless a test is about first run, preflight is
// already complete so the app opens on the board.
async function prepareProfile(options) {
  const given = options.args?.find((arg) => arg.startsWith("--user-data-dir="));
  const owned = given ? undefined : await mkdtemp(path.join(tmpdir(), "foom-profile-"));
  const profile = given ? given.slice("--user-data-dir=".length) : owned;
  if (!options.firstRun) {
    await mkdir(profile, { recursive: true });
    await writeFile(
      path.join(profile, "settings.json"),
      JSON.stringify({ version: 1, settings: { setupComplete: true } }),
      { flag: "wx" },
    ).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return {
    args: [...(options.args ?? []), ...(owned ? [`--user-data-dir=${owned}`] : [])],
    cleanup: () =>
      owned ? rm(owned, { recursive: true, force: true, maxRetries: 5 }) : Promise.resolve(),
  };
}

async function launchApp(context, openShell = true, options = {}) {
  const profile = await prepareProfile(options);
  const watchdog = setTimeout(() => {
    console.error("Electron test exceeded its 60-second hard deadline; terminating worker");
    // Playwright's exit handler kills the process groups it launched.
    process.exit(1);
  }, 60_000);
  watchdog.unref();
  const env = { ...process.env, ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    chromiumSandbox: true,
    colorScheme: null,
    timeout: 15_000,
    args: [path.join(__dirname, "../.."), ...profile.args],
    env,
  });
  const child = app.process();
  app.context().setDefaultTimeout(10_000);
  app.on("console", (message) => {
    if (message.type() === "error") console.error("Electron:", message.text());
  });
  context.after(async () => {
    console.info("Closing app");
    let timer;
    try {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.equal(child.exitCode, 0, "Electron must exit normally");
        clearTimeout(watchdog);
        return;
      }
      await Promise.race([
        (async () => {
          // Cleanup uses the public quit path too, with a deterministic response.
          await app.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
            dialog.showErrorBox = (title, content) => {
              console.error(title, content);
            };
          });
          await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Electron shutdown exceeded 10 seconds")),
            10000,
          );
        }),
      ]);
      assert.equal(child.exitCode, 0, "Electron must exit normally");
      console.info("App closed");
      clearTimeout(watchdog);
    } finally {
      clearTimeout(timer);
      await profile.cleanup().catch(() => {});
      // If graceful shutdown failed, fail the test and terminate the process tree.
      // The worker watchdog remains armed in case a Playwright connection also hangs.
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          require("node:child_process").execFileSync(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { timeout: 5000 },
          );
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      }
    }
  });
  // The shell markup now arrives with React’s first commit.
  const page = await app.firstWindow();
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), {
      timeout: 10000,
    })
    .toBe(true);
  if (options.firstRun || options.emptyBoard) return app;
  await page.getByRole("button", { name: "Local shell", exact: true }).press("Enter");
  await page.locator(".board-row[data-kind='shell']").waitFor();
  // Report startup errors directly instead of timing out on a permanently disabled control.
  await expect
    .poll(() => page.locator("#status").textContent(), { timeout: 10000 })
    .not.toBe("Starting shell…");
  assert.doesNotMatch(await page.locator("#status").textContent(), /Unable|failed/);
  if (openShell) {
    // Use the board's keyboard action for setup; pointer clicks wait for layout
    // stability and can stall during the first window's startup on a CI display.
    await page.locator(".board-row[data-kind='shell']").press("Enter");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  }
  return app;
}

test("terminal runs an interactive shell behind an isolated bridge", {
  timeout: 45_000,
}, async (context) => {
  const app = await launchApp(context);
  console.info("Electron launched");
  try {
    const page = await app.firstWindow();
    console.info("Window opened");
    await page.waitForLoadState("domcontentloaded");
    assert.equal(await page.title(), "Foom");
    await page.waitForFunction(
      () => !document.querySelector("#status").textContent.includes("Starting"),
    );
    console.info("Shell started");
    assert.doesNotMatch(await page.locator("#status").innerText(), /Unable/);
    await page.evaluate(() => {
      window.terminalOutput = "";
      window.desktop.onData((_id, _token, data) => {
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
    if (process.platform === "linux" || process.platform === "win32") {
      // Select real xterm output with the mouse, then use the native clipboard shortcuts.
      const marker = page
        .locator(".xterm-rows > div")
        .filter({ hasText: /^FOOM_SHELL_OK$/ })
        .last();
      await marker.waitFor();
      const box = await marker.boundingBox();
      assert.ok(box);
      await page.mouse.dblclick(box.x + 10, box.y + box.height / 2);
      await app.evaluate(({ clipboard }) => clipboard.writeText("clipboard sentinel"));
      // Playwright's CDP keyboard path bypasses Electron's before-input-event.
      const shortcut = (keyCode) =>
        app.evaluate(({ BrowserWindow }, key) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.focus();
          for (const type of ["keyDown", "keyUp"]) {
            window.webContents.sendInputEvent({
              type,
              keyCode: key,
              modifiers: ["control", "shift"],
            });
          }
        }, keyCode);
      await shortcut("C");
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe("FOOM_SHELL_OK");
      const pasteCommand =
        process.platform === "win32"
          ? 'Write-Output ("FOOM_" + "PASTE_OK")'
          : "printf 'FOOM_%s\\n' PASTE_OK";
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasteCommand);
      await input.focus();
      await shortcut("V");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.terminalOutput.includes("FOOM_PASTE_OK"));
      console.info(`Copy/paste shortcuts passed on ${process.platform}`);
    }
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
      // Keep both sizes within the runner's display and on the same side of
      // the board's responsive breakpoint; native window managers may clamp
      // oversized requests, and switching layouts changes terminal width.
      const original = await page.locator(".xterm-screen").boundingBox();
      assert.ok(original);
      const larger = await app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const area = screen.getDisplayMatching(window.getBounds()).workAreaSize;
        const width = area.width >= 1040 ? 1000 : 700;
        const height = Math.min(650, area.height - 40);
        // Exercise PTY resizing below the normal minimum on small CI displays.
        window.setMinimumSize(0, 0);
        window.setSize(width - 100, height - 150);
        return { width, height };
      });
      await page.waitForFunction(
        (height) => document.querySelector(".xterm-screen").getBoundingClientRect().height < height,
        original.height,
      );
      const before = await readSize("BEFORE");
      const screen = await page.locator(".xterm-screen").boundingBox();
      assert.ok(screen);
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
        larger,
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
    assert.deepEqual(
      await page.evaluate(() => ({
        node: typeof window.require,
        process: typeof window.process,
        capabilities: Object.keys(window.desktop),
      })),
      {
        node: "undefined",
        process: "undefined",
        capabilities: [
          "onBoardCommand",
          "create",
          "attach",
          "detach",
          "kill",
          "input",
          "resize",
          "acknowledge",
          "tail",
          "onActivity",
          "onWorkspaceChange",
          "startWorktree",
          "removeWorktree",
          "sidebarInventory",
          "sidebarCommand",
          "workspace",
          "addRepository",
          "worktrees",
          "createWorktree",
          "scanAgents",
          "launchAgent",
          "setupState",
          "saveSetup",
          "setInferenceKey",
          "removeInferenceKey",
          "checkInference",
          "cancelInferenceCheck",
          "localModels",
          "codeSuggestions",
          "scanCode",
          "applyRepositories",
          "onSetupChange",
          "feedback",
          "onState",
          "onData",
          "onExit",
        ],
      },
    );
    await page.evaluate(() => {
      window.activityBatches = [];
      window.stopActivity = window.desktop.onActivity((batch) =>
        window.activityBatches.push(batch),
      );
    });
    // The real renderer must not duplicate main's protocol response.
    // PowerShell needs the call operator to execute a quoted executable path.
    const probeCommand = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "protocol-probe.js")}"`;
    await page.keyboard.type(probeCommand);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.terminalOutput.includes("PROTOCOL_OK"));
    await page.waitForFunction(() =>
      window.activityBatches.some((batch) =>
        batch.some(({ id, rate }) => typeof id === "string" && rate > 0),
      ),
    );
    await page.evaluate(() => window.stopActivity());
    assert.ok(!(await page.evaluate(() => window.terminalOutput.includes("PROTOCOL_FAIL"))));
    // A second PTY stays detached while emitting well beyond the view high-water mark.
    // Reattachment must restore the final marker from main-owned headless state.
    const detached = await page.evaluate(async () => {
      const terminal = await window.desktop.create(80, 24);
      window.detachedOutput = "";
      window.detachedChunks = 0;
      window.detachedExited = false;
      window.desktop.onExit((id, code) => {
        if (id === terminal.id && code === 0) window.detachedExited = true;
      });
      window.desktop.onData((id, token, data) => {
        if (id !== terminal.id) return;
        window.detachedOutput += data;
        window.detachedChunks++;
        window.desktop.acknowledge(id, token, data.length);
      });
      await window.desktop.attach(terminal.id);
      await window.desktop.detach(terminal.id);
      window.detachedChunks = 0;
      return terminal.id;
    });
    const flood =
      process.platform === "win32"
        ? '1..6000 | ForEach-Object { "x" * 70 }; Write-Output ("DETACHED_" + "COMPLETE")'
        : "i=0; while [ $i -lt 6000 ]; do printf '%070d\\n' $i; i=$((i+1)); done; printf 'DETACHED_%s\\n' COMPLETE";
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "; exit\r"), {
      id: detached,
      command: flood,
    });
    await page.waitForFunction(() => window.detachedExited);
    assert.equal(await page.evaluate(() => window.detachedChunks), 0);
    const tail = await page.evaluate((id) => window.desktop.tail(id, 5), detached);
    assert.ok(tail.some((line) => line.includes("DETACHED_COMPLETE")));
    assert.ok(tail.every((line) => !line.includes("\x1b")));
    await page.evaluate(async (id) => {
      window.detachedOutput = "";
      await window.desktop.attach(id);
    }, detached);
    await page.waitForFunction(() => window.detachedOutput.includes("DETACHED_COMPLETE"));
    await page.evaluate((id) => window.desktop.kill(id), detached);
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
    // Quit with fresh, detached PTYs as well as the restarted visible shell. Native
    // exit callbacks must finish before Electron tears down its Node environment.
    await page.evaluate(async () => {
      const removed = await window.desktop.create(80, 24);
      await window.desktop.kill(removed.id);
      await window.desktop.create(80, 24);
    });
  } catch (error) {
    const pages = app.windows();
    if (pages[0])
      console.error(
        "Terminal failure state:",
        await pages[0].evaluate(() => ({
          viewport: { width: innerWidth, height: innerHeight },
          terminal: document.querySelector(".xterm-screen")?.getBoundingClientRect().toJSON(),
          status: document.querySelector("#status")?.textContent,
          output: window.terminalOutput?.slice(-8000),
        })),
      );
    throw error;
  }
});

test("bundled brand fonts and both system themes render in Electron", {
  timeout: 45_000,
}, async (context) => {
  const app = await launchApp(context);
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
      // Terminal and interface themes have separate media-change listeners.
      (expected) =>
        getComputedStyle(document.documentElement).backgroundColor === expected &&
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

// Exercise the real app/PTY lifecycle; control only the native dialog response so
// these checks run on all three desktop platforms without OS-specific UI drivers.
for (const action of ["close", "quit", "shortcut"]) {
  test(`quit via ${action} confirms, cancel preserves PTYs, and confirm reaps shells`, {
    timeout: 45_000,
  }, async (context) => {
    const app = await launchApp(context);
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => !/Starting|Unable/.test(document.querySelector("#status").textContent),
    );
    await page.evaluate(() => {
      window.quitOutput = "";
      window.desktop.onData((_id, _token, data) => {
        window.quitOutput += data;
      });
    });
    const command =
      process.platform === "win32"
        ? 'Write-Output ("QUIT_PID:" + $PID)'
        : "printf 'QUIT_%s:%s\\n' PID $$";
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /QUIT_PID:\d+/.test(window.quitOutput));
    const firstPid = await page.evaluate(() =>
      Number(window.quitOutput.match(/QUIT_PID:(\d+)/)[1]),
    );
    const second = await page.evaluate(async () => {
      const { id } = await window.desktop.create(80, 24);
      window.secondOutput = "";
      window.desktop.onData((terminal, token, data) => {
        if (terminal === id) {
          window.secondOutput += data;
          window.desktop.acknowledge(id, token, data.length);
        }
      });
      await window.desktop.attach(id);
      return id;
    });
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "\r"), {
      id: second,
      command,
    });
    await page.waitForFunction(() => /QUIT_PID:\d+/.test(window.secondOutput));
    const secondPid = await page.evaluate(() =>
      Number(window.secondOutput.match(/QUIT_PID:(\d+)/)[1]),
    );
    await page.evaluate((id) => window.desktop.detach(id), second);
    await app.evaluate(({ dialog }) => {
      globalThis.quitPrompts = [];
      globalThis.quitResponse = 0;
      dialog.showMessageBox = async (_window, options) => {
        globalThis.quitPrompts.push(options);
        return { response: globalThis.quitResponse, checkboxChecked: false };
      };
    });
    const requestQuit = () =>
      app.evaluate(({ app, BrowserWindow }, method) => {
        const window = BrowserWindow.getAllWindows()[0];
        setTimeout(() => {
          if (method === "close") window.close();
          else if (method === "quit") app.quit();
          else {
            window.focus();
            window.webContents.sendInputEvent({
              type: "keyDown",
              keyCode: "Q",
              modifiers: [process.platform === "darwin" ? "meta" : "control"],
            });
          }
        }, 50);
      }, action);
    await requestQuit();
    await expect.poll(() => app.evaluate(() => globalThis.quitPrompts.length)).toBe(1);
    assert.equal(
      await app.evaluate(() => globalThis.quitPrompts[0].message),
      "2 terminals are still running. Quit anyway?",
    );
    assert.equal(await app.evaluate(() => globalThis.quitPrompts[0].cancelId), 0);
    for (const pid of [firstPid, secondPid]) process.kill(pid, 0);
    const alive =
      process.platform === "win32"
        ? 'Write-Output ("CANCEL_" + "ALIVE")'
        : "printf 'CANCEL_%s\\n' ALIVE";
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(alive);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.quitOutput.includes("CANCEL_ALIVE"));
    await app.evaluate(() => {
      globalThis.quitResponse = 1;
    });
    await quitAndWait(app, requestQuit);
    for (const pid of [firstPid, secondPid]) {
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if (error.code === "ESRCH") return true;
            throw error;
          }
        })
        .toBe(true);
    }
  });
}

test("closing with an exited terminal quits without confirmation", {
  timeout: 45_000,
}, async (context) => {
  const app = await launchApp(context);
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => !/Starting|Unable/.test(document.querySelector("#status").textContent),
  );
  const background = await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
    actual: BrowserWindow.getAllWindows()[0].getBackgroundColor().toUpperCase(),
    expected: nativeTheme.shouldUseDarkColors ? "#05040A" : "#F3F0FA",
  }));
  assert.equal(background.actual, background.expected);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await page.getByRole("status").filter({ hasText: "Shell exited" }).waitFor();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () => {
      throw new Error("Unexpected quit confirmation");
    };
  });
  await quitAndWait(app, () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()),
  );
});

test("utility host survives output floods without losing rows or delaying another PTY", {
  timeout: 45_000,
}, async (context) => {
  const app = await launchApp(context);
  await app.firstWindow();
  const measured = await app.evaluate(
    async ({ app }, { node, probe }) => {
      const load = process
        .getBuiltinModule("node:module")
        .createRequire(app.getAppPath() + "/package.json");
      const { TerminalHostClient } = load("./build/main/terminals/terminal-host-client.js");
      const exited = new Map();
      const host = new TerminalHostClient((id, code) => exited.set(id, code));
      const wait = async (condition) => {
        const deadline = Date.now() + 15000;
        while (!(await condition())) {
          if (Date.now() > deadline) throw new Error("Host probe timeout");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      try {
        const spec = { command: node, cwd: app.getPath("temp"), cols: 500, rows: 24 };
        const flood = await host.create({ ...spec, args: [probe, "flood"] });
        const echo = await host.create({ ...spec, args: [probe, "echo"] });
        let output = "";
        await host.attach(echo, (token, data) => {
          output += data;
          host.acknowledge(echo, token, data.length);
        });
        await wait(
          async () => output.includes("READY") && (await host.tail(flood, 1)).includes("READY"),
        );
        const samples = [];
        let duringFlood = 0;
        host.write(flood, "g");
        for (let index = 0; index < 30; index++) {
          const marker = `ECHO_${index}_OK`;
          const start = performance.now();
          const busy = !exited.has(flood);
          host.write(echo, marker);
          await wait(() => output.includes(marker));
          samples.push(performance.now() - start);
          if (busy) duringFlood++;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await wait(() => exited.has(flood));
        const lines = await host.tail(flood, 10000);
        const rows = lines.filter((line) => line.startsWith("ROW_"));
        const intact =
          rows.length === 8000 &&
          rows.every(
            (line, index) => line === `ROW_${String(index).padStart(5, "0")}:${"x".repeat(440)}`,
          );
        return {
          samples,
          duringFlood,
          intact,
          exit: exited.get(flood),
          last: lines.at(-1),
          hosts: app.getAppMetrics().filter((metric) => metric.name === "Foom terminal host")
            .length,
        };
      } finally {
        await host.dispose();
      }
    },
    { node: process.execPath, probe: path.join(__dirname, "host-probe.js") },
  );
  assert.equal(measured.exit, 0);
  assert.equal(measured.intact, true, "all 8,000 headless rows retain their index and content");
  assert.equal(measured.last, "FLOOD_END");
  assert.ok(measured.duringFlood > 0, "echo probes overlap the flood");
  assert.ok(measured.hosts >= 1, "PTYs run in named utility processes");
  const sorted = measured.samples.toSorted((a, b) => a - b);
  console.info(
    `Flood echo latency: median=${sorted[15].toFixed(1)}ms p95=${sorted[28].toFixed(1)}ms max=${sorted[29].toFixed(1)}ms; ${measured.duringFlood}/30 probes during flood; 8000/8000 rows intact`,
  );
  assert.ok(sorted[29] < 1000, "echo remains responsive during a flood (CI ceiling: 1s)");
});

test("a crashed utility host reports failure and the renderer can restart", {
  timeout: 45_000,
}, async (context) => {
  const app = await launchApp(context);
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => !/Starting|exited|Unable/.test(document.querySelector("#status").textContent),
  );
  const hostPid = await app.evaluate(({ app }) => {
    const metric = app.getAppMetrics().find((metric) => metric.name === "Foom terminal host");
    if (!metric) throw new Error("Missing utility host");
    process.kill(metric.pid, "SIGKILL");
    return metric.pid;
  });
  await page.getByRole("status").filter({ hasText: "Terminal host failed" }).waitFor();
  await page.getByRole("button", { name: "Restart shell" }).click();
  await page.waitForFunction(
    () => !/Starting|failed|Unable/.test(document.querySelector("#status").textContent),
  );
  // A title is available before the replacement attachment is ready for input.
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const replacementPid = await app.evaluate(
    ({ app }) => app.getAppMetrics().find((metric) => metric.name === "Foom terminal host")?.pid,
  );
  assert.ok(replacementPid && replacementPid !== hostPid);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo HOST_RESTART_OK");
  await page.keyboard.press("Enter");
  await page
    .locator(".xterm-rows > div")
    .filter({ hasText: /^HOST_RESTART_OK$/ })
    .last()
    .waitFor();
});

test("host answers color queries once through real view transitions and system themes", {
  timeout: 45000,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-color-probe-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const app = await launchApp(context);
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => !document.querySelector("#status").textContent.includes("Starting"),
  );
  await page.evaluate(() => {
    window.probeOutput = "";
    window.desktop.onData((id, _token, data) => {
      window.probeId = id;
      window.probeOutput += data;
    });
  });
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.probeId);
  for (const theme of ["light", "dark", "dracula"]) {
    if (theme === "dracula") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await page.getByRole("button", { name: "Dracula", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.desktop.setupState()).settings.terminalTheme),
        )
        .toBe("dracula");
      await page.keyboard.press("Escape");
      await expect(page.locator(".xterm-scrollable-element")).toHaveCSS(
        "background-color",
        "rgb(40, 42, 54)",
      );
    }
    await app.evaluate(
      ({ nativeTheme }, value) => {
        nativeTheme.themeSource = value;
      },
      theme === "dracula" ? "light" : theme,
    );
    await page.waitForFunction(
      (dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark,
      theme === "dark",
    );
    for (const mode of ["attached", "detached", "reattach"]) {
      const label = `_${theme}_${mode}`;
      const resultFile = path.join(directory, label);
      const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "protocol-probe.js")}" colors ${theme} ${label} "${resultFile}"`;
      await page.evaluate(
        async ({ command, mode }) => {
          if (mode !== "attached") await window.desktop.detach(window.probeId);
          window.desktop.input(window.probeId, command + "\r");
          if (mode === "reattach") await window.desktop.attach(window.probeId);
        },
        { command, mode },
      );
      if (mode === "detached") {
        // Wait for the probe to finish with no renderer attached, even on slow machines.
        await expect.poll(() => readFile(resultFile, "utf8").catch(() => "pending")).toBe("OK");
        await page.evaluate(() => window.desktop.attach(window.probeId));
      }
      await page.waitForFunction(
        (label) =>
          window.probeOutput.includes(`PROTOCOL_OK${label}`) ||
          window.probeOutput.includes(`PROTOCOL_FAIL${label}`),
        label,
      );
      assert.ok(
        await page.evaluate((label) => window.probeOutput.includes(`PROTOCOL_OK${label}`), label),
      );
      assert.ok(
        !(await page.evaluate(
          (label) => window.probeOutput.includes(`PROTOCOL_FAIL${label}`),
          label,
        )),
      );
    }
  }
});

test("Preflight transitions restore background fullscreen output repeatedly", {
  timeout: 45000,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-view-probe-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "stage");
  const app = await launchApp(context);
  const page = await app.firstWindow();
  const hide = page.getByRole("button", { name: "Preflight", exact: true });
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
  await hide.click();
  await expect(page.locator(".preflight")).toBeVisible();
  await expect(open).toBeEnabled();
  await expect(page.locator("#terminal")).toBeHidden();
  await page.evaluate(() => {
    window.viewChunks = 0;
    window.desktop.input(window.viewId, "a");
  });
  await expect.poll(() => readFile(marker, "utf8").catch(() => "pending")).toBe("alternate");
  assert.equal(await page.evaluate(() => window.viewChunks), 0);
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.keyboard.press("Escape");
    await expect(page.locator(".preflight")).toBeHidden();
    await open.click();
    await expect(hide).toBeEnabled();
    await expect(rows).toContainText("ALTERNATE_HIDDEN_OUTPUT");
    await expect(rows).not.toContainText("NORMAL_VIEW_READY");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await hide.click();
    await expect(page.locator(".preflight")).toBeVisible();
    await expect(page.locator(".preflight")).toBeVisible();
    await expect(open).toBeEnabled();
  }
  await page.evaluate(() => window.desktop.input(window.viewId, "n"));
  await expect.poll(() => readFile(marker, "utf8")).toBe("normal");
  await page.keyboard.press("Escape");
  await expect(page.locator(".preflight")).toBeHidden();
  await open.click();
  await expect(hide).toBeEnabled();
  await expect(rows).toContainText("NORMAL_VIEW_READY");
  await expect(rows).toContainText("NORMAL_HIDDEN_OUTPUT");
  await expect(rows).not.toContainText("ALTERNATE_HIDDEN_OUTPUT");
  // Continue scrolling after restoration, including origin-relative positioning,
  // repeated attachments, and transitions between both buffers.
  for (const mode of ["a", "n", "a", "n"]) {
    await hide.click();
    await expect(page.locator(".preflight")).toBeVisible();
    await expect(page.locator(".preflight")).toBeVisible();
    await expect(open).toBeEnabled();
    await page.evaluate((key) => window.desktop.input(window.viewId, key), mode);
    await expect.poll(() => readFile(marker, "utf8")).toBe(mode === "a" ? "alternate" : "normal");
    for (const setup of ["s", "o"]) {
      await page.evaluate((key) => window.desktop.input(window.viewId, key), setup);
      await expect.poll(() => readFile(marker, "utf8")).toBe(setup);
      for (let cycle = 0; cycle < 3; cycle++) {
        await page.keyboard.press("Escape");
        await expect(page.locator(".preflight")).toBeHidden();
        await open.click();
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
        await hide.click();
        await expect(page.locator(".preflight")).toBeVisible();
        await expect(open).toBeEnabled();
      }
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(".preflight")).toBeHidden();
    await open.click();
    await expect(hide).toBeEnabled();
  }
  // Reopening restores interactive input as well as the screen.
  await page.keyboard.type("q");
});

test("board starts with live terminals only and peeks without opening", async (context) => {
  const app = await launchApp(context, false);
  const page = await app.firstWindow();
  const row = page.locator(".board-row");
  await expect(row).toHaveCount(1);
  await expect(row).toBeFocused();
  await expect(page.locator("#terminal")).toBeHidden();
  await page.getByLabel("Filter repositories and sessions").click();
  await row.focus();
  await expect(page.getByRole("complementary", { name: "Terminal peek" })).toBeVisible();
  await expect(row).toBeFocused();
  await expect(page.locator("#terminal")).toBeHidden();
  await page.keyboard.press("Escape");
  await assertAccessible(page);
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  const restart = page.getByRole("button", { name: "Restart shell" });
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await boardCommand(app, "B");
  await expect(row).toBeFocused();
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

// A stand-in for Claude Code: reports a hook-capable version, prompts in plain text,
// then fires its PermissionRequest hook through the command Foom attached.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log("  --settings <file-or-json>  Load settings"); process.exit(0); }
if (process.cwd().endsWith("finish-ok")) { console.log("Finished successfully"); setTimeout(() => process.exit(0), 100); return; }
if (process.cwd().endsWith("finish-failed")) { console.log("Failed task"); setTimeout(() => process.exit(1), 100); return; }
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const command = settings.hooks.PermissionRequest[0].hooks[0].command;
const env = process.env;
writeFileSync(process.env.FOOM_FAKE_CREDENTIALS, JSON.stringify({
  url: env.FOOM_HOOK_URL, session: env.FOOM_SESSION, token: env.FOOM_TOKEN,
}));
process.stdout.write("FOOM_AGENT_READY\\r\\nContinue? (y/n) ");
process.stdin.setRawMode(true);
process.stdin.on("data", (key) => {
  const input = key.toString();
  if (input === "y") {
    process.stdout.write("y\\r\\n\\x1b[1mAllow Bash(npm test)?\\x1b[0m\\r\\n");
    const hook = spawn("sh", ["-c", command], { stdio: ["pipe", "ignore", "ignore"] });
    hook.stdin.end(JSON.stringify({ session_id: "fake-session", hook_event_name: "PermissionRequest" }));
  } else if (input === "f") {
    let count = 0;
    const timer = setInterval(() => {
      process.stdout.write("Working " + "x".repeat(1000) + "\\r\\n");
      if (++count === 50) { clearInterval(timer); process.stdout.write("Continue? (y/n) "); }
    }, 50);
  } else if (input === "q") {
    process.exit(3);
  }
});
`;

test("launches an agent in a managed worktree and routes its attention signals", {
  timeout: 60_000,
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { chmod, mkdir, writeFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-workspace-"));
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const credentials = path.join(root, "credentials.json");

  const app = await launchApp(context, false, {
    args: [`--user-data-dir=${path.join(root, "user-data")}`],
    // A private HOME keeps the login shell from loading rc files that would put a real
    // agent ahead of the fake one on PATH.
    env: {
      HOME: path.join(root, "home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FOOM_FAKE_CREDENTIALS: credentials,
    },
  }).finally(() => {
    // Chromium may still write user-data until the app cleanup hook has finished.
    context.after(() => rm(root, { recursive: true, force: true }));
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const setup = await page.evaluate(async () => {
    window.foomStates = [];
    window.desktop.onState((state) => window.foomStates.push(state));
    const repository = await window.desktop.addRepository();
    const tree = await window.desktop.createWorktree(repository.path, "feature/fake", "adjacent");
    const scan = await window.desktop.scanAgents(false);
    return { repository, tree, claude: scan.agents.find((agent) => agent.id === "claude") };
  });
  assert.equal(setup.tree.branch, "feature/fake");
  assert.equal(setup.tree.managed, true);
  assert.equal(
    setup.claude.hooks,
    true,
    `Fake agent not detected: ${JSON.stringify(setup.claude)}`,
  );

  // The renderer can't substitute an executable or an unmanaged path.
  await assert.rejects(
    page.evaluate((request) => window.desktop.launchAgent(request), {
      agent: "claude",
      repository: setup.repository.path,
      worktree: repo,
      cols: 80,
      rows: 24,
    }),
    /not managed by Foom/,
  );

  const launched = await page.evaluate((request) => window.desktop.launchAgent(request), {
    agent: "claude",
    repository: setup.repository.path,
    worktree: setup.tree.path,
    cols: 80,
    rows: 24,
  });
  assert.equal(launched.attention, "hooks");
  const id = launched.id;
  const latest = () =>
    page.evaluate((terminal) => window.foomStates.filter((s) => s.id === terminal).at(-1), id);
  await expect
    .poll(() => page.evaluate((terminal) => window.desktop.tail(terminal, 5), id), {
      timeout: 10000,
    })
    .toContain("FOOM_AGENT_READY");

  // Quiet after a y/n prompt: the text rules ask for attention.
  await expect.poll(async () => (await latest())?.state, { timeout: 10000 }).toBe("needs_input");
  assert.equal((await latest()).signal, "pattern:confirmation");
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.deepEqual(
    snapshot.terminals.map(({ id: terminal, branch, agent }) => ({ terminal, branch, agent })),
    [{ terminal: id, branch: "feature/fake", agent: "claude" }],
  );

  const agentRow = page
    .locator('.board-row[data-kind="agent"]')
    .filter({ hasText: "feature/fake" });
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  await expect(agentRow).toContainText("pattern:confirmation");
  const firstCredentials = JSON.parse(await readFile(credentials, "utf8"));
  await page.evaluate(async (repository) => {
    const tree = await window.desktop.createWorktree(repository, "feature/newer", "adjacent");
    await window.desktop.launchAgent({
      agent: "claude",
      repository,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    });
  }, setup.repository.path);
  await expect(page.locator(".board-row").filter({ hasText: "feature/newer" })).toHaveAttribute(
    "data-state",
    "needs_input",
  );
  // Peek reads the real host tail and leaves both focus and attachment alone.
  await agentRow.focus();
  await page.locator(".board-row:focus").focus();
  await expect(page.locator(".board-peek")).toContainText("FOOM_AGENT_READY");
  await expect(agentRow).toBeFocused();
  await expect(page.locator("#terminal")).toBeHidden();
  await page.locator('.board-row[data-kind="shell"]').press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await boardCommand(app, "B");
  // The native shortcut reaches the renderer asynchronously; wait before sending
  // the next key so ArrowDown cannot go to the terminal instead of the sidebar.
  await expect(page.locator('.board-row[data-kind="shell"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-nav]:focus")).toBeVisible();
  await agentRow.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.locator('.board-row[data-kind="shell"]').press("Enter");
  await boardCommand(app, "N");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  await assertAccessible(page);
  await page.keyboard.type("f");
  await expect(agentRow).toHaveAttribute("data-state", "working");
  await expect
    .poll(() =>
      agentRow
        .locator(".board-light")
        .evaluate((element) => Number(element.style.getPropertyValue("--light-opacity"))),
    )
    .toBeGreaterThan(0.9);
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  // Typing is the reply; then the agent's hook asks for permission.
  await page.keyboard.type("y");
  await expect
    .poll(async () => (await latest())?.signal, { timeout: 10000 })
    .toBe("claude:PermissionRequest");
  assert.ok(
    (await page.evaluate(() => window.foomStates.map((s) => s.signal))).includes("user:reply"),
  );
  // Later quiet evaluations keep the permission request in force.
  await page.waitForTimeout(2500);
  assert.equal((await latest()).state, "needs_input");

  // Not attention clears it and records feedback.
  await page.getByRole("button", { name: "Not attention", exact: true }).click();
  await expect(agentRow).toHaveAttribute("data-state", "quiet_ok");
  assert.equal((await latest()).signal, "user:dismissed");

  // Exit is final and revokes the launch's hook credentials.
  const hook = firstCredentials;
  await page.evaluate((terminal) => window.desktop.input(terminal, "q"), id);
  await expect.poll(async () => (await latest())?.state, { timeout: 10000 }).toBe("failed");
  const replay = await fetch(hook.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: hook.token,
      "X-Foom-Session": hook.session,
    },
    body: JSON.stringify({ session_id: "fake-session", hook_event_name: "PermissionRequest" }),
  });
  assert.equal(replay.status, 401);
  await expect(agentRow).toHaveAttribute("data-state", "failed");
  await boardCommand(app, "B");
  for (const branch of ["finish-ok", "finish-failed"]) {
    await page.evaluate(
      async ({ repository, branch }) => {
        const tree = await window.desktop.createWorktree(repository, branch, "adjacent");
        await window.desktop.launchAgent({
          agent: "claude",
          repository,
          worktree: tree.path,
          cols: 80,
          rows: 24,
        });
      },
      { repository: setup.repository.path, branch },
    );
    const row = page.locator(".board-row").filter({ hasText: branch });
    await expect(row).toHaveAttribute("data-state", branch === "finish-ok" ? "done" : "failed");
    await row.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(page.locator(".xterm-rows")).toContainText(
      branch === "finish-ok" ? "Finished successfully" : "Failed task",
    );
    await page.keyboard.press("Escape");
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 850));
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
  }
  const log = await readFile(path.join(root, "user-data", "verdicts.jsonl"), "utf8");
  assert.match(log, /"feedback":"not_attention"/);
  assert.match(log, /"action":"replied"/);
  assert.doesNotMatch(log, /FOOM_AGENT_READY|npm test/);
});

test("inference keys stay in main and require real OS encryption", async (context) => {
  const instance = await launchApp(context, false);
  const page = await instance.firstWindow();
  const result = await instance.evaluate(async ({ app, safeStorage }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const fs = load("node:fs/promises");
    const path = load("node:path");
    const { InferenceKeys } = load("./build/main/evaluator/inference-keys.js");
    const dir = await fs.mkdtemp(path.join(app.getPath("temp"), "foom-inference-"));
    const keys = new InferenceKeys(dir);
    const secure =
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
    try {
      if (!secure) {
        let rejected = false;
        try {
          await keys.set("openai", "synthetic-key-not-a-real-credential");
        } catch {
          rejected = true;
        }
        return { rejected, files: await fs.readdir(dir) };
      }
      await keys.set("openai", "synthetic-key-not-a-real-credential");
      const bytes = await fs.readFile(path.join(dir, "inference-openai.key"));
      const roundTrip = (await keys.get("openai")) === "synthetic-key-not-a-real-credential";
      await keys.remove("openai");
      return {
        roundTrip,
        encrypted: bytes.length > 0 && !bytes.includes("synthetic-key-not-a-real-credential"),
        files: await fs.readdir(dir),
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  if ("rejected" in result) assert.equal(result.rejected, true);
  else {
    assert.equal(result.roundTrip, true);
    assert.equal(result.encrypted, true);
  }
  assert.deepEqual(result.files, []);
  // Preflight can store, remove and test a key; nothing in the bridge reads one back.
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys(window.desktop).filter((key) => /key|secret|inference/i.test(key)),
    ),
    ["setInferenceKey", "removeInferenceKey", "checkInference", "cancelInferenceCheck"],
  );
  const state = await page.evaluate(() => window.desktop.setupState());
  assert.deepEqual(state.keys, { anthropic: false, openai: false, google: false });
});

test("focus reports reach the shell without counting as a reply", {
  timeout: 45_000,
  skip: process.platform === "win32" && "The prompt script is POSIX shell",
}, async (context) => {
  const app = await launchApp(context);
  const page = await app.firstWindow();
  await page.evaluate(() => {
    window.foomStates = [];
    window.focusOutput = "";
    window.desktop.onState((state) => window.foomStates.push(state));
    window.desktop.onData((_id, _token, data) => {
      window.focusOutput += data;
    });
  });
  const latest = () => page.evaluate(() => window.foomStates.at(-1));
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  // Enable focus reporting (DECSET 1004), then wait silently at a password prompt.
  await page.keyboard.type(
    "printf '\\033[?1004h\\nPass''word: '; read -rs reply; printf '\\033[?1004l\\nGOT:%q\\n' \"$reply\"",
  );
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await latest())?.signal, { timeout: 10000 })
    .toBe("pattern:password");

  // Moving focus to the board control makes xterm report focus-out to the program.
  await boardCommand(app, "B");
  await page.waitForTimeout(1500);
  assert.equal((await latest()).state, "needs_input");

  await input.focus();
  await page.keyboard.type("y");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      () => page.evaluate(() => window.foomStates.some((state) => state.signal === "user:reply")),
      { timeout: 10000 },
    )
    .toBe(true);
  // The program received the focus reports along with the real reply.
  // xterm also reports focus-in as soon as reporting is enabled.
  await page.waitForFunction(() =>
    /GOT:\$'(?:\\E\[[IO])*\\E\[O(?:\\E\[[IO])*y'/.test(window.focusOutput),
  );
  assert.equal(
    (await page.evaluate(() => window.foomStates.map((state) => state.signal))).filter(
      (signal) => signal === "user:reply",
    ).length,
    1,
  );
});

/** Git without inherited GIT_* variables, which could point it at Foom's own repository. */
function isolatedGit(args, options = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return require("node:child_process").execFileSync("git", args, { ...options, env });
}

async function tabTo(page, name) {
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (label === name) return;
  }
  throw new Error(`Could not reach "${name}" with Tab`);
}

test("a fresh profile opens preflight, and it passes accessibility checks", async (context) => {
  const app = await launchApp(context, false, { firstRun: true });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Start preflight" }).waitFor();
  assert.equal(await page.locator(".board-home").count(), 0);
  // The ring moves by path distance, boosts on hover/focus, and stops for reduced motion.
  const ring = () =>
    page
      .locator(".ignite-ring")
      .last()
      .evaluate((ring) => {
        const style = getComputedStyle(ring);
        return `${style.animationName} ${style.animationPlayState} ${style.animationDuration} ${style.animationTimingFunction}`;
      });
  assert.equal(await ring(), "ignite-orbit, ignite-boost running, paused 4s, 1.25s linear, linear");
  await page.getByRole("button", { name: "Start preflight" }).hover();
  assert.equal(
    await ring(),
    "ignite-orbit, ignite-boost running, running 4s, 1.25s linear, linear",
  );
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "Start preflight" }).focus();
  assert.equal(
    await ring(),
    "ignite-orbit, ignite-boost running, running 4s, 1.25s linear, linear",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await ring(), "none running, running 0s ease");
  await page.emulateMedia({ reducedMotion: null });
  await assertAccessible(page);
  await page.getByRole("button", { name: "Start preflight" }).click();
  await page.getByText("Which agents do you run?").waitFor();
  await expect(page.getByText("Looking…")).toHaveCount(0, { timeout: 20000 });
  await assertAccessible(page);
});

async function assertPreflightFits(page, label) {
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  await expect
    .poll(
      () =>
        page.locator(".preflight-viewport").evaluate((viewport) => {
          const content = viewport.querySelector(".preflight-content");
          const stage = viewport.querySelector(".preflight-stage");
          const inner = viewport.querySelector(".preflight-inner");
          const footer = viewport.querySelector(".preflight-footer");
          const scale = Number(getComputedStyle(content).zoom);
          const overflows =
            Math.max(inner.offsetHeight, inner.scrollHeight) > stage.clientHeight + 1;
          return {
            clippedNavigation: footer
              ? [...footer.querySelectorAll("button")].some((button) => {
                  const bounds = button.getBoundingClientRect();
                  const visible = footer.getBoundingClientRect();
                  return (
                    bounds.top < visible.top - 1 ||
                    bounds.bottom > visible.bottom + 1 ||
                    bounds.left < visible.left - 1 ||
                    bounds.right > visible.right + 1
                  );
                })
              : false,
            horizontal: stage.scrollWidth > stage.clientWidth + 1,
            enlargedOverflow: overflows && scale > 1.00001,
            outsideWindow: viewport.getBoundingClientRect().bottom > window.innerHeight + 1,
            coveredFooter: footer
              ? stage.getBoundingClientRect().bottom > footer.getBoundingClientRect().top + 1
              : false,
          };
        }),
      { message: label },
    )
    .toEqual({
      clippedNavigation: false,
      horizontal: false,
      enlargedOverflow: false,
      outsideWindow: false,
      coveredFooter: false,
    });
  await expect
    .poll(async () => {
      const before = await page
        .locator(".preflight-content")
        .evaluate((content) => getComputedStyle(content).zoom);
      await settle();
      return page
        .locator(".preflight-content")
        .evaluate((content, before) => getComputedStyle(content).zoom === before, before);
    })
    .toBe(true);
}

test("preflight fits safely through resize, zoom, long input and changing steps", {
  timeout: 60_000,
}, async (context) => {
  const app = await launchApp(context, false);
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Preflight", exact: true }).click();
  const rail = page.getByRole("navigation", { name: "Preflight steps" });
  for (const [width, height, zoom] of [
    [1600, 1000, 100],
    [1600, 1000, 150],
    [1600, 1000, 80],
    [1280, 720, 150],
    [900, 640, 100],
    [650, 600, 150],
    [480, 360, 150],
    // Leave room for native window chrome even on Linux without a window manager.
    [480, 300, 150],
    [2400, 1400, 100],
    [1600, 1000, 100],
  ]) {
    const size = await app.evaluate(
      ({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setMinimumSize(0, 0);
        window.setSize(width, height);
        window.webContents.setZoomFactor(zoom / 100);
        return window.getContentBounds();
      },
      { width, height, zoom },
    );
    await expect
      .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
      .toEqual([Math.round((size.width * 100) / zoom), Math.round((size.height * 100) / zoom)]);
    for (const step of [
      "Welcome",
      "Agents",
      "Repositories",
      "Worktrees",
      "Evaluator",
      "Go / no-go",
    ]) {
      await rail.getByRole("button", { name: new RegExp(step) }).click();
      await assertPreflightFits(page, `${width}×${height} at ${zoom}%: ${step}`);
      if (step === "Evaluator") {
        const cloud = page.getByRole("radio", { name: /Use an API key/ });
        if (await cloud.isEnabled()) {
          await cloud.check();
          await page.getByLabel("Model", { exact: true }).fill("a".repeat(300));
          await assertPreflightFits(page, "Expanded API settings and a long model name");
        }
        await page.getByRole("radio", { name: /Use a local model/ }).check();
        await page.getByLabel("Model", { exact: true }).fill("a".repeat(300));
        await assertPreflightFits(page, "Expanded local settings and a long model name");
      }
    }
  }
  await rail.getByRole("button", { name: /Evaluator/ }).click();
  await page.getByRole("radio", { name: /Use a local model/ }).check();
  for (const control of [
    "Larger",
    "Larger",
    "Larger",
    "Larger",
    "Larger",
    "Smaller",
    "Smaller",
    "Smaller",
    "Smaller",
    "Smaller",
    "Smaller",
    "Smaller",
    "Larger",
    "Larger",
  ]) {
    await page.getByRole("button", { name: control, exact: true }).click();
    await assertPreflightFits(
      page,
      "Real interface-size controls after resizing and expanding settings",
    );
  }
});

test("large repository scans remain readable and filter without changing scale", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-layout-repos-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  for (const group of ["alpha", "beta", "gamma"]) {
    for (let index = 0; index < 12; index++) {
      const directory = path.join(root, group, `project-${index}-${"long-name-".repeat(12)}`);
      await mkdir(directory, { recursive: true });
      isolatedGit(["init", "-q", directory]);
    }
  }
  const app = await launchApp(context, false);
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow, dialog }, directory) => {
    BrowserWindow.getAllWindows()[0].setSize(1600, 1000);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, root);
  await page.getByRole("button", { name: "Preflight", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Preflight steps" })
    .getByRole("button", { name: /Repositories/ })
    .click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await expect(page.locator(".repo-row")).toHaveCount(36);
  await assertPreflightFits(page, "Many repository groups and long names");
  await page.locator('.repo-row input[type="checkbox"]').last().uncheck();
  await assertPreflightFits(page, "Selection at the bottom of a long scan");
  const scale = await page
    .locator(".preflight-content")
    .evaluate((content) => getComputedStyle(content).zoom);
  await page.getByRole("searchbox").fill("does-not-exist");
  await expect(page.locator(".repo-row")).toHaveCount(0);
  await expect(page.locator(".preflight-content")).toHaveCSS("zoom", scale);
  await page.getByRole("searchbox").fill("");
  await expect(page.locator(".repo-row")).toHaveCount(36);
  await assertPreflightFits(page, "Clearing a repository filter");
});

test("first run goes from no agents to go, launches by keyboard, and can be replayed", {
  timeout: 60_000,
  skip: process.platform === "win32" && "The fake agents are POSIX scripts",
}, async (context) => {
  const { chmod, symlink } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-first-run-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const userData = path.join(root, "user-data");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  isolatedGit(["init", "-q", repo]);
  // Node gets its own folder: agents installed beside it must stay hidden.
  const nodeBin = path.join(root, "node-bin");
  await mkdir(nodeBin);
  await symlink(process.execPath, path.join(nodeBin, "node"));

  const app = await launchApp(context, false, {
    firstRun: true,
    args: [`--user-data-dir=${userData}`],
    // A private HOME and PATH hide any agents installed on this machine.
    env: {
      HOME: path.join(root, "home"),
      PATH: [bin, nodeBin, "/usr/bin", "/bin"].join(path.delimiter),
    },
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);

  const contentScales = new Map();
  // Check centering against actual stage bounds: macOS can clamp tall window requests.
  // Short steps center at every interface size; overflowing steps keep their top reachable.
  for (const [width, height, zoom] of [
    [1200, 900, 1],
    [1600, 1000, 1],
    [1600, 700, 1],
    [1600, 2000, 1],
    // A small CI display can clamp both requested window sizes to the same bounds.
    // Zoom out further to exercise actual scale growth even on that display.
    [1600, 1000, 0.5],
    [1600, 1000, 0.8],
    [1600, 1000, 1.5],
    [800, 600, 1.5],
  ]) {
    const size = await app.evaluate(
      ({ BrowserWindow, screen }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const available = screen.getPrimaryDisplay().workAreaSize;
        window.setSize(Math.min(width, available.width), Math.min(height, available.height));
        window.webContents.setZoomFactor(zoom);
        return window.getContentBounds();
      },
      { width, height, zoom },
    );
    // Window resize delivery and ResizeObserver run after the main-process call returns.
    await expect
      .poll(() =>
        page.evaluate(
          ({ size, zoom }) =>
            Math.max(
              Math.abs(window.innerWidth - size.width / zoom),
              Math.abs(window.innerHeight - size.height / zoom),
            ),
          { size, zoom },
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    await expect
      .poll(() =>
        page.locator(".preflight-stage").evaluate((stage) => {
          const inner = stage.querySelector(".preflight-inner");
          const bounds = inner.getBoundingClientRect();
          const stageBounds = stage.getBoundingClientRect();
          return Math.abs(
            bounds.top - stageBounds.top - Math.max(0, (stageBounds.height - bounds.height) / 2),
          );
        }),
      )
      .toBeLessThan(2);
    contentScales.set(
      `${width}x${height}@${zoom}`,
      await page
        .locator(".preflight-content")
        .evaluate((content) => Number(getComputedStyle(content).zoom)),
    );
    if (width === 800) {
      const overflow = await page.locator(".preflight-stage").evaluate((stage) => {
        const overflows = stage.scrollHeight > stage.clientHeight;
        stage.scrollTop = stage.scrollHeight;
        return {
          overflows,
          bottom: stage.querySelector(".preflight-inner").getBoundingClientRect().bottom,
          stageBottom: stage.getBoundingClientRect().bottom,
        };
      });
      assert.ok(overflow.overflows, "Small zoomed stage exercises overflow");
      assert.ok(
        Math.abs(overflow.bottom - overflow.stageBottom) < 2,
        "The content bottom is reachable",
      );
    }
  }
  await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setZoomFactor(1);
    const available = screen.getPrimaryDisplay().workAreaSize;
    window.setSize(Math.min(1600, available.width), Math.min(1000, available.height));
  });

  assert.ok(
    contentScales.get("1600x1000@0.5") > contentScales.get("1600x1000@1.5"),
    "More available CSS space enlarges content, even when native window sizes are clamped",
  );
  const sharedScale = contentScales.get("1600x1000@1");
  const assertFooter = async (sameSize = true) => {
    const layout = await page.locator(".preflight-content").evaluate((content) => {
      const stage = content.querySelector(".preflight-stage");
      const footer = content.querySelector(".preflight-footer");
      stage.scrollTop = stage.scrollHeight;
      return {
        scale: getComputedStyle(content).zoom,
        bottom: footer.getBoundingClientRect().bottom,
        viewport: window.innerHeight,
        stageBottom: stage.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
      };
    });
    if (sameSize)
      assert.ok(
        Number(layout.scale) <= sharedScale,
        "Larger steps can only lower the shared scale ceiling",
      );
    assert.ok(
      Math.abs(layout.bottom - layout.viewport) < 2,
      "Navigation stays at the viewport bottom",
    );
    assert.ok(
      layout.stageBottom <= layout.footerTop + 1,
      "Scrolled content cannot cover navigation",
    );
  };

  await tabTo(page, "Start preflight");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Not found")).toHaveCount(3, { timeout: 20000 });
  await assertFooter();
  await tabTo(page, "Continue");
  await page.keyboard.press("Enter");
  // The private HOME has no code folders, so the picker is the way in.
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByText("1 of 1 selected").waitFor();
  await assertFooter();
  for (const heading of [
    "Where should new worktrees go?",
    "How should Foom read a terminal that goes quiet?",
    "Hold. Something needs fixing.",
  ]) {
    await tabTo(page, "Continue");
    await page.keyboard.press("Enter");
    await page.getByText(heading).waitFor();
    await assertFooter();
    if (heading.startsWith("How should")) {
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(800, 600);
        window.webContents.setZoomFactor(1.5);
      });
      await assertFooter(false);
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Back", exact: true })).toBeInViewport();
      await app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.webContents.setZoomFactor(1);
        const available = screen.getPrimaryDisplay().workAreaSize;
        window.setSize(Math.min(1600, available.width), Math.min(1000, available.height));
      });
    }
  }
  await expect(page.getByRole("button", { name: "Launch" })).toBeDisabled();
  await page.getByRole("button", { name: "Fix" }).click();

  // Install all three, then scan again.
  const script = (body) => `#!/usr/bin/env node\nconst a = process.argv[2];\n${body}\n`;
  const agents = {
    claude: script(
      'if (a === "--version") console.log("2.1.300 (Claude Code)"); else console.log("  --settings <file-or-json>");',
    ),
    codex: script(
      'if (a === "--version") console.log("codex-cli 0.155.1"); else console.log("  -c, --config <key=value>");',
    ),
    agy: script('if (a === "--version") console.log("1.2.13");'),
  };
  for (const [name, source] of Object.entries(agents)) {
    await writeFile(path.join(bin, name), source);
    await chmod(path.join(bin, name), 0o755);
  }
  await page.getByRole("button", { name: "Scan again" }).click();
  await expect(page.getByText("Found", { exact: true })).toHaveCount(3, { timeout: 20000 });
  await expect(page.locator(".badge-value")).toHaveText(["2.1.300", "0.155.1", "1.2.13"]);
  for (const name of ["Hooks", "Notify", "Evaluator"])
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  // Where each agent was found is a tooltip away, by keyboard as well as pointer.
  // Park the pointer away from the cards, so a hover can't win over keyboard focus.
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: "codex", exact: true }).focus();
  await expect(page.getByRole("tooltip")).toContainText(`Found at ${path.join(bin, "codex")}`);
  await expect
    .poll(() =>
      page.getByRole("button", { name: "codex", exact: true }).evaluate((trigger) => {
        const bubble = document.querySelector('[role="tooltip"]:not([hidden])');
        const bounds = bubble.getBoundingClientRect();
        return Math.abs(bounds.top - trigger.getBoundingClientRect().bottom - 6);
      }),
    )
    .toBeLessThan(2);
  await assertPreflightFits(page, "Tooltip outside the scaled layout");
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.getByRole("button", { name: /Go \/ no-go/ }).click();
  await page.getByText("All stations go.").waitFor();
  await assertAccessible(page);
  await tabTo(page, "Launch");
  await page.keyboard.press("Enter");

  // Reduced motion shows a still frame, then the board.
  await page.getByText("Takeoff was faster than expected.").waitFor();
  await page.getByRole("button", { name: "Local shell", exact: true }).press("Enter");
  const shellRow = page.locator(".board-row[data-kind='shell']");
  await shellRow.waitFor({ timeout: 10000 });
  const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
  assert.deepEqual(saved.settings, {
    codexNotifierAcknowledged: false,
    setupComplete: true,
    hooks: true,
    agents: { claude: true, codex: true, agy: true },
    worktreeLocation: "root",
    inference: { kind: "rules" },
    inferenceTimeoutMs: 5000,
    colorMode: "system",
    interfaceTheme: "follow",
    interfaceScale: 100,
    terminalFontSize: 14,
    terminalTheme: "follow",
    sound: {
      soundscape: "drive",
      working: false,
      workingVolume: 0.15,
      alerts: true,
      alertVolume: 0.5,
    },
    codeFolder: await realpath(repo),
  });

  // Preflight can run again over the board; Escape returns to the same row.
  await shellRow.focus();
  await page.getByRole("button", { name: "Preflight" }).click();
  await page.getByRole("button", { name: "Start preflight" }).waitFor();
  await expect(page.locator(".board-home")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator(".board-home")).toBeVisible();
  assert.equal(await shellRow.evaluate((row) => row === document.activeElement), true);
});

test("Run check streams live progress from a local model server, then saves the source", async (context) => {
  const { createServer } = require("node:http");
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
  // A stand-in for Ollama that keeps "thinking" until the test has seen live progress.
  const server = createServer(async (request, response) => {
    if (request.url === "/api/version") return response.end('{"version":"9.9.9"}');
    if (request.url === "/api/ps") return response.end('{"models":[]}');
    if (request.url === "/v1/models") return response.end('{"data":[{"id":"fake:1b"}]}');
    if (request.url !== "/v1/chat/completions") return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk({ reasoning: "Considering" }));
    await released;
    response.write(chunk({ content: '{"state":"needs_input","confidence":0.9}' }));
    response.end(`${chunk({}, "stop")}data: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    // A failed assertion must not leave a streaming request holding teardown open.
    release();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  // launchApp owns this profile and removes it only after Electron exits.
  const app = await launchApp(context, false, { firstRun: true });
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Start preflight" }).click();
  for (let step = 0; step < 3; step++) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Use a local model/ }).check();
  await page.getByRole("textbox", { name: "Endpoint" }).fill(endpoint);
  await page.getByRole("combobox", { name: "Model" }).fill("fake:1b");
  await page.getByText("Ollama 9.9.9 · 1 model").waitFor();
  await page.getByRole("button", { name: "Run check" }).click();

  // These arrive while the check is still running.
  const steps = page.getByRole("list", { name: "Check steps" });
  await steps.getByText("fake:1b is available").waitFor();
  await steps.getByText("Thinking").waitFor();
  await page.getByText("Thinking: 1 chunk").waitFor();
  await assertPreflightFits(page, "Streaming evaluator output");
  await expect(page.getByRole("progressbar", { name: "Time limit" })).toBeVisible();
  await assertAccessible(page);
  release();

  await page.getByText(/needs_input · confidence 0\.90 in .*Foom will use this source/).waitFor();
  await expect(steps.getByText("Loaded fake:1b")).toBeVisible();
  await page.getByText("Details", { exact: true }).click();
  await assertPreflightFits(page, "Expanded evaluator request and reply details");
  const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
  assert.deepEqual(saved.settings.inference, { kind: "local", model: "fake:1b", endpoint });

  // A closed port fails at the first step, in plain words.
  await page.getByRole("textbox", { name: "Endpoint" }).fill("http://127.0.0.1:59999/v1");
  await page.getByRole("button", { name: "Run check" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Connection refused: nothing is listening on 127.0.0.1:59999" })
    .waitFor();
});

test("appearance switches light and dark, and zoom shortcuts resize the interface", async (context) => {
  const app = await launchApp(context, false, { firstRun: true });
  const page = await app.firstWindow();
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
            .locator(".noise-tile")
            .evaluateAll((tiles) => tiles.map((tile) => getComputedStyle(tile).backgroundColor)),
        { message: "Row backgrounds must switch with text" },
      )
      .toEqual(Array(10).fill(surface));
  }
  await page.emulateMedia({ colorScheme: null });
  const dark = () => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const background = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

  await page.getByRole("radio", { name: "Dark" }).check();
  await expect.poll(dark).toBe(true);
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), "dark");
  await expect.poll(background).toBe("rgb(5, 4, 10)");
  await assertAccessible(page);
  await page.getByRole("radio", { name: "Light" }).check();
  await expect.poll(dark).toBe(false);
  await expect.poll(background).toBe("rgb(243, 240, 250)");

  const zoom = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    );
  const press = (keyCode, shift) =>
    app.evaluate(
      ({ BrowserWindow }, { keyCode, shift, mac }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.focus();
        const modifiers = mac ? ["meta"] : ["control", ...(shift ? ["shift"] : [])];
        for (const type of ["keyDown", "keyUp"])
          window.webContents.sendInputEvent({ type, keyCode, modifiers });
      },
      { keyCode, shift, mac: process.platform === "darwin" },
    );
  const size = () =>
    app.evaluate(({ BrowserWindow }) => {
      const { width, height } = BrowserWindow.getAllWindows()[0].getBounds();
      return { width, height };
    });
  const start = await size();
  const grown = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
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
  await press("0", false);
  await expect.poll(zoom).toBeCloseTo(1);
  await page.getByText("100%").waitFor();
  // And returns to exactly its starting size.
  await expect.poll(size).toEqual(start);
  await assertAccessible(page);
});

test("preflight scans a code folder and adds the repositories worked on recently", async (context) => {
  const { utimes } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-code-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const code = path.join(root, "code");
  const old = new Date(Date.now() - 90 * 86_400_000);
  for (const [name, stale] of [
    ["recent-app", false],
    [path.join("clients", "portal"), false],
    ["dusty", true],
  ]) {
    const repo = path.join(code, name);
    await mkdir(repo, { recursive: true });
    isolatedGit(["init", "-q", "-b", "main", repo]);
    if (stale) await utimes(path.join(repo, ".git", "HEAD"), old, old);
  }
  const app = await launchApp(context, false, { firstRun: true });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, code);
  await page.getByRole("button", { name: "Start preflight" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByText("2 of 3 selected").waitFor();
  const recent = page.getByRole("region", { name: "Recent · last 30 days" });
  await expect(recent.getByRole("checkbox")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Older" }).getByRole("checkbox")).not.toBeChecked();
  await assertAccessible(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Where should new worktrees go?").waitFor();
  await assertAccessible(page);
  const added = await page.evaluate(async () =>
    (await window.desktop.workspace()).repositories.map((repo) => repo.name).sort(),
  );
  assert.deepEqual(added, ["portal", "recent-app"]);
});

test("new worktree dialog launches by keyboard and confirms dirty removal", {
  timeout: 60000,
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-launch-ui-"));
  const repo = path.join(root, "app");
  const bin = path.join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await mkdir(path.join(root, "home"));
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: repo },
  );
  if (process.platform !== "win32") {
    await writeFile(path.join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  }
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: {
      HOME: path.join(root, "home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FOOM_FAKE_CREDENTIALS: path.join(root, "fake-hook.json"),
    },
  }).finally(() => {
    // Hooks run in registration order. Close Electron before deleting the second
    // worktree: a live PowerShell process holds its working directory on Windows.
    context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  });
  const page = await app.firstWindow();
  const tabToField = async (id, reverse = false) => {
    for (let step = 0; step < 40; step++) {
      await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
      if ((await page.evaluate(() => document.activeElement?.id)) === id) return;
    }
    throw new Error(`Could not reach ${id} by keyboard`);
  };
  await page.getByRole("button", { name: "New worktree", exact: true }).waitFor();
  await expect(page.locator(".board-row")).toHaveCount(0);
  await page.evaluate(() => window.desktop.saveSetup({ worktreeLocation: "adjacent" }));
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await tabTo(page, "New worktree");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add repository…" })).toBeEnabled();
  await tabTo(page, "Add repository…");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Repository", { exact: true })).not.toHaveValue("");
  await tabToField("worktree-branch");
  await expect(page.getByLabel("Branch")).toBeFocused();
  await page.keyboard.type("--bad");
  await tabTo(page, "Create and start");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Invalid branch");
  // Return to the branch field entirely by keyboard.
  await tabToField("worktree-branch", true);
  await expect(page.getByLabel("Branch")).toBeFocused();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("feature/ui");
  if (process.platform !== "win32") {
    await tabToField("worktree-run");
    await expect(page.getByLabel("Run")).toBeFocused();
    // Native select type-ahead works without opening an OS-owned popup.
    await page.keyboard.press("c");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Run")).toHaveValue("claude");
  }
  await assertAccessible(page);
  await tabTo(page, "Create and start");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page.locator(".board-row").filter({ hasText: "feature/ui" });
  await expect(row).toBeVisible();
  const launched = await page.evaluate(() => window.desktop.workspace());
  const terminal = launched.terminals[0];
  assert.ok(terminal);
  if (process.platform !== "win32") {
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 5), terminal.id))
      .toContain("FOOM_AGENT_READY");
  }
  const remaining = await page.evaluate(
    (repository) =>
      window.desktop.startWorktree({
        repository,
        branch: "feature/remaining",
        run: "shell",
        acknowledgeCodexNotifierReplacement: false,
      }),
    terminal.repository,
  );
  await row.click();
  await expect(page.locator("#terminal")).toBeVisible();
  const dirty = path.join(terminal.worktree, "unsaved.txt");
  await writeFile(dirty, "preserve unless confirmed");
  await app.evaluate(({ dialog }) => {
    globalThis.removalOptions = null;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.removalOptions = options;
      return { response: 0 };
    };
  });
  await page.getByRole("button", { name: "Actions for feature/ui", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.removalOptions?.detail))
    .toContain("unsaved.txt");
  assert.equal(await readFile(dirty, "utf8"), "preserve unless confirmed");
  await expect(row).toBeVisible();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await page.getByRole("button", { name: "Actions for feature/ui", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await expect(row).toHaveCount(0);
  await assert.rejects(readFile(dirty), { code: "ENOENT" });
  await page.locator(".board-row").filter({ hasText: "feature/remaining" }).click();
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("echo FOOM_REMAINING_TERMINAL");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 10), remaining))
    .toContain("FOOM_REMAINING_TERMINAL");

  assert.equal(
    isolatedGit(["branch", "--list", "feature/ui"], { cwd: repo }).toString().trim(),
    "feature/ui",
  );
});

test("external worktrees offer confirmed removal while preserving branches and the main checkout", {
  timeout: 45000,
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-external-removal-"));
  const repo = path.join(root, "repo");
  const external = path.join(root, "external");
  await mkdir(repo);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: repo },
  );
  isolatedGit(["worktree", "add", "-b", "external", external], { cwd: repo });
  const dirty = path.join(external, "unsaved.txt");
  await writeFile(dirty, "keep until confirmed");
  const app = await launchApp(context, false, { emptyBoard: true }).finally(() => {
    context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    globalThis.removalOptions = null;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.removalOptions = options;
      return { response: 0 };
    };
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const row = page.getByRole("button", { name: "Actions for external", exact: true });
  await row.click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.removalOptions?.detail))
    .toContain("unsaved.txt");
  assert.equal(await readFile(dirty, "utf8"), "keep until confirmed");
  await expect(row).toBeVisible();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await row.click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await expect(row).toHaveCount(0);
  await assert.rejects(readFile(dirty), { code: "ENOENT" });
  assert.equal(
    isolatedGit(["branch", "--list", "external"], { cwd: repo }).toString().trim(),
    "external",
  );
  await page.getByRole("button", { name: "Actions for Main checkout", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Remove worktree…" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
  await expect(
    page.getByRole("heading", { name: "repo › Main checkout › Shell", exact: true }),
  ).toBeVisible();
  const checkout = page.getByRole("button", { name: "Main checkout", exact: true });
  await expect(checkout.locator(".tree-checkout-branch")).toHaveText("main");
  await expect(
    page.getByRole("treeitem", { name: "Main checkout", exact: true }).locator(".board-row"),
  ).toHaveCount(1);
  if (process.env.FOOM_SCREENSHOTS) {
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: path.join(tmpdir(), `foom-main-checkout-${colorScheme}.png`) });
    }
  }
});

test("external worktrees support independent shells and confirmed shared agents", {
  timeout: 60000,
}, async (context) => {
  // macOS temp aliases and Windows short/case-normalized paths differ from Git's inventory.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-external-launch-")));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await mkdir(path.join(root, "home"));
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const external = path.join(root, "external");
  const detached = path.join(root, "detached");
  const agentTree = path.join(root, "agent");
  git("worktree", "add", "-b", "external", external);
  git("worktree", "add", "--detach", detached);
  git("worktree", "add", "-b", "agent", agentTree);
  if (process.platform !== "win32") {
    await writeFile(
      path.join(bin, "claude"),
      FAKE_CLAUDE.replace(
        "const settings =",
        'process.stdout.write("CWD:" + process.cwd() + "\\r\\n");\nconst settings =',
      ),
      { mode: 0o755 },
    );
  }
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: {
      HOME: path.join(root, "home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FOOM_FAKE_CREDENTIALS: path.join(root, "fake-hook.json"),
    },
  }).finally(() => {
    context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  for (const [name, directory] of [
    ["external", external],
    ["Detached HEAD", detached],
  ]) {
    await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
    await expect(page.locator(".board-row").filter({ hasText: name })).toBeVisible();
    const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (t) => t.worktree === directory,
    );
    assert.ok(terminal);
    const command =
      process.platform === "win32"
        ? "[Console]::WriteLine(('CWD:' + (Get-Location).Path))"
        : "printf 'CWD:%s\\n' \"$PWD\"";
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "\r"), {
      id: terminal.id,
      command,
    });
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 20)).join(""), terminal.id),
      )
      .toContain(`CWD:${directory}`);
  }
  await app.evaluate(({ dialog }) => {
    globalThis.sharingPrompts = [];
    globalThis.allowSharing = false;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.sharingPrompts.push(options.message);
      return { response: globalThis.allowSharing ? 1 : 0 };
    };
  });
  const sharedSessions = () =>
    page.evaluate(
      async (worktree) =>
        (await window.desktop.workspace()).terminals.filter((t) => t.worktree === worktree),
      agentTree,
    );
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
    await expect.poll(async () => (await sharedSessions()).length).toBe(i + 1);
  }
  assert.deepEqual(await app.evaluate(() => globalThis.sharingPrompts), []);
  if (process.platform !== "win32") {
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
    await expect(page.locator(".board-row").filter({ hasText: "agent" })).toHaveCount(3);
    assert.deepEqual(await app.evaluate(() => globalThis.sharingPrompts), []);
    const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (t) => t.worktree === agentTree && t.kind === "agent",
    );
    assert.ok(terminal);
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 20)).join(""), terminal.id),
      )
      .toContain(`CWD:${agentTree}`);
    const anotherAgent = () =>
      page.evaluate(
        ({ repository, worktree }) =>
          window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "claude" }),
        { repository: repo, worktree: agentTree },
      );
    await anotherAgent();
    assert.equal((await sharedSessions()).length, 3, "Cancel must not create an agent");
    assert.deepEqual(await app.evaluate(() => globalThis.sharingPrompts), [
      "Run another agent in this checkout?",
    ]);
    await app.evaluate(() => {
      globalThis.allowSharing = true;
    });
    await anotherAgent();
    assert.equal((await sharedSessions()).filter((t) => t.kind === "agent").length, 2);
    assert.equal(await app.evaluate(() => globalThis.sharingPrompts.length), 2);
  }
  const shell = (await sharedSessions()).find((t) => t.kind === "shell");
  assert.ok(shell);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "stop", id }), shell.id);
  await expect
    .poll(async () => (await sharedSessions()).find((t) => t.id === shell.id)?.exited)
    .toBe(true);
  const promptsBeforeRestart = await app.evaluate(() => globalThis.sharingPrompts.length);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "restart", id }), shell.id);
  assert.equal((await sharedSessions()).filter((t) => t.kind === "shell").length, 2);
  assert.ok((await sharedSessions()).every((t) => t.id !== shell.id));
  assert.equal(await app.evaluate(() => globalThis.sharingPrompts.length), promptsBeforeRestart);
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  assert.ok(
    inventory.repositories[0].worktrees.every((tree) => !tree.managed),
    "Launching must not adopt external checkouts",
  );
  await app.evaluate(() => {
    globalThis.allowSharing = true;
  });
  await page.evaluate(
    ({ repository, worktree }) =>
      window.desktop.sidebarCommand({ kind: "remove-worktree", repository, worktree }),
    { repository: repo, worktree: agentTree },
  );
  assert.deepEqual(await sharedSessions(), []);
  await assert.rejects(realpath(agentTree), { code: "ENOENT" });
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 2);
});

test("persistent sidebar keeps Escape in the PTY and routes keyboard navigation", {
  timeout: 45000,
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-input-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "keys");
  await writeFile(marker, "");
  const app = await launchApp(context);
  const page = await app.firstWindow();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  // Establish the startup verdict first, including on faster runners.
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  await page.keyboard.press("Escape");
  await expect.poll(() => readFile(marker, "utf8")).toContain("1b\n");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+n");
  await expect.poll(() => readFile(marker, "utf8")).toContain("02");
  await expect.poll(() => readFile(marker, "utf8")).toContain("0e");
  await expect(page.locator("#terminal")).toBeVisible();
  await boardCommand(app, "B");
  await expect(page.locator(".board-row")).toBeFocused();
  await expect(page.locator(".board-peek")).toContainText("INPUT_READY");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const screen = page.locator(".xterm-screen");
  await screen.hover();
  // Earlier keystrokes can clear the initial prompt before slow runners reach here.
  // Ask the probe for fresh evidence rather than relying on its startup debounce.
  await page.keyboard.type("p");
  await expect
    .poll(() => page.locator(".board-row").getAttribute("data-state"))
    .toBe("needs_input");
  const verdictLog = path.join(
    await app.evaluate(({ app }) => app.getPath("userData")),
    "verdicts.jsonl",
  );
  const feedbackBefore = (await readFile(verdictLog, "utf8"))
    .split("\n")
    .filter((line) => line.includes('"action"'));
  await page.mouse.wheel(0, 56);
  await expect.poll(() => readFile(marker, "utf8")).toContain("1b5b42");
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  assert.deepEqual(
    (await readFile(verdictLog, "utf8")).split("\n").filter((line) => line.includes('"action"')),
    feedbackBefore,
  );
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "working");
  await page.keyboard.type("m");
  await expect(page.locator(".xterm-rows")).toContainText("MOUSE_READY");
  await writeFile(marker, "");
  await page.mouse.wheel(0, -56);
  await expect.poll(() => readFile(marker, "utf8")).toContain("1b5b3c");
  assert.doesNotMatch(await readFile(marker, "utf8"), /1b5b41|1b4f41/);
  await assertAccessible(page);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // Exercise compact layouts as on a display smaller than the normal minimum.
    window.setMinimumSize(0, 0);
    window.setSize(640, 600);
  });
  await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
  await expect
    .poll(() => page.locator(".board-list").evaluate((el) => el.getBoundingClientRect().width))
    .toBe(64);
  await assertAccessible(page);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("q");
});

test("wheel moves less and preserves normal shell scrollback", {
  timeout: 30000,
  skip: process.platform === "win32" && "less is a POSIX pager",
}, async (context) => {
  const app = await launchApp(context);
  const page = await app.firstWindow();
  await page.evaluate(() => {
    window.pagerOutput = "";
    window.desktop.onData((_id, _token, data) => {
      window.pagerOutput = (window.pagerOutput + data).slice(-8192);
    });
  });
  const rows = page.locator(".xterm-rows");
  // View focus does not guarantee that the login shell has finished initializing.
  // Start a fresh line so an unechoed command cannot leave the marker after the prompt.
  await page.keyboard.type("printf '\\nFOOM_%s\\n' PAGER_READY");
  await page.keyboard.press("Enter");
  await expect(
    rows.locator(":scope > div").filter({ hasText: /^FOOM_PAGER_READY\s*$/ }),
  ).toHaveCount(1);
  // Login-shell exports must not override the PTY dimensions or alternate screen.
  await page.keyboard.type("seq 1 300 | env -u LINES -u COLUMNS -u LESS less");
  await page.keyboard.press("Enter");
  try {
    await expect.poll(() => rows.locator(":scope > div").first().textContent()).toMatch(/^1\s*$/);
    // The first row can paint before less finishes entering its interactive mode.
    // Its bottom prompt is the readiness boundary for sending wheel-generated keys.
    await expect(rows.locator(":scope > div").last())
      .toHaveText(/^\s*:\s*$/)
      .catch(async (error) => {
        console.error("Pager readiness failed", await rows.innerText());
        throw error;
      });
    await page.locator(".xterm-screen").hover();
    await page.mouse.wheel(0, 140);
    await expect
      .poll(() => rows.locator(":scope > div").first().textContent())
      .not.toMatch(/^1\s*$/);
  } catch (error) {
    console.error("Pager screen", await rows.innerText());
    console.error("Pager stream", JSON.stringify(await page.evaluate(() => window.pagerOutput)));
    throw error;
  }
  await page.keyboard.type("q");
  await page.keyboard.type("seq 1 300");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("300");
  const before = await rows.textContent();
  await page.mouse.wheel(0, -500);
  await expect.poll(() => rows.textContent()).not.toBe(before);
});

test("empty sidebar and terminal pane stay accessible at both widths", async (context) => {
  const app = await launchApp(context, false, { emptyBoard: true });
  const page = await app.firstWindow();
  for (const width of [1000, 640]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(0, 0);
      window.setSize(width, 600);
    }, width);
    await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New worktree", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Terminal pane" })).toContainText("New worktree");
    await assertAccessible(page);
  }
});

test("fake Codex receives inline flag only when help advertises it", {
  timeout: 30000,
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-inline-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
  const help = path.join(root, "help");
  const cli = path.join(bin, "codex");
  await writeFile(
    cli,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('codex-cli 0.159.3');
else if (process.argv[2] === '--help') console.log(fs.readFileSync(${JSON.stringify(help)}, 'utf8'));
else console.log('ARGS:' + JSON.stringify(process.argv.slice(2)));
`,
  );
  await chmod(cli, 0o755);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: repo },
  );
  await writeFile(help, "--no-alt-screen");
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: { HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.equal(repository.path, await realpath(repo));
  await expect(page.getByRole("treeitem", { name: "repo", exact: true })).toBeVisible();
  for (const supported of [true, false]) {
    await writeFile(help, supported ? "--no-alt-screen" : "--no-alt-screen-extra");
    const id = await page.evaluate(
      async ({ repo, branch }) => {
        await window.desktop.scanAgents(true);
        const tree = await window.desktop.createWorktree(repo, branch, "adjacent");
        return (
          await window.desktop.launchAgent({
            agent: "codex",
            repository: repo,
            worktree: tree.path,
            cols: 80,
            rows: 24,
          })
        ).id;
      },
      { repo: repository.path, branch: supported ? "inline" : "fullscreen" },
    );
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
      .toContain(supported ? 'ARGS:["--no-alt-screen"]' : "ARGS:[]");
  }
});

test("Settings shares live preflight values, sizes the terminal and restores keyboard focus", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-settings-repositories-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const repository = path.join(root, "settings-example");
  await mkdir(repository);
  isolatedGit(["init", "-q", repository]);
  const app = await launchApp(context);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  const page = await app.firstWindow();
  const shortcut = () => boardCommand(app, ",", false);
  const row = page.locator('.board-row[data-kind="shell"]');
  await boardCommand(app, "B");
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await page.locator(".xterm-helper-textarea").waitFor();
  await shortcut();
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Terminal pane" })).toBeHidden();
  const tabToControl = async (control) => {
    for (let step = 0; step < 50; step++) {
      await page.keyboard.press("Tab");
      if (await control.evaluate((element) => document.activeElement === element)) return;
    }
    throw new Error("Settings control is not reachable with Tab");
  };
  const nextSelectOption = async (control, value) => {
    await tabToControl(control);
    if (process.platform === "darwin") {
      // macOS native select popups do not consume synthetic web keyboard events:
      // https://github.com/electron/electron/issues/12513
      // Still verify Tab reachability, DOM change handling, and persistence here;
      // Linux and Windows exercise selection entirely through the keyboard.
      await control.selectOption(value);
    } else {
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
    }
    await expect(control).toHaveValue(value);
    await page.keyboard.press("Tab");
  };
  const section = async (name) => {
    await tabTo(page, name);
    await page.keyboard.press("Enter");
  };
  const hooks = page.getByLabel("Attach Foom's hooks when it launches an agent", { exact: false });
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
  await section("Worktrees");
  await tabToControl(page.getByRole("radio", { name: /Keep worktrees/ }));
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.worktreeLocation),
    )
    .toBe("adjacent");
  await section("Evaluator");
  await tabToControl(page.getByRole("radio", { name: /Rules only/ }));
  await page.keyboard.press("ArrowUp");
  await nextSelectOption(page.getByLabel("Time limit"), "10000");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.inferenceTimeoutMs),
    )
    .toBe(10000);
  await section("Appearance");
  await tabToControl(page.getByRole("radio", { name: "System", exact: true }));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await tabTo(page, "+");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "110%" })).toBeVisible();
  await section("Terminal");
  const font = page.getByLabel("Terminal font size");
  await nextSelectOption(font, "15");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalFontSize),
    )
    .toBe(15);
  await page.keyboard.press("Escape");

  await expect(row).toBeFocused();
  await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "15px");
  await page.getByRole("button", { name: "Preflight", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "110%" })).toBeVisible();
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await page.getByRole("button", { name: "Larger", exact: true }).click();
  await page.keyboard.press("Escape");
  await shortcut();
  await section("Appearance");
  await expect(page.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "120%" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
});

test("every Settings section passes axe in light and dark, including the narrow layout", async (context) => {
  const app = await launchApp(context, false);
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const name of [
    "Agents and hooks",
    "Repositories",
    "Worktrees",
    "Evaluator",
    "Appearance",
    "Terminal",
    "Themes",
    "Sound",
  ]) {
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true })
      .click();
    await assertAccessible(page);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // Exercise compact layouts as on a display smaller than the normal minimum.
    window.setMinimumSize(0, 0);
    window.setSize(640, 640);
  });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await assertAccessible(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test("window size defaults to 60 percent and survives a normal quit and relaunch", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-window-size-"));
  context.after(() => rm(profile, { recursive: true, force: true, maxRetries: 5 }));
  const options = { args: [`--user-data-dir=${profile}`], emptyBoard: true };
  const app = await launchApp(context, false, options);
  const initial = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const area = screen.getPrimaryDisplay().workAreaSize;
    return { size: window.getSize(), area };
  });
  assert.deepEqual(initial.size, [
    Math.min(initial.area.width, Math.max(900, Math.round(initial.area.width * 0.6))),
    Math.min(initial.area.height, Math.max(640, Math.round(initial.area.height * 0.6))),
  ]);
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workAreaSize;
    BrowserWindow.getAllWindows()[0].setSize(
      Math.min(1200, area.width),
      Math.min(850, area.height),
    );
  });
  const size = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getSize(),
  );
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, "window-size.json"), "utf8")), {
    width: size[0],
    height: size[1],
  });
  const restored = await launchApp(context, false, options);
  assert.deepEqual(
    await restored.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()),
    size,
  );
  await quitAndWait(restored, () => restored.evaluate(({ app }) => app.quit()));
});

test("sidebar menus escape the scroll area, stay in the window and launch from a worktree", {
  timeout: 60000,
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-sidebar-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  isolatedGit(["init", "-q", "-b", "main"], { cwd: repo });
  isolatedGit(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: repo },
  );
  const app = await launchApp(context, false, { emptyBoard: true }).finally(() => {
    context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog, BrowserWindow }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    BrowserWindow.getAllWindows()[0].setSize(1000, 700);
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "repo", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const repository = (await window.desktop.workspace()).repositories[0];
    if (!repository) throw new Error("Missing registered repository");
    for (let i = 0; i < 18; i++)
      await window.desktop.createWorktree(
        repository.path,
        `feature/row-${String(i).padStart(2, "0")}`,
        "adjacent",
      );
  });
  // A reload also verifies the registered repository and its empty worktrees survive.
  await page.reload();
  const bottom = page.getByRole("button", { name: "Actions for feature/row-17", exact: true });
  await bottom.scrollIntoViewIfNeeded();
  await bottom.click();
  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  const anchor = await bottom.boundingBox();
  assert.ok(box && anchor);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box.x >= anchor.x + anchor.width, "menu opens to the right over the pane");
  assert.ok(
    box.y >= 0 && box.y + box.height <= viewport.height && box.x + box.width <= viewport.width,
  );
  assert.equal(await menu.evaluate((element) => element.closest(".board-list")), null);
  await assertAccessible(page);
  if (process.env.FOOM_SCREENSHOTS) {
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.screenshot({ path: path.join(tmpdir(), `foom-sidebar-${colorScheme}.png`) });
    }
  }

  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Remove worktree…" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: /^Shell \(/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(bottom).toBeFocused();
  await bottom.click();
  await page.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(page.locator(".board-row").filter({ hasText: "feature/row-17" })).toBeVisible();
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.equal(snapshot.terminals[0].branch, "feature/row-17");
  // Long previews remain passive and bounded, without an inaccessible scroll region.
  const previewCommand =
    process.platform === "win32"
      ? "1..40 | ForEach-Object { 'peek-line' }"
      : "printf 'peek-line\\n%.0s' {1..40}";
  await page.evaluate(({ id, command }) => window.desktop.input(id, command + "\r"), {
    id: snapshot.terminals[0].id,
    command: previewCommand,
  });
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.desktop.tail(id, 40)).filter((line) => line.includes("peek-line")).length,
        snapshot.terminals[0].id,
      ),
    )
    .toBeGreaterThan(20);
  const launchedRow = page.locator(".board-row");
  const filter = page.getByLabel("Filter repositories and sessions");
  await filter.fill("row");
  const label = page
    .getByRole("button", { name: "feature/row-17", exact: true })
    .locator(".tree-label");
  await expect(label).toHaveText("feature/row-17");
  await expect(label.locator("mark")).toHaveText("row");
  // Highlight fragments flow as text within one label, without flex gaps.
  await expect(label).toHaveCSS("display", "block");
  await filter.fill("");
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await launchedRow.focus();
    const accent = await page.locator(".sidebar-shell").evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(launchedRow).toHaveCSS("outline-color", accent);
    await expect(launchedRow).toHaveCSS("outline-style", "solid");
    const peek = page.getByRole("complementary", { name: "Terminal peek" });
    await expect(peek).toBeVisible();
    await expect(peek).toHaveCSS("overflow", "clip");
    await assertAccessible(page);
    const peekBox = await peek.boundingBox();
    const sidebarBox = await page.locator(".sidebar-shell").boundingBox();
    assert.ok(
      peekBox && sidebarBox && peekBox.x >= sidebarBox.x + sidebarBox.width,
      "peek stays in the terminal pane",
    );
    await launchedRow.press("Enter");
    await page.getByRole("region", { name: "Terminal pane" }).focus();
    await expect(launchedRow).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator('.board-entry[data-selected="true"]')).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    const rowBox = await launchedRow.boundingBox();
    const headerBox = await page.locator(".sidebar-shell .board-top").boundingBox();
    assert.ok(rowBox && rowBox.height <= 50, "session keeps two compact readable lines");
    assert.ok(headerBox && headerBox.height <= 100, "header preserves tree space");
    await expect(launchedRow.locator(".board-reason")).toHaveCSS("font-size", "12px");
    await expect(launchedRow.locator(".board-reason")).toHaveCSS("white-space", "nowrap");
    if (process.env.FOOM_SCREENSHOTS)
      await page.screenshot({
        path: path.join(tmpdir(), `foom-review-session-${colorScheme}.png`),
      });
  }

  await bottom.click();
  await page.locator(".board-list").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  await page.getByRole("button", { name: "Collapse repo", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand repo", exact: true })).toBeVisible();
  await expect(page.getByLabel("Pinned")).toBeVisible();
  await page.getByRole("button", { name: "Expand repo", exact: true }).click();
  const session = page.locator(".board-row");
  await session.locator(".session-name").dblclick();
  await assertAccessible(page);
  await page.getByRole("textbox", { name: "Session name", exact: true }).fill("Build helper");
  await page.getByRole("textbox", { name: "Session name", exact: true }).press("Enter");
  await page.reload();
  await page.getByLabel("Filter repositories and sessions").fill("build helper");
  await expect(page.locator(".board-row")).toContainText("Build helper");
  await assertAccessible(page);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // Use interface scaling: macOS can retain the native minimum window width.
    window.setSize(960, 700);
    window.webContents.setZoomFactor(1.5);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(720);
  await expect(page.getByRole("button", { name: "Actions for repo", exact: true })).toHaveCount(0);
  await expect(page.locator(".board-row")).toHaveCount(1);
  await page.getByRole("button", { name: "Actions for Build helper in feature/row-17" }).focus();
  const compactAction = await page
    .getByRole("button", { name: "Actions for Build helper in feature/row-17" })
    .boundingBox();
  const compactLight = await page.locator(".board-row .board-light").boundingBox();
  assert.ok(
    compactAction && compactLight && compactAction.x >= compactLight.x + compactLight.width + 4,
    "compact action clears the light and its attention halo",
  );
  if (process.env.FOOM_SCREENSHOTS)
    await page.screenshot({ path: path.join(tmpdir(), "foom-review-compact.png") });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Stop shell" })).toBeFocused();
  await page.keyboard.press("Escape");
  await assertAccessible(page);
});

test("Bash command status reaches the sidebar without closing the shell", {
  timeout: 30_000,
  skip: process.platform !== "linux" && "Requires Bash 4.4 or newer",
}, async (context) => {
  const app = await launchApp(context, true, { env: { SHELL: "/bin/bash" } });
  const page = await app.firstWindow();
  const row = page.locator(".board-row[data-kind='shell']");
  await expect(row).toContainText("Shell is ready");
  await expect(row).toHaveAttribute("data-state", "quiet_ok");
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  await page.keyboard.type("sleep 1");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-state", "working");
  await expect(row).toHaveAttribute("data-state", "done");
  await page.keyboard.type("false");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-state", "failed");
  await page.waitForTimeout(2500);
  await expect(row).toHaveAttribute("data-state", "failed");
  await page.keyboard.type("echo next");
  await expect(row).toHaveAttribute("data-state", "failed");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-state", "done");
});

test("every interface theme applies live to native chrome and passes axe on board and Settings", {
  timeout: 55000,
}, async (context) => {
  const app = await launchApp(context);
  const page = await app.firstWindow();
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
    await boardCommand(app, ",", false);
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
          BrowserWindow.getAllWindows()[0].getBackgroundColor(),
        )
      ).toLowerCase(),
      background,
    );
    await expect(
      page.getByRole("list", { name: "Terminal status previews" }).getByRole("listitem"),
    ).toHaveCount(6);
    await assertAccessible(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#terminal")).toBeVisible();
    await assertAccessible(page);
  }
  await boardCommand(app, ",", false);
  await page.getByRole("button", { name: "Themes", exact: true }).click();
  await page.getByRole("button", { name: /^System/ }).click();
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), "system");
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
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(0, 0);
    window.setSize(640, 640);
  });
  await assertAccessible(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test("soundscape sends one attention cadence and one completion to a fake audio sink", {
  timeout: 45000,
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-sound-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "keys");
  const app = await launchApp(context);
  const page = await app.firstWindow();
  await page.evaluate(() => {
    window.soundTones = [];
    window.AudioContext = class {
      currentTime = 0;
      state = "running";
      destination = {};
      createGain() {
        return {
          gain: {
            setValueAtTime() {},
            linearRampToValueAtTime() {},
            exponentialRampToValueAtTime() {},
          },
          connect() {},
          disconnect() {},
        };
      }
      createOscillator() {
        let frequency;
        return {
          frequency: {
            setValueAtTime(value) {
              frequency = value;
            },
          },
          connect() {},
          disconnect() {},
          start() {
            window.soundTones.push(frequency);
          },
          stop() {},
        };
      }
      close() {
        return Promise.resolve();
      }
    };
    window.soundTerminal = undefined;
    window.desktop.onData((id) => {
      window.soundTerminal = id;
    });
  });
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`,
  );
  await page.keyboard.press("Enter");
  // Hide the terminal before its verdict settles; settings keeps the source subscribed.
  await boardCommand(app, ",", false);
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  await expect.poll(() => page.evaluate(() => window.soundTones)).toEqual([880, 880]);
  await assertAccessible(page);
  assert.deepEqual(await page.evaluate(() => window.soundTones), [880, 880]);
  // Exit the real PTY: process exit is a Done verdict on every supported shell/platform.
  await page.evaluate(() => window.desktop.input(window.soundTerminal, "q"));
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.tail(window.soundTerminal, 40)).join("\n")),
    )
    .not.toContain("INPUT_READY");
  await page.evaluate(() => window.desktop.input(window.soundTerminal, "exit\r"));
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "done");
  await expect.poll(() => page.evaluate(() => window.soundTones)).toEqual([880, 880, 660]);
  await page.getByLabel("Alerts on", { exact: true }).uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.alerts),
    )
    .toBe(false);
});
