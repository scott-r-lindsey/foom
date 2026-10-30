const { evidencePath } = require("../helpers/evidence.js");
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
  confirmationPage,
  fixtureCleanup,
  launchApp,
  launchCheckoutShell,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
  restartShellFromSidebar,
  stopSession,
} = require("./harness.js");

test("fresh focused terminal cursor blinks and preserves application style on reattach", {
  timeout: deadline(45000),
}, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "foom-cursor-probe-"));
  removeAfterApps(context, directory);
  const marker = path.join(directory, "stage");
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  // ACKs originate in xterm's write callback, after parsing (not after paint).
  await app.evaluate(({ ipcMain }) => {
    globalThis.cursorProbeAcks = {};
    globalThis.cursorProbeAck = (_event, id, token, count) => {
      const tokens = (globalThis.cursorProbeAcks[id] ??= {});
      tokens[token] = (tokens[token] ?? 0) + count;
    };
    ipcMain.on("terminal:ack", globalThis.cursorProbeAck);
  });
  // Keep observing through output and every reattach, not just startup. A frame
  // sentinel per data event detects starvation without a perpetual rAF loop.
  await page.evaluate(() => {
    window.cursorProbe = { output: {}, active: [], frames: 0, pending: 0 };
    const frames = new Set();
    window.stopCursorProbeData = window.desktop.onData((id, token, data) => {
      const output = (window.cursorProbe.output[id] ??= { units: 0, text: "", tokens: {} });
      output.units += data.length;
      if (!(token in output.tokens)) output.text = "";
      output.text = (output.text + data).slice(-8192);
      output.tokens[token] = (output.tokens[token] ?? 0) + data.length;
      window.cursorProbe.pending++;
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        window.cursorProbe.frames++;
        window.cursorProbe.pending--;
      });
      frames.add(frame);
    });
    window.stopCursorProbeActivity = window.desktop.onActivity((batch) => {
      for (const { id, rate } of batch)
        if (rate > 0 && !window.cursorProbe.active.includes(id)) window.cursorProbe.active.push(id);
    });
    window.stopCursorProbeFrames = () => {
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  });
  const shell = page.locator(".terminal-tile[data-kind='shell'] .tile-terminal");
  const rows = shell.locator(".xterm-rows");
  const cursor = rows.locator(".xterm-cursor");
  const expectCursor = async (style, blinking, animation = /.*/) => {
    await expect(shell.locator(".xterm")).toHaveCount(1);
    // Focus paints the current row synchronously; the previous row can retain an
    // outline cursor until xterm's queued frame. Check count and state together.
    await expect
      .poll(() =>
        cursor.evaluateAll((elements) =>
          elements.map((element) => ({
            className: element.className,
            blinking: element.classList.contains("xterm-cursor-blink"),
            animation: getComputedStyle(element).animationName,
          })),
        ),
      )
      .toEqual([
        {
          className: expect.stringMatching(style),
          blinking,
          animation: expect.stringMatching(animation),
        },
      ]);
  };
  const prompt = process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/;
  let id;
  let expectedOutput = prompt;
  let stage = "startup";
  try {
    await launchCheckoutShell(app, page);
    await expect
      .poll(async () => {
        id = (await page.evaluate(() => window.desktop.workspace())).terminals[0]?.id;
        return Boolean(id);
      })
      .toBe(true);
    // Shell readiness belongs to the always-parsing host, not xterm's rAF paint.
    // A focused view can still have an unpainted cursor row on a cold CI display.
    // Join physical rows so a wrapped PowerShell prompt remains one readiness signal.
    await expect
      .poll(async () => (await page.evaluate((id) => window.desktop.tail(id, 40), id)).join("\n"))
      .toMatch(prompt);
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expectCursor(/xterm-cursor-block/, true, /blink_block_/);

    const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "view-probe.js")}" "${marker}"`;
    stage = "initial probe output";
    expectedOutput = /NORMAL_VIEW_READY/;
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("NORMAL_VIEW_READY");
    stage = "steady cursor output";
    expectedOutput = /CURSOR_STEADY/;
    await page.keyboard.press("c");
    await expectCursor(/xterm-cursor-underline/, false);
    await openSettingsScreen(page);
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".board-row[data-kind='shell']").click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expectCursor(/xterm-cursor-underline/, false);
    await openSettingsScreen(page);
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    stage = "blinking cursor reattach";
    expectedOutput = /CURSOR_BLINKING/;
    await page.evaluate((id) => window.desktop.input(id, "b"), id);
    await expect.poll(() => readFile(marker, "utf8")).toBe("blinking");
    await page.keyboard.press("Escape");
    await page.locator(".board-row[data-kind='shell']").click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expectCursor(/xterm-cursor-bar/, true, /blink_bar_/);
    stage = "default cursor output and reattach";
    expectedOutput = /CURSOR_DEFAULT_STEADY/;
    await page.keyboard.press("r");
    await expect(rows).toContainText("CURSOR_DEFAULT_STEADY");
    await expectCursor(/xterm-cursor-block/, false);
    await openSettingsScreen(page);
    await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".board-row[data-kind='shell']").click();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expectCursor(/xterm-cursor-block/, false);
    await stopSession(page, id);
    await expect(cursor).toHaveCount(0);
  } catch (error) {
    const host = id
      ? await page
          .evaluate((id) => window.desktop.tail(id, 40), id)
          .then(
            (lines) => ({ lines }),
            (error) => ({ error: String(error) }),
          )
      : { lines: [] };
    const renderer = await page.evaluate(() => ({
      probe: window.cursorProbe,
      rows: document.querySelector(".xterm-rows")?.textContent,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      active: document.activeElement?.outerHTML,
      status: document.querySelector(".tile-status")?.textContent,
      bounds: document.querySelector(".xterm-screen")?.getBoundingClientRect().toJSON(),
    }));
    const acknowledgements = await app.evaluate(() => globalThis.cursorProbeAcks);
    const delivered = renderer.probe.output[id];
    const token = Object.keys(delivered?.tokens ?? {}).at(-1);
    const parsed = acknowledgements[id]?.[token] ?? 0;
    const rendering = !expectedOutput.test(host.lines?.join("\n") ?? "")
      ? "expected host output unavailable"
      : !expectedOutput.test(delivered?.text ?? "")
        ? "no expected data delivered to view"
        : parsed < delivered.tokens[token]
          ? "data delivered; view unsubscribed or xterm write incomplete"
          : renderer.probe.pending > 0
            ? "data written; no frames for pending view data"
            : !expectedOutput.test(renderer.rows ?? "")
              ? "data written but not painted despite frames"
              : "output painted; cursor or focus assertion failed";
    context.diagnostic(
      `Cursor lifecycle diagnostics: ${JSON.stringify({
        id,
        stage,
        expectedOutput: String(expectedOutput),
        hostState: host.error
          ? "host tail unavailable"
          : expectedOutput.test(host.lines.join("\n"))
            ? "expected host output observed"
            : host.lines.length || renderer.probe.active.includes(id)
              ? "PTY output observed; expected output absent"
              : "no PTY output observed",
        host,
        renderer,
        rendering,
        token,
        acknowledgements,
        workspace: await page.evaluate(() => window.desktop.workspace()),
        windows: await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            url: window.webContents.getURL(),
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            bounds: window.getBounds(),
            focused: window.isFocused(),
            contentsFocused: window.webContents.isFocused(),
          })),
        ),
      })}`,
    );
    throw error;
  } finally {
    await page.evaluate(() => {
      window.stopCursorProbeData();
      window.stopCursorProbeActivity();
      window.stopCursorProbeFrames();
    });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeListener("terminal:ack", globalThis.cursorProbeAck);
    });
  }
});

