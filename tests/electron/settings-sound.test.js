const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  fixtureCleanup,
  installSoundSink,
  launchApp,
  openSettingsScreen,
  removeAfterApps,
} = require("./harness.js");

test("volume sliders keep the dragged value while sound saves settle", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  fixtureCleanup(context).apps.unshift(async () => {
    await app.evaluate(() => globalThis.soundSaveRestore?.()).catch(() => {});
  });
  const page = await boardPage(app);
  // Hold real persistence at the service boundary, then deliver its actual
  // settings broadcasts and replies after the pointer has moved farther.
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { Setup } = load("./build/main/setup/setup.js");
    const save = Setup.prototype.save;
    globalThis.soundSaveGates = [];
    globalThis.soundSaveCount = 0;
    globalThis.soundSaveRestore = () => {
      Setup.prototype.save = save;
      for (const release of globalThis.soundSaveGates.splice(0)) release();
    };
    Setup.prototype.save = async function (patch) {
      if (patch.sound) {
        globalThis.soundSaveCount++;
        await new Promise((resolve) => globalThis.soundSaveGates.push(resolve));
      }
      return save.call(this, patch);
    };
  });
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  const working = page.getByLabel("Working volume", { exact: true });
  await working.scrollIntoViewIfNeeded();
  const box = await working.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(working).toHaveValue("100");
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(1);
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(2);
  await expect(working).toHaveValue("100");
  await expect(page.getByText("Working volume · 100%", { exact: true })).toBeVisible();
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.workingVolume),
    )
    .toBe(1);

  const alerts = page.getByLabel("Alert volume", { exact: true });
  await alerts.press("Home");
  // The preceding save may have persisted before its renderer reply settled.
  // Wait until this edit is in flight before queuing edits behind its gate.
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(3);
  await alerts.press("ArrowRight");
  await alerts.press("ArrowRight");
  await expect(alerts).toHaveValue("2");
  await alerts.press("Escape");
  await expect(alerts).toHaveCount(0);
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect.poll(() => app.evaluate(() => globalThis.soundSaveCount)).toBe(4);
  await app.evaluate(() => globalThis.soundSaveGates.shift()());
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.alertVolume),
    )
    .toBe(0.02);
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
  const app = await launchApp(context, {
    fixture: "running-shell",
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
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "input-probe.js")}" "${marker}"; exit`,
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
  // The launch command queues exit after the probe, avoiding input before PowerShell
  // has resumed. Process exit is a Done verdict on every supported platform.
  await page.evaluate(() => window.desktop.input(window.soundTerminal, "q"));
  await expect(page.locator(".board-row")).toHaveAttribute("data-state", "shell");
  await expect(page.locator(".board-row")).toHaveAttribute("data-exited", "true");
  await page.waitForTimeout(2200);
  assert.deepEqual(await page.evaluate(() => window.soundTones), [0.25]);
  await page.getByLabel("Alerts on", { exact: true }).uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.alerts),
    )
    .toBe(false);
});

test("sidebar footer zoom and master volume stay synchronized and presets are absent", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await installSoundSink(page);
  const footer = page.locator(".sidebar-footer-bar");
  await expect(footer.getByRole("group", { name: "Zoom", exact: true })).toBeVisible();
  await expect(footer.getByRole("slider", { name: "Volume", exact: true })).toHaveValue("100");
  for (const name of [
    "One",
    "Two side by side",
    "Two stacked",
    "Two by two",
    "One and two",
    "One and three",
    "Tidy tiles",
  ])
    await expect(footer.getByRole("button", { name, exact: true })).toHaveCount(0);
  assert.equal(
    (await page.evaluate(() => window.desktop.appMenu.commands())).some((entry) =>
      entry?.id?.startsWith("preset-"),
    ),
    false,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.desktop.appMenu.execute("preset-grid");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await footer.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(110);
  await footer.getByRole("button", { name: "Zoom 110%, reset to 100%", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(100);
  await footer.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const volume = footer.getByRole("slider", { name: "Volume", exact: true });
  await volume.press("Home");
  await volume.press("ArrowRight");
  await expect(volume).toHaveValue("5");
  await expect.poll(() => page.evaluate(() => window.soundTones.length)).toBeGreaterThan(0);
  await expect(footer.getByRole("button", { name: "Mute", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.volume),
    )
    .toBe(0.05);
  await footer.getByRole("button", { name: "Zoom 100%", exact: true }).hover();
  await page.mouse.wheel(0, -100);
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(110);
  await footer.getByRole("button", { name: "Zoom 110%, reset to 100%", exact: true }).hover();
  await page.mouse.wheel(0, 100);
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.interfaceScale),
    )
    .toBe(100);
  await footer.getByRole("button", { name: "Mute", exact: true }).click();
  await footer.getByRole("button", { name: "Unmute", exact: true }).hover();
  await page.mouse.wheel(0, -100);
  await expect(volume).toHaveValue("10");
  await expect
    .poll(() => page.evaluate(async () => (await window.desktop.setupState()).settings.sound))
    .toMatchObject({ volume: 0.1, muted: false });
  await volume.hover();
  await page.mouse.wheel(0, 100);
  await expect(volume).toHaveValue("5");
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.sound.volume),
    )
    .toBe(0.05);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  const settingsVolume = page
    .locator(".sound-controls")
    .getByRole("slider", { name: "Volume", exact: true });
  await expect(settingsVolume).toHaveValue("5");
  await settingsVolume.press("End");
  await expect(volume).toHaveValue("100");
  await page.locator(".sound-controls").getByRole("button", { name: "Mute", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await footer.getByRole("button", { name: "Unmute", exact: true }).click();
  for (const colorMode of ["dark", "light"]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), colorMode);
    await expect
      .poll(() =>
        page
          .locator(".sidebar-shell")
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue("--surface").trim().toLowerCase(),
          ),
      )
      .toBe(colorMode === "dark" ? "#0d0a17" : "#e9e4f5");
    await page.screenshot({
      path: `test-results/footer-after-${colorMode}-300.png`,
      animations: "disabled",
    });
    await page.locator(".sidebar-shell").evaluate((element) => {
      element.style.flexBasis = "220px";
    });
    await expect(footer).toBeVisible();
    await expect(page.locator(".sidebar-shell")).toHaveCSS("flex-basis", "220px");
    const bounds = await footer.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      return [...element.querySelectorAll("button, input")].every((control) => {
        const rect = control.getBoundingClientRect();
        return (
          rect.left >= outer.left &&
          rect.right <= outer.right &&
          rect.top >= outer.top &&
          rect.bottom <= outer.bottom
        );
      });
    });
    assert.equal(bounds, true, "footer controls fit the minimum sidebar width");
    await page.screenshot({
      path: `test-results/footer-after-${colorMode}-220.png`,
      animations: "disabled",
    });
    await page.locator(".sidebar-shell").evaluate((element) => {
      element.style.flexBasis = "300px";
    });
  }
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(footer.getByRole("button", { name: "Foom config", exact: true })).toBeVisible();
  await expect(footer.getByRole("group", { name: "Zoom", exact: true })).toBeHidden();
  await expect(volume).toBeHidden();
});
