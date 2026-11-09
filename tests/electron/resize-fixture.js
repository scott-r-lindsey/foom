const path = require("node:path");
const { writeFile } = require("node:fs/promises");
const { sizeTileBoard } = require("./tile-fixture.js");
const { expect } = require("./test-policy.js");
const { openSettingsScreen } = require("./harness.js");

async function observeResize(app) {
  await app.evaluate(({ app }) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { TerminalHostClient } = load("./build/main/terminals/terminal-host-client.js");
    const resize = TerminalHostClient.prototype.resize;
    TerminalHostClient.prototype.resize = function (...args) {
      globalThis.resizeProbeHost = this;
      return resize.apply(this, args);
    };
  });
}

function terminalColumns(app, id) {
  return app.evaluate(
    async (_electron, id) =>
      globalThis.resizeProbeHost ? (await globalThis.resizeProbeHost.screen(id)).cols : 0,
    id,
  );
}

function renderedText(page) {
  return page
    .locator(".tile-terminal .xterm-rows")
    .evaluate((rows) => [...rows.children].map((row) => row.textContent.trimEnd()).join(""));
}

// Used with both a local fixture shell and the fixture-SSH shell. The raw child
// stays alive through both resizes and reattachment, then writes at its cursor.
async function liveRawResize(app, page, id, root) {
  const script = path.join(root, "live-resize.js");
  await writeFile(
    script,
    `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("RAW_RESIZE_READY\\r\\n");
process.stdin.on("data", (data) => {
  for (const key of data.toString()) {
    if (key === "p") process.stdout.write("\\x1b[2J\\x1b[H" + "P".repeat(96));
    if (key === "z") process.stdout.write("Z");
    if (key === "q") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\\r\\nRAW_RESIZE_DONE\\r\\n", () => process.exit(0));
    }
  }
});
`,
  );
  await observeResize(app);
  await sizeTileBoard(app, page, 1500, 900);
  const cols = () => terminalColumns(app, id);
  await expect.poll(cols).toBeGreaterThan(96);
  const tail = () => page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join(""), id);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(
    `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
  );
  await page.keyboard.press("Enter");
  await expect.poll(tail).toContain("RAW_RESIZE_READY");
  await page.keyboard.type("p");
  await expect.poll(tail).toBe("P".repeat(96));
  await expect.poll(() => renderedText(page)).toBe("P".repeat(96));
  await sizeTileBoard(app, page, 900, 900);
  await expect.poll(cols).toBeLessThan(96);
  await sizeTileBoard(app, page, 1500, 900);
  await expect.poll(cols).toBeGreaterThan(96);
  await page.evaluate((id) => {
    window.rawResizeTokens = new Set();
    window.stopRawResize = window.desktop.onData((terminalId, token) => {
      if (terminalId === id) window.rawResizeTokens.add(token);
    });
  }, id);
  await openSettingsScreen(page);
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(`[data-drag-session="${id}"]`).click();
  await expect.poll(() => page.evaluate(() => window.rawResizeTokens.size)).toBeGreaterThan(0);
  const input = page.locator(".xterm-helper-textarea");
  await expect(input).toBeEditable();
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.type("z");
  // Live programs own redraw. POSIX may clip the old suffix; ConPTY can redraw
  // it. Neither may leave stale P cells after the newly written Z.
  await expect.poll(tail).toMatch(/^P+Z$/);
  const expected = await tail();
  await expect.poll(() => renderedText(page)).toBe(expected);
  await page.keyboard.type("q");
  await expect.poll(tail).toContain("RAW_RESIZE_DONE");
  await expect.poll(tail).toMatch(/[$#>]\s*$/);
  await page.evaluate(() => window.stopRawResize());
}

module.exports = { observeResize, terminalColumns, renderedText, liveRawResize };

// Hold only the renderer lifecycle notification. Native exit, workspace updates,
// snapshots, output and resize RPCs continue normally on both transports.
async function holdExit(app, page, id) {
  const window = await app.browserWindow(page);
  await window.evaluate((window, id) => {
    const contents = window.webContents;
    const send = contents.send;
    const held = [];
    contents.send = function (channel, ...args) {
      if (channel === "terminal:exit" && args[0] === id) held.push(args);
      else return send.call(this, channel, ...args);
    };
    globalThis.exitDelivery = { contents, send, held };
  }, id);
  return {
    count: () => app.evaluate(() => globalThis.exitDelivery.held.length),
    release: () =>
      app.evaluate(() => {
        const gate = globalThis.exitDelivery;
        gate.contents.send = gate.send;
        for (const args of gate.held.splice(0))
          gate.send.call(gate.contents, "terminal:exit", ...args);
      }),
  };
}

async function reconcileExitResize(app, page, id, gate, prompt) {
  const cols = () => terminalColumns(app, id);
  const tail = () => page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join(""), id);
  await expect.poll(gate.count).toBe(1);
  await expect.poll(tail).toBe(prompt);
  await expect.poll(() => renderedText(page)).toBe(prompt.trimEnd());
  await sizeTileBoard(app, page, 900, 900);
  await expect.poll(cols).toBeLessThan(prompt.length);
  await expect.poll(tail).toBe(prompt);
  const clipped = prompt.slice(0, await cols()).trimEnd();
  await expect.poll(() => renderedText(page)).toBe(clipped);
  await gate.release();
  // Recovery must happen in the attached view, without visiting Settings.
  await expect.poll(() => renderedText(page)).toBe(prompt.trimEnd());
  await expect.poll(tail).toBe(prompt);
  await sizeTileBoard(app, page, 1500, 900);
  await expect.poll(cols).toBeGreaterThan(prompt.length);
  await expect.poll(tail).toBe(prompt);
  await expect.poll(() => renderedText(page)).toBe(prompt.trimEnd());
}

async function exitResizeRace(app, page, id, root) {
  const script = path.join(root, "exit-resize.js");
  await writeFile(
    script,
    `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("EXIT_RESIZE_READY\\r\\n");
process.stdin.once("data", () => {
  process.stdout.write("\\x1b[2J\\x1b[H" + "P".repeat(96), () => process.exit(0));
});
`,
  );
  await observeResize(app);
  await sizeTileBoard(app, page, 1500, 900);
  await expect.poll(() => terminalColumns(app, id)).toBeGreaterThan(96);
  const tail = () => page.evaluate(async (id) => (await window.desktop.tail(id, 40)).join(""), id);
  await expect.poll(tail).toMatch(/[$#>]\s*$/);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(`exec "${process.execPath}" "${script}"`);
  await page.keyboard.press("Enter");
  await expect.poll(tail).toContain("EXIT_RESIZE_READY");
  const gate = await holdExit(app, page, id);
  try {
    await page.keyboard.type("q");
    await reconcileExitResize(app, page, id, gate, "P".repeat(96));
  } finally {
    await gate.release();
  }
}

module.exports.holdExit = holdExit;
module.exports.reconcileExitResize = reconcileExitResize;
module.exports.exitResizeRace = exitResizeRace;
