async function boardPage(app) {
  let page;
  await expect
    .poll(() => {
      page = app.windows().find((page) => page.url() === "app://bundle/index.html");
      return Boolean(page);
    })
    .toBe(true);
  return page;
}

// Real decoding with a silent output sink: observe the selected recording without speaker output.
async function installSoundSink(page) {
  await page.addInitScript(() => {
    const Decoder = window.AudioContext;
    window.soundTones = [];
    window.soundDecoded = 0;
    window.AudioContext = class {
      decoder = new Decoder();
      currentTime = 0;
      state = "running";
      destination = {};
      async decodeAudioData(bytes) {
        const buffer = await this.decoder.decodeAudioData(bytes);
        window.soundDecoded++;
        return buffer;
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, setTargetAtTime() {} },
          connect() {},
          disconnect() {},
        };
      }
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          disconnect() {},
          start() {
            window.soundTones.push(this.buffer.duration);
          },
          stop() {},
        };
      }
      close() {
        return this.decoder.close();
      }
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.soundDecoded >= 4);
}

async function confirmationPage(app) {
  let page;
  await expect
    .poll(() => {
      page = app.windows().find((page) => page.url() === "app://confirmation/confirmation.html");
      return Boolean(page);
    })
    .toBe(true);
  return page;
}

const { assertBundledTerminalFonts } = require("./font-checks.js");
const { AxeBuilder } = require("@axe-core/playwright");
const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { _electron: electron } = require("@playwright/test");
const { deadline, expect } = require("./test-policy.js");
const { auditProcesses } = require("./process-audit.js");

async function boardCommand(app, keyCode, shift = true) {
  await app.evaluate(
    ({ BrowserWindow }, { keyCode, mac, shift }) => {
      const contents = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      ).webContents;
      if (!mac && /^[1-9]$/.test(keyCode) && !shift) {
        for (const type of ["keyDown", "keyUp"])
          contents.sendInputEvent({ type, keyCode: "Space", modifiers: ["control", "shift"] });
        for (const type of ["keyDown", "keyUp"]) contents.sendInputEvent({ type, keyCode });
        return;
      }
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
  await expect
    .poll(() => app.evaluate(() => globalThis.readyToQuit), { timeout: deadline(8000) })
    .toBe(true);
  await app.close();
}

// A test timeout does not cancel Playwright promises or dispose native processes.
// One teardown owns ordering: all apps/PTY hosts quit before any fixture removal.
const fixtureCleanups = new WeakMap();
function fixtureCleanup(context) {
  let cleanup = fixtureCleanups.get(context);
  if (!cleanup) {
    cleanup = { apps: [], directories: new Set() };
    fixtureCleanups.set(context, cleanup);
    context.after(async () => {
      const failures = [];
      try {
        await cleanup.audit?.capture();
      } catch (error) {
        failures.push(error);
      }
      for (const close of cleanup.apps) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await cleanup.audit?.finish();
      } catch (error) {
        failures.push(error);
      }
      for (const directory of cleanup.directories) {
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (error) {
          // Fixture deletion is best effort; keep assertion/quit failures intact.
          console.warn(`Unable to remove test fixture ${directory}:`, error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Electron teardown failed");
    });
  }
  return cleanup;
}
function removeAfterApps(context, directory) {
  fixtureCleanup(context).directories.add(directory);
}

test("fixture cleanup closes every app before removing directories and retains quit failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-cleanup-order-"));
  let teardown;
  const context = {
    after: (callback) => {
      teardown = callback;
    },
  };
  removeAfterApps(context, root);
  const cleanup = fixtureCleanup(context);
  const failure = new Error("quit failed");
  let secondClosed = false;
  cleanup.apps.push(async () => {
    await realpath(root);
    throw failure;
  });
  cleanup.apps.push(async () => {
    await realpath(root);
    secondClosed = true;
  });
  await assert.rejects(
    teardown,
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
  assert.equal(secondClosed, true);
  await assert.rejects(realpath(root), { code: "ENOENT" });
});

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
    owned,
  };
}

async function launchCheckoutShell(app, page) {
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const directory = path.join(profile, "shell-fixture");
  await mkdir(directory, { recursive: true });
  const repository = await realpath(directory);
  isolatedGit(["init", "-q", repository]);
  await app.evaluate(({ dialog }, repository) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repository] });
  }, repository);
  await page.getByRole("button", { name: "Add repository", exact: true }).press("Enter");
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).repositories.map(
        (entry) => entry.path,
      ),
    )
    .toContain(repository);
  // The first window can still be animating on a cold CI display. Keyboard
  // activation exercises the menu without depending on pointer hit-test stability.
  await page.getByRole("button", { name: "Actions for shell-fixture", exact: true }).press("Enter");
  await page.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
}

async function launchApp(context, openShell = true, options = {}) {
  // CI prepares the binary separately. Direct runs also resolve it before the
  // Playwright launch deadline/audit, without downloading during test discovery.
  // Do not supply executablePath: that skips Playwright's Electron loader.
  require("electron");
  const cleanup = fixtureCleanup(context);
  cleanup.audit ??= await auditProcesses(context);
  const profile = await prepareProfile(options);
  if (profile.owned) removeAfterApps(context, profile.owned);
  const watchdog = setTimeout(() => {
    console.error("Electron test exceeded its hard deadline; terminating worker");
    // Playwright's exit handler kills the process groups it launched.
    process.exit(1);
  }, deadline(90_000));
  watchdog.unref();
  let entry = path.join(__dirname, "../..");
  if (options.home) {
    // Electron resolves home from native OS APIs on macOS/Windows, not HOME.
    // A fixture package sets it before application modules construct services.
    const fixture = await mkdtemp(path.join(tmpdir(), "foom-entry-"));
    removeAfterApps(context, fixture);
    const manifest = JSON.parse(await readFile(path.join(entry, "package.json"), "utf8"));
    await writeFile(
      path.join(fixture, "package.json"),
      JSON.stringify({
        name: manifest.name,
        productName: manifest.productName,
        version: manifest.version,
        main: "bootstrap.cjs",
      }),
    );
    await writeFile(
      path.join(fixture, "bootstrap.cjs"),
      [
        'const { app } = require("electron");',
        `app.setPath("home", ${JSON.stringify(options.home)});`,
        `app.setAppPath(${JSON.stringify(entry)});`,
        `require(${JSON.stringify(path.join(entry, "build/main/main.js"))});`,
      ].join("\n"),
    );
    entry = fixture;
  }
  const env = { ...process.env, ...options.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron
    .launch({
      chromiumSandbox: true,
      colorScheme: null,
      timeout: deadline(15_000),
      args: [entry, ...profile.args],
      env,
    })
    .catch((error) => {
      clearTimeout(watchdog);
      throw error;
    });
  const child = app.process();
  cleanup.audit.add(child.pid);
  app.context().setDefaultTimeout(deadline(10_000));
  const staleTerminalErrors = [];
  app.on("window", (page) => {
    page.on("pageerror", (error) => console.error("Renderer error:", error));
  });
  app.on("console", (message) => {
    if (message.text().includes("Unknown or foreign terminal ID"))
      staleTerminalErrors.push(message.text());
    if (message.type() === "error") console.error("Electron:", message.text());
  });
  fixtureCleanup(context).apps.push(async () => {
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
          // Use the real quit dialog, including when the board has crashed.
          await quitAndWait(app, async () => {
            await app.evaluate(({ app }) => app.quit());
            await expect
              .poll(async () => {
                if (await app.evaluate(() => globalThis.readyToQuit)) return true;
                const dialog = app
                  .windows()
                  .find((page) => page.url() === "app://confirmation/confirmation.html");
                return Boolean(
                  dialog &&
                    (await dialog
                      .getByRole("button", { name: "Stop all and quit" })
                      .count()
                      .catch((error) => {
                        if (dialog.isClosed()) return 0;
                        throw error;
                      })),
                );
              })
              .toBe(true);
            if (!(await app.evaluate(() => globalThis.readyToQuit))) {
              const dialog = await confirmationPage(app);
              await dialog.getByRole("button", { name: "Stop all and quit" }).click();
            }
          });
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Electron shutdown exceeded its deadline")),
            deadline(10000),
          );
        }),
      ]);
      assert.equal(child.exitCode, 0, "Electron must exit normally");
      console.info("App closed");
      assert.deepEqual(staleTerminalErrors, [], "Normal flows must not use revoked terminal IDs");
      clearTimeout(watchdog);
    } finally {
      clearTimeout(timer);
      // If graceful shutdown failed, fail the test and terminate the process tree.
      // The watchdog stays armed while teardown runs, but must not outlive it.
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          require("node:child_process").execFileSync(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { timeout: deadline(5000) },
          );
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      }
      clearTimeout(watchdog);
    }
  });
  // The shell markup now arrives with React’s first commit.
  const page = await boardPage(app);
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL() === "app://bundle/index.html")
            .isVisible(),
        ),
      {
        timeout: deadline(10000),
      },
    )
    .toBe(true);
  if (options.firstRun || options.emptyBoard) return app;
  await launchCheckoutShell(app, page);
  await page.locator(".board-row[data-kind='shell']").waitFor();
  // Report startup errors directly instead of timing out on a permanently disabled control.
  await expect
    .poll(() => page.locator(".tile-status").textContent(), { timeout: deadline(10000) })
    .not.toBe("Starting shell…");
  assert.doesNotMatch(await page.locator(".tile-status").textContent(), /Unable|failed/);
  if (!openShell) {
    await page.getByRole("button", { name: "Hide session", exact: true }).click();
    await boardCommand(app, "B");
  }
  if (openShell) {
    // Use the board's keyboard action for setup; pointer clicks wait for layout
    // stability and can stall during the first window's startup on a CI display.
    await page.locator(".board-row[data-kind='shell']").press("Enter");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  }
  return app;
}

test("terminal runs an interactive shell behind an isolated bridge", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context);
  console.info("Electron launched");
  try {
    const page = await boardPage(app);
    console.info("Window opened");
    // The hidden confirmation window can be the first CDP target on a cold
    // display. Activate the board before testing xterm painting and selection.
    await page.bringToFront();
    await page.waitForLoadState("domcontentloaded");
    assert.equal(await page.title(), "Foom");
    await page.waitForFunction(
      () => !document.querySelector(".tile-status").textContent.includes("Starting"),
    );
    console.info("Shell started");
    assert.doesNotMatch(await page.locator(".tile-status").innerText(), /Unable/);
    await page.evaluate(() => {
      window.terminalOutput = "";
      window.desktop.onData((_id, _token, data) => {
        window.terminalOutput += data;
      });
    });
    const input = page.locator(".xterm-helper-textarea");
    await input.focus();
    // IPC output can arrive while Chromium is between animation frames during startup.
    // Poll it from the test process rather than using waitForFunction's rAF default.
    // The output marker is not present in the echoed command itself.
    const command =
      process.platform === "win32"
        ? 'Write-Output ("FOOM_" + "SHELL_OK")'
        : "printf 'FOOM_%s\\n' SHELL_OK";
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.terminalOutput.includes("FOOM_SHELL_OK")))
      .toBe(true);
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
      await page.mouse.dblclick(box.x + 10, box.y + box.height / 4);
      await app.evaluate(({ clipboard }) => clipboard.writeText("clipboard sentinel"));
      // Playwright's CDP keyboard path bypasses Electron's before-input-event.
      const shortcut = (keyCode) =>
        app.evaluate(({ BrowserWindow }, key) => {
          const window = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
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
      await expect
        .poll(() => page.evaluate(() => window.terminalOutput.includes("FOOM_PASTE_OK")))
        .toBe(true);
      console.info(`Copy/paste shortcuts passed on ${process.platform}`);
    }
    if (process.platform !== "win32") {
      const readSize = async (label) => {
        await page.keyboard.type(`printf 'SIZE_%s:' ${label}; stty size`);
        await page.keyboard.press("Enter");
        await expect
          .poll(() =>
            page.evaluate(
              (name) => new RegExp(`SIZE_${name}:\\d+ \\d+`).test(window.terminalOutput),
              label,
            ),
          )
          .toBe(true);
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
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
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
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL() === "app://bundle/index.html")
            .setSize(size.width, size.height),
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
      await expect
        .poll(() => page.evaluate(() => window.terminalOutput.includes("FOOM_TTY_OK")))
        .toBe(true);
      // exec keeps one process, so once the marker prints, sleep is the foreground job that
      // receives Ctrl+C. Pressing it earlier can signal the shell before sleep starts.
      await page.keyboard.type("sh -c 'printf \"FOOM_%s\\n\" SLEEPING; exec sleep 30'");
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => window.terminalOutput.includes("FOOM_SLEEPING")))
        .toBe(true);
      await page.keyboard.press("Control+c");
      await page.keyboard.type("printf 'FOOM_%s\\n' INTERRUPTED");
      await page.keyboard.press("Enter");
      await expect
        .poll(() => page.evaluate(() => window.terminalOutput.includes("FOOM_INTERRUPTED")))
        .toBe(true);
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
          "sounds",
          "confirmations",
          "isDevelopment",
          "appMenu",
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
          "onExecution",
          "onState",
          "onData",
          "onTerminalAvailability",
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
    await expect
      .poll(() => page.evaluate(() => window.terminalOutput.includes("PROTOCOL_OK")))
      .toBe(true);
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
      const { sandbox, contextIsolation, nodeIntegration } = BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getLastWebPreferences();
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
    assert.deepEqual(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .map((window) => window.webContents.getURL())
          .sort(),
      ),
      ["app://bundle/index.html", "app://confirmation/confirmation.html"],
    );
    console.info("Security checks passed");
    await input.focus();
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: "Shell exited" }).waitFor();
    console.info("Shell exited");
    await page.getByRole("button", { name: "Restart shell" }).click();
    await page.waitForFunction(
      () => !/Starting|exited|Unable/.test(document.querySelector(".tile-status").textContent),
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
    const page = app.windows().find((page) => page.url() === "app://bundle/index.html");
    if (page)
      console.error(
        "Terminal failure state:",
        await page.evaluate(() => ({
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          rows: [...document.querySelectorAll(".xterm-rows > div")].map((row) => row.textContent),
          viewport: { width: innerWidth, height: innerHeight },
          terminal: document.querySelector(".xterm-screen")?.getBoundingClientRect().toJSON(),
          status: document.querySelector(".tile-status")?.textContent,
          output: window.terminalOutput?.slice(-8000),
        })),
      );
    throw error;
  }
});

