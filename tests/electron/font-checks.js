const assert = require("node:assert/strict");

// Disable local font matching so a developer's installed Nerd Fonts cannot hide
// a missing packaged asset. Use the same probe in development and packaged CI.
async function assertBundledTerminalFonts(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  await cdp.send("CSS.setLocalFontsEnabled", { enabled: false });
  try {
    const metrics = await page.evaluate(async () => {
      const faces = await Promise.all(
        ["400", "700"].map((weight) =>
          document.fonts.load(`${weight} 14px "Hack Nerd Font Mono"`, "W\ue0b0"),
        ),
      );
      const rows = document.querySelector(".xterm-rows");
      const family = getComputedStyle(rows).fontFamily;
      const probes = [];
      for (const weight of [400, 700]) {
        for (const italic of [false, true]) {
          const span = document.createElement("span");
          span.id = `font-probe-${weight}-${italic}`;
          span.className = italic ? "xterm-italic" : "";
          span.style.fontWeight = String(weight);
          span.textContent = "W\ue0b0";
          rows.append(span);
          probes.push(span);
        }
      }
      await document.fonts.ready;
      const canvas = document.createElement("canvas").getContext("2d");
      return {
        family,
        loaded: faces.map(
          (matches) => matches.length > 0 && matches.every((f) => f.status === "loaded"),
        ),
        widths: probes.map((span) => {
          const style = getComputedStyle(span);
          canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          return [canvas.measureText("W").width, canvas.measureText("\ue0b0").width];
        }),
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      };
    });
    assert.match(metrics.family, /^"Hack Nerd Font Mono", "Geist Mono", monospace$/);
    assert.deepEqual(metrics.loaded, [true, true]);
    assert.match(metrics.csp, /font-src 'self';/);
    for (const [cell, arrow] of metrics.widths) {
      assert.ok(
        cell > 0 && Math.abs(cell - arrow) < 0.01,
        `Powerline arrow ${arrow} must fit one cell ${cell}`,
      );
    }
    const { root } = await cdp.send("DOM.getDocument");
    for (const weight of [400, 700]) {
      for (const italic of [false, true]) {
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: `#font-probe-${weight}-${italic}`,
        });
        const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        // Both ASCII and the icon must come from the bundled face. With local
        // fonts disabled, italics must synthesize from that same Regular/Bold.
        assert.deepEqual(
          fonts.map(({ postScriptName, isCustomFont, glyphCount }) => ({
            postScriptName,
            isCustomFont,
            glyphCount,
          })),
          [
            {
              postScriptName: weight === 400 ? "HackNFM-Regular" : "HackNFM-Bold",
              isCustomFont: true,
              glyphCount: 2,
            },
          ],
        );
      }
    }
  } finally {
    await page.evaluate(() =>
      document.querySelectorAll('[id^="font-probe-"]').forEach((node) => node.remove()),
    );
    await cdp.send("CSS.setLocalFontsEnabled", { enabled: true });
    await cdp.detach();
  }
}

module.exports = { assertBundledTerminalFonts };
