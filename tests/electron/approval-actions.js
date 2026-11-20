const { expect } = require("./test-policy.js");

/** Reveal the decision and its consequence, then let the movement guard settle. */
async function revealApproval(page, button) {
  await expect(page.locator(".approval-placeholder")).toHaveCount(0);
  const revealedRow = await button.evaluate((element) => {
    if (!element.hasAttribute("data-approval-discard")) return false;
    element.closest("footer").scrollIntoView({ block: "center" });
    return true;
  });
  if (!revealedRow) await button.scrollIntoViewIfNeeded();
  // Scrolling and its ResizeObserver/React update must finish before checking enabled.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(button).toBeEnabled();
}

async function clickApproval(page, button) {
  await revealApproval(page, button);
  await button.evaluate((element) => {
    const viewport = element.closest(".approval-scroll");
    console.info(
      "Quit ordering: " +
        JSON.stringify({
          event: "renderer:decision-ready",
          ms: Math.round(performance.now()),
          decisionId: element.getAttribute("data-approval-decision"),
          rect: element.getBoundingClientRect().toJSON(),
          viewport: viewport?.getBoundingClientRect().toJSON(),
          scrollTop: viewport?.scrollTop,
        }),
    );
  });
  const control = await button.elementHandle();
  if (!control) throw new Error("Missing approval control");
  try {
    await button.click();
    // The next decision must not race the accepted answer's render. Otherwise
    // its zero-placeholder check can pass before withdrawal commits, scroll a
    // later row early, and leave it clipped when the placeholder collapses.
    await expect.poll(() => control.evaluate((element) => element.isConnected)).toBe(false);
  } finally {
    await control.dispose();
  }
}

module.exports = { clickApproval, revealApproval };