test("bundled brand fonts and both system themes render in Electron", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context);
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
    timeout: deadline(45_000),
  }, async (context) => {
    const app = await launchApp(context);
    const page = await boardPage(app);
    await page.waitForFunction(
      () => !/Starting|Unable/.test(document.querySelector(".tile-status").textContent),
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
    const requestQuit = () =>
      app.evaluate(({ app, BrowserWindow }, method) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        setTimeout(() => {
          if (method === "close") window.close();
          else if (method === "quit") app.quit();
          else {
            window.focus();
            window.webContents.sendInputEvent({
              type: "keyDown",
              keyCode: "Q",
              modifiers: process.platform === "darwin" ? ["meta"] : ["control", "shift"],
            });
          }
        }, 50);
      }, action);
    await requestQuit();
    const confirmation = await confirmationPage(app);
    await expect(confirmation.getByRole("alertdialog")).toHaveAccessibleName(
      "Quit with 2 terminals running?",
    );
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirmation.keyboard.press("Enter");
    await expect(confirmation.getByRole("alertdialog")).toHaveCount(0);
    for (const pid of [firstPid, secondPid]) process.kill(pid, 0);
    const alive =
      process.platform === "win32"
        ? 'Write-Output ("CANCEL_" + "ALIVE")'
        : "printf 'CANCEL_%s\\n' ALIVE";
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(alive);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.quitOutput.includes("CANCEL_ALIVE"));
    await quitAndWait(app, async () => {
      await requestQuit();
      await confirmation.getByRole("button", { name: "Stop all and quit" }).click();
    });
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
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  await page.waitForFunction(
    () => !/Starting|Unable/.test(document.querySelector(".tile-status").textContent),
  );
  const background = await app.evaluate(({ BrowserWindow, nativeTheme }) => ({
    actual: BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .getBackgroundColor()
      .toUpperCase(),
    expected: nativeTheme.shouldUseDarkColors ? "#05040A" : "#F3F0FA",
  }));
  assert.equal(background.actual, background.expected);
  // A created PTY is not yet a ready PowerShell prompt on a cold Windows runner.
  if (process.platform === "win32")
    await expect.poll(() => page.locator(".xterm-rows").innerText()).toMatch(/PS [\s\S]*>/);
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
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .close(),
    ),
  );
});

test("utility host survives output floods without losing rows or delaying another PTY", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context);
  await boardPage(app);
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
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  await page.waitForFunction(
    () => !/Starting|exited|Unable/.test(document.querySelector(".tile-status").textContent),
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
    () => !/Starting|failed|Unable/.test(document.querySelector(".tile-status").textContent),
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
  timeout: deadline(45000),
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-color-probe-"));
  removeAfterApps(context, directory);
  const app = await launchApp(context);
  const page = await boardPage(app);
  await page.waitForFunction(
    () => !document.querySelector(".tile-status").textContent.includes("Starting"),
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

test("Settings transitions restore background fullscreen output repeatedly", {
  timeout: deadline(45000),
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-view-probe-"));
  removeAfterApps(context, directory);
  const marker = path.join(directory, "stage");
  const app = await launchApp(context);
  const page = await boardPage(app);
  const hide = page.getByRole("button", { name: "Settings", exact: true });
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
    await expect(hide).toBeEnabled();
    await expect(rows).toContainText("ALTERNATE_HIDDEN_OUTPUT");
    await expect(rows).not.toContainText("NORMAL_VIEW_READY");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await hide.click();
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await expect(open).toBeEnabled();
  }
  await page.evaluate(() => window.desktop.input(window.viewId, "n"));
  await expect.poll(() => readFile(marker, "utf8")).toBe("normal");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
  await open.click();
  await expect(hide).toBeEnabled();
  await expect(rows).toContainText("NORMAL_VIEW_READY");
  await expect(rows).toContainText("NORMAL_HIDDEN_OUTPUT");
  await expect(rows).not.toContainText("ALTERNATE_HIDDEN_OUTPUT");
  // Continue scrolling after restoration, including origin-relative positioning,
  // repeated attachments, and transitions between both buffers.
  for (const mode of ["a", "n", "a", "n"]) {
    await hide.click();
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
        await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
        await expect(open).toBeEnabled();
      }
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Settings" })).toBeHidden();
    await open.click();
    await expect(hide).toBeEnabled();
  }
  // Reopening restores interactive input as well as the screen.
  await page.keyboard.type("q");
});