test("terminal runs an interactive shell behind an isolated bridge", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  console.info("Electron launched");
  try {
    const page = await boardPage(app);
    console.info("Window opened");
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
    // PTY creation and attachment precede shell startup. Wait for the initial
    // prompt before typing so startup cannot clear or consume the command.
    await expect
      .poll(() => page.locator(".xterm-rows").innerText())
      .toMatch(process.platform === "win32" ? /PS [\s\S]*>/ : /[$#%>]\s*$/);
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
          "previews",
          "windows",
          "sounds",
          "confirmations",
          "isDevelopment",
          "appMenu",
          "onBoardCommand",
          "create",
          "attach",
          "detach",
          "kill",
          "copyTerminalSelection",
          "input",
          "resize",
          "acknowledge",
          "tail",
          "onActivity",
          "actionLog",
          "clearActionLog",
          "onWorkspaceChange",
          "startWorktree",
          "removeWorktree",
          "panelFacts",
          "onFocusWorktree",
          "sidebarInventory",
          "sidebarCommand",
          "workspace",
          "addRepository",
          "worktrees",
          "branches",
          "createWorktree",
          "changeAgentSetup",
          "changeAgyPlugin",
          "scanAgents",
          "launchAgent",
          "configStatus",
          "decideConfig",
          "openConfigFolder",
          "onConfigChange",
          "hosts",
          "listTerminalFonts",
          "listThemes",
          "openThemesFolder",
          "checkReadiness",
          "restartToUpdate",
          "setupState",
          "saveSetup",
          "environmentState",
          "saveEnvironment",
          "removeEnvironment",
          "readShellEnvironment",
          "importEnvironment",
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
    await expect(input).toHaveAttribute("readonly", "");
    await expect(page.locator(".xterm-cursor")).toHaveCount(0);
    // Focusing the retained output must not revive the cursor.
    await input.focus();
    await expect(page.locator(".xterm-cursor")).toHaveCount(0);
    console.info("Shell exited");
    await restartShellFromSidebar(page);
    await page.waitForFunction(
      () => !/Starting|exited|Unable/.test(document.querySelector(".tile-status").textContent),
    );
    await expect(input).not.toHaveAttribute("readonly", "");
    await input.focus();
    await page.keyboard.type(
      process.platform === "win32"
        ? 'Write-Output ("RESTART_" + "INPUT_OK")'
        : "printf 'RESTART_%s\\n' INPUT_OK",
    );
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.terminalOutput.includes("RESTART_INPUT_OK")))
      .toBe(true);
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

test("utility host survives output floods without losing rows or delaying another PTY", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
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
          hosts: app
            .getAppMetrics()
            .filter((metric) => metric.name?.startsWith("Foom terminal host ")).length,
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

test("utility host survives concurrent terminal exits and drains multi-terminal shutdown", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  fixtureCleanup(context).apps.unshift(async () => {
    await app.evaluate(async () => {
      const host = globalThis.ptyRaceHost;
      if (!host) return;
      try {
        await host.shutdown();
      } finally {
        await host.dispose();
      }
    });
  });
  await boardPage(app);
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { TerminalHostClient } = load("./build/main/terminals/terminal-host-client.js");
    globalThis.ptyRaceExits = [];
    globalThis.ptyRaceHost = new TerminalHostClient((id, code) =>
      globalThis.ptyRaceExits.push({ id, code }),
    );
  });
  // Every batch must succeed; this is concurrent native lifecycle coverage, not a retry.
  for (const shutdown of [false, true]) {
    const ids = await app.evaluate(
      async ({ app }, { node, probe }) => {
        const host = globalThis.ptyRaceHost;
        return Promise.all(
          Array.from({ length: 12 }, () =>
            host.create({
              command: node,
              args: [probe, "echo"],
              cwd: app.getPath("temp"),
              cols: 80,
              rows: 24,
            }),
          ),
        );
      },
      { node: process.execPath, probe: path.join(__dirname, "host-probe.js") },
    );
    await expect
      .poll(() =>
        app.evaluate(async (_electron, ids) => {
          const lines = await Promise.all(ids.map((id) => globalThis.ptyRaceHost.tail(id, 5)));
          return lines.every((tail) => tail.some((line) => line.includes("READY")));
        }, ids),
      )
      .toBe(true);
    await app.evaluate(
      async (_electron, { ids, shutdown }) => {
        const host = globalThis.ptyRaceHost;
        // Resizes run while native exit watchers remove other sessions' handles.
        if (shutdown) await host.shutdown();
        else
          await Promise.all(
            ids.map(async (id, index) => {
              host.resize(id, 90 + index, 30);
              await host.stop(id);
            }),
          );
      },
      { ids, shutdown },
    );
    await expect.poll(() => app.evaluate(() => globalThis.ptyRaceHost.runningCount)).toBe(0);
    if (!shutdown) {
      await expect.poll(() => app.evaluate(() => globalThis.ptyRaceExits.length)).toBe(12);
      assert.equal(
        await app.evaluate(() => globalThis.ptyRaceExits.some(({ code }) => code === -1)),
        false,
      );
    }
  }
});

