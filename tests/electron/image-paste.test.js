const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readFile, stat } = require("node:fs/promises");
const { codexFixture } = require("./agent-fixture.js");
const { boardPage, launchApp, stopSession } = require("./harness.js");
const { deadline, expect } = require("./test-policy.js");
const { evidencePath } = require("../helpers/evidence.js");
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3RwQkAMAwDsey/dDpEH6L0wAPo8OzO0/OCArSgAC0oQAsK0IICtKAALShACwrQggK0oAAtKEALCtCCArSgAC0oQAtuAzzh+wu4oAAtKEALCtCCArSgAC0oQAsK0IICtKAALShACwrQggK0oAAtKEALPg84Qafh0lRgkoQAAAAASUVORK5CYII=";
async function imageClipboard(app, text) {
  await app.evaluate(
    async ({ clipboard, ClipboardItem }, { png, text }) => {
      const values = { "image/png": new Blob([Buffer.from(png, "base64")]) };
      if (text !== undefined) values["text/plain"] = text;
      await clipboard.write([new ClipboardItem(values)]);
    },
    { png: PNG, text },
  );
}
const pasteKey = process.platform === "darwin" ? "Meta+V" : "Control+V";

test("image paste refuses shells with a fixed visible result and shares context menu Paste", {
  timeout: deadline(30_000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell" });
  const page = await boardPage(app);
  const terminal = page.locator(".xterm-helper-textarea");
  await terminal.focus();
  await imageClipboard(app);
  await page.keyboard.press(pasteKey);
  await expect(
    page.getByText("Image paste is not supported for this session.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: evidencePath("screenshots-937/unsupported-shell.png"),
    animations: "disabled",
  });
  await page.locator(".xterm-screen").click({ button: "right", position: { x: 60, y: 30 } });
  const menu = page.getByRole("menu", { name: "Terminal menu", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Paste", exact: true })).toBeEnabled();
  await page.screenshot({
    path: evidencePath("screenshots-937/context-menu-paste.png"),
    animations: "disabled",
  });
  await menu.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect(
    page.getByText("Image paste is not supported for this session.", { exact: true }),
  ).toBeVisible();
  await imageClipboard(app, "TEXT_WINS_937");
  await terminal.focus();
  await page.keyboard.press(pasteKey);
  await expect(page.locator(".xterm-rows")).toContainText("TEXT_WINS_937");
  await expect(page.locator(".tile-paste-result")).toHaveCount(0);
});

test("agent image paste normalizes privately, sends one bracketed reference without Enter and cleans on close", {
  timeout: deadline(45_000),
  skip: process.platform === "win32" && "The fixture CLI is a POSIX executable",
}, async (context) => {
  const { app, page, repository, root, help } = await codexFixture(context, {
    prefix: "foom-image's paste-",
    helpText: "--no-alt-screen",
    source: ({ help }) => `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('codex-cli 0.163.0');
else if (process.argv[2] === '--help') console.log('--no-alt-screen');
else {
 const log = ${JSON.stringify(path.join(path.dirname(help), "input"))};
 fs.writeFileSync(log, '');
 process.stdin.setRawMode(true); process.stdin.resume();
 process.stdout.write('\\x1b[?2004hIMAGE_READY_937\\r\\n');
 process.stdin.on('data', data => {fs.appendFileSync(log, data);process.stdout.write('RECEIVED_937\\r\\n');});
}
`,
  });
  assert.ok(help.startsWith(root));
  const id = await page.evaluate(
    async (repo) =>
      (
        await window.desktop.launchAgent({
          agent: "codex",
          repository: repo,
          worktree: repo,
          cols: 80,
          rows: 24,
        })
      ).id,
    repository.path,
  );
  // LaunchAgent returns a session; selecting its row presents the live terminal.
  const row = page.locator(".board-row[data-kind='agent']").first();
  await row.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText("IMAGE_READY_937");
  await page.locator(".xterm-helper-textarea").focus();
  await imageClipboard(app);
  await page.keyboard.press(pasteKey);
  const marker = path.join(root, "input");
  await expect.poll(() => readFile(marker, "utf8")).toContain("[pasted image '");
  const first = await readFile(marker, "utf8");
  assert.ok(first.startsWith("\x1b[200~[pasted image '"));
  assert.ok(first.endsWith("'] \x1b[201~"));
  assert.equal(first.split("\x1b[200~").length, 2);
  assert.doesNotMatch(first, /[\r\n]/u);
  const quoted = first.slice("\x1b[200~[pasted image '".length, -"'] \x1b[201~".length);
  const file = quoted.replaceAll("'\\''", "'");
  assert.ok(!file.startsWith(repository.path));
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await page.locator(".xterm-screen").click({ button: "right", position: { x: 60, y: 30 } });
  await page
    .getByRole("menu", { name: "Terminal menu", exact: true })
    .getByRole("menuitem", { name: "Paste", exact: true })
    .click();
  await expect.poll(async () => (await readFile(marker, "utf8")).split("\x1b[200~").length).toBe(3);
  await stopSession(page, id);
  await expect
    .poll(async () => {
      try {
        await stat(file);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    })
    .toBe(false);
});