test("board starts with live terminals only and peeks without opening", async (context) => {
  const app = await launchApp(context, false);
  const page = await boardPage(app);
  const row = page.locator(".board-row");
  await expect(row).toHaveCount(1);
  await expect(row).toBeFocused();
  await expect(page.locator(".tile-terminal")).toBeHidden();
  await page.getByLabel("Filter repositories and sessions").click();
  await row.focus();
  await expect(page.getByRole("complementary", { name: "Terminal peek" })).toBeVisible();
  await expect(row).toBeFocused();
  await expect(page.locator(".tile-terminal")).toBeHidden();
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
writeFileSync(process.env.TEST_FAKE_CREDENTIALS, JSON.stringify({
  url: env.FOOM_HOOK_URL, session: env.FOOM_SESSION, token: env.FOOM_TOKEN,
  controlUrl: env.FOOM_CONTROL_URL, controlToken: env.FOOM_CONTROL_TOKEN, instanceId: env.FOOM_CONTROL_INSTANCE,
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
    const start = spawn("sh", ["-c", settings.hooks.UserPromptSubmit[0].hooks[0].command], { stdio: ["pipe", "ignore", "ignore"] });
    start.stdin.end(JSON.stringify({ session_id: "fake-session", hook_event_name: "UserPromptSubmit" }));
    let count = 0;
    const timer = setInterval(() => {
      process.stdout.write("Working " + "x".repeat(1000) + "\\r\\n");
      if (++count === 50) { clearInterval(timer); process.stdout.write("Continue? (y/n) "); }
    }, 50);
  } else if (input === "a") {
    process.stdout.write("\\x1b[2J\\x1b[HRunning approved command\\r\\n\\x1b]0;◐ Claude Code\\x07");
  } else if (input === "e") {
    process.stdout.write("\\x1b[2J\\x1b[HReady\\r\\n\\x1b]0;✳ Claude Code\\x07");
  } else if (input === "s") {
    const stop = spawn("sh", ["-c", settings.hooks.Stop[0].hooks[0].command], { stdio: ["pipe", "ignore", "ignore"] });
    stop.stdin.end(JSON.stringify({ session_id: "fake-session", hook_event_name: "Stop" }));
  } else if (input === "q") {
    process.exit(3);
  }
});
`;

test("launches an agent in a managed worktree and routes its attention signals", {
  timeout: deadline(60_000),
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
      TEST_FAKE_CREDENTIALS: credentials,
    },
  }).finally(() => {
    // Chromium may still write user-data until the app cleanup hook has finished.
    removeAfterApps(context, root);
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, repo);
  const setup = await page.evaluate(async () => {
    window.foomStates = [];
    window.foomExecutions = [];
    window.desktop.onExecution((event) => window.foomExecutions.push(event));
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
      timeout: deadline(10000),
    })
    .toContain("FOOM_AGENT_READY");

  // Quiet after a y/n prompt: the text rules ask for attention.
  await expect
    .poll(async () => (await latest())?.state, { timeout: deadline(10000) })
    .toBe("needs_input");
  assert.equal((await latest()).signal, "pattern:confirmation");
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.deepEqual(
    snapshot.terminals
      .filter((entry) => entry.kind === "agent")
      .map(({ id: terminal, branch, agent }) => ({ terminal, branch, agent })),
    [{ terminal: id, branch: "feature/fake", agent: "claude" }],
  );

  const agentRow = page
    .locator('.board-row[data-kind="agent"]')
    .filter({ hasText: "feature/fake" });
  await expect(agentRow).toHaveAttribute("data-state", "needs_input");
  await expect(agentRow).toContainText("pattern:confirmation");
  const firstCredentials = JSON.parse(await readFile(credentials, "utf8"));
  const controlRequest = (
    token = firstCredentials.controlToken,
    instanceId = firstCredentials.instanceId,
  ) =>
    fetch(firstCredentials.controlUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, instanceId, method: "whoami", params: {} }),
    });
  const identity = await controlRequest();
  assert.equal(identity.status, 200);
  const controlIdentity = (await identity.json()).result;
  assert.equal(controlIdentity.terminalId, id);
  assert.equal(controlIdentity.sessionId, firstCredentials.session);
  assert.equal(controlIdentity.role, "agent");
  assert.equal((await controlRequest(firstCredentials.token)).status, 401);
  assert.equal((await controlRequest(firstCredentials.controlToken, "stale-instance")).status, 400);
  assert.ok(!JSON.stringify(snapshot).includes(firstCredentials.controlToken));
  const mcpUrl = firstCredentials.controlUrl.replace("/control/v1", "/mcp");
  let mcpSession;
  const mcpRequest = (message) =>
    fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firstCredentials.controlToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(mcpSession
          ? { "Mcp-Session-Id": mcpSession, "Mcp-Protocol-Version": "2025-11-25" }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    });
  const initialized = await mcpRequest({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "electron-test", version: "1" },
    },
  });
  assert.equal(initialized.status, 200);
  mcpSession = initialized.headers.get("mcp-session-id");
  assert.ok(mcpSession);
  assert.equal((await mcpRequest({ method: "notifications/initialized" })).status, 202);
  const listed = await (
    await mcpRequest({ id: 2, method: "tools/list", params: { _meta: { progressToken: 1 } } })
  ).json();
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["whoami", "sessions", "session_state"],
  );
  const metadata = await (
    await mcpRequest({ id: 3, method: "tools/call", params: { name: "sessions", arguments: {} } })
  ).json();
  assert.ok(metadata.result.structuredContent.sessions.some((row) => row.id === id));
  for (const row of metadata.result.structuredContent.sessions) {
    assert.equal(row.reason, row.state);
    assert.equal("output" in row, false);
    assert.equal("conversationId" in row, false);
    assert.equal("signal" in row, false);
  }
  assert.ok(!JSON.stringify(metadata).includes(firstCredentials.controlToken));
  const forbidden = await (
    await mcpRequest({ id: 4, method: "tools/call", params: { name: "tail", arguments: { id } } })
  ).json();
  assert.equal(forbidden.result.isError, true);

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
  await expect(page.locator(".tile-terminal")).toBeHidden();
  await page.locator('.board-row[data-kind="shell"]').press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await boardCommand(app, "B");
  // The native shortcut reaches the renderer asynchronously; wait before sending
  // the next key so ArrowDown cannot go to the terminal instead of the sidebar.
  await expect(page.locator('.board-row[data-kind="shell"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-nav]:focus")).toBeVisible();
  await page.getByRole("button", { name: "Hide session", exact: true }).click();
  await agentRow.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.getByRole("button", { name: "Hide session", exact: true }).click();
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
  // Typing records feedback; the agent hook establishes the permission request.
  await page.keyboard.type("y");
  await expect
    .poll(async () => (await latest())?.signal, { timeout: deadline(10000) })
    .toBe("claude:PermissionRequest");
  assert.ok(
    !(await page.evaluate(() => window.foomStates.map((s) => s.signal))).includes("user:reply"),
  );
  // Later quiet evaluations keep the permission request in force.
  await page.waitForTimeout(2500);
  assert.equal((await latest()).state, "needs_input");

  // Dismissal clears attention but does not establish resumed execution.
  await page.getByRole("button", { name: "Not attention", exact: true }).click();
  await expect(agentRow).toHaveAttribute("data-state", "quiet_ok");
  assert.equal((await latest()).signal, "user:dismissed");
  assert.equal((await latest()).execution.phase, "blocked");

  // Approval followed by a fresh working title resumes the same turn; input alone
  // never did. A title-only end (Esc) is neutral until the authoritative Stop.
  await page.evaluate((terminal) => window.desktop.input(terminal, "a"), id);
  await expect(agentRow).toHaveAttribute("data-state", "working");
  await page.evaluate((terminal) => window.desktop.input(terminal, "e"), id);
  await expect(agentRow).toHaveAttribute("data-state", "quiet_ok");
  await page.evaluate((terminal) => window.desktop.input(terminal, "s"), id);
  await expect(agentRow).toHaveAttribute("data-state", "done");
  const transitions = await page.evaluate(
    (terminal) => window.foomExecutions.filter((event) => event.terminalId === terminal),
    id,
  );
  assert.ok(transitions.some((event) => event.to === "working" && event.source === "hook"));
  assert.deepEqual(
    transitions.slice(-2).map(({ from, to, source }) => ({ from, to, source })),
    [
      { from: "blocked", to: "working", source: "title" },
      { from: "working", to: "idle", source: "title" },
    ],
  );
  assert.equal(transitions.at(-1).turn, transitions.at(-2).turn);
  assert.ok(transitions.every((event) => Number.isFinite(event.at) && event.from !== event.to));

  // Exit is final and revokes the launch's hook credentials.
  const hook = firstCredentials;
  await page.evaluate((terminal) => window.desktop.input(terminal, "q"), id);
  await expect
    .poll(async () => (await latest())?.state, { timeout: deadline(10000) })
    .toBe("failed");
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
  assert.equal((await controlRequest()).status, 401);
  assert.equal((await mcpRequest({ id: 5, method: "tools/list" })).status, 401);
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
    await page.getByRole("button", { name: "Hide session", exact: true }).click();
    await row.click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(page.locator(".xterm-rows")).toContainText(
      branch === "finish-ok" ? "Finished successfully" : "Failed task",
    );
    await page.keyboard.press("Escape");
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1200, 850),
  );
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
  const page = await boardPage(instance);
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
  timeout: deadline(45_000),
  skip: process.platform === "win32" && "The prompt script is POSIX shell",
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
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
    .poll(async () => (await latest())?.signal, { timeout: deadline(10000) })
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
      { timeout: deadline(10000) },
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

async function tabTo(page, name, accessibleName = name) {
  const target = page.getByRole("button", { name: accessibleName, exact: true });
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  const tabStops = await page
    .locator(
      'button:visible:not(:disabled), input:visible:not(:disabled), select:visible:not(:disabled), textarea:visible:not(:disabled), [tabindex="0"]:visible',
    )
    .count();
  for (let step = 0; step <= tabStops; step++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (label === name) return;
  }
  throw new Error(`Could not reach "${name}" with Tab`);
}

test("a fresh profile opens preflight, and it passes accessibility checks", async (context) => {
  const app = await launchApp(context, false, { firstRun: true });
  const page = await boardPage(app);
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
  await expect(page.getByText("Looking…")).toHaveCount(0, { timeout: deadline(20000) });
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
  timeout: deadline(60_000),
}, async (context) => {
  const app = await launchApp(context, false, { firstRun: true });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Start preflight", exact: true }).click();
  for (let step = 0; step < 4; step++)
    await page.getByRole("button", { name: "Continue", exact: true }).click();
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
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
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
  removeAfterApps(context, root);
  for (const group of ["alpha", "beta", "gamma"]) {
    for (let index = 0; index < 12; index++) {
      const directory = path.join(root, group, `project-${index}-${"long-name-".repeat(12)}`);
      await mkdir(directory, { recursive: true });
      isolatedGit(["init", "-q", directory]);
    }
  }
  const app = await launchApp(context, false, { firstRun: true });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow, dialog }, directory) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1600, 1000);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, root);
  await page.getByRole("button", { name: "Start preflight", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
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
  timeout: deadline(60_000),
  skip: process.platform === "win32" && "The fake agents are POSIX scripts",
}, async (context) => {
  const { chmod, symlink } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-first-run-"));
  removeAfterApps(context, root);
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
  const page = await boardPage(app);
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
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
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
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
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
  await expect(page.getByText("Not found")).toHaveCount(3, { timeout: deadline(20000) });
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
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        window.setSize(800, 600);
        window.webContents.setZoomFactor(1.5);
      });
      await assertFooter(false);
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeInViewport();
      await expect(page.getByRole("button", { name: "Back", exact: true })).toBeInViewport();
      await app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
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
  await expect(page.getByText("Found", { exact: true })).toHaveCount(3, {
    timeout: deadline(20000),
  });
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
  await launchCheckoutShell(app, page);
  const shellRow = page.locator(".board-row[data-kind='shell']");
  await shellRow.waitFor({ timeout: deadline(10000) });
  const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
  assert.deepEqual(saved.settings, {
    codexNotifierAcknowledged: false,
    setupComplete: true,
    hooks: true,
    agents: { claude: true, codex: true, agy: true },
    agentArguments: { claude: [], codex: [], agy: [] },
    agentBypassAcknowledged: { claude: false, codex: false, agy: false },
    worktreeLocation: "root",
    inference: { kind: "rules" },
    inferenceTimeoutMs: 5000,
    colorMode: "system",
    interfaceTheme: "follow",
    interfaceScale: 100,
    terminalFontSize: 14,
    terminalTheme: "follow",
    sound: {
      choices: {
        working: { source: "builtin", file: "seagate-read-write.ogg" },
        done: { source: "builtin", file: "typewriter-bell.ogg" },
        "needs-you": { source: "builtin", file: "bicycle-bell.ogg" },
        refusal: { source: "builtin", file: "lip-pop.ogg" },
      },
      working: false,
      workingVolume: 0.15,
      alerts: true,
      alertVolume: 0.5,
    },
    codeFolder: await realpath(repo),
  });

  // Settings returns to the same sidebar row.
  await shellRow.focus();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("region", { name: "Settings" }).waitFor();
  await expect(page.locator(".board-terminal")).toBeHidden();
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
  const page = await boardPage(app);
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

test("preflight scans a code folder and adds the repositories worked on recently", async (context) => {
  const { utimes } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-code-"));
  removeAfterApps(context, root);
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
  const page = await boardPage(app);
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
  timeout: deadline(60000),
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
  if (process.platform !== "win32") {
    await writeFile(
      path.join(bin, "codex"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.1.0"); process.exit(0); }
if (args[0] === "--help") { console.log("-c, --config <key=value> --sandbox <mode> read-only"); process.exit(0); }
console.log("REVIEW_ARGS:" + JSON.stringify(args));
console.log("Listening on http://localhost:3000");
process.stdin.setRawMode(true);
process.stdin.resume();
`,
      { mode: 0o755 },
    );
  }
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: {
      HOME: path.join(root, "home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TEST_FAKE_CREDENTIALS: path.join(root, "fake-hook.json"),
    },
  }).finally(() => {
    // Hooks run in registration order. Close Electron before deleting the second
    // worktree: a live PowerShell process holds its working directory on Windows.
    removeAfterApps(context, root);
  });
  const page = await boardPage(app);
  const tabToField = async (id, reverse = false) => {
    // Selecting the already-registered repository does not change its value.
    // Wait for the async add to release the disabled fieldset before sending Tab.
    await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator(`#${id}`)).toBeEnabled();
    const tabStops = await page
      .locator(
        'button:visible:not(:disabled), input:visible:not(:disabled), select:visible:not(:disabled), textarea:visible:not(:disabled), [tabindex="0"]:visible',
      )
      .count();
    for (let step = 0; step <= tabStops; step++) {
      await page.keyboard.press(reverse ? "Shift+Tab" : "Tab");
      if ((await page.evaluate(() => document.activeElement?.id)) === id) return;
    }
    throw new Error(`Could not reach ${id} by keyboard`);
  };
  await page.getByRole("button", { name: "Add repository", exact: true }).waitFor();
  await expect(page.locator(".board-row")).toHaveCount(0);
  await page.evaluate(() => window.desktop.saveSetup({ worktreeLocation: "adjacent" }));
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await tabTo(page, "Add repository");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Actions for app", exact: true }).click();
  await page.getByRole("menuitem", { name: "New worktree…", exact: true }).press("Enter");
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
  // This includes real Git worktree creation and shell startup, which can take
  // longer than the default five-second assertion budget on Windows runners.
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: deadline(15000) });
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
  await expect(page.locator(".tile-terminal")).toBeVisible();
  const dirty = path.join(terminal.worktree, "unsaved.txt");
  await writeFile(dirty, "preserve unless confirmed");
  await page.getByRole("button", { name: "Actions for feature/ui", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  const confirmation = await confirmationPage(app);
  await expect(confirmation.getByLabel("Uncommitted changes")).toContainText("unsaved.txt");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.keyboard.press("Enter");
  await expect(confirmation.getByRole("alertdialog")).toHaveCount(0);
  assert.equal(await readFile(dirty, "utf8"), "preserve unless confirmed");
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Actions for feature/ui", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await confirmation.getByRole("button", { name: "Discard 1 change and remove" }).click();
  await expect(row).toHaveCount(0);
  await assert.rejects(readFile(dirty), { code: "ENOENT" });
  await page.locator(".board-row").filter({ hasText: "feature/remaining" }).click();
  await expect(page.locator(".tile-terminal")).toBeVisible();
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
  timeout: deadline(45000),
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
    removeAfterApps(context, root);
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const row = page.getByRole("button", { name: "Actions for external", exact: true });
  await row.click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  const confirmation = await confirmationPage(app);
  await expect(confirmation.getByLabel("Uncommitted changes")).toContainText("unsaved.txt");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.keyboard.press("Enter");
  await expect(confirmation.getByRole("alertdialog")).toHaveCount(0);
  assert.equal(await readFile(dirty, "utf8"), "keep until confirmed");
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole("menuitem", { name: "Remove worktree…" }).click();
  await confirmation.getByRole("button", { name: "Discard 1 change and remove" }).click();
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
  timeout: deadline(60000),
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
  if (process.platform !== "win32") {
    await writeFile(
      path.join(bin, "codex"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.1.0"); process.exit(0); }
if (args[0] === "--help") { console.log("-c, --config <key=value> --sandbox <mode> read-only"); process.exit(0); }
console.log("REVIEW_ARGS:" + JSON.stringify(args));
console.log("Listening on http://localhost:3000");
process.stdin.setRawMode(true);
process.stdin.resume();
`,
      { mode: 0o755 },
    );
  }
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: {
      HOME: path.join(root, "home"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TEST_FAKE_CREDENTIALS: path.join(root, "fake-hook.json"),
    },
  }).finally(() => {
    removeAfterApps(context, root);
  });
  const page = await boardPage(app);
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
    // Inventory arrives before the launch command finishes revealing the row and
    // focusing its terminal. Revealing clears any open menu, so wait for focus
    // before opening the next one.
    await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  }
  if (process.platform !== "win32") {
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
    await expect(page.locator(".board-row").filter({ hasText: "agent" })).toHaveCount(3);
    const terminal = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
      (t) => t.worktree === agentTree && t.kind === "agent",
    );
    assert.ok(terminal);
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 20)).join(""), terminal.id),
      )
      .toContain(`CWD:${agentTree}`);
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Click again for two agents here" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    assert.equal((await sharedSessions()).length, 3, "Cancel must not create an agent");
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "Claude Code", exact: true }).click();
    const sharedArm = page.getByRole("menuitem", { name: "Click again for two agents here" });
    await expect(sharedArm).toBeVisible();
    // Measure the minimum interval from main's arm, not from the async launch request.
    await page.waitForTimeout(310);
    await sharedArm.click();
    await expect
      .poll(async () => (await sharedSessions()).filter((t) => t.kind === "agent").length)
      .toBe(2);
    await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
    await page.getByRole("button", { name: "Actions for agent", exact: true }).click();
    await page.getByRole("menuitem", { name: /Review with Codex/ }).click();
    await expect(sharedArm).toBeVisible();
    await page.waitForTimeout(310); // The click-again minimum interval is the behavior under test.
    await sharedArm.click();
    await expect
      .poll(async () => (await sharedSessions()).filter((t) => t.readOnly).length)
      .toBe(1);
    const reviewer = (await sharedSessions()).find((t) => t.readOnly);
    assert.ok(reviewer);
    await expect
      .poll(() =>
        page.evaluate(async (id) => (await window.desktop.tail(id, 30)).join(""), reviewer.id),
      )
      .toContain('["--sandbox","read-only","-c","approval_policy=\\"never\\""]'.slice(0, -1));
    await expect(page.locator(".board-row").filter({ hasText: "Reviewing read-only" })).toHaveCount(
      1,
    );
    await expect
      .poll(async () => (await sharedSessions()).find((t) => t.id === reviewer.id)?.state?.state)
      .toBe("quiet_ok");
    await expect
      .poll(async () => (await sharedSessions()).find((t) => t.id === terminal.id)?.state?.state)
      .toBe("needs_input");
    assert.equal(reviewer.bypass, false);
  }
  const shell = (await sharedSessions()).find((t) => t.kind === "shell");
  assert.ok(shell);
  await page.evaluate(() => {
    window.confirmationArm = null;
    window.desktop.confirmations.subscribe((arm) => {
      window.confirmationArm = arm;
    });
  });
  const stop = page.evaluate((id) => window.desktop.sidebarCommand({ kind: "stop", id }), shell.id);
  await page.waitForFunction(() => window.confirmationArm !== null);
  await page.waitForTimeout(310);
  await page.evaluate(() => window.desktop.confirmations.confirm(window.confirmationArm));
  await stop;
  await expect
    .poll(async () => (await sharedSessions()).find((t) => t.id === shell.id)?.exited)
    .toBe(true);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "restart", id }), shell.id);
  assert.equal((await sharedSessions()).filter((t) => t.kind === "shell").length, 2);
  assert.ok((await sharedSessions()).every((t) => t.id !== shell.id));
  const inventory = await page.evaluate(() => window.desktop.sidebarInventory());
  assert.ok(
    inventory.repositories[0].worktrees.every((tree) => !tree.managed),
    "Launching must not adopt external checkouts",
  );
  const removal = page.evaluate(
    ({ repository, worktree }) =>
      window.desktop.sidebarCommand({ kind: "remove-worktree", repository, worktree }),
    { repository: repo, worktree: agentTree },
  );
  await page.waitForFunction(() => window.confirmationArm !== null);
  await page.waitForTimeout(310);
  await page.evaluate(() => window.desktop.confirmations.confirm(window.confirmationArm));
  await removal;
  assert.deepEqual(await sharedSessions(), []);
  await assert.rejects(realpath(agentTree), { code: "ENOENT" });
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals.length, 2);
});

test("persistent sidebar keeps Escape in the PTY and routes keyboard navigation", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-input-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "keys");
  await writeFile(marker, "");
  const app = await launchApp(context);
  const page = await boardPage(app);
  await page.locator(".xterm-helper-textarea").focus();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  // Establish the startup verdict first, including on faster runners.
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  await page.keyboard.press("Escape");
  await expect.poll(() => readFile(marker, "utf8")).toContain("1b\n");
  for (const [key, hex] of [
    ["c", "03"],
    ["w", "17"],
    ["d", "04"],
    ["q", "11"],
  ]) {
    await page.keyboard.press(`Control+${key}`);
    await expect.poll(() => readFile(marker, "utf8")).toContain(hex);
  }
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+n");
  await expect.poll(() => readFile(marker, "utf8")).toContain("02");
  await expect.poll(() => readFile(marker, "utf8")).toContain("0e");
  await expect(page.locator(".tile-terminal")).toBeVisible();
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
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
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
  timeout: deadline(30000),
  skip: process.platform === "win32" && "less is a POSIX pager",
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
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
  const page = await boardPage(app);
  for (const width of [1000, 640]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.setMinimumSize(0, 0);
      window.setSize(width, 600);
    }, width);
    await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add repository", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "New worktree", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Local shell", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Tile 1: empty" })).toBeVisible();
    await assertAccessible(page);
  }
  await page.screenshot({ path: path.join(tmpdir(), "foom-132-empty-sidebar.png") });
});

test("fake Codex receives inline flag only when help advertises it", {
  timeout: deadline(30000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-inline-"));
  removeAfterApps(context, root);
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
  const page = await boardPage(app);
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

test("agent hooks and titles publish execution transitions independently of terminal output", {
  timeout: deadline(30000),
  skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-inline-"));
  removeAfterApps(context, root);
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
else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\\x1b]2;⠋ codex\\x07');
  process.stdin.on('data', data => {
    if (data.toString().includes('w')) process.stdout.write('\\x1b[2J\\x1b[H\\x1b]2;⠙ codex\\x07');
    if (data.toString().includes('n')) {
      const command = JSON.parse(process.argv.find(arg => arg.startsWith('notify=')).slice(7));
      require('node:child_process').spawnSync(command[0], [...command.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'fake-thread', 'turn-id': 'fake-turn' })]);
      process.stdout.write('NOTIFIED\\n');
    }
    if (data.toString().includes('a')) process.stdout.write('\\x1b]2;Action Required | codex\\x07');
    if (data.toString().includes('i')) process.stdout.write('\\x1b[2J\\x1b[HWhich file should I edit?\\x1b]2;codex\\x07');
  });
}
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
  await writeFile(help, "--no-alt-screen -c, --config <value>");
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: { HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.equal(repository.path, await realpath(repo));
  await expect(page.getByRole("treeitem", { name: "repo", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.executionEvents = [];
    window.desktop.onExecution((event) => window.executionEvents.push(event));
  });
  const id = await page.evaluate(async (repo) => {
    await window.desktop.scanAgents(true);
    const tree = await window.desktop.createWorktree(repo, "titles", "adjacent");
    return (
      await window.desktop.launchAgent({
        agent: "codex",
        acknowledgeCodexNotifierReplacement: true,
        repository: repo,
        worktree: tree.path,
        cols: 80,
        rows: 24,
      })
    ).id;
  }, repository.path);
  const row = page.locator('.board-row[data-kind="agent"]');
  await expect(row).toHaveAttribute("data-state", "working");
  await expect(row).toContainText("rules:codex:osc_title_working");
  await page.evaluate((id) => window.desktop.input(id, "a"), id);
  await expect(row).toHaveAttribute("data-state", "needs_input");
  await expect(row).toContainText("Approval requested");
  await expect(row).toContainText("rules:codex:osc_title_blocked");
  await page.evaluate((id) => window.desktop.input(id, "i"), id);
  await expect(row).toHaveAttribute("data-state", "quiet_ok");
  await expect(row).toContainText("Agent turn ended; checking output");
  await expect(row).toContainText("rules:codex:osc_title_idle");
  await page.evaluate((id) => window.desktop.input(id, "w"), id);
  await expect(row).toHaveAttribute("data-state", "working");
  await page.evaluate((id) => window.desktop.input(id, "n"), id);
  await expect(row).toHaveAttribute("data-state", "done");
  const events = await page.evaluate(() => window.executionEvents);
  assert.deepEqual(
    events.map((event) => event.to),
    ["working", "blocked", "idle", "working", "idle"],
  );
  assert.equal(events.at(-1).source, "hook");
  assert.equal(events.at(-1).turn, 2);
  assert.ok(
    events.every((event) => event.terminalId === id && !("tail" in event) && !("prompt" in event)),
  );
});

test("Settings shares live preflight values, sizes the terminal and restores keyboard focus", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-settings-repositories-"));
  removeAfterApps(context, root);
  const repository = path.join(root, "settings-example");
  await mkdir(repository);
  isolatedGit(["init", "-q", repository]);
  const app = await launchApp(context);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, root);
  const page = await boardPage(app);
  const shortcut = async () => {
    await boardCommand(app, ",", process.platform !== "darwin");
    // Native input dispatch returns before React makes Settings interactive.
    // Wait before sending Tab, which otherwise still goes to the terminal.
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  };
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
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
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
  await tabTo(page, "+", "Larger");
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
  await shortcut();
  await section("Appearance");
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
  const app = await launchApp(context, false);
  const page = await boardPage(app);
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

test("window size defaults to 60 percent and survives a normal quit and relaunch", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-window-size-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`], emptyBoard: true };
  const app = await launchApp(context, false, options);
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
  const restored = await launchApp(context, false, options);
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

test("sidebar menus escape the scroll area, stay in the window and launch from a worktree", {
  timeout: deadline(60000),
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
    removeAfterApps(context, root);
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog, BrowserWindow }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1000, 700);
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
    const accent = colorScheme === "light" ? "rgb(91, 43, 217)" : "rgb(155, 107, 255)";
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
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
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
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
  timeout: deadline(30_000),
  skip: process.platform !== "linux" && "Requires Bash 4.4 or newer",
}, async (context) => {
  const app = await launchApp(context, true, { env: { SHELL: "/bin/bash" } });
  const page = await boardPage(app);
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

test("tiles build irregular layouts, preserve views, refuse full placement and replace only for attention", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-tiles-")));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await mkdir(path.join(root, "home"));
  isolatedGit(["init", "-q", repo]);
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: { HOME: path.join(root, "home") },
  }).finally(() => {
    removeAfterApps(context, root);
  });
  const page = await boardPage(app);
  await installSoundSink(page);
  await app.evaluate(({ dialog, BrowserWindow }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1500, 900);
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.desktop.workspace())).repositories.map(
        (entry) => entry.path,
      ),
    )
    .toContain(repo);
  await page.evaluate(async (repo) => {
    for (let i = 0; i < 4; i++)
      await window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "shell",
      });
  }, repo);
  const rows = page.locator(".board-row");
  await expect(rows).toHaveCount(4);
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  await rows.nth(0).click();
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  await page.evaluate(() => {
    window.tileElements = [document.querySelector(".terminal-tile")];
    window.attachments = [];
    window.desktop.onData((id, token) => {
      if (!window.attachments.some((item) => item.id === id && item.token === token))
        window.attachments.push({ id, token });
    });
  });
  await page.getByRole("button", { name: "Split right", exact: true }).click();
  await expect(page.getByRole("region", { name: "Tile 2: empty" })).toBeVisible();
  await rows.nth(1).click();
  await page.getByRole("button", { name: "Split down", exact: true }).nth(1).click();
  await rows.nth(2).click();
  const tiles = page.locator(".terminal-tile");
  await expect(tiles).toHaveCount(3);
  await expect(page.locator(".xterm-helper-textarea").nth(2)).toBeFocused();
  assert.equal(
    await page.evaluate(() => window.tileElements[0] === document.querySelector(".terminal-tile")),
    true,
  );
  await page.evaluate(() => {
    window.soundTones = [];
  });
  await rows.nth(3).click();
  await expect(rows.nth(3)).toHaveAttribute("data-refused", "true");
  await expect.poll(() => page.evaluate(() => window.soundTones.length)).toBe(1);
  assert.ok((await page.evaluate(() => window.soundTones[0])) <= 0.3);
  await rows.nth(3).click();
  await expect.poll(() => page.evaluate(() => window.soundTones.length)).toBe(2);
  await expect(tiles.nth(2)).toContainText("Shell");
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("foom.tiles.v1")).tree.second.second.session,
    ),
    sessions[2].id,
  );
  const gutter = page.getByRole("separator").first();
  const box = await gutter.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + box.height / 4, { steps: 8 });
  await page.mouse.up();
  await expect(gutter).not.toHaveAttribute("aria-valuenow", "50");
  await boardCommand(app, "1", false);
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  await page.evaluate(() => {
    window.tileElements = [...document.querySelectorAll(".terminal-tile")];
    window.xterms = [...document.querySelectorAll(".xterm")];
  });
  for (const session of sessions.slice(0, 3))
    await page.evaluate((id) => window.desktop.input(id, "echo VIEW_TOKEN_READY\r"), session.id);
  await expect.poll(() => page.evaluate(() => window.attachments.length)).toBe(3);
  const attachments = await page.evaluate(() => window.attachments);
  await boardCommand(app, "Enter");
  await expect(tiles.first()).toHaveAttribute("data-maximized", "true");
  await expect(tiles.nth(1)).toHaveAttribute("inert", "");
  await boardCommand(app, "Enter");
  await expect(tiles.first()).toHaveAttribute("data-maximized", "false");
  assert.equal(
    await page.evaluate(() =>
      window.xterms.every((element, i) => element === document.querySelectorAll(".xterm")[i]),
    ),
    true,
  );
  for (const session of sessions.slice(0, 3))
    await page.evaluate((id) => window.desktop.input(id, "echo VIEW_TOKEN_STABLE\r"), session.id);
  await expect(page.locator(".xterm-rows").first()).toContainText("VIEW_TOKEN_STABLE");
  assert.deepEqual(await page.evaluate(() => window.attachments), attachments);
  await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
    id: sessions[3].id,
    command:
      process.platform === "win32"
        ? "Read-Host 'Continue? (y/n)'\r"
        : "printf 'Continue? (y/n)'; read answer\r",
  });
  await expect(rows.nth(3)).toHaveAttribute("data-state", "needs_input");
  await boardCommand(app, "N");
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem("foom.tiles.v1")).tree.first.session),
    sessions[3].id,
  );
  await page.getByRole("button", { name: "Hide session", exact: true }).first().click();
  await rows.nth(0).click();
  await page.getByRole("button", { name: "One and three", exact: true }).click();
  await expect(tiles).toHaveCount(4);
  assert.equal(
    await page.evaluate(() =>
      window.tileElements.every((element) => document.body.contains(element)),
    ),
    true,
  );
  await assertAccessible(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(tiles.first()).toHaveCSS("transition-duration", "0s");
  await page.screenshot({ path: path.join(tmpdir(), "foom-132-tiles.png") });
  await page.getByRole("button", { name: "Close tile", exact: true }).first().click();
  assert.equal(
    (await page.evaluate(() => window.desktop.workspace())).terminals.filter((t) => !t.exited)
      .length,
    4,
  );
  const persisted = await page.evaluate(() => localStorage.getItem("foom.tiles.v1"));
  await page.reload();
  await expect(tiles).toHaveCount(3);
  assert.equal(await page.evaluate(() => localStorage.getItem("foom.tiles.v1")), persisted);
});

