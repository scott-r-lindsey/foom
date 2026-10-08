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
  for (const name of ["codex-v1.sh", "codex-v1.ps1"]) {
    const observer = path.join(resources, "app.asar.unpacked", "build", "observers", name);
    assert.ok(
      existsSync(observer),
      `${name} must be readable by a native interpreter outside ASAR`,
    );
    assert.equal(
      readFileSync(observer, "utf8"),
      readFileSync(path.join(__dirname, "../../build/observers", name), "utf8"),
    );
  }

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
  const soundManifest = JSON.parse(
    readFileSync(path.join(__dirname, "../../src/sounds/manifest.json"), "utf8"),
  );
  for (const entry of soundManifest)
    assert.deepEqual(
      extractFile(archive, path.join("build/sounds", entry.file)),
      readFileSync(path.join(__dirname, "../../src/sounds", entry.file)),
    );
  assert.ok(
    notices.includes(readFileSync(path.join(__dirname, "../../src/sounds/NOTICES.txt"), "utf8")),
  );
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
  env.HOME = profile;
  env.USERPROFILE = profile;
  const audit = await auditProcesses(context);
  context.after(() => audit.finish());
  // Match Playwright's development launcher on macOS: this disposable smoke
  // profile stores no credentials and must not open an interactive Keychain dialog.
  // Packaging fuses, sandboxing and the shipped app configuration remain intact.
  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ],
    {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
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
    await expect
      .poll(() => {
        page = browser
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url() === "app://bundle/index.html");
        return Boolean(page);
      })
      .toBe(true);
    page.setDefaultTimeout(deadline(15000));
    // Bridge initialization is independent of the first native window paint.
    // Packaged macOS can withhold animation frames during CDP attachment.
    await page.waitForFunction(() => window.desktop, undefined, { polling: 100 });
    assert.equal(await page.evaluate(() => window.desktop.isDevelopment), false);
    await expect(page.locator(".dev-profile")).toHaveCount(0);
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.desktop.workspace())).repositories.map(
          (entry) => entry.path,
        ),
      )
      .toContain(repository);
    const sounds = await page.evaluate(async () => {
      const context = new AudioContext();
      try {
        const entries = (await window.desktop.sounds.list()).filter(
          (entry) => entry.source === "builtin",
        );
        const decoded = [];
        for (const entry of entries) {
          if (entry.error) throw Error(entry.file + ": " + entry.error);
          const result = await window.desktop.sounds.read({
            kind: entry.kind,
            source: entry.source,
            file: entry.file,
          });
          if (result.error) throw Error(entry.file + ": " + result.error);
          const buffer = await context.decodeAudioData(new Uint8Array(result.bytes).buffer);
          decoded.push({ file: entry.kind + "/" + entry.file, duration: buffer.duration });
        }
        return decoded;
      } finally {
        await context.close();
      }
    });
    assert.equal(sounds.length, soundManifest.length);
    for (const entry of soundManifest)
      assert.ok(
        Math.abs(sounds.find((sound) => sound.file === entry.file).duration - entry.duration) <
          0.001,
        entry.file,
      );
    console.info("Packaged recordings loaded and decoded");
    console.info("Packaged repository restored");
    await page.getByRole("button", { name: "Actions for repo", exact: true }).click();
    const packagedCommands = await page.evaluate(() => window.desktop.appMenu.commands());
    assert.ok(
      !packagedCommands.some((item) => ["reload", "force-reload", "devtools"].includes(item.id)),
    );
    for (const id of ["reload", "force-reload", "devtools"]) {
      assert.equal(
        await page.evaluate(async (id) => {
          try {
            await window.desktop.appMenu.execute(id);
            return false;
          } catch {
            return true;
          }
        }, id),
        true,
      );
    }
    await page.evaluate(() => {
      window.packagedReloadSentinel = true;
    });
    for (const key of process.platform === "darwin"
      ? ["Meta+r", "Meta+Shift+r", "Meta+Shift+i"]
      : ["Control+r", "Control+Shift+r", "Control+Shift+i", "F5", "F12"])
      await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => window.packagedReloadSentinel), true);
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
    // Preserve startup evidence when the board never becomes a Playwright page.
    // The trusted confirmation window can be the first CDP context/target.
    console.error("Packaged startup stderr:", stderr);
    if (page) {
      let timer;
      try {
        console.error(
          "Packaged renderer startup state:",
          await Promise.race([
            page.evaluate(() => ({
              ready: document.readyState,
              visibility: document.visibilityState,
              bridge: typeof window.desktop,
              title: document.title,
            })),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve("Renderer did not answer"), deadline(1000));
            }),
          ]),
        );
      } catch (diagnosticError) {
        console.error("Packaged renderer diagnostics failed:", diagnosticError);
      } finally {
        clearTimeout(timer);
      }
    }
    console.error(
      "Packaged CDP pages:",
      browser?.contexts().map((context) => context.pages().map((candidate) => candidate.url())),
    );
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => undefined);
      if (session) {
        try {
          console.error("Packaged CDP targets:", await session.send("Target.getTargets"));
        } catch (diagnosticError) {
          console.error("Packaged target diagnostics failed:", diagnosticError);
        } finally {
          await session.detach().catch(() => {});
        }
      }
    }
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
        .press(process.platform === "darwin" ? "Meta+q" : "Control+Shift+q")
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

test("packaged console helper runs without Node from relocated Unicode paths", async (context) => {
  const { copyFileSync, chmodSync } = require("node:fs");
  const { createHash } = require("node:crypto");
  const root = path.join(__dirname, "../..", "out", `Foom-${process.platform}-${process.arch}`);
  const resources =
    process.platform === "darwin"
      ? path.join(root, "Foom.app/Contents/Resources")
      : path.join(root, "resources");
  const directory = path.join(resources, "app.asar.unpacked/build/console");
  const name = process.platform === "win32" ? "foom.exe" : "foom";
  const helper = path.join(directory, name);
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.sha256, createHash("sha256").update(readFileSync(helper)).digest("hex"));
  assert.match(manifest.node, /^24\./);
  assert.ok(readFileSync(path.join(directory, "NODE-LICENSE.txt"), "utf8").includes("Node.js"));
  const scratch = mkdtempSync(path.join(tmpdir(), "foom console 日本語 "));
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  const moved = path.join(scratch, name);
  copyFileSync(helper, moved);
  chmodSync(moved, 0o755);
  const env = { ...process.env, PATH: scratch, NODE_OPTIONS: "--require=/foom-must-not-load-code" };
  const { spawnSync } = require("node:child_process");
  for (const executable of [helper, moved]) {
    const version = spawnSync(executable, ["--version", "--json"], {
      env,
      encoding: "utf8",
      timeout: deadline(5000),
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stderr, "");
    assert.deepEqual(JSON.parse(version.stdout), { version: manifest.version, protocol: 1 });
    const invalid = spawnSync(executable, ["--unknown", "--json"], {
      env,
      encoding: "utf8",
      timeout: deadline(5000),
    });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, "");
    assert.deepEqual(JSON.parse(invalid.stderr), { error: "invalid_request" });
  }
});
