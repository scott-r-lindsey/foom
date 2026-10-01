const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { _electron: electron, expect } = require("@playwright/test");

async function assertAccessible(page) {
  // Electron does not support Target.createTarget. This app has no cross-origin frames.
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    // PTY output has arbitrary user/agent-selected ANSI colors. Keep the app chrome
    // and xterm input in scope, but do not audit external programs' rendered text.
    const results = await new AxeBuilder({ page }).setLegacyMode().exclude(".xterm-rows").analyze();
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
    args: [path.join(__dirname, ".."), ...profile.args],
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
  if (options.firstRun) return app;
  await page.locator(".board-row[data-kind='shell']").waitFor();
  // Report startup errors directly instead of timing out on a permanently disabled control.
  await expect
    .poll(() => page.locator("#status").textContent(), { timeout: 10000 })
    .not.toBe("Starting shell…");
  assert.doesNotMatch(await page.locator("#status").textContent(), /Unable|failed/);
  await expect(page.locator("#toggle-terminal")).toBeEnabled();
  if (openShell) {
    await page.locator(".board-row[data-kind='shell']").click();
    await expect(page.getByRole("button", { name: "Hide terminal", exact: true })).toBeEnabled();
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
        const width = area.width >= 1040 ? 1000 : 760;
        const height = Math.min(650, area.height - 40);
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
          "create",
          "attach",
          "detach",
          "kill",
          "input",
          "resize",
          "acknowledge",
          "tail",
          "onActivity",
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
      const { TerminalHostClient } = load("./build/terminal-host-client.js");
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
  for (const theme of ["light", "dark"]) {
    await app.evaluate(({ nativeTheme }, value) => {
      nativeTheme.themeSource = value;
    }, theme);
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

test("Hide and Open restore hidden fullscreen output across repeated view transitions", {
  timeout: 45000,
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-view-probe-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, "stage");
  const app = await launchApp(context);
  const page = await app.firstWindow();
  const hide = page.getByRole("button", { name: "Hide terminal", exact: true });
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
  await page.keyboard.press("Escape");
  await expect(open).toBeEnabled();
  await expect(open).toBeFocused();
  await expect(page.locator("#terminal")).toBeHidden();
  await page.evaluate(() => {
    window.viewChunks = 0;
    window.desktop.input(window.viewId, "a");
  });
  await expect.poll(() => readFile(marker, "utf8").catch(() => "pending")).toBe("alternate");
  assert.equal(await page.evaluate(() => window.viewChunks), 0);
  for (let cycle = 0; cycle < 4; cycle++) {
    await open.click();
    await expect(hide).toBeEnabled();
    await expect(rows).toContainText("ALTERNATE_HIDDEN_OUTPUT");
    await expect(rows).not.toContainText("NORMAL_VIEW_READY");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await hide.click();
    await expect(open).toBeEnabled();
  }
  await page.evaluate(() => window.desktop.input(window.viewId, "n"));
  await expect.poll(() => readFile(marker, "utf8")).toBe("normal");
  await open.click();
  await expect(hide).toBeEnabled();
  await expect(rows).toContainText("NORMAL_VIEW_READY");
  await expect(rows).toContainText("NORMAL_HIDDEN_OUTPUT");
  await expect(rows).not.toContainText("ALTERNATE_HIDDEN_OUTPUT");
  // Continue scrolling after restoration, including origin-relative positioning,
  // repeated attachments, and transitions between both buffers.
  for (const mode of ["a", "n", "a", "n"]) {
    await hide.click();
    await expect(open).toBeEnabled();
    await page.evaluate((key) => window.desktop.input(window.viewId, key), mode);
    await expect.poll(() => readFile(marker, "utf8")).toBe(mode === "a" ? "alternate" : "normal");
    for (const setup of ["s", "o"]) {
      await page.evaluate((key) => window.desktop.input(window.viewId, key), setup);
      await expect.poll(() => readFile(marker, "utf8")).toBe(setup);
      for (let cycle = 0; cycle < 3; cycle++) {
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
        await expect(open).toBeEnabled();
      }
    }
    await open.click();
    await expect(hide).toBeEnabled();
  }
  // Reopening restores interactive input as well as the screen.
  await page.keyboard.type("q");
});

test("board is home, routes attention with the keyboard and respects reduced motion", async (context) => {
  const app = await launchApp(context, false);
  const page = await app.firstWindow();
  const board = page.getByRole("main", { name: "Board" });
  const rows = board.locator(".board-row");
  await expect(rows).toHaveCount(11);
  await expect(page.locator("#terminal")).toBeHidden();
  await expect(rows.first()).toBeFocused();
  await assertAccessible(page);
  // An existing hover must not make the first keyboard peek toggle off.
  await rows.nth(2).hover();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("p");
  await expect(board.getByRole("complementary", { name: "Terminal peek" })).toBeVisible();
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("n");
  await expect(board.locator(".board-terminal")).toBeFocused();
  await expect(board.locator(".sample-terminal")).toContainText("Run npm test?");
  await expect(rows.nth(1)).toContainText("Needs you");
  await assertAccessible(page);
  await page.keyboard.press("Tab");
  await expect(board.getByRole("button", { name: "Back to board · Esc" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rows.nth(1)).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await board
      .locator('[data-state="checking"] .board-light')
      .evaluate((element) => getComputedStyle(element).animationName),
    "none",
  );
  assert.equal(
    await board
      .locator('[data-state="working"] .board-light')
      .first()
      .evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 1100));
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: path.join(__dirname, `../out/56-board-${colorScheme}.png`),
    });
  }
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: path.join(__dirname, `../out/56-open-${colorScheme}.png`) });
  }
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  const restart = page.getByRole("button", { name: "Restart shell" });
  await expect(restart).toBeEnabled();
  await restart.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rows.first()).toBeFocused();
});