test("launching into full tiles replaces focus and empty tiles support mouse controls", async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const original = (await page.evaluate(() => window.desktop.workspace())).terminals[0];
  // The first window can still be animating on a cold CI display. Keyboard
  // activation exercises the menu without depending on pointer hit-test stability.
  await page.getByRole("button", { name: "Actions for shell-fixture", exact: true }).press("Enter");
  await page.getByRole("menuitem", { name: /^Shell \(/ }).press("Enter");
  await expect(page.locator(".board-row")).toHaveCount(2);
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  const created = sessions.find((session) => session.id !== original.id);
  assert.ok(created);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("foom.tiles.v1")).tree.session))
    .toBe(created.id);
  await expect(page.locator('.board-row[data-refused="true"]')).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea").first()).toBeFocused();
  assert.equal(sessions.find((session) => session.id === original.id).exited, false);

  await page.getByRole("button", { name: "Two by two", exact: true }).click();
  const empty = page.getByRole("region", { name: "Tile 4: empty", exact: true });
  await empty.hover();
  await expect(empty.locator(".tile-number")).toHaveText("4");
  await expect(empty.getByRole("button")).toHaveCount(3);
  await empty.getByRole("button", { name: "Close tile", exact: true }).click();
  await expect(page.locator(".terminal-tile")).toHaveCount(3);
  const sibling = page.getByRole("region", { name: "Tile 3: empty", exact: true });
  await expect(sibling).toHaveAttribute("data-focused", "true");
  await sibling.getByRole("button", { name: "Split down", exact: true }).click();
  await expect(page.locator(".terminal-tile")).toHaveCount(4);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await expect(empty.locator(".tile-title")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await assertAccessible(page);
  }
  await page.screenshot({ path: path.join(tmpdir(), "foom-tile-bug-fixes.png") });
});

