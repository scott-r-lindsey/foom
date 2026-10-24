const { gitSync: isolatedGit } = require("../helpers/git.js");

const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdir, mkdtemp, readFile, realpath, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { deadline, expect } = require("./test-policy.js");
const {
  assertAccessible,
  boardCommand,
  boardPage,
  launchApp,
  openSettingsScreen,
  quitAndWait,
  removeAfterApps,
} = require("./harness.js");

test("legacy inference profiles upgrade without evaluator controls or stored keys", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-legacy-profile-"));
  removeAfterApps(context, root);
  await writeFile(
    path.join(root, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        hooks: false,
        worktreeLocation: "adjacent",
        interfaceScale: 110,
        inference: { kind: "openai", model: "saved-model" },
        inferenceTimeoutMs: 15000,
      },
    }),
  );
  for (const provider of ["anthropic", "openai", "google"])
    await writeFile(path.join(root, `inference-${provider}.key`), Buffer.from([0, 128, 255]));
  const temporary = path.join(
    root,
    "inference-openai.key.12345678-1234-4234-8234-123456789abc.tmp",
  );
  await writeFile(temporary, Buffer.from([0, 128, 255]));
  const app = await launchApp(context, {
    fixture: "empty-board",
    args: [`--user-data-dir=${root}`],
  });
  const page = await boardPage(app);
  const state = await page.evaluate(() => window.desktop.setupState());
  assert.equal(state.settings.hooks, false);
  assert.equal(state.settings.worktreeLocation, "adjacent");
  assert.equal(state.settings.interfaceScale, 110);
  assert.equal("inference" in state.settings, false);
  assert.equal("inferenceTimeoutMs" in state.settings, false);
  assert.equal("keys" in state, false);
  for (const provider of ["anthropic", "openai", "google"])
    await assert.rejects(readFile(path.join(root, `inference-${provider}.key`)), {
      code: "ENOENT",
    });
  await assert.rejects(readFile(temporary), { code: "ENOENT" });
  assert.doesNotMatch(await readFile(path.join(root, "settings.json"), "utf8"), /inference/);
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys(window.desktop).filter((key) => /inference|localModels/i.test(key)),
    ),
    [],
  );
  await openSettingsScreen(page);
  await page.getByRole("navigation", { name: "Settings sections" }).waitFor();
  await expect(page.getByText(/Evaluator|Run check|API key/)).toHaveCount(0);
  await page.evaluate(() => window.desktop.saveSetup({ setupComplete: false }));
  await page.reload();
  await page.getByRole("button", { name: "Start preflight" }).waitFor();
  const steps = page.getByRole("navigation", { name: "Preflight steps" }).locator("ol");
  await expect(steps.getByRole("button")).toHaveText([
    "Welcome",
    "T-2Agents",
    "T-1Repositories",
    "T-0Go / no-go",
  ]);
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.worktreeLocation,
    "adjacent",
  );
  await expect(page.getByText(/Evaluator|Run check|API key/)).toHaveCount(0);
});