test("a crashed utility host reports failure and the renderer can restart", {
  timeout: deadline(45_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.waitForFunction(
    () => !/Starting|exited|Unable/.test(document.querySelector(".tile-status").textContent),
  );
  await expect(page.locator(".tile-restoring")).toHaveCount(0);
  const hostPid = await app.evaluate(({ app }) => {
    const metric = app
      .getAppMetrics()
      .find((metric) => metric.name?.startsWith("Foom terminal host "));
    if (!metric) throw new Error("Missing utility host");
    process.kill(metric.pid, "SIGKILL");
    return metric.pid;
  });
  await expect(page.getByRole("status").filter({ hasText: "Terminal host failed" })).toBeVisible();
  await expect(page.getByRole("status", { name: /^Restoring / })).toHaveCount(0);
  await restartShellFromSidebar(page);
  await page.waitForFunction(
    () => !/Starting|failed|Unable/.test(document.querySelector(".tile-status").textContent),
  );
  // A title is available before the replacement attachment is ready for input.
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const replacementPid = await app.evaluate(
    ({ app }) =>
      app.getAppMetrics().find((metric) => metric.name?.startsWith("Foom terminal host "))?.pid,
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
  const app = await launchApp(context, { fixture: "running-shell" });
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
      await openSettingsScreen(page);
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await page.getByRole("button", { name: /^Colors / }).click();
      await page.getByRole("menuitemradio", { name: "Dracula", exact: true }).click();
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

test("focus reports reach the shell without counting as a reply", {
  timeout: deadline(45_000),
  skip: process.platform === "win32" && "The prompt script is POSIX shell",
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
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

test("middle click reports without pasting while tracking and Shift preserves Linux primary selection", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-middle-click-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "input");
  await writeFile(marker, "");
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`,
  );
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  const selection = "PRIMARY_SELECTION_317";
  if (process.platform === "linux") {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text, "selection"), selection);
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText("selection")), selection);
  }
  await page.keyboard.type("m");
  await expect(page.locator(".xterm-rows")).toContainText("MOUSE_READY");
  const screen = page.locator(".xterm-screen");
  // A PTY acknowledgement after each click bounds the complete input sequence;
  // assertions include both press/release and any native paste before that barrier.
  let barriers = 0;
  const readInput = async () => {
    await page.keyboard.type("b");
    barriers++;
    await expect
      .poll(
        async () =>
          (await page.locator(".xterm-rows").innerText()).split("INPUT_BARRIER").length - 1,
      )
      .toBe(barriers);
    return Buffer.from((await readFile(marker, "utf8")).replaceAll("\n", ""), "hex").toString();
  };
  const clickInput = async (shift) => {
    await writeFile(marker, "");
    if (shift) await page.keyboard.down("Shift");
    await screen.click({ button: "middle", position: { x: 40, y: 40 } });
    if (shift) await page.keyboard.up("Shift");
    return readInput();
  };
  assert.match(
    (await clickInput(false)).replaceAll("\x1b", "ESC"),
    /^ESC\[<1;\d+;\d+MESC\[<1;\d+;\d+mb$/,
  );
  if (process.platform === "linux") {
    assert.equal(await clickInput(true), `${selection}b`);
    await page.keyboard.type("n");
    await expect(page.locator(".xterm-rows")).toContainText("MOUSE_OFF");
    assert.equal(await clickInput(false), `${selection}b`);
  }
  // A later application-menu paste must survive, including on platforms where
  // middle click never produces a native primary-selection paste.
  await writeFile(marker, "");
  await app.evaluate(({ clipboard }) => clipboard.writeText("CLIPBOARD_317"));
  await page.evaluate(() => window.desktop.appMenu.execute("paste"));
  assert.equal(await readInput(), "CLIPBOARD_317b");
  await page.keyboard.type("q");
});

test("wheel moves less and preserves normal shell scrollback", {
  timeout: deadline(30000),
  skip: process.platform === "win32" && "less is a POSIX pager",
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
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

test("Bash command status reaches the sidebar without closing the shell", {
  timeout: deadline(30_000),
  skip: process.platform !== "linux" && "Requires Bash 4.4 or newer",
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-program-"));
  removeAfterApps(context, root);
  await require("node:fs/promises").copyFile("/bin/sleep", path.join(root, "vim"));
  const app = await launchApp(context, {
    fixture: "running-shell",
    env: { SHELL: "/bin/bash", PATH: root },
  });
  const page = await boardPage(app);
  const row = page.locator(".board-row[data-kind='shell']");
  await expect(row).toHaveAttribute("data-state", "shell");
  await expect(row.locator(".board-reason")).toHaveCount(0);
  const state = () =>
    page.evaluate(
      async () =>
        (await window.desktop.workspace()).terminals.find((t) => t.kind === "shell")?.state?.state,
    );
  await expect.poll(state).toBe("quiet_ok");
  const input = page.locator(".xterm-helper-textarea");
  await input.focus();
  for (const program of ["sleep", "vim"]) {
    await page.keyboard.type(`${program} 2`);
    await page.keyboard.press("Enter");
    await expect(row.locator(".session-program")).toHaveText(program);
    await expect(page.locator(".tile-title .session-program")).toHaveText(program);
    await expect(row).toHaveAttribute("data-state", "shell");
    await expect.poll(state).toBe("done");
    await expect(row.locator(".session-program")).toHaveCount(0);
  }
  await page.keyboard.type(
    `node -e 'setInterval(() => process.stdout.write("x".repeat(512) + "\\n"), 100)'`,
  );
  await page.keyboard.press("Enter");
  await expect(row.locator(".session-program")).toHaveText("node");
  await row.evaluate((element) => {
    window.activityRow = element;
    window.activityRowChanges = 0;
    window.activityObserver = new MutationObserver((records) => {
      window.activityRowChanges += records.length;
    });
    window.activityObserver.observe(element, { childList: true, subtree: true });
  });
  await expect
    .poll(() =>
      row
        .locator(".board-light")
        .evaluate((element) => Number(element.style.getPropertyValue("--activity"))),
    )
    .toBeGreaterThan(0.9);
  await expect.poll(() => row.locator(".activity-trace path").getAttribute("d")).toContain("L");
  assert.equal(
    await row.evaluate(
      (element) => window.activityRow === element && window.activityRowChanges === 0,
    ),
    true,
  );
  await page.evaluate(() => window.activityObserver.disconnect());
  if (process.env.FOOM_SCREENSHOTS)
    await page.screenshot({ path: evidencePath("foom-270-glow.png") });
  await page.keyboard.press("Control+c");
  await expect(row.locator(".session-program")).toHaveCount(0);
  await page.keyboard.type("false");
  await page.keyboard.press("Enter");
  await expect.poll(state).toBe("failed");
  await expect(row).toHaveAttribute("data-state", "shell");
  await page.keyboard.type("echo next");
  await page.keyboard.press("Enter");
  await expect.poll(state).toBe("done");
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-exited", "true");
  await expect(row).toHaveAccessibleName(/Exited/);
  await expect(row.locator(".session-program")).toHaveText("exited");
  await assertAccessible(page);
  if (process.env.FOOM_SCREENSHOTS)
    await page.screenshot({ path: evidencePath("foom-270-exited.png") });
});

test("shell fixture starts through keyboard while startup layout moves", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
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

test("restored exited sessions hide the unattached terminal until restarted", async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-restored-cursor-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`] };
  const app = await launchApp(context, { ...options, fixture: "running-shell" });
  const page = await boardPage(app);
  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially("exit");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(async () => (await window.desktop.workspace()).terminals[0]?.exited))
    .toBe(true);
  await expect
    .poll(
      async () => JSON.parse(await readFile(path.join(profile, "sessions.json"), "utf8")).length,
    )
    .toBe(1);
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));

  const restoredApp = await launchApp(context, { fixture: "restored", ...options });
  const restored = await boardPage(restoredApp);
  await expect(restored.locator(".board-row")).toHaveCount(1);
  // A saved exited row has no screen or board assignment until restarted.
  await restored.locator(".board-row").press("Enter");
  await expect(restored.locator('.terminal-tile[data-empty="false"]')).toHaveCount(0);
  await expect(restored.locator(".tile-terminal")).toBeHidden();
  await expect(restored.locator(".xterm-helper-textarea")).not.toBeFocused();
  await expect(restored.locator(".xterm-cursor:visible")).toHaveCount(0);

  await restartShellFromSidebar(restored);
  await expect(restored.locator(".tile-restoring")).toHaveCount(0);
  await expect(restored.locator(".tile-terminal")).toBeVisible();
  await expect(restored.locator(".xterm-helper-textarea")).toBeFocused();
  await restored.locator(".xterm-helper-textarea").pressSequentially("echo RESTORED_SHELL_READY");
  await restored.locator(".xterm-helper-textarea").press("Enter");
  await expect
    .poll(() =>
      restored.evaluate(async () => {
        const terminal = (await window.desktop.workspace()).terminals[0];
        return (await window.desktop.tail(terminal.id, 10)).join("\n");
      }),
    )
    .toContain("RESTORED_SHELL_READY");
});

