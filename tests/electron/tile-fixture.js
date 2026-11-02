const { expect } = require("./test-policy.js");

// Split/attachment scenarios need enough CSS pixels for the usable tile minimum.
// Keep narrow-window behavior tests explicit about when they grow the board.
async function sizeTileBoard(app, page, width = 1500, height = 900) {
  const native = await app.browserWindow(page);
  try {
    await native.evaluate(
      (window, { width, height }) => {
        const zoom = window.webContents.getZoomFactor();
        window.setContentSize(Math.round(width * zoom), Math.round(height * zoom));
      },
      { width, height },
    );
  } finally {
    await native.dispose();
  }
  await expect
    .poll(() => page.evaluate((width) => Math.abs(innerWidth - width), width))
    .toBeLessThanOrEqual(1);
}

module.exports = { sizeTileBoard };
