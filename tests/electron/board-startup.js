// Loaded by the fixture bootstrap before main constructs either native window.
// Native events and compositor traces distinguish a visible CDP document from
// a mapped window with a live frame sink. This never runs in the shipped app.
function recordBoardStartup({ app }) {
  const state = { events: [] };
  globalThis.boardStartup = state;
  app.on("browser-window-created", (_event, window) => {
    const record = (event) => {
      if (state.events.length >= 128 || window.isDestroyed()) return;
      state.events.push({
        event,
        at: performance.now(),
        id: window.id,
        url: window.webContents.getURL(),
        visible: window.isVisible(),
        focused: window.isFocused(),
        bounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
      });
    };
    record("created");
    for (const event of ["show", "hide", "focus", "blur", "resize", "ready-to-show"])
      window.on(event, () => record(event));
    for (const event of ["did-start-loading", "did-navigate", "dom-ready", "did-finish-load"])
      window.webContents.on(event, () => record(event));
  });
}

module.exports = { recordBoardStartup };
