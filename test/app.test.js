const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { _electron: electron } = require("@playwright/test");

test("hello world launches with a working, isolated bridge", { timeout: 30_000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(__dirname, "..")], env });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    assert.equal(await page.title(), "Foom");
    await page.getByRole("button", { name: "Say hello" }).click();
    await page.getByRole("status").filter({ hasText: "Hello from the main process!" }).waitFor();
    assert.deepEqual(
      await page.evaluate(() => ({
        node: typeof window.require,
        process: typeof window.process,
        capabilities: Object.keys(window.desktop),
      })),
      { node: "undefined", process: "undefined", capabilities: ["sayHello"] },
    );
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
  } finally {
    await app.close();
  }
});