test("ten sample rows receive 10 Hz activity without React commits", async (context) => {
  const app = await launchApp(context, false);
  const page = await app.firstWindow();
  await page.addInitScript(() => {
    window.boardCommits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: () => {
        window.boardCommits++;
      },
      onCommitFiberUnmount: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector("#toggle-terminal")?.disabled);
  await expect(page.locator('.board-row[data-kind="sample"]')).toHaveCount(10);
  const before = await page.evaluate(() => {
    window.activityMutations = 0;
    window.activityObserver = new MutationObserver((records) => {
      window.activityMutations += records.length;
    });
    for (const light of document.querySelectorAll('.board-row[data-kind="sample"] .board-light')) {
      window.activityObserver.observe(light, { attributes: true, attributeFilter: ["style"] });
    }
    return window.boardCommits;
  });
  assert.ok(before > 0, "React commit hook is active");
  await expect
    .poll(() => page.evaluate(() => window.activityMutations))
    .toBeGreaterThanOrEqual(100);
  assert.equal(await page.evaluate(() => window.boardCommits), before);
  await page.evaluate(() => window.activityObserver.disconnect());
});

test("renderer bundle contains production React without a Node process dependency", async () => {
  const bundle = await readFile(path.join(__dirname, "../build/renderer/renderer.js"), "utf8");
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
  } else if (input === "q") {
    process.exit(3);
  }
});
`;

test("launches an agent in a managed worktree and routes its attention signals", {
  timeout: 60_000,
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { execFileSync } = require("node:child_process");
  const { chmod, mkdir, writeFile } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Foom", "-c", "user.email=foom@example.com", ...args], {
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

  // Typing is the reply; then the agent's hook asks for permission.
  await page.evaluate((terminal) => window.desktop.input(terminal, "y"), id);
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
  const { verdictId } = await latest();
  await page.evaluate(
    ({ terminal, verdict }) => window.desktop.feedback(terminal, verdict, "dismissed"),
    { terminal: id, verdict: verdictId },
  );
  assert.equal((await latest()).signal, "user:dismissed");

  // Exit is final and revokes the launch's hook credentials.
  const hook = JSON.parse(await readFile(credentials, "utf8"));
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
    const { InferenceKeys } = load("./build/inference-keys.js");
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
  await page.locator("#toggle-terminal").focus();
  await page.waitForTimeout(1500);
  assert.equal((await latest()).state, "needs_input");

  await input.focus();
  await page.keyboard.type("y");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await latest())?.signal, { timeout: 10000 }).toBe("user:reply");
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
  // The accretion ring orbits, pauses while you're on it, and holds still for reduced motion.
  const ring = () =>
    page.getByRole("button", { name: "Start preflight" }).evaluate((button) => {
      const style = getComputedStyle(button);
      return `${style.animationName} ${style.animationPlayState}`;
    });
  assert.equal(await ring(), "ignite-orbit running");
  await page.getByRole("button", { name: "Start preflight" }).hover();
  assert.equal(await ring(), "ignite-orbit paused");
  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await ring(), "none running");
  await page.emulateMedia({ reducedMotion: null });
  await assertAccessible(page);
  await page.getByRole("button", { name: "Start preflight" }).click();
  await page.getByText("Which agents do you run?").waitFor();
  await expect(page.getByText("Looking…")).toHaveCount(0, { timeout: 20000 });
  await assertAccessible(page);
});

test("first run goes from no agents to go, launches by keyboard, and can be replayed", {
  timeout: 60_000,
  skip: process.platform === "win32" && "The fake agents are POSIX scripts",
}, async (context) => {
  const { execFileSync } = require("node:child_process");
  const { chmod, symlink } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-first-run-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const bin = path.join(root, "bin");
  const repo = path.join(root, "app");
  const userData = path.join(root, "user-data");
  await mkdir(bin);
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  execFileSync("git", ["init", "-q", repo]);
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

  await tabTo(page, "Start preflight");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Not found")).toHaveCount(3, { timeout: 20000 });
  await tabTo(page, "Continue");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Add one repository…" }).click();
  await page.getByText("Already added: app").waitFor();
  await tabTo(page, "Continue");
  await page.keyboard.press("Enter");
  await tabTo(page, "Continue");
  await page.keyboard.press("Enter");
  await page.getByText("Hold. Something needs fixing.").waitFor();
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
  await expect(page.locator(".preflight-tag")).toHaveText(["Hooks", "Notify", "Evaluator"]);
  await page.getByRole("button", { name: /Go \/ no-go/ }).click();
  await page.getByText("All stations go.").waitFor();
  await assertAccessible(page);
  await tabTo(page, "Launch");
  await page.keyboard.press("Enter");

  // Reduced motion shows a still frame, then the board.
  await page.getByText("Takeoff was faster than expected.").waitFor();
  const shellRow = page.locator(".board-row[data-kind='shell']");
  await shellRow.waitFor({ timeout: 10000 });
  const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
  assert.deepEqual(saved.settings, {
    setupComplete: true,
    hooks: true,
    agents: { claude: true, codex: true, agy: true },
    worktreeLocation: "root",
    inference: { kind: "rules" },
    inferenceTimeoutMs: 5000,
    colorMode: "system",
    interfaceScale: 100,
    codeFolder: null,
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
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const userData = await mkdtemp(path.join(tmpdir(), "foom-check-"));
  context.after(() => rm(userData, { recursive: true, force: true, maxRetries: 5 }));

  const app = await launchApp(context, false, {
    firstRun: true,
    args: [`--user-data-dir=${userData}`],
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Start preflight" }).click();
  for (let step = 0; step < 2; step++) await page.getByRole("button", { name: "Continue" }).click();
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
  await expect(page.getByRole("progressbar", { name: "Time limit" })).toBeVisible();
  await assertAccessible(page);
  release();

  await page.getByText(/needs_input · confidence 0\.90 in .*Foom will use this source/).waitFor();
  await expect(steps.getByText("Loaded fake:1b")).toBeVisible();
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
  await press("=", true);
  await expect.poll(zoom).toBeCloseTo(1.1);
  await page.getByText("110%").waitFor();
  // The window grows with the interface while the screen has room.
  await expect
    .poll(size)
    .toEqual({ width: Math.round(start.width * 1.1), height: Math.round(start.height * 1.1) });
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
  const { execFileSync } = require("node:child_process");
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
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
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
  await page.getByText("How should Foom read a terminal that goes quiet?").waitFor();
  const added = await page.evaluate(async () =>
    (await window.desktop.workspace()).repositories.map((repo) => repo.name).sort(),
  );
  assert.deepEqual(added, ["portal", "recent-app"]);
});
