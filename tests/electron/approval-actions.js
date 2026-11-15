const { expect } = require("./test-policy.js");

/** Reveal a decision first, then let its movement guard settle before native input. */
async function clickApproval(page, button) {
  await expect(page.locator(".approval-placeholder")).toHaveCount(0);
  await button.scrollIntoViewIfNeeded();
  // Scrolling and its ResizeObserver/React update must finish before checking enabled.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(button).toBeEnabled();
  await button.click();
}

module.exports = { clickApproval };