test("new and restored shells show a silent foreground program until the next prompt", {
  timeout: deadline(60_000),
  // Silent commands need Bash 4.4 PS0 markers; Windows has no foreground name.
  skip: process.platform !== "linux" && "Requires Bash 4.4 or newer",
}, async (context) => {
  const profile = await mkdtemp(path.join(tmpdir(), "foom-restored-program-"));
  removeAfterApps(context, profile);
  const options = { args: [`--user-data-dir=${profile}`] };
  const showsSleep = async (page) => {
    const row = page.locator(".board-row[data-kind='shell']");
    const input = page.locator(".xterm-helper-textarea");
    await expect(input).toBeFocused();
    await expect(row.locator(".session-program")).toHaveCount(0);
    await input.pressSequentially("sleep 30");
    await input.press("Enter");
    await expect(row.locator(".session-program")).toHaveText("sleep");
    await input.press("Control+c");
    await expect(row.locator(".session-program")).toHaveCount(0);
  };
  const app = await launchApp(context, { ...options, fixture: "running-shell" });
  await showsSleep(await boardPage(app));
  await quitAndWait(app, async () => {
    await app.evaluate(({ app }) => app.quit());
    await (await confirmationPage(app)).getByRole("button", { name: "Stop all and quit" }).click();
  });

  const restoredApp = await launchApp(context, { fixture: "restored", ...options });
  const restored = await boardPage(restoredApp);
  const row = restored.locator(".board-row[data-kind='shell']");
  await expect(row).toHaveCount(1);
  await expect
    .poll(() =>
      restored.evaluate(async () => {
        const terminal = (await window.desktop.workspace()).terminals[0];
        return Boolean(terminal && !terminal.exited && !terminal.dormant);
      }),
    )
    .toBe(true);
  await row.press("Enter");
  await showsSleep(restored);
});

