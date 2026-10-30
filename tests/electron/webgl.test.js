const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const path = require("node:path");
const { deadline, expect } = require("./test-policy.js");
const { launchApp, boardPage } = require("./harness.js");

const contexts = (page) =>
  page.locator(".xterm-screen canvas").evaluateAll(
    (canvases) =>
      canvases.filter((canvas) => {
        const gl = canvas.getContext("webgl2");
        return gl && !gl.isContextLost();
      }).length,
  );
async function expectContexts(app, page, count) {
  try {
    await expect.poll(() => contexts(page)).toBe(count);
  } catch (error) {
    console.error(
      "WebGL fixture diagnostics",
      await app.evaluate(async ({ app }) => {
        let info;
        try {
          info = await app.getGPUInfo("complete");
        } catch (failure) {
          info = String(failure);
        }
        return { platform: process.platform, features: app.getGPUFeatureStatus(), info };
      }),
    );
    throw error;
  }
}
async function output(page, id, marker) {
  const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${path.join(__dirname, "webgl-output.js")}" ${marker}\r`;
  await page.evaluate(({ id, command }) => window.desktop.input(id, command), { id, command });
  await expect
    .poll(() => page.evaluate(async (id) => (await window.desktop.tail(id, 160)).join("\n"), id))
    .toContain(`WEBGL_${marker}_DONE`);
}

test("WebGL loss keeps the terminal, scrollback and attachment usable through DOM", {
  timeout: deadline(45000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell", renderer: "webgl" });
  const page = await boardPage(app);
  await expectContexts(app, page, 1);
  const [session] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  await page.evaluate(() => {
    window.webglTokens = [];
    window.webglElement = document.querySelector(".xterm");
    window.stopWebglData = window.desktop.onData((_id, token) => window.webglTokens.push(token));
  });
  const renderer = await page.locator(".xterm-screen canvas").evaluateAll((canvases) => {
    const gl = canvases.map((canvas) => canvas.getContext("webgl2")).find(Boolean);
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
  });
  assert.match(renderer, process.platform === "darwin" ? /Metal/ : /SwiftShader/);
  await output(page, session.id, "BEFORE");
  await page.locator(".xterm-screen canvas").evaluateAll((canvases) => {
    const gl = canvases.map((canvas) => canvas.getContext("webgl2")).find(Boolean);
    gl.getExtension("WEBGL_lose_context").loseContext();
  });
  const rows = page.locator(".xterm-rows");
  await expect(rows).toBeVisible();
  await expect(rows).toContainText("WEBGL_BEFORE_DONE");
  await expectContexts(app, page, 0);
  const input = page.locator(".xterm-helper-textarea");
  for (let index = 0; index < 8; index++) await input.press("Shift+PageUp");
  await expect(rows).toContainText("WEBGL_BEFORE_TOP");
  for (let index = 0; index < 8; index++) await input.press("Shift+PageDown");
  await expect(rows).toContainText("WEBGL_BEFORE_DONE");
  await output(page, session.id, "AFTER");
  await expect(rows).toContainText("WEBGL_AFTER_DONE");
  assert.equal(
    await page.evaluate(() => document.querySelector(".xterm") === window.webglElement),
    true,
  );
  assert.equal(
    await page.evaluate(() => new Set(window.webglTokens).size),
    1,
    "loss must not reattach",
  );
  await page.evaluate(() => window.desktop.appMenu.execute("settings"));
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expect(rows).toContainText("WEBGL_AFTER_DONE");
  await expectContexts(app, page, 0);
  assert.equal(
    await page.evaluate(() => document.querySelector(".xterm") === window.webglElement),
    true,
  );
  const history = await page.evaluate(
    async (id) => (await window.desktop.tail(id, 300)).join("\n"),
    session.id,
  );
  assert.ok(history.includes("WEBGL_BEFORE_TOP"));
  assert.ok(history.includes("WEBGL_AFTER_DONE"));
  await page.evaluate(() => window.stopWebglData());
});

test("WebGL uses a visible context budget and releases hidden and unmounted views", {
  timeout: deadline(60000),
}, async (context) => {
  const app = await launchApp(context, { fixture: "running-shell", renderer: "webgl" });
  const page = await boardPage(app);
  const [first] = (await page.evaluate(() => window.desktop.workspace())).terminals;
  for (let index = 1; index < 18; index++) {
    const largest = await page.locator(".terminal-tile").evaluateAll(
      (nodes) =>
        nodes
          .map((node, index) => {
            const { width, height } = node.getBoundingClientRect();
            return { index, width, height, area: width * height };
          })
          .sort((a, b) => b.area - a.area)[0],
    );
    await page
      .locator(".terminal-tile")
      .nth(largest.index)
      .getByRole("button", { name: /^Tile \d+ menu$/ })
      .click();
    await page
      .getByRole("menuitem", {
        name: largest.width > largest.height * 1.5 ? "Split terminal left" : "Split terminal up",
        exact: true,
      })
      .click();
    await page.evaluate(
      ({ repository, worktree }) =>
        window.desktop.sidebarCommand({ kind: "launch", repository, worktree, run: "shell" }),
      first,
    );
    await expect(page.locator(".board-row[data-kind='shell']")).toHaveCount(index + 1);
    await page.locator(".board-row[data-kind='shell']").nth(index).click();
    await expect(page.locator(".terminal-tile[data-empty=false]")).toHaveCount(index + 1);
  }
  await expect(page.locator(".xterm")).toHaveCount(18);
  await expectContexts(app, page, 12);
  await expect(page.locator(".terminal-tile[data-empty=false] .xterm-rows")).toHaveCount(6);
  await page.evaluate(() => window.desktop.appMenu.execute("settings"));
  await expectContexts(app, page, 0);
  await expect(page.locator(".xterm")).toHaveCount(18);
  await page.getByRole("button", { name: "Close settings (Esc)", exact: true }).click();
  await expectContexts(app, page, 12);
  const firstTile = page.locator(".terminal-tile").first();
  await firstTile.getByRole("button", { name: "Hide", exact: true }).click();
  await page.evaluate(() => window.desktop.appMenu.execute("tidy-tiles"));
  await expect(page.locator(".xterm")).toHaveCount(17);
  await expectContexts(app, page, 11);
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL() === "app://bundle/index.html")
        .webContents.getLastWebPreferences();
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
      };
    }),
    { sandbox: true, contextIsolation: true, nodeIntegration: false },
  );
});
