const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { chromium } = require("@playwright/test");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");

test("packaged utility host runs native PTYs with RunAsNode disabled", {
  timeout: 45000,
}, async () => {
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
  const wire = await getCurrentFuseWire(executable);
  assert.equal(wire[FuseV1Options.RunAsNode], 48, "RunAsNode fuse is disabled");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Main's inspector is disabled in the package. CDP reaches only the renderer;
  // the probe exercises the same restricted bridge as the shipped application.
  // A private profile with preflight already complete, so the package opens on the board.
  const profile = mkdtempSync(path.join(tmpdir(), "foom-packaged-"));
  writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({ version: 1, settings: { setupComplete: true } }),
  );
  const child = spawn(executable, ["--remote-debugging-port=0", `--user-data-dir=${profile}`], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let browser;
  const watchdog = setTimeout(() => {
    console.error("Packaged probe exceeded its hard deadline");
    if (process.platform === "win32")
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else child.kill("SIGKILL");
    process.exit(1);
  }, 40000);
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
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent("page"));
    page.setDefaultTimeout(15000);
    await page.getByRole("button", { name: "Local shell", exact: true }).press("Enter");
    await page.waitForFunction(
      () =>
        window.desktop &&
        document.querySelector("#status")?.textContent &&
        !document.querySelector("#status").textContent.includes("Starting"),
    );
    assert.doesNotMatch(await page.locator("#status").innerText(), /Unable/);
    await page.waitForFunction(() => !document.querySelector("#toggle-terminal").disabled);
    await page.locator('.board-row[data-kind="shell"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector("#toggle-terminal").textContent === "Hide terminal" &&
        !document.querySelector("#toggle-terminal").disabled,
    );
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
    await page.evaluate(({ id, command }) => window.desktop.input(id, command + "; exit\r"), {
      id,
      command,
    });
    await page.waitForFunction(() => window.packagedExit);
    await page.evaluate((id) => window.desktop.attach(id), id);
    await page.waitForFunction(() => window.packagedOutput.includes("PACKAGED_PTY_OK"));
    await page.evaluate((id) => window.desktop.kill(id), id);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await page.getByRole("status").filter({ hasText: "Shell exited" }).waitFor();
    console.info(
      `Packaged ${process.platform}/${process.arch}: native PTY, detached headless snapshot, RunAsNode=false passed`,
    );
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      if (process.platform === "win32")
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5000 });
      else child.kill("SIGTERM");
      await exited;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    clearTimeout(watchdog);
  }
});