test("hidden streaming buffers catch up byte-for-byte in normal and alternate screens", {
  timeout: deadline(45000),
}, async (context) => {
  const { Terminal } = require("@xterm/headless");
  const { SerializeAddon } = require("@xterm/addon-serialize");
  const { output } = require("./streaming-buffer.js");
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await app.evaluate(({ ipcMain }) => {
    globalThis.bufferGrid = undefined;
    ipcMain.on("terminal:resize", (_event, _id, cols, rows) => {
      globalThis.bufferGrid = { cols, rows };
    });
  });
  await page.evaluate(() => {
    window.bufferEvents = [];
    window.stopBufferEvents = window.desktop.onData((id, token, data) => {
      window.bufferEvents.push({ id, token, data });
    });
  });
  await launchCheckoutShell(app, page);
  await expect(page.locator('.board-row[data-kind="shell"]')).toHaveCount(1);
  await expect
    .poll(() => app.evaluate(() => globalThis.bufferGrid))
    .toMatchObject({
      cols: expect.any(Number),
      rows: expect.any(Number),
    });
  const [session] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  const grid = await app.evaluate(() => globalThis.bufferGrid);
  const reference = new Terminal({ ...grid, scrollback: 10000, allowProposedApi: true });
  const expected = new SerializeAddon();
  reference.loadAddon(expected);
  const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));
  try {
    const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "streaming-buffer.js")}"\r`;
    await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
      id: session.id,
      command,
    });
    await expect(page.locator('.terminal-tile[data-kind="shell"] .xterm-rows')).toContainText(
      "BUFFER_READY",
    );
    await write(
      reference,
      await page.evaluate(() => window.bufferEvents.map((e) => e.data).join("")),
    );
    for (const stage of ["normal", "alternate"]) {
      await page.getByRole("button", { name: "Hide", exact: true }).click();
      await expect(page.locator(".tile-terminal:visible")).toHaveCount(0);
      await page.evaluate(() => {
        window.bufferEvents = [];
      });
      await page.evaluate(({ id, key }) => window.desktop.input(id, key), {
        id: session.id,
        key: stage === "alternate" ? "a" : "n",
      });
      await expect
        .poll(async () =>
          (await page.evaluate((id) => window.desktop.tail(id, 5), session.id)).join("\n"),
        )
        .toContain(`BUFFER_${stage}_DONE`);
      assert.equal(await page.evaluate(() => window.bufferEvents.length), 0);
      await write(reference, output(stage));
      await page.locator(".board-row[data-kind='shell']").click();
      await expect(page.locator('.terminal-tile[data-kind="shell"] .xterm-rows')).toContainText(
        `BUFFER_${stage}_DONE`,
      );
      const snapshot = await page.evaluate(() => window.bufferEvents.map((e) => e.data).join(""));
      const restored = new Terminal({ ...grid, scrollback: 10000, allowProposedApi: true });
      const actual = new SerializeAddon();
      restored.loadAddon(actual);
      try {
        await write(restored, snapshot);
        assert.deepEqual(Buffer.from(actual.serialize()), Buffer.from(expected.serialize()));
      } finally {
        restored.dispose();
      }
    }
  } finally {
    reference.dispose();
    await page.evaluate(() => window.stopBufferEvents());
  }
});

