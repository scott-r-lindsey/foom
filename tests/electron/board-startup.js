// Loaded by the fixture bootstrap before main constructs either native window.
// Native events and compositor traces distinguish a visible CDP document from
// a mapped window with a live frame sink. This never runs in the shipped app.
function recordBoardStartup({ app, contentTracing }, trace) {
  const state = { events: [], tracing: false };
  globalThis.boardStartup = state;
  // Start alongside main's readiness continuation, without gating its startup.
  // Stop through the API before interaction/quit: CLI tracing can hang Electron
  // shutdown while flushing a cold renderer on window-manager-less Xvfb.
  state.traceReady = trace
    ? app.whenReady().then(async () => {
        await contentTracing.startRecording({
          included_categories: [
            "cc",
            "viz",
            "blink",
            "navigation",
            "devtools.timeline",
            "renderer.scheduler",
            "disabled-by-default-cc.debug*",
            "disabled-by-default-viz.debug*",
          ],
          excluded_categories: ["*"],
          recording_mode: "record-until-full",
          trace_buffer_size_in_kb: 16384,
        });
        state.tracing = true;
      })
    : Promise.resolve();
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
