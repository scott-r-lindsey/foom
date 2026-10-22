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
  removeAfterApps,
} = require("./harness.js");

test("an agent configures Foom in the config folder with validation and approval", {
  timeout: deadline(90_000),
  skip: process.platform === "win32" && "The fake agent is a POSIX script",
}, async (context) => {
  const { chmod } = require("node:fs/promises");
  const { interfaceThemes } = require("../../build/shared/interface-themes.js");
  const { DEFAULT_SOUND } = require("../../build/shared/sounds.js");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-env-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  const palette = interfaceThemes["eclipse-dark"];
  const good = { kind: "theme", name: "Agent", base: palette.base, colors: palette.colors };
  const bad = { ...good, colors: { ...palette.colors, accent: "not a color" } };
  // The fake agent edits files when keys arrive, like an agent following AGENTS.md.
  await writeFile(
    path.join(bin, "claude"),
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log("  --settings <file-or-json>  Load settings"); process.exit(0); }
const theme = (value) => writeFileSync("themes/agent.json", JSON.stringify(value));
writeFileSync(${JSON.stringify(path.join(root, "agent-cwd.txt"))}, process.cwd());
process.stdout.write("FOOM_CONFIG_AGENT_READY\\r\\n");
process.stdin.setRawMode(true);
process.stdin.on("data", (key) => {
  const input = key.toString();
  if (input === "t" || input === "g") theme(${JSON.stringify(good)});
  if (input === "i") theme(${JSON.stringify(bad)});
  if (input === "s") {
    const settings = JSON.parse(readFileSync("settings.json", "utf8"));
    settings.sound = { ...${JSON.stringify(DEFAULT_SOUND)}, alerts: false };
    writeFileSync("settings.json", JSON.stringify(settings));
  }
  if (input === "t" || input === "v") {
    const result = spawnSync("foom", ["config", "validate", "."], { encoding: "utf8" });
    process.stdout.write("validate exit=" + result.status + "\\r\\n");
  }
});
`,
  );
  await chmod(path.join(bin, "claude"), 0o755);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  const folder = path.join(home, ".foom", "config");
  const gear = page.locator(".config-gear");
  await expect(gear).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Foom config" })).toHaveCount(0);
  // 1. Launch a fake agent in Foom config from the footer panel.
  await page.locator(".config-gear").click();
  const panel = page.getByRole("dialog", { name: "Foom config details and commands" });
  await expect(panel).toContainText(folder);
  await panel.getByRole("menuitem", { name: "Via Claude Code", exact: true }).click();
  const id = await expect
    .poll(async () => {
      const snapshot = await page.evaluate(() => window.desktop.workspace());
      return snapshot.terminals.find((entry) => entry.config)?.id ?? null;
    })
    .not.toBeNull()
    .then(async () => {
      const snapshot = await page.evaluate(() => window.desktop.workspace());
      return snapshot.terminals.find((entry) => entry.config).id;
    });
  const tail = () =>
    page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join("\n"), id);
  // Long temporary paths wrap in the terminal, so the agent reports its cwd in a file.
  await expect.poll(tail).toContain("FOOM_CONFIG_AGENT_READY");
  assert.equal(
    await realpath(await readFile(path.join(root, "agent-cwd.txt"), "utf8")),
    await realpath(folder),
  );
  const snapshot = await page.evaluate(() => window.desktop.workspace());
  assert.equal(snapshot.terminals.find((entry) => entry.id === id).attention, "hooks");

  // 2. It writes a theme and validates the folder with the bundled CLI.
  await page.evaluate((id) => window.desktop.input(id, "t"), id);
  await expect.poll(tail).toContain("validate exit=0");
  await boardCommand(app, ",", process.platform !== "darwin");
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("button", { name: "Foom config", exact: true }).click();
  // Nothing needs the user, so the section lists nothing beyond the folder.
  await expect(page.getByRole("button", { name: "Open folder", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent changes" })).toHaveCount(0);
  const problems = page.getByRole("list", { name: "Rejected files" });
  await expect(problems).toHaveCount(0);
  await sections.getByRole("button", { name: "Themes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Agent", exact: true })).toBeVisible();

  // 3. An invalid theme is rejected and the last good colors stay.
  await page.evaluate((id) => window.desktop.input(id, "i"), id);
  await sections.getByRole("button", { name: "Foom config", exact: true }).click();
  const rejected = problems.getByRole("listitem").filter({ hasText: "themes/agent.json" });
  await expect(rejected).toContainText("$.colors.accent: not-a-color");
  const catalog = await page.evaluate(() => window.desktop.listThemes());
  assert.equal(
    catalog.interface.find((entry) => entry.theme.name === "Agent").theme.colors.accent,
    palette.colors.accent,
  );

  // 4. Turning off the needs-you sound is held; Keep it on restores the file.
  await page.evaluate((id) => window.desktop.input(id, "s"), id);
  const banner = page.getByRole("region", { name: "Change waiting for approval" });
  await expect(banner).toContainText("An agent wants to turn off the needs-you sound");
  await expect(banner).toHaveCSS("border-top-color", /rgb/);
  await page.locator(".config-gear").click();
  await expect(page.locator(".config-dock")).toContainText("Needs you");
  await expect(gear).toHaveAttribute("aria-label", /needs you/);
  await expect(gear).toHaveAttribute("data-tone", "needs");
  // Both statuses remain readable inside the forced compact rail.
  const originalSize = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === "app://bundle/index.html",
    );
    const size = window.getContentBounds();
    window.setMinimumSize(1, 1);
    window.setContentSize(640, 720);
    return size;
  });
  const sidebar = page.locator(".sidebar-shell");
  await expect(sidebar).toHaveAttribute("data-compact", "true");
  await expect(page.locator(".config-dock")).toHaveCount(0);
  await expect(page.locator(".rail-needs")).toContainText("need you");
  await expect(gear).toHaveAttribute("aria-label", /needs you.*rejected/);
  await expect(page.locator(".board-list .board-row").filter({ hasText: "CC" })).toBeVisible();
  await page.screenshot({ path: "test-results/config-footer-compact.png", animations: "disabled" });
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL() === "app://bundle/index.html")
      .setContentSize(size.width, size.height);
  }, originalSize);
  await expect(sidebar).toHaveAttribute("data-compact", "false");
  // Resizing dismisses the panel; reopen it to inspect its approval facts.
  await gear.click();

  await expect(panel).toContainText("Needs you");
  await page.keyboard.press("Escape");
  assert.equal(
    (await page.evaluate(() => window.desktop.setupState())).settings.sound.alerts,
    true,
  );
  await banner.getByRole("button", { name: "Keep it on" }).click();
  await expect(banner).toHaveCount(0);
  const restored = JSON.parse(await readFile(path.join(folder, "settings.json"), "utf8"));
  assert.notEqual(restored.sound?.alerts, false);

  // 5. A fixed theme clears its rejection; Foom never made the folder a git repository.
  await page.evaluate((id) => window.desktop.input(id, "g"), id);
  await expect
    .poll(() => readFile(path.join(folder, "themes/agent.json"), "utf8"))
    .toBe(JSON.stringify(good));
  await expect(rejected).toHaveCount(0);
  await assert.rejects(require("node:fs/promises").access(path.join(folder, ".git")));
  await assertAccessible(page);
});

test("config agents receive only the bundled manual and revoke the attachment on exit", {
  timeout: deadline(90_000),
}, async (context) => {
  const { installManualAgent } = require("./manual-agent.js");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "foom-config-manual-")));
  removeAfterApps(context, root);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  const report = await installManualAgent(home, bin, true);
  const app = await launchApp(context, { fixture: "agent", home, env: { HOME: home, PATH: bin } });
  const page = await boardPage(app);
  await page.locator(".config-gear").click();
  await page
    .getByRole("dialog", { name: "Foom config details and commands" })
    .getByRole("menuitem", { name: "Via Codex", exact: true })
    .click();
  let result;
  await expect
    .poll(async () => {
      try {
        result = JSON.parse(await readFile(report, "utf8"));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.tools, ["manual"]);
  assert.equal(result.instructions, "For questions about using Foom, call manual.");
  assert.ok(result.refused.includes("whoami"));
  assert.ok(result.refused.includes("handoff"));
  assert.ok(result.refused.includes("launch"));
  const index = JSON.parse(await readFile("build/manual/sections.json", "utf8"));
  assert.equal(result.text, index.find((section) => section.id === "shortcuts").text);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.desktop.workspace())).terminals.find(
          (entry) => entry.config,
        )?.exitCode,
    )
    .toBe(0);
  await expect
    .poll(async () => {
      try {
        await fetch(result.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${result.token}`, "Content-Type": "application/json" },
          body: "{}",
        });
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
});