test("Settings forge cards persist user host assignments without activating providers", {
  timeout: deadline(45_000),
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-forge-cards-"));
  removeAfterApps(context, root);
  const home = path.join(root, "home");
  const userData = path.join(root, "profile");
  const folder = path.join(home, ".foom", "config", "forges");
  await mkdir(folder, { recursive: true });
  const manifest = JSON.parse(
    await readFile(path.join(__dirname, "../../src/shared/bundled-forges/github.json"), "utf8"),
  );
  await writeFile(
    path.join(folder, "custom.json"),
    JSON.stringify({ ...manifest, id: "custom", name: "Custom forge" }),
  );
  await writeFile(path.join(folder, "broken.json"), "{}");
  const app = await launchApp(context, {
    fixture: "empty-board",
    home,
    args: [`--user-data-dir=${userData}`],
  });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Forges", exact: true }).click();
  const github = page.getByRole("region", { name: "GitHub", exact: true });
  const custom = page.getByRole("region", { name: "Custom forge", exact: true });
  await expect(github.getByRole("switch")).toBeChecked();
  await expect(github).toContainText("github.com");
  await expect(custom.getByRole("switch")).not.toBeChecked();
  await expect(custom.getByRole("textbox")).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "broken", exact: true }).getByRole("switch"),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: /Duplicate|Approve/ })).toHaveCount(0);
  await assertAccessible(page);
  await custom.getByRole("switch").click();
  await expect(custom.getByRole("switch")).toBeChecked();
  await expect(custom.getByRole("textbox")).toBeEnabled();
  await custom.getByRole("textbox").fill("https://bad.example.org");
  await custom.getByRole("button", { name: "Assign host" }).click();
  await expect(page.getByRole("alert")).toHaveText("Unable to update settings.");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await custom.getByRole("textbox").fill("git.example.org");
  await custom.getByRole("button", { name: "Assign host" }).click();
  await expect(custom.getByRole("button", { name: "Remove git.example.org" })).toBeVisible();
  await custom.getByRole("switch").click();
  await expect(custom.getByRole("switch")).not.toBeChecked();
  await expect(custom.getByRole("textbox")).toBeDisabled();
  await expect(custom).toContainText("git.example.org");
  const rejected = await page.evaluate(() =>
    window.desktop.saveSetup({ forgeHosts: { "new.example.org": "custom" } }).then(
      () => "saved",
      (error) => String(error),
    ),
  );
  assert.match(rejected, /foom-error:operation-failed/);
  const before = await page.evaluate(() => window.desktop.setupState());
  assert.equal(before.settings.forgeHosts["github.com"], "github");
  assert.equal(before.settings.forgeHosts["git.example.org"], "custom");
  await quitAndWait(app, () => app.evaluate(({ app }) => app.quit()));
  const saved = JSON.parse(await readFile(path.join(userData, "settings.json"), "utf8"));
  assert.deepEqual(saved.settings.forges, { github: true, gitlab: true, custom: false });
  assert.deepEqual(saved.settings.forgeHosts, {
    "github.com": "github",
    "gitlab.com": "gitlab",
    "git.example.org": "custom",
  });
  const restarted = await launchApp(context, {
    fixture: "empty-board",
    home,
    args: [`--user-data-dir=${userData}`],
  });
  const restored = await boardPage(restarted);
  await openSettingsScreen(restored);
  await restored.getByRole("button", { name: "Forges", exact: true }).click();
  const restoredCustom = restored.getByRole("region", { name: "Custom forge", exact: true });
  await expect(restoredCustom.getByRole("switch")).not.toBeChecked();
  await expect(restoredCustom).toContainText("git.example.org");
  await restoredCustom.getByRole("button", { name: "Remove git.example.org" }).click();
  await expect(restoredCustom.getByRole("button", { name: "Remove git.example.org" })).toHaveCount(
    0,
  );
});

test("Settings session panel preview follows color and contrast; Environment links to Agents", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  const navigation = page.getByRole("navigation", { name: "Settings sections" });
  await navigation.getByRole("button", { name: "Environment", exact: true }).click();
  await expect(
    page.getByText("Added to every shell and agent Foom starts.", { exact: false }),
  ).toBeVisible();
  await page
    .locator(".settings-controls")
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(navigation.getByRole("button", { name: "Agents", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  const preview = page.getByRole("img", { name: "Session panel preview" });
  const mark = preview.locator(".panel-mark");
  const backgrounds = [];
  for (const [level, tint] of [
    ["Vivid", "1"],
    ["Subtle", "0.5"],
    ["Plain", "0"],
  ]) {
    await page.getByRole("radio", { name: level, exact: true }).check();
    await expect(preview).toHaveCSS("--panel-tint", tint);
    backgrounds.push(await mark.evaluate((node) => getComputedStyle(node).backgroundColor));
  }
  assert.equal(new Set(backgrounds).size, 3);
  await page.getByRole("radio", { name: "Vivid", exact: true }).check();
  await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "high-contrast" }));
  await expect(preview).toHaveCSS("--panel-tint", "0");
  await page.evaluate(() => window.desktop.saveSetup({ interfaceTheme: "follow" }));
  await page.emulateMedia({ contrast: "more" });
  await expect(preview).toHaveCSS("--panel-tint", "0");
  await expect(preview).toHaveCSS("--panel-chip-line", "100%");
  await assertAccessible(page);
});

test("Settings opens on General from the menu, sidebar and keyboard", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await page.locator(".config-gear").click();
  const panel = page.getByRole("dialog", { name: "Foom config details and commands" });
  await expect(panel.getByRole("menuitem", { name: "Open Foom config settings" })).toHaveCount(0);
  await expect(panel.getByRole("menuitem", { name: "Open folder", exact: true })).toBeVisible();
  if (process.env.FOOM_UI_SCREENSHOTS)
    await page.screenshot({
      path: path.join(process.env.FOOM_UI_SCREENSHOTS, "sidebar-config-menu.png"),
      animations: "disabled",
    });
  await panel.getByRole("menuitem", { name: /^Settings/ }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await boardCommand(app, ",", process.platform !== "darwin");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeFocused();
});