test("tile leader avoids AltGr chords and cancels unmatched keys", {
  skip: process.platform === "darwin" && "macOS retains Command tile bindings",
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  const leader = async (keyCode) => {
    await boardCommand(app, "Space");
    await app.evaluate(({ BrowserWindow }, keyCode) => {
      for (const type of ["keyDown", "keyUp"])
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL() === "app://bundle/index.html")
          .webContents.sendInputEvent({ type, keyCode });
    }, keyCode);
  };
  const tiles = page.locator(".terminal-tile");
  await page.keyboard.press("Control+Alt+Shift+r");
  await expect(tiles).toHaveCount(1);
  await leader("R");
  await expect(tiles).toHaveCount(2);
  await leader("1");
  await expect(tiles.first()).toHaveAttribute("data-focused", "true");
  await leader("Escape");
  await page.keyboard.press("r");
  await expect(tiles).toHaveCount(2);
  await leader("W");
  await expect(tiles).toHaveCount(1);
});

test("tile terminal viewport has no native overflow bars", async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Dracula", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.terminalTheme),
    )
    .toBe("dracula");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Two by two", exact: true }).click();
  await expect(page.locator(".terminal-tile").first()).toHaveCSS(
    "background-color",
    "rgb(40, 42, 54)",
  );
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    const viewport = page.locator(".tile-terminal .xterm-viewport").first();
    await expect(viewport).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(viewport).toHaveCSS("overflow", "hidden");
    // The bottom strip below the last whole character row comes from the tile's
    // terminal theme, while xterm's current viewport still owns scrollback.
    await expect(page.locator(".xterm-scrollable-element").first()).toBeVisible();
  }
  await page.screenshot({ path: path.join(tmpdir(), "foom-132-bars-fixed.png") });
});