test("maximized-away terminals pause paints and restore without changing attachment", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const inventory = await page.evaluate(() => window.desktop.workspace());
  const [session] = inventory.terminals;
  const repository = inventory.repositories[0].path;
  const tile = page.locator(`.terminal-tile:has(.xterm-helper-textarea)`).first();
  const tileId = await tile.getAttribute("data-tile");
  const original = page.locator(`.terminal-tile[data-tile="${tileId}"]`);
  await page.evaluate((id) => {
    window.coveredTokens = [];
    window.coveredUnits = 0;
    window.coveredElement = document.querySelector(".xterm");
    window.stopCoveredData = window.desktop.onData((terminal, token, data) => {
      if (terminal !== id) return;
      window.coveredTokens.push(token);
      window.coveredUnits += data.length;
    });
  }, session.id);
  await app.evaluate(({ ipcMain }, id) => {
    globalThis.coveredParsed = 0;
    ipcMain.on("terminal:ack", (_event, terminal, _token, count) => {
      if (terminal === id) globalThis.coveredParsed += count;
    });
  }, session.id);
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "streaming-buffer.js")}"\r`;
  await page.evaluate(({ id, command }) => window.desktop.input(id, command), {
    id: session.id,
    command,
  });
  await expect(original.locator(".xterm-rows")).toContainText("BUFFER_READY");
  const tileCount = await page.locator(".terminal-tile").count();
  await page.evaluate(() => window.desktop.appMenu.execute("split-right"));
  await expect(page.locator(".terminal-tile")).toHaveCount(tileCount + 1);
  await page.evaluate(
    (repository) =>
      window.desktop.sidebarCommand({
        kind: "launch",
        repository,
        worktree: repository,
        run: "shell",
      }),
    repository,
  );
  await expect(page.locator('.board-row[data-kind="shell"]')).toHaveCount(2);
  const next = (await page.evaluate(() => window.desktop.workspace())).terminals.find(
    (entry) => entry.id !== session.id,
  );
  await page.locator(`[data-drag-session="${next.id}"]`).click();
  const second = page.locator(`.terminal-tile[data-kind="shell"]:not([data-tile="${tileId}"])`);
  await expect(second).toHaveCount(1);
  await second.getByRole("button", { name: "Maximize tile", exact: true }).click();
  await expect(original.locator(".xterm-screen")).toBeHidden();
  assert.ok((await original.locator(".tile-terminal").boundingBox()).width > 0);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1300, 900);
  });
  // Let the visibility observer and any already queued paint cross a frame.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const intersection = await original.locator(".xterm-screen").evaluate(
    (screen) =>
      new Promise((resolve) => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve({ intersects: entry.isIntersecting, ratio: entry.intersectionRatio });
        });
        observer.observe(screen);
      }),
  );
  assert.equal(intersection.intersects, false, JSON.stringify(intersection));
  for (const [key, stage] of [
    ["n", "normal"],
    ["a", "alternate"],
  ]) {
    const deliveredBefore = await page.evaluate(() => window.coveredUnits);
    await page.evaluate(({ id, key }) => window.desktop.input(id, key), { id: session.id, key });
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.desktop.tail(id, 5), session.id)).join("\n"),
      )
      .toContain(`BUFFER_${stage}_DONE`);
    await expect
      .poll(() => page.evaluate(() => window.coveredUnits))
      .toBeGreaterThan(deliveredBefore);
    await expect
      .poll(async () => {
        const delivered = await page.evaluate(() => window.coveredUnits);
        return (await app.evaluate(() => globalThis.coveredParsed)) >= delivered;
      })
      .toBe(true);
    // xterm selection refreshes may still update the backing DOM; covered
    // screens must stay excluded from browser layout/paint while parsing.
    await expect(original.locator(".xterm-screen")).toBeHidden();
  }
  await second.getByRole("button", { name: "Restore tile", exact: true }).click();
  await expect(original.locator(".xterm-rows")).toContainText("BUFFER_alternate_DONE");
  assert.equal(await page.evaluate(() => new Set(window.coveredTokens).size), 1);
  assert.equal(
    await original.locator(".xterm").evaluate((element) => element === window.coveredElement),
    true,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await second.getByRole("button", { name: "Maximize tile", exact: true }).click();
  await expect(original.locator(".xterm-screen")).toBeHidden();
  assert.equal(
    await original
      .locator(".xterm-screen")
      .evaluate((screen) => getComputedStyle(screen).transitionDuration),
    "0s",
  );
  await second.getByRole("button", { name: "Restore tile", exact: true }).click();
  await expect(original.locator(".xterm-rows")).toContainText("BUFFER_alternate_DONE");
  await page.evaluate(() => window.stopCoveredData());
});

