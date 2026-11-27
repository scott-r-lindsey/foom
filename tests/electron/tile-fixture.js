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

async function expectTileHeaderHitTargets(tile, labels) {
  // Locator clicks can scroll an overflow-hidden tile. Check where the board
  // lays out the buttons before Playwright can move them into view.
  const hitTargets = await tile.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll(".tile-title button"))
      .filter((button) => {
        const { left, right, top, bottom } = button.getBoundingClientRect();
        return (
          left >= bounds.left &&
          right <= bounds.right &&
          button.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))
        );
      })
      .map((button) => button.getAttribute("aria-label"));
  });
  expect(hitTargets).toEqual(labels);
}

module.exports = { expectTileHeaderHitTargets, sizeTileBoard };