test("every interface theme applies live to native chrome and passes axe on board and Settings", {
  timeout: deadline(55000),
}, async (context) => {
  const app = await launchApp(context);
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
    ).toHaveCount(6);
    await assertAccessible(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tile-terminal")).toBeVisible();
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

test("recorded sounds refresh and preview user files while shell attention and completion stay silent", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-sound-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "keys");
  // Deliberately differ from Electron's home, proving the fixture does not rely
  // on the environment override that only worked on Linux.
  const shellHome = path.join(root, "shell-home");
  await mkdir(shellHome);
  const app = await launchApp(context, true, {
    home: root,
    env: { HOME: shellHome, USERPROFILE: shellHome },
  });
  const page = await boardPage(app);
  await installSoundSink(page);
  // Working audio is enabled, but this plain shell must contribute no loop.
  await page.evaluate(async () => {
    const { settings } = await window.desktop.setupState();
    await window.desktop.saveSetup({ sound: { ...settings.sound, working: true } });
  });
  await page.evaluate(() => {
    window.soundTerminal = undefined;
    window.desktop.onData((id) => {
      window.soundTerminal = id;
    });
  });
  // Reload reattaches the terminal asynchronously. Use the board action that
  // waits for attachment before focusing, instead of focusing its early markup.
  await page.locator(".board-row[data-kind='shell']").press("Enter");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`,
  );
  await page.keyboard.press("Enter");
  // Capture its ID before Settings detaches the view and stops output delivery.
  await page.waitForFunction(() => typeof window.soundTerminal === "string");
  // Hide the terminal before its verdict settles; settings keeps the source subscribed.
  await boardCommand(app, ",", process.platform !== "darwin");
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "needs_input");
  // Silence must persist past the alert settling/debounce window.
  await page.waitForTimeout(2200);
  assert.deepEqual(await page.evaluate(() => window.soundTones), []);
  await assertAccessible(page);
  const home = await app.evaluate(({ app }) => app.getPath("home"));
  assert.equal(await realpath(home), await realpath(root));
  const sample = Buffer.alloc(44 + 8000); // 0.25 s mono PCM, 16 kHz
  sample.write("RIFF");
  sample.writeUInt32LE(sample.length - 8, 4);
  sample.write("WAVEfmt ", 8);
  sample.writeUInt32LE(16, 16);
  sample.writeUInt16LE(1, 20);
  sample.writeUInt16LE(1, 22);
  sample.writeUInt32LE(16000, 24);
  sample.writeUInt32LE(32000, 28);
  sample.writeUInt16LE(2, 32);
  sample.writeUInt16LE(16, 34);
  sample.write("data", 36);
  sample.writeUInt32LE(8000, 40);
  for (let i = 0; i < 4000; i++)
    sample.writeInt16LE(Math.round(2000 * Math.sin(i * 0.2)), 44 + i * 2);
  await writeFile(path.join(home, ".foom/config/sounds/done/test-bell.wav"), sample);
  await expect(page.getByRole("option", { name: "Test bell", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  await page.screenshot({ path: path.join(__dirname, "../../test-results/sound-settings.png") });
  await page.getByLabel("Done sound", { exact: true }).selectOption("user:test-bell.wav");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.choices.done),
    )
    .toEqual({ source: "user", file: "test-bell.wav" });
  await page.getByRole("button", { name: "Preview done", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.soundTones)).toEqual([0.25]);
  // Exit the real PTY: process exit is a Done verdict on every supported shell/platform.
  await page.evaluate(() => window.desktop.input(window.soundTerminal, "q"));
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.tail(window.soundTerminal, 40)).join("\n")),
    )
    .not.toContain("INPUT_READY");
  await page.evaluate(() => window.desktop.input(window.soundTerminal, "exit\r"));
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "done");
  await page.waitForTimeout(2200);
  assert.deepEqual(await page.evaluate(() => window.soundTones), [0.25]);
  await page.getByLabel("Alerts on", { exact: true }).uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.alerts),
    )
    .toBe(false);
});

test("click-again repository removal rejects double clicks, cancels, expires and confirms", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, false, { emptyBoard: true });
  const page = await boardPage(app);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const repo = path.join(profile, "remove-fixture");
  await mkdir(repo);
  isolatedGit(["init", "-q", repo]);
  const keptFile = path.join(repo, "keep.txt");
  await writeFile(keptFile, "repository contents");
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const actions = page.getByRole("button", { name: "Actions for remove-fixture", exact: true });
  await actions.click();
  await page.getByRole("menuitem", { name: "Remove repository…" }).dblclick();
  const armed = page.getByRole("menuitem", { name: "Click again to remove" });
  await expect(armed).toBeVisible();
  assert.equal((await page.evaluate(() => window.desktop.workspace())).repositories.length, 1);
  await page.keyboard.press("Escape");
  await actions.click();
  await page.getByRole("menuitem", { name: "Remove repository…" }).click();
  await expect(armed).toBeVisible();
  // The expiration interval itself is under test.
  await page.waitForTimeout(3050);
  await expect(page.getByRole("menuitem", { name: "Remove repository…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove repository…" }).click();
  await expect(armed).toBeVisible();
  await page.waitForTimeout(310);
  await armed.click();
  await expect(actions).toHaveCount(0);
  assert.equal(
    await readFile(keptFile, "utf8"),
    "repository contents",
    "Repository files are kept",
  );
});

test("trusted quit dialog isolates answers, passes axe in both themes and survives a board crash", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context);
  const board = await boardPage(app);
  const dialog = await confirmationPage(app);
  const processes = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.webContents.getOSProcessId()),
  );
  assert.equal(new Set(processes).size, 2, "Confirmation must use a separate renderer process");
  for (const colorMode of ["light", "dark"]) {
    await board.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), colorMode);
    await app.evaluate(({ app }) => app.quit());
    await expect(dialog.getByRole("alertdialog")).toBeVisible();
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const parent = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      if (parent.isEnabled()) throw Error("Parent must be disabled during confirmation");
      const bounds = parent.getBounds();
      parent.setBounds({
        ...bounds,
        x: bounds.x + 10,
        y: bounds.y + 10,
        width: bounds.width - 20,
        height: bounds.height - 20,
      });
      return bounds;
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const parent = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
          const child = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://confirmation/confirmation.html",
          );
          return JSON.stringify(parent.getBounds()) === JSON.stringify(child.getBounds());
        }),
      )
      .toBe(true);
    const id = await dialog.evaluate(() => {
      let id;
      const off = window.confirmation.render((request) => {
        id = request?.id;
      });
      off();
      return id;
    });
    await app.evaluate(({ BrowserWindow, ipcMain }, id) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      ).webContents;
      ipcMain.emit(
        "confirmation:answer",
        { sender: board, senderFrame: board.mainFrame },
        id,
        true,
      );
    }, id);
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    assert.equal(await board.evaluate(() => "confirmation" in window), false);
    await mkdir("test-results", { recursive: true });
    await dialog.screenshot({
      path: `test-results/confirmation-${colorMode}.png`,
      animations: "disabled",
    });
    const scan = await new AxeBuilder({ page: dialog }).setLegacyMode().analyze();
    assert.deepEqual(scan.violations, []);
    await dialog.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Stop all and quit" })).toBeFocused();
    await dialog.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.keyboard.press("Escape");
    await expect(dialog.getByRole("alertdialog")).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const parent = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      if (!parent.isEnabled()) throw Error("Parent must be enabled after cancellation");
      parent.setBounds(bounds);
    }, bounds);
  }
  const boardPid = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    ).webContents;
    globalThis.boardCrash = null;
    contents.once("render-process-gone", (_event, details) => {
      globalThis.boardCrash = { reason: details.reason, crashed: contents.isCrashed() };
    });
    return contents.getOSProcessId();
  });
  assert.ok(Number.isInteger(boardPid) && boardPid > 0, "Board renderer PID must be valid");
  // Terminate only this test app's board renderer, then wait for main to observe the loss.
  process.kill(boardPid);
  await expect
    .poll(() => app.evaluate(() => globalThis.boardCrash))
    .toMatchObject({ crashed: true });
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await expect(dialog.getByRole("alertdialog")).toHaveAccessibleName(
      "Quit with 1 terminal running?",
    );
    await dialog.getByRole("button", { name: "Stop all and quit" }).click();
  });
});

test("Settings persists literal agent defaults and discloses bypass once per agent", {
  timeout: deadline(60_000),
}, async (context) => {
  const { copyFile, chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-default-args-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const output = path.join(root, "argv.json");
  await Promise.all([bin, home, repo].map((directory) => mkdir(directory)));
  // A real Node executable is a cross-platform fixture agent. Its unrecognized version
  // falls back to output evaluation; --eval records execArgv plus positional argv.
  const executable = path.join(bin, process.platform === "win32" ? "claude.exe" : "claude");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
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
  const profile = path.join(root, "profile");
  const app = await launchApp(context, false, {
    args: [`--user-data-dir=${profile}`],
    emptyBoard: true,
    env: { HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_ARGV: output },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  assert.ok(repository);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const input = page.getByLabel("Claude Code default arguments");
  await expect(input).toBeVisible();
  await input.fill("--settings={}");
  await page.getByRole("button", { name: "Save default arguments", exact: true }).click();
  await expect(page.locator(".agent-defaults [role=status]")).toContainText("Claude Code, line 1:");
  await expect(page.locator(".agent-defaults [role=status]")).toContainText("reserved");
  const args = [
    "--eval",
    'require("node:fs").writeFileSync(process.env.TEST_ARGV, JSON.stringify([...process.execArgv, ...process.argv.slice(1)])); setInterval(() => {}, 1000)',
    "value with spaces",
    "'literal quotes'",
    "$(not-a-command); &",
    "--dangerously-skip-permissions",
  ];
  await input.fill(`${args.join("\r\n")}\r\n\r\n`);
  await page.getByRole("button", { name: "Save default arguments", exact: true }).click();
  const disclosure = await confirmationPage(app);
  await expect(disclosure.getByRole("alertdialog")).toHaveAccessibleName(
    "Save bypass defaults for Claude Code?",
  );
  await expect(disclosure.getByRole("alertdialog")).toContainText(
    "A worktree is not a sandbox. With these arguments, the agent can act as you anywhere on the machine.",
  );
  await expect(disclosure.getByRole("button", { name: "Cancel" })).toBeFocused();
  const disclosureScan = await new AxeBuilder({ page: disclosure }).setLegacyMode().analyze();
  assert.deepEqual(disclosureScan.violations, []);
  await disclosure.keyboard.press("Enter");
  await expect(page.locator(".agent-defaults [role=status]")).toContainText("cancelled");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.setupState())).settings.agentArguments.claude,
    [],
  );
  await page.getByRole("button", { name: "Save default arguments", exact: true }).click();
  await disclosure.getByRole("button", { name: "Save bypass defaults", exact: true }).click();
  await expect(page.locator(".agent-defaults [role=status]")).toContainText(
    "Default arguments saved",
  );
  await page.getByRole("button", { name: "Save default arguments", exact: true }).click();
  await expect(page.locator(".agent-defaults [role=status]")).toContainText(
    "Default arguments saved",
  );
  await expect(disclosure.getByRole("alertdialog")).toHaveCount(0);
  const persisted = JSON.parse(
    await readFile(path.join(profile, "settings.json"), "utf8"),
  ).settings;
  assert.deepEqual(persisted.agentArguments.claude, args);
  assert.equal(persisted.agentBypassAcknowledged.claude, true);
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await page.evaluate(
    (repo) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "claude",
      }),
    repository.path,
  );
  await expect
    .poll(async () => {
      try {
        return JSON.parse(await readFile(output, "utf8"));
      } catch {
        return null;
      }
    })
    .toEqual(args);
  await expect(page.locator(".session-bypass")).toHaveText("◇ Bypass");
  await page.evaluate(() =>
    window.desktop.saveSetup({ agentArguments: { claude: [], codex: [], agy: [] } }),
  );
  await expect(page.locator(".session-bypass")).toHaveText("◇ Bypass");
});

test("profile lock focuses the first app, exits duplicates and permits another profile", {
  timeout: deadline(45000),
}, async (context) => {
  const first = await launchApp(context, false, {
    emptyBoard: true,
    env: {
      FOOM_SESSION: "parent-session",
      FOOM_TOKEN: "parent-token",
      FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
      CLAUDECODE: "1",
    },
  });
  const page = await boardPage(first);
  await expect(page.locator(".dev-profile")).toHaveText("Dev");
  assert.equal(
    await first.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .getTitle(),
    ),
    "Foom Dev",
  );
  assert.deepEqual(
    await first.evaluate(() =>
      Object.keys(process.env).filter((key) => key.startsWith("FOOM_") || key === "CLAUDECODE"),
    ),
    [],
  );
  const profile = await first.evaluate(({ app }) => app.getPath("userData"));
  const second = await launchApp(context, false, { emptyBoard: true });
  assert.notEqual(await second.evaluate(({ app }) => app.getPath("userData")), profile);
  await first.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    globalThis.duplicateFocused = false;
    window.on("focus", () => {
      globalThis.duplicateFocused = true;
    });
    window.hide();
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  let exited;
  fixtureCleanup(context).apps.push(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  child = require("node:child_process").spawn(
    require("electron"),
    [path.join(__dirname, "../.."), `--user-data-dir=${profile}`],
    { env, stdio: "ignore" },
  );
  exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  fixtureCleanup(context).audit.add(child.pid);
  await expect.poll(() => child.exitCode, { timeout: deadline(10000) }).toBe(0);
  assert.deepEqual(await exited, { code: 0, signal: null });
  await expect
    .poll(() =>
      first.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        return globalThis.duplicateFocused && window.isVisible() && window.isFocused();
      }),
    )
    .toBe(true);
});

for (const agent of ["claude", "codex"]) {
  test(`resumes exited ${agent} conversations in place after a Foom restart`, {
    timeout: deadline(60_000),
    skip: process.platform === "win32" && "The fake CLI is a POSIX executable",
  }, async (context) => {
    const { chmod } = require("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "foom-resume-"));
    removeAfterApps(context, root);
    const bin = path.join(root, "bin");
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    const profile = path.join(root, "profile");
    const argvFile = path.join(root, "argv.json");
    await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
    isolatedGit(["init", "-q", "-b", "main", repo]);
    isolatedGit([
      "-C",
      repo,
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ]);
    const conversation = "0199abcd-1234-7890-abcd-123456789abc";
    await writeFile(
      path.join(bin, agent),
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync, renameSync } = require("node:fs");
const args = process.argv.slice(2);
const agent = ${JSON.stringify(agent)};
if (args[0] === "--version") { console.log(agent === "claude" ? "2.1.300 (Claude Code)" : "codex-cli 0.160.1"); process.exit(0); }
if (args[0] === "--help") { console.log("--settings <json> -c, --config <value> --no-alt-screen"); process.exit(0); }
const record = process.env.TEST_ARGV + "." + process.pid + ".tmp";
writeFileSync(record, JSON.stringify({ args, cwd: process.cwd(), token: process.env.FOOM_TOKEN, pid: process.pid }));
renameSync(record, process.env.TEST_ARGV);
const resumed = args.includes("--resume") || args.includes("resume");
if (resumed) {
  console.log("RESUMED_CONVERSATION " + process.pid);
  process.stdin.setRawMode(true);
  process.stdin.on("data", () => process.exit(0));
} else {
  const payload = agent === "claude" ? { session_id: ${JSON.stringify(conversation)}, hook_event_name: "Stop" } : { "thread-id": ${JSON.stringify(conversation)}, "turn-id": "turn-1", type: "agent-turn-complete" };
  let command, hookArgs, input;
  if (agent === "claude") {
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    command = "sh"; hookArgs = ["-c", settings.hooks.Stop[0].hooks[0].command]; input = JSON.stringify(payload);
  } else {
    const notify = args.find(arg => arg.startsWith("notify="));
    [command, ...hookArgs] = JSON.parse(notify.slice(7));
    hookArgs.push(JSON.stringify(payload));
  }
  const hook = spawn(command, hookArgs, { stdio: ["pipe", "ignore", "inherit"] });
  hook.stdin.end(input);
  hook.on("exit", () => { console.log("AGENT_EXITED"); process.exit(0); });
}
`,
    );
    await chmod(path.join(bin, agent), 0o755);
    const options = {
      emptyBoard: true,
      args: [`--user-data-dir=${profile}`],
      env: { HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TEST_ARGV: argvFile },
    };
    const app = await launchApp(context, false, options);
    const page = await boardPage(app);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, repo);
    const id = await page.evaluate(async (agent) => {
      const repository = await window.desktop.addRepository();
      return window.desktop.startWorktree({
        repository: repository.path,
        branch: "resume-test",
        run: agent,
        acknowledgeCodexNotifierReplacement: true,
      });
    }, agent);
    await expect
      .poll(() =>
        page.evaluate(
          async (id) => (await window.desktop.workspace()).terminals.find((row) => row.id === id),
          id,
        ),
      )
      .toMatchObject({ exited: true, conversationId: conversation });
    const firstLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8"))[0]
            ?.conversationId,
      )
      .toBe(conversation);
    await quitAndWait(app, () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((win) => win.webContents.getURL() === "app://bundle/index.html")
          .close(),
      ),
    );
    const restoredApp = await launchApp(context, false, options);
    const restored = await boardPage(restoredApp);
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: true, dormant: true, conversationId: conversation }]);
    const agentName = agent === "claude" ? "Claude Code" : "Codex";
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "Copy session ID", exact: true }).click();
    // Clipboard writing finishes before the source's inventory refresh and menu
    // dismissal. Wait for the completed UI action before opening it again.
    await expect(restored.getByRole("menu", { name: "Actions", exact: true })).toHaveCount(0);
    await expect
      .poll(() => restoredApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(conversation);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() => restored.evaluate(async () => (await window.desktop.workspace()).terminals))
      .toMatchObject([{ id, exited: false, conversationId: conversation }]);
    await expect(restored.locator(".xterm-rows")).toContainText("RESUMED_CONVERSATION");
    const resumedLaunch = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${resumedLaunch.pid}`,
    );
    assert.deepEqual(resumedLaunch.args.slice(0, 2), [
      agent === "claude" ? "--resume" : "resume",
      conversation,
    ]);
    assert.equal(resumedLaunch.cwd, firstLaunch.cwd);
    assert.notEqual(resumedLaunch.token, firstLaunch.token);
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    await restored.locator(".xterm-helper-textarea").press("q");
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(true);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: /^Resume conversation/ }).click();
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(false);
    await expect
      .poll(async () => JSON.parse(await readFile(argvFile, "utf8")).token)
      .not.toBe(resumedLaunch.token);
    const secondResume = JSON.parse(await readFile(argvFile, "utf8"));
    await expect(restored.locator(".xterm-rows")).toContainText(
      `RESUMED_CONVERSATION ${secondResume.pid}`,
    );
    await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
    await restored.locator(".xterm-helper-textarea").press("q");
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited),
      )
      .toBe(true);
    await restored
      .getByRole("button", { name: `Actions for ${agentName} in resume-test`, exact: true })
      .click();
    await restored.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect
      .poll(() =>
        restored.evaluate(async () => (await window.desktop.workspace()).terminals.length),
      )
      .toBe(0);
    await expect
      .poll(async () => JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8")))
      .toEqual([]);
    assert.equal(await realpath(resumedLaunch.cwd), resumedLaunch.cwd);
  });
}
test("external Git changes refresh inventory and retain sessions in removed worktrees", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-inventory-watch-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const external = path.join(root, "external");
  await mkdir(repo);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "--allow-empty", "-qm", "init");
  const app = await launchApp(context, false, { emptyBoard: true });
  const page = await boardPage(app);
  page.on("console", (message) => {
    if (message.type() === "error") context.diagnostic(`Inventory renderer: ${message.text()}`);
  });
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("button", { name: "Main checkout", exact: true })).toBeVisible();
  git("worktree", "add", "-b", "topic/external", external);
  const actions = page.getByRole("button", { name: "Actions for topic/external", exact: true });
  await actions.click();
  await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.workspace())).terminals.length)
    .toBe(1);
  const terminal = await page.evaluate(async () => (await window.desktop.workspace()).terminals[0]);
  // Windows locks the process cwd, which is separate from PowerShell's location.
  // Move and verify both before removing the worktree, retaining the live session
  // and its original launch location so every platform exercises the same behavior.
  const quoted = `'${repo.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const input =
    process.platform === "win32"
      ? `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${quoted}; [System.IO.Directory]::SetCurrentDirectory((Get-Location).ProviderPath); if ([System.IO.Directory]::GetCurrentDirectory() -eq ${quoted}) { Write-Output ('moved-' + 'ready') } else { throw 'Process cwd did not move' }\r`
      : `cd ${quoted} && printf 'moved-%s\\n' ready\r`;
  await page.evaluate(({ id, input }) => window.desktop.input(id, input), {
    id: terminal.id,
    input,
  });
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), terminal.id))
    .toContain("moved-ready");
  git("worktree", "remove", external);
  const session = page.locator(".board-row").filter({ hasText: "Worktree removed" });
  try {
    await expect(session).toHaveCount(1);
  } catch (error) {
    console.error(
      "Inventory after external removal",
      JSON.stringify(
        await page.evaluate(async () => ({
          workspace: await window.desktop.workspace(),
          inventory: await window.desktop.sidebarInventory(),
        })),
      ),
    );
    console.error("Board after external removal", await page.locator("body").innerText());
    throw error;
  }
  await expect(actions).toHaveCount(0);
  assert.equal((await page.evaluate(() => window.desktop.workspace())).terminals[0].exited, false);
  await page.getByRole("button", { name: "topic/external", exact: true }).click();
  await expect(page.locator(".location-launchers")).toContainText("Worktree removed");
  await assert.rejects(
    page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "shell" }),
      { repository: repo, worktree: external },
    ),
    /Worktree was removed/,
  );
  git("checkout", "-b", "topic/renamed");
  await expect(page.locator(".tree-checkout-branch")).toHaveText("topic/renamed");
  // Focus is an independent backstop, including after the watcher has failed.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .emit("focus");
  });
  await page.evaluate((id) => window.desktop.input(id, "exit\r"), terminal.id);
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.workspace())).terminals[0].exited)
    .toBe(true);
  await page.evaluate((id) => window.desktop.sidebarCommand({ kind: "close", id }), terminal.id);
  await expect(session).toHaveCount(0);
  await expect(page.getByRole("button", { name: "topic/external", exact: true })).toHaveCount(0);
});