test("macOS private selection pastes from terminal A to B through bracketed paste", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-selection-paste-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "input");
  await writeFile(marker, "");
  const app = await launchApp(context, { fixture: "running-shell" });
  let page = await boardPage(app);
  // Exercise macOS renderer behavior on every CI platform without shipped test flags.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await page.reload();
  page = await boardPage(app);
  // Leave room for both terminals under the normal minimum-column placement rule.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1400, 1000);
  });
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await openSettingsScreen(page);
  await expect(page.getByRole("checkbox", { name: "Middle-click pastes selection" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Terminal", exact: true })).toBeFocused();
  const toggle = page.getByRole("checkbox", { name: "Middle-click pastes selection", exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.middleClickPaste),
    )
    .toBe(true);
  if (process.env.FOOM_CAPTURE_856 === "1") {
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (colorMode) =>
          window.desktop.saveSetup({
            interfaceTheme: colorMode === "system" ? "follow" : `eclipse-${colorMode}`,
          }),
        mode,
      );
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(mode === "dark");
      await toggle.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: evidencePath(`screenshots-856/settings-terminal-${mode}.png`),
        animations: "disabled",
      });
    }
  }
  await assertAccessible(page);
  // Selecting the row queues input focus after the serialized reattachment.
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`;
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  await launchCheckoutShell(app, page);
  const tiles = page.locator(".terminal-tile[data-kind='shell']");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(1).locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type(command + " bracketed");
  await page.keyboard.press("Enter");
  await expect(tiles.locator(".xterm-rows")).toContainText(["INPUT_READY", "INPUT_READY"]);
  // The probe places INPUT_READY in row one. Target xterm's event overlay and
  // wait for the selection paint before moving to B, including during tile motion.
  const screenA = tiles.nth(0).locator(".xterm-screen");
  await screenA.dblclick({ position: { x: 20, y: 8 } });
  await expect(tiles.nth(0).locator(".xterm-selection div:visible").first()).toBeVisible();
  const screenB = tiles.nth(1).locator(".xterm-screen");
  if (process.platform === "linux") {
    // Chromium still emits Linux's native primary paste despite platform injection.
    // macOS has no such ClipboardEvent; keep the real middle click but model its absence.
    await page.evaluate(() => {
      document.addEventListener(
        "paste",
        (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true,
      );
    });
  }
  await writeFile(marker, "");
  await screenB.click({ button: "middle", position: { x: 40, y: 40 } });
  await page.keyboard.type("b");
  await expect(tiles.nth(1).locator(".xterm-rows")).toContainText("INPUT_BARRIER");
  const input = Buffer.from(
    (await readFile(marker, "utf8")).replaceAll("\n", ""),
    "hex",
  ).toString();
  assert.equal(input, "\x1b[200~INPUT_READY\x1b[201~b");
  await page.keyboard.type("q");
});

test("copy on select writes only completed terminal selections when enabled", {
  timeout: deadline(45000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-copy-select-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "input");
  await writeFile(marker, "");
  const app = await launchApp(context, { fixture: "running-shell" });
  let page = await boardPage(app);
  const capture = process.env.FOOM_CAPTURE_872 === "1";
  if (capture) {
    // Show both neighboring options in review captures on Linux.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    });
    await page.reload();
    page = await boardPage(app);
  }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1200, 900);
  });
  // Wait for reattachment before Settings claims focus, especially on Windows.
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "Copy on select", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Middle-click pastes selection", exact: true }),
  ).toHaveCount(capture || process.platform === "darwin" ? 1 : 0);
  if (capture) {
    for (const mode of ["light", "dark"]) {
      await page.evaluate(
        (colorMode) =>
          window.desktop.saveSetup({
            interfaceTheme: colorMode === "system" ? "follow" : `eclipse-${colorMode}`,
          }),
        mode,
      );
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(mode === "dark");
      await toggle.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: evidencePath(`screenshots-872/settings-terminal-${mode}.png`),
        animations: "disabled",
      });
    }
  }
  await assertAccessible(page);
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`;
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  const screen = page.locator(".xterm-screen");
  await app.evaluate(({ clipboard }) => clipboard.writeText("COPY_SENTINEL"));
  await screen.dblclick({ position: { x: 20, y: 8 } });
  await expect(page.locator(".xterm-selection div:visible").first()).toBeVisible();
  // Wait beyond the selection debounce to prove the disabled path stays unchanged.
  await page.waitForTimeout(150);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), "COPY_SENTINEL");
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await toggle.check();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.copyOnSelect),
    )
    .toBe(true);
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await expect(page.locator(".xterm-rows")).toContainText("INPUT_READY");
  // xterm replaces row spans during selection/focus paints. Resolving a span
  // handle and measuring it in a later browser call can read a detached node's
  // zero rectangle. Query and measure the marker in one turn from the stable screen.
  await screen.hover({ position: { x: 1, y: 8 } });
  const markerBounds = () =>
    screen.evaluate((element) => {
      const row = element.querySelector(".xterm-rows > div");
      if (row?.textContent !== "INPUT_READY") return null;
      const range = document.createRange();
      range.selectNodeContents(row);
      const { x, y, width, height } = range.getBoundingClientRect();
      return width > 0 && height > 0 ? { x, y, width, height } : null;
    });
  let bounds;
  await expect
    .poll(async () => {
      bounds = await markerBounds();
      return bounds;
    })
    .not.toBeNull();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width, bounds.y + bounds.height / 2, { steps: 4 });
  // Prove the held drag selected the marker before checking completion/copy.
  const selection = page.locator(".xterm-selection div:visible").first();
  await expect(selection).toBeVisible();
  await expect
    .poll(async () => (await selection.boundingBox())?.width)
    .toBeCloseTo(bounds.width, 0);
  await page.waitForTimeout(150);
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), "COPY_SENTINEL");
  await page.mouse.up();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("INPUT_READY");
  // The same bounds may omit xterm's onSelectionChange; mouse-up still copies.
  await app.evaluate(({ clipboard }) => clipboard.writeText("COPY_REPEAT_SENTINEL"));
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width, bounds.y + bounds.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe("INPUT_READY");
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await toggle.uncheck();
  // The fixture cleanup owns confirmation and quit ordering.
  await page.locator(".board-row[data-kind='shell']").click();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("q");
});

