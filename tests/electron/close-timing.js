const { expect } = require("./test-policy.js");

// Main and renderer share the host clock. Exclude Playwright gesture/polling overhead
// from the acceptance-to-paint measurement; no product timing or deadline changes.
async function measureClose(app, page, id) {
  await expect(page.locator(`[data-drag-session="${id}"]`)).toHaveCount(1);
  await app.evaluate(({ app }, id) => {
    const load = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const { WorkspaceContext } = load("./build/main/workspace/workspace-context.js");
    const close = WorkspaceContext.prototype.closeSession;
    globalThis.measuredClose = {};
    WorkspaceContext.prototype.closeSession = function (entry, ...args) {
      if (entry.id === id) globalThis.measuredClose.accepted = Date.now();
      return close.call(this, entry, ...args).finally(() => {
        if (entry.id === id) globalThis.measuredClose.settled = Date.now();
      });
    };
  }, id);
  await page.evaluate((id) => {
    const observer = new MutationObserver(() => {
      if (document.querySelector(`[data-drag-session="${CSS.escape(id)}"]`)) return;
      observer.disconnect();
      globalThis.closeRowRemoved = Date.now();
      requestAnimationFrame(() => {
        globalThis.closeFrame = Date.now();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, id);
}
async function closeTiming(app, page) {
  await expect.poll(() => page.evaluate(() => globalThis.closeFrame)).toBeTruthy();
  const main = await app.evaluate(() => globalThis.measuredClose);
  const renderer = await page.evaluate(() => ({
    removed: globalThis.closeRowRemoved,
    frame: globalThis.closeFrame,
  }));
  return {
    acceptedToRowMs: renderer.removed - main.accepted,
    acceptedToFrameMs: renderer.frame - main.accepted,
    cleanupMs: main.settled === undefined ? "pending" : main.settled - main.accepted,
  };
}
module.exports = { measureClose, closeTiming };