test("application menu uses the command registry and supports native keyboard access", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  const commands = await page.evaluate(() => window.desktop.appMenu.commands());
  assert.ok(commands.some((item) => item.id === "reload"));
  assert.equal(commands.find((item) => item.id === "new-window").enabled, false);
  if (process.platform === "darwin") {
    const labels = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items.map((item) => item.label),
    );
    assert.deepEqual(labels, ["Foom", "File", "Edit", "View", "Window", "Help", "Developer"]);
    const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
    await filter.fill("menu edit probe");
    for (const keyCode of ["A", "X"])
      await app.evaluate(({ BrowserWindow }, keyCode) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === "app://bundle/index.html",
        );
        for (const type of ["keyDown", "keyUp"])
          window.webContents.sendInputEvent({ type, keyCode, modifiers: ["meta"] });
      }, keyCode);
    await expect(filter).toHaveValue("");
    const paste = () =>
      app.evaluate(({ Menu }) => {
        // macOS roles execute natively; MenuItem.click() intentionally skips them.
        // https://github.com/electron/electron/blob/v44.4.5/lib/browser/api/menu-item-roles.ts
        if (Menu.getApplicationMenu().getMenuItemById("paste").role !== "paste")
          throw new Error("Missing Paste role");
        Menu.sendActionToFirstResponder("paste:");
      });
    await paste();
    await expect(filter).toHaveValue("menu edit probe");
    await filter.fill("");
    await page.locator(".session-name").dblclick();
    await paste();
    await expect(page.getByRole("textbox", { name: "Session name", exact: true })).toHaveValue(
      "menu edit probe",
    );
    await page.keyboard.press("Escape");
    return;
  }
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null);
  const trigger = page.getByRole("button", { name: "Foom menu" });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Foom" });
  await expect(menu).toBeVisible();
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.querySelectorAll(".row-menu, .row-menu button")).flatMap((element) =>
        element.getAnimations().map((animation) => animation.finished),
      ),
    ),
  );
  await assertAccessible(page);
  await page.screenshot({ path: "test-results/application-menu.png", animations: "disabled" });
  await expect(page.getByRole("menuitem", { name: "New Window", exact: true })).toBeDisabled();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: /Toggle Developer Tools/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("menuitem", { name: "About Foom", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
  for (const key of ["F10", "Alt"]) {
    await app.evaluate(({ BrowserWindow }, keyCode) => {
      const window = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      window.focus();
      for (const type of ["keyDown", "keyUp"]) window.webContents.sendInputEvent({ type, keyCode });
    }, key);
    await expect(menu).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to terminal · Esc" }).click();
  }
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()),
    false,
  );
});

test("application menu restores the edit target and selection before Paste", {
  timeout: deadline(45000),
  skip: process.platform === "darwin",
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  const filter = page.getByRole("textbox", { name: "Filter repositories and sessions" });
  await filter.fill("before");
  await filter.evaluate((input) => input.setSelectionRange(2, 5));
  await app.evaluate(({ clipboard }) => clipboard.writeText("AFTER"));
  await page.getByRole("button", { name: "Foom menu" }).click();
  await page.getByRole("menuitem", { name: /^Paste/ }).click();
  await expect(filter).toHaveValue("beAFTERe");
  await expect(filter).toBeFocused();
  await expect(page.getByRole("menu", { name: "Foom" })).toHaveCount(0);
  await filter.evaluate((input) => input.setSelectionRange(2, 7));
  await app.evaluate(({ clipboard }) => clipboard.writeText("STALE"));
  await page.getByRole("button", { name: "Foom menu" }).click();
  await page.getByRole("menuitem", { name: /^Copy/ }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("AFTER");
  await expect(filter).toBeFocused();
  await filter.fill("");
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  const command =
    process.platform === "win32"
      ? 'Write-Output ("MENU_" + "PASTE_TARGET")'
      : "printf 'MENU_%s\\n' PASTE_TARGET";
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), command);
  await page.getByRole("button", { name: "Foom menu" }).click();
  await page.getByRole("menuitem", { name: /^Paste/ }).click();
  await expect(input).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("MENU_PASTE_TARGET");
});

test("application menu closes before focus commands and keeps their destination focused", {
  timeout: deadline(45000),
  skip: process.platform === "darwin",
}, async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  const menu = page.getByRole("menu", { name: "Foom" });
  const trigger = page.getByRole("button", { name: "Foom menu" });
  await trigger.click();
  await page.getByRole("menuitem", { name: /^Focus sidebar/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".board-row")).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitem", { name: /^Focus tile 1 / }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
});