test("terminal context menu targets the clicked shell and preserves tracked right clicks", {
  timeout: deadline(60000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-context-menu-"));
  removeAfterApps(context, root);
  const marker = path.join(root, "input");
  await writeFile(marker, "");
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setSize(1400, 1000);
  });
  const tiles = page.locator(".terminal-tile[data-kind='shell']");
  const shellA = tiles.nth(0);
  await launchCheckoutShell(app, page);
  await expect(tiles).toHaveCount(2);
  const shellB = tiles.nth(1);
  const screenA = shellA.locator(".xterm-screen");
  const screenB = shellB.locator(".xterm-screen");
  const menu = page.getByRole("menu", { name: "Terminal menu", exact: true });
  const openA = () => screenA.click({ button: "right", position: { x: 90, y: 40 } });
  await openA();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(shellA.locator(".xterm-helper-textarea")).toBeFocused();
  // Capture the plain shell menu, then the same menu with an xterm selection.
  for (const mode of ["dark", "light"]) {
    await page.evaluate(
      async (theme) => window.desktop.saveSetup({ interfaceTheme: `eclipse-${theme}` }),
      mode,
    );
    await openA();
    await expect(menu).toBeVisible();
    await page.screenshot({
      path: evidencePath(`screenshots-936/${mode}-shell.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await openA();
    await menu.getByRole("menuitem", { name: "Select all", exact: true }).click();
    await expect(shellA.locator(".xterm-selection div:visible").first()).toBeVisible();
    await openA();
    await expect(menu.getByRole("menuitem", { name: "Copy", exact: true })).toBeEnabled();
    await page.screenshot({
      path: evidencePath(`screenshots-936/${mode}-selection.png`),
      animations: "disabled",
    });
    await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(/shell-fixture/);
    // A normal left click clears the selection before the next plain-shell capture.
    await screenA.click({ position: { x: 20, y: 40 } });
  }
  // An outside click retains its newer focus choice instead of restoring A.
  await openA();
  await screenB.click({ position: { x: 20, y: 40 } });
  await expect(menu).toHaveCount(0);
  await expect(shellB.locator(".xterm-helper-textarea")).toBeFocused();
  // Paste must reach A even though B was the focused tile before the menu opened.
  await app.evaluate(({ clipboard }) => clipboard.writeText("CONTEXT_PASTE_936"));
  await openA();
  await menu.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect(shellA.locator(".xterm-rows")).toContainText("CONTEXT_PASTE_936");
  await expect(shellB.locator(".xterm-rows")).not.toContainText("CONTEXT_PASTE_936");
  await page.keyboard.press("Control+u");
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"`;
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await expect(shellA.locator(".xterm-rows")).toContainText("INPUT_READY");
  await openA();
  await menu.getByRole("menuitem", { name: "Clear", exact: true }).click();
  await expect(shellA.locator(".xterm-rows")).not.toContainText("INPUT_READY");
  await expect(shellB.locator(".xterm-rows")).toContainText(/[$#%>]/);
  await page.keyboard.type("m");
  await expect(shellA.locator(".xterm-rows")).toContainText("MOUSE_READY");
  await writeFile(marker, "");
  await openA();
  await expect(menu).toHaveCount(0);
  await page.keyboard.type("b");
  await expect(shellA.locator(".xterm-rows")).toContainText("INPUT_BARRIER");
  assert.match(
    Buffer.from((await readFile(marker, "utf8")).replaceAll("\n", ""), "hex")
      .toString()
      .replaceAll("\x1b", "ESC"),
    /^ESC\[<2;\d+;\d+MESC\[<2;\d+;\d+mb$/,
  );
  await writeFile(marker, "");
  await screenA.click({ button: "right", modifiers: ["Shift"], position: { x: 90, y: 40 } });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shellA.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("b");
  await expect.poll(async () => (await readFile(marker, "utf8")).trim()).toBe("62");
  await page.keyboard.type("q");
});
