const { assertBundledTerminalFonts } = require("./font-checks.js");
const { extractFile } = require("@electron/asar");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  readFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { chromium } = require("@playwright/test");
const { deadline, expect } = require("./test-policy.js");
const { auditProcesses } = require("./process-audit.js");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");

test("packaged utility host runs native PTYs with RunAsNode disabled", {
  timeout: deadline(45000),
}, async (context) => {
  const root = path.join(__dirname, "../..", "out", `Foom-${process.platform}-${process.arch}`);
  const executable =
    process.platform === "darwin"
      ? path.join(root, "Foom.app", "Contents", "MacOS", "foom")
      : path.join(root, process.platform === "win32" ? "foom.exe" : "foom");
  if (process.platform === "win32") {
    const pty = path.join(root, "resources", "app.asar.unpacked", "node_modules", "node-pty");
    const directory = ["build/Release", "build/Debug", `prebuilds/win32-${process.arch}`]
      .map((directory) => path.join(pty, directory))
      .find((directory) => existsSync(path.join(directory, "conpty.node")));
    assert.ok(directory, "packaged ConPTY native addon is present outside ASAR");
    for (const file of ["conpty.dll", "OpenConsole.exe"]) {
      assert.ok(
        existsSync(path.join(directory, "conpty", file)),
        `missing ${file} beside ${directory}`,
      );
    }
  }
  const resources =
    process.platform === "darwin"
      ? path.join(root, "Foom.app", "Contents", "Resources")
      : path.join(root, "resources");
  const archive = path.join(resources, "app.asar");
  const notices = extractFile(archive, path.join("build", "THIRD_PARTY_NOTICES.txt")).toString();
  for (const name of [
    "hack-LICENSE.txt",
    "nerd-fonts-LICENSE.txt",
    "nerd-fonts-glyphs-NOTICES.txt",
  ]) {
    const source = readFileSync(path.join(__dirname, "../../src/renderer/fonts", name), "utf8");
    assert.equal(
      extractFile(archive, path.join("build", "renderer", "fonts", name)).toString(),
      source,
    );
    assert.ok(notices.includes(source), `${name} is included in packaged third-party notices`);
  }
  for (const weight of ["Regular", "Bold"]) {
    const name = `HackNerdFontMono-${weight}.woff2`;
    assert.deepEqual(
      extractFile(archive, path.join("build", "renderer", "fonts", name)),
      readFileSync(path.join(__dirname, "../../src/renderer/fonts", name)),
    );
  }
  const wire = await getCurrentFuseWire(executable);
  assert.equal(wire[FuseV1Options.RunAsNode], 48, "RunAsNode fuse is disabled");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Main's inspector is disabled in the package. CDP reaches only the renderer;
  // the probe exercises the same restricted bridge as the shipped application.
  // A private profile with preflight already complete, so the package opens on the board.
  // Match fs.promises.realpath in the registry: resolve macOS symlinks and Windows 8.3 names.
  const profile = realpathSync.native(mkdtempSync(path.join(tmpdir(), "foom-packaged-")));
  writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({ version: 1, settings: { setupComplete: true } }),
  );
  const repository = path.join(profile, "repo");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  writeFileSync(
    path.join(profile, "worktrees.json"),
    JSON.stringify({ version: 1, repositories: [repository], managed: [] }),
  );
  const audit = await auditProcesses(context);
  context.after(() => audit.finish());
  const child = spawn(executable, ["--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  audit.add(child.pid);
  let browser;
  let page;
  let standalone;
  let failure;
  const watchdog = setTimeout(() => {
    console.error("Packaged probe exceeded its hard deadline");
    try {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          timeout: deadline(3000),
        });
    } finally {
      child.kill("SIGKILL");
      process.exit(1);
    }
  }, deadline(40000));
  let stderr = "";
  try {
    const endpoint = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Package exited (${code}): ${stderr}`)));
      child.stderr.on("data", (data) => {
        stderr = (stderr + data.toString()).slice(-16000);
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) resolve(match[1]);
      });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: deadline(10000) });
    const context = browser.contexts()[0];
    page = context.pages()[0] || (await context.waitForEvent("page"));
    page.setDefaultTimeout(deadline(15000));
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.desktop.workspace())).repositories.map(
          (entry) => entry.path,
        ),
      )
      .toContain(repository);
    console.info("Packaged repository restored");
    await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Shell \(/ }).click();
    await page.waitForFunction(
      () =>
        window.desktop &&
        document.querySelector(".tile-status")?.textContent &&
        !document.querySelector(".tile-status").textContent.includes("Starting"),
    );
    assert.doesNotMatch(await page.locator(".tile-status").innerText(), /Unable/);
    await page.locator('.board-row[data-kind="shell"]').press("Enter");
    await expect(page.getByRole("navigation", { name: "Terminal sidebar" })).toBeVisible();
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await assertBundledTerminalFonts(page);
    console.info("Packaged terminal attached");
    const command =
      process.platform === "win32"
        ? 'Write-Output ("PACKAGED_" + "PTY_OK")'
        : "printf 'PACKAGED_%s\\n' PTY_OK";
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await page
      .locator(".xterm-rows > div")
      .filter({ hasText: /^PACKAGED_PTY_OK$/ })
      .last()
      .waitFor();
    console.info("Packaged interactive PTY command passed");
    const primary = await page.evaluate(async () => {
      const [terminal] = (await window.desktop.workspace()).terminals;
      if (!terminal) throw new Error("Missing packaged shell");
      return terminal.id;
    });
    // Exercise detached headless state, native process exit and snapshot restoration.
    const id = await page.evaluate(async () => {
      const { id } = await window.desktop.create(80, 24);
      window.packagedOutput = "";
      window.packagedExit = false;
      window.desktop.onData((source, token, data) => {
        if (source === id) {
          window.packagedOutput += data;
          window.desktop.acknowledge(id, token, data.length);
        }
      });
      window.desktop.onExit((source, code) => {
        if (source === id && code === 0) window.packagedExit = true;
      });
      return id;
    });
    standalone = id;
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "; exit\r"), {
      id,
      command,
    });
    await page.waitForFunction(() => window.packagedExit);
    await page.evaluate((id) => window.desktop.attach(id), id);
    await page.waitForFunction(() => window.packagedOutput.includes("PACKAGED_PTY_OK"));
    await page.evaluate((id) => window.desktop.kill(id), id);
    // Keyboard input is exercised above. After the standalone probe, address
    // the original shell by ID so focus changes cannot misroute its exit command.
    await page.evaluate((id) => window.desktop.input(id, "exit\r"), primary);
    await page.getByRole("status").filter({ hasText: "Shell exited" }).waitFor();
    console.info(
      `Packaged ${process.platform}/${process.arch}: native PTY, detached headless snapshot, RunAsNode=false passed`,
    );
  } catch (error) {
    failure = error;
    console.error("Packaged smoke failed:", error);
  } finally {
    try {
      await audit.capture();
      // Close through the app after revoking its terminal capabilities. Disconnecting
      // CDP does not quit Electron, and taskkill can stall on a busy Windows runner.
      await page
        ?.evaluate(async (standalone) => {
          const ids = (await window.desktop.workspace()).terminals.map((terminal) => terminal.id);
          if (standalone) ids.push(standalone);
          await Promise.all(ids.map((id) => window.desktop.kill(id).catch(() => {})));
        }, standalone)
        .catch(() => {});
      await page?.keyboard
        .press(process.platform === "darwin" ? "Meta+q" : "Control+q")
        .catch(() => {});
      await browser?.close();
      if (child.exitCode === null && child.signalCode === null) {
        let timer;
        const exited = new Promise((resolve) => child.once("exit", resolve));
        await Promise.race([
          exited,
          new Promise((resolve) => {
            timer = setTimeout(resolve, deadline(5000));
          }),
        ]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") {
            await new Promise((resolve, reject) => {
              execFile(
                "taskkill",
                ["/pid", String(child.pid), "/T", "/F"],
                { timeout: deadline(5000) },
                (error) => {
                  if (error && child.exitCode === null && child.signalCode === null) reject(error);
                  else resolve();
                },
              );
            });
          } else child.kill("SIGKILL");
          await exited;
        }
      }
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      child.kill("SIGKILL");
      failure ??= error;
      console.error("Packaged cleanup failed:", error);
    } finally {
      clearTimeout(watchdog);
    }
  }
  if (failure) throw failure;
});