test("nested repository names follow the General toggle and retain their identity", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-nested-repositories-"));
  removeAfterApps(context, root);
  const repository = path.join(root, "work", "foom");
  await mkdir(repository, { recursive: true });
  isolatedGit(["init", "-q", "-b", "main", repository]);
  isolatedGit([
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const app = await launchApp(context, { fixture: "empty-board" });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, repository);
  const page = await boardPage(app);
  await page.getByRole("button", { name: "Add repository", exact: true }).click();
  const row = page.locator(".repository-row .tree-label");
  await expect(row).toHaveText("foom");
  await expect(page.getByRole("button", { name: "Add repository", exact: true })).toHaveText(
    "+ Add repo",
  );
  await page.evaluate(
    (codeFolder) => window.desktop.saveSetup({ codeFolder }),
    await realpath(root),
  );
  const screenshot = async (name) => {
    if (process.env.FOOM_UI_SCREENSHOTS)
      await page.screenshot({
        path: path.join(process.env.FOOM_UI_SCREENSHOTS, name + ".png"),
        animations: "disabled",
      });
  };
  await screenshot("nested-repo-off-add-label");
  await openSettingsScreen(page);
  const toggle = page.getByRole("checkbox", {
    name: "Show repository paths relative to code folder",
  });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(row).toHaveText("work/foom");
  await screenshot("settings-general-toggle");
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await screenshot("nested-repo-on");
  const before = await page.evaluate(() => window.desktop.workspace());
  await openSettingsScreen(page);
  await toggle.uncheck();
  await expect(row).toHaveText("foom");
  assert.deepEqual(
    (await page.evaluate(() => window.desktop.workspace())).repositories,
    before.repositories,
  );
  await page.getByRole("button", { name: "Close settings (Esc)" }).click();
  await page.getByRole("button", { name: "Foom menu" }).click();
  await expect(page.getByRole("menuitem", { name: /^Via / })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /^Settings…/ })).toBeVisible();
  await screenshot("application-menu-linux");
  await page.getByRole("menuitem", { name: "Developer", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Action log", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Developer tools/ })).toBeVisible();
  await screenshot("developer-submenu-linux");
});

test("General update opt-out persists; update notices and restart counts remain quiet", async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  const check = page.getByRole("checkbox", { name: "Check for updates", exact: true });
  // Fixture profiles explicitly opt out before launch; the product default is tested in SettingsStore.
  await expect(check).not.toBeChecked();
  await check.check();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.checkForUpdates),
    )
    .toBe(true);
  await check.uncheck();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.desktop.setupState()).settings.checkForUpdates),
    )
    .toBe(false);
  const state = await page.evaluate(() => window.desktop.setupState());
  for (const mode of ["light", "dark"]) {
    await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
    for (const status of ["available", "downloaded", "error"]) {
      // Fake local main facts exercise the real sandboxed bridge without any updater or HTTP call.
      await app.evaluate(
        ({ BrowserWindow }, state) => {
          const board = BrowserWindow.getAllWindows().find(
            (window) => window.webContents.getURL() === "app://bundle/index.html",
          );
          board.webContents.send("setup:changed", state);
        },
        {
          ...state,
          settings: { ...state.settings, colorMode: mode, checkForUpdates: true },
          updates: { status, runningAgents: 3 },
        },
      );
      if (status === "downloaded")
        await expect(
          page.getByRole("button", { name: "Restart to update · 3 running agents" }),
        ).toBeVisible();
      else
        await expect(
          page.getByText(
            status === "available" ? "Update available" : "Could not check for updates.",
            { exact: true },
          ),
        ).toBeVisible();
      if (process.env.FOOM_UPDATE_SCREENSHOTS === "1") {
        await mkdir("screenshots-603", { recursive: true });
        await page.screenshot({ path: `screenshots-603/general-${mode}-${status}.png` });
      }
    }
  }
  // Renderer facts do not authorize quit: the main service has no staged update.
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await page.evaluate(() => window.desktop.restartToUpdate());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    windows,
  );
  await assertAccessible(page);
});

test("General close finished agents defaults on and saves immediately", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "empty-board" });
  const page = await boardPage(app);
  await openSettingsScreen(page);
  const control = page.getByRole("checkbox", { name: "Close finished agents", exact: true });
  await expect(control).toBeChecked();
  await control.uncheck();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.setupState())).settings.closeFinishedAgents,
    )
    .toBe(false);
  await control.check();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.setupState())).settings.closeFinishedAgents,
    )
    .toBe(true);
  if (process.env.FOOM_CAPTURE_745 === "1") {
    await mkdir("screenshots-745", { recursive: true });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((colorMode) => window.desktop.saveSetup({ colorMode }), mode);
      await expect
        .poll(() => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches))
        .toBe(mode === "dark");
      await control.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `screenshots-745/general-${mode}.png` });
    }
  }
  await assertAccessible(page);
});
