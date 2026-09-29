const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { _electron: electron, expect } = require("@playwright/test");

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
async function launchApp(context) {
  const watchdog = setTimeout(() => {
    console.error("Electron test exceeded its 60-second hard deadline; terminating worker");
    // Playwright's exit handler kills the process groups it launched.
    process.exit(1);
  }, 60_000);
  watchdog.unref();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    chromiumSandbox: true,
    colorScheme: null,
    timeout: 15_000,
    args: [path.join(__dirname, "..")],
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
          "onData",
          "onExit",
        ],
      },
    );
    // The real renderer must not duplicate main's protocol response.
    // PowerShell needs the call operator to execute a quoted executable path.
    const probeCommand = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "protocol-probe.js")}"`;
    await page.keyboard.type(probeCommand);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.terminalOutput.includes("PROTOCOL_OK"));
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
      "2 agents are still working. Quit anyway?",
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