test("tile drag drops replace, split every edge, swap and move without reattachment; keyboard swaps and Escape", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-drag-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  isolatedGit(["init", "-q", repo]);
  const app = await launchApp(context, false, { emptyBoard: true });
  const page = await boardPage(app);
  await app.evaluate(({ dialog, BrowserWindow }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1500, 900);
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.workspace())).repositories.length)
    .toBe(1);
  await page.evaluate(async (repo) => {
    for (let i = 0; i < 3; i++)
      await window.desktop.sidebarCommand({
        kind: "launch",
        repository: repo,
        worktree: repo,
        run: "shell",
      });
  }, repo);
  const rows = page.locator(".board-row");
  await expect(rows).toHaveCount(3);
  await rows.nth(0).click();
  const tiles = page.locator(".terminal-tile");
  const drag = async (source, target, x, y, cancel = false) => {
    const before = await saved();
    const from = await source.boundingBox(),
      to = await target.boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width * x, to.y + to.height * y, { steps: 12 });
    await expect(page.locator(".tile-drop-preview")).toBeVisible();
    await expect(page.locator(".tile-drop-preview")).toHaveCSS("border-top-style", "dashed");
    const theme = await page
      .locator("html")
      .evaluate((element) => getComputedStyle(element).colorScheme);
    await page.screenshot({ path: path.join(tmpdir(), `foom-133-preview-${theme}.png`) });
    await expect(page.locator('.tile-area > [role="status"]')).toContainText("Escape cancels");
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator(".tile-drop-preview")).toHaveCount(0);
    if (!cancel && before !== (await saved()))
      await expect(
        page.locator('.terminal-tile[data-focused="true"] .xterm-helper-textarea'),
      ).toBeFocused();
  };
  const saved = () => page.evaluate(() => localStorage.getItem("foom.tiles.v1"));
  const initial = await saved();
  await drag(rows.nth(1), tiles.first(), 0.5, 0.5, true);
  assert.equal(await saved(), initial);
  await drag(rows.nth(1), tiles.first(), 0.5, 0.5);
  const ids = await rows.evaluateAll((rows) => rows.map((row) => row.dataset.dragSession));
  assert.equal(JSON.parse(await saved()).tree.session, ids[1]);
  for (const [zone, x, y, theme] of [
    ["left", 0.1, 0.5, "light"],
    ["right", 0.9, 0.5, "dark"],
    ["up", 0.5, 0.1, "light"],
    ["down", 0.5, 0.9, "dark"],
  ]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
    await page.getByRole("button", { name: "One", exact: true }).click();
    await drag(rows.nth(1), tiles.first(), 0.5, 0.5);
    await drag(rows.nth(2), tiles.first(), x, y);
    await expect(tiles).toHaveCount(2);
    const tree = JSON.parse(await saved()).tree;
    assert.equal(tree.direction, zone === "left" || zone === "right" ? "horizontal" : "vertical");
    assert.equal((zone === "left" || zone === "up" ? tree.first : tree.second).session, ids[2]);
    // Restore the other session for the next edge's source/target pair.
    await drag(rows.nth(1), tiles.first(), 0.5, 0.5);
  }
  await page.getByRole("button", { name: "Two side by side", exact: true }).click();
  await rows.nth(0).click();
  await page.evaluate(() => {
    window.dragTiles = [...document.querySelectorAll(".terminal-tile")];
    window.dragXterms = [...document.querySelectorAll(".xterm")];
    window.dragTokens = new Map();
    window.desktop.onData((id, token) => window.dragTokens.set(id, token));
  });
  const sessions = (await page.evaluate(() => window.desktop.workspace())).terminals;
  const pulse = async () => {
    await page.evaluate(() => window.dragTokens.clear());
    for (const session of sessions)
      await page.evaluate((id) => window.desktop.input(id, "echo DRAG_TOKEN\r"), session.id);
    await expect.poll(() => page.evaluate(() => window.dragTokens.size)).toBe(2);
  };
  await pulse();
  const tokens = await page.evaluate(() => [...window.dragTokens].sort());
  await drag(tiles.first().locator(".tile-title"), tiles.nth(1), 0.5, 0.5);
  assert.equal(
    await page.evaluate(
      () => document.querySelectorAll(".terminal-tile")[1] === window.dragTiles[0],
    ),
    true,
  );
  for (const [x, y] of [
    [0.1, 0.5],
    [0.9, 0.5],
    [0.5, 0.1],
    [0.5, 0.9],
  ]) {
    const moving = page.locator(
      `[data-tile="${await page.evaluate(() => window.dragTiles[0].dataset.tile)}"]`,
    );
    const other = page.locator(
      `[data-tile="${await page.evaluate(() => window.dragTiles[1].dataset.tile)}"]`,
    );
    await drag(moving.locator(".tile-title"), other, x, y);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    ).webContents;
    if (process.platform !== "darwin")
      for (const type of ["keyDown", "keyUp"])
        contents.sendInputEvent({ type, keyCode: "Space", modifiers: ["control", "shift"] });
    for (const type of ["keyDown", "keyUp"])
      contents.sendInputEvent({
        type,
        keyCode: "Up",
        modifiers: process.platform === "darwin" ? ["meta", "alt"] : ["shift"],
      });
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector(".terminal-tile") === window.dragTiles[0]),
    )
    .toBe(true);
  await pulse();
  assert.deepEqual(await page.evaluate(() => [...window.dragTokens].sort()), tokens);
  assert.equal(
    await page.evaluate(() => window.dragXterms.every((node) => node.isConnected)),
    true,
  );
  await page.screenshot({ path: path.join(tmpdir(), "foom-133-tiles.png") });
});

test("stable Codex observers drive execution and retire the notifier after a verified turn", {
  timeout: deadline(30000),
  skip:
    process.platform === "win32" &&
    "The fake CLI is a POSIX executable; native Windows observers have unit integration coverage",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "foom-codex-hooks-"));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(repo), mkdir(home)]);
  const cli = path.join(bin, "codex");
  await writeFile(
    cli,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.161.0'); process.exit(0); }
if (args[0] === '--help') { console.log('-c, --config <value> --no-alt-screen'); process.exit(0); }
const notify = args.find(arg => arg.startsWith('notify='));
const hooks = args.filter(arg => arg.startsWith('hooks.'));
if (hooks.length !== 6) throw new Error('Missing lifecycle hooks');
const emit = (event) => {
  const definition = hooks.find(arg => arg.startsWith('hooks.' + event + '='));
  const command = JSON.parse(definition.match(/command=("(?:[^"\\\\]|\\\\.)*")/)[1]);
  const payload = { session_id: 'fake-conversation', hook_event_name: event, turn_id: 'turn', source: 'startup', tool_name: 'Bash', stop_hook_active: false, prompt: 'DISCARDED', transcript_path: '/never-read' };
  const result = spawnSync('sh', ['-c', command], { input: JSON.stringify(payload), encoding: 'utf8' });
  if (result.status !== 0 || result.stdout || result.stderr) throw new Error('Observer emitted output or failed');
};
console.log(notify ? 'NOTIFIER FALLBACK' : 'USER NOTIFIER PRESERVED');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => {
  const key = data.toString();
  if (key === 's') emit('SessionStart');
  if (key === 'w') emit('UserPromptSubmit');
  if (key === 'b') emit('PermissionRequest');
  if (key === 'p') emit('PostToolUse');
  if (key === 'e') { console.log('Completed.'); emit('Stop'); }
  if (key === 'n') {
    const command = JSON.parse(notify.slice(7));
    spawnSync(command[0], [...command.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'fake-conversation', 'turn-id': 'fallback-turn' })]);
  }
  console.log('OBSERVED ' + key);
});
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
  const app = await launchApp(context, false, {
    emptyBoard: true,
    env: { HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  const repository = await page.evaluate(() => window.desktop.addRepository());
  const launch = (branch, acknowledge) =>
    page.evaluate(
      async ({ repository, branch, acknowledge }) => {
        await window.desktop.scanAgents(true);
        const tree = await window.desktop.createWorktree(repository, branch, "adjacent");
        return (
          await window.desktop.launchAgent({
            agent: "codex",
            repository,
            worktree: tree.path,
            cols: 80,
            rows: 24,
            acknowledgeCodexNotifierReplacement: acknowledge,
          })
        ).id;
      },
      { repository: repository.path, branch, acknowledge },
    );
  const id = await launch("first", true);
  const health = () =>
    page.evaluate(
      async () =>
        (await window.desktop.scanAgents(false)).agents.find((agent) => agent.id === "codex")
          .codexHookState,
    );
  const phase = () =>
    page.evaluate(
      async (id) =>
        (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id)
          .execution.phase,
      id,
    );
  const key = async (value) => {
    await page.evaluate(({ id, value }) => window.desktop.input(id, value), { id, value });
    await expect
      .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
      .toContain(`OBSERVED ${value}`);
  };
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), id))
    .toContain("NOTIFIER FALLBACK");
  await key("n");
  await expect.poll(health).toBe("declined");
  await key("s");
  await key("w");
  await expect.poll(phase).toBe("working");
  await key("b");
  await expect.poll(phase).toBe("blocked");
  await key("p");
  await expect.poll(phase).toBe("working");
  await key("e");
  await expect.poll(phase).toBe("idle");
  await expect
    .poll(() =>
      page.evaluate(
        async (id) =>
          (await window.desktop.workspace()).terminals.find((terminal) => terminal.id === id).state
            ?.state,
        id,
      ),
    )
    .toBe("done");
  await expect.poll(health).toBe("trusted");
  const later = await launch("later", false);
  await expect
    .poll(() => page.evaluate((id) => window.desktop.tail(id, 40), later))
    .toContain("USER NOTIFIER PRESERVED");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Agents and hooks", exact: true })
    .click();
  await expect(page.getByText(/Codex hooks: Trusted/)).toBeVisible();
  await page.screenshot({ path: path.join(__dirname, "../../test-results/codex-hook-setup.png") });
});

test("neutral identity badges keep labels and geometry across themes and interface scales", async (context) => {
  const app = await launchApp(context);
  const page = await boardPage(app);
  const basePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  const row = page.locator('.board-row[data-kind="shell"]');
  await expect(row).toBeVisible();
  await row.press("F2");
  await page.getByRole("textbox", { name: "Session name" }).fill("Build helper");
  await page.getByRole("textbox", { name: "Session name" }).press("Enter");
  await expect(row).toHaveAccessibleName(/Build helper · Shell \(.+\)/);
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
      const peek = page.getByRole("complementary", { name: "Terminal peek" });
      await expect(peek).toBeVisible();
      await expect(peek.getByRole("heading")).toHaveText(/^Shell \(.+\) · /);
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

test("merged cleanup deletes two worktrees and branches while preserving a skipped checkout", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-merged-")));
  removeAfterApps(context, root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const git = (...args) =>
    isolatedGit(["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const remote = path.join(root, "remote.git");
  git("clone", "--bare", repo, remote);
  git("remote", "add", "origin", remote);
  const app = await launchApp(context, false, { emptyBoard: true, home });
  const page = await boardPage(app);
  await app.evaluate(({ dialog }, repo) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
  }, repo);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  await expect(page.getByRole("button", { name: "Actions for repo", exact: true })).toBeVisible();
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  const paths = {};
  for (const branch of ["merged-one", "merged-two", "dirty"]) {
    const tree = await page.evaluate(
      ({ repo, branch }) => window.desktop.createWorktree(repo, branch, "adjacent"),
      { repo: repository, branch },
    );
    paths[branch] = tree.path;
  }
  await writeFile(path.join(paths.dirty, "keep.txt"), "must survive");
  // Wait for the source to include the fresh eligibility result before opening its menu.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.sidebarInventory())).repositories[0]
          ?.canDeleteMerged,
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Actions for merged-two", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete merged worktrees…" }).click();
  const confirmation = await confirmationPage(app);
  await expect(confirmation.getByRole("list", { name: "Worktrees to delete" })).toHaveText(
    "merged-onemerged-two",
  );
  await expect(confirmation.getByRole("list", { name: "Skipped worktrees" })).toContainText(
    "dirtyuncommitted changes",
  );
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.screenshot({ path: path.join(tmpdir(), "foom-122-confirmation.png") });
  const results = await new AxeBuilder({ page: confirmation }).setLegacyMode().analyze();
  assert.deepEqual(
    results.violations.filter((v) => ["serious", "critical"].includes(v.impact)),
    [],
  );
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  assert.ok((git("branch", "--list", "merged-one") || "").includes("merged-one"));
  await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete merged worktrees…" }).click();
  await expect(confirmation.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate((repository) => window.desktop.worktrees(repository), repository))
          .length,
    )
    .toBe(2);
  for (const branch of ["merged-one", "merged-two"]) {
    await assert.rejects(realpath(paths[branch]), { code: "ENOENT" });
    await expect.poll(() => git("branch", "--list", branch).toString().trim()).toBe("");
  }
  assert.equal(await readFile(path.join(paths.dirty, "keep.txt"), "utf8"), "must survive");
  assert.ok(git("branch", "--list", "dirty").includes("dirty"));
});

test("shell fixture starts through keyboard while startup layout moves", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, false, { emptyBoard: true });
  const page = await boardPage(app);
  await page.evaluate(() => {
    window.fixtureMoving = true;
    let frame = 0;
    const move = () => {
      frame++;
      for (const button of document.querySelectorAll(".row-actions"))
        button.style.transform = `translateX(${frame % 2 ? 4 : 0}px)`;
      if (window.fixtureMoving) requestAnimationFrame(move);
    };
    move();
  });
  try {
    await launchCheckoutShell(app, page);
    await expect(page.locator(".board-row[data-kind='shell']")).toBeVisible();
    await page.locator(".board-row[data-kind='shell']").press("Enter");
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  } finally {
    await page.evaluate(() => {
      window.fixtureMoving = false;
    });
  }
});

test("console pairing requires trusted approval and gives only read-only repository scope", {
  timeout: deadline(45000),
}, async (context) => {
  const { assertCliPairing } = require("./cli-checks.js");
  const app = await launchApp(context, false);
  const page = await boardPage(app);
  const profile = await app.evaluate(({ app }) => app.getPath("userData"));
  const repository = await page.evaluate(
    async () => (await window.desktop.workspace()).repositories[0].path,
  );
  const confirmation = await confirmationPage(app);
  await assertCliPairing(
    context,
    path.join(__dirname, "../../build/console", process.platform === "win32" ? "foom.exe" : "foom"),
    profile,
    repository,
    confirmation,
  );
});
