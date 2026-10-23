async function waitForBoardDocument(window) {
  const contents = window.webContents;
  const loaded = () =>
    contents.getURL() === "app://bundle/index.html" && !contents.isLoadingMainFrame();
  let dispose = () => {};
  try {
    await new Promise((resolve, reject) => {
      const finished = () => {
        // Electron can emit did-finish-load before clearing its loading flag.
        // The event itself establishes readiness for this document.
        if (contents.getURL() === "app://bundle/index.html") resolve();
      };
      const closed = () => reject(new Error("Board closed before document readiness"));
      const gone = (_event, details) =>
        reject(new Error(`Board renderer exited before document readiness: ${details.reason}`));
      const failed = (_event, code, description, url, mainFrame) => {
        if (mainFrame) reject(new Error(`Board navigation failed: ${code} ${description} ${url}`));
      };
      dispose = () => {
        window.removeListener("closed", closed);
        contents.removeListener("did-finish-load", finished);
        contents.removeListener("render-process-gone", gone);
        contents.removeListener("did-fail-load", failed);
      };
      window.once("closed", closed);
      contents.on("did-finish-load", finished);
      contents.once("render-process-gone", gone);
      contents.on("did-fail-load", failed);
      if (loaded()) resolve();
    });
  } finally {
    dispose();
  }
}

// Wait for compositor output, not layout or device metadata. Initialization is
// bounded by launchApp's existing hard watchdog, not the rAF assertion budget.
async function waitForBoardCompositor(window, ready) {
  if (ready.has(window.id)) return;
  const contents = window.webContents;
  let dispose = () => {};
  try {
    await new Promise((resolve, reject) => {
      const closed = () => reject(new Error("Board closed before compositor readiness"));
      const gone = (_event, details) =>
        reject(new Error(`Board renderer exited before compositor readiness: ${details.reason}`));
      dispose = () => {
        window.removeListener("closed", closed);
        contents.removeListener("render-process-gone", gone);
      };
      window.once("closed", closed);
      contents.once("render-process-gone", gone);
      contents.beginFrameSubscription(true, () => resolve());
    });
    ready.add(window.id);
  } finally {
    dispose();
    if (!contents.isDestroyed()) contents.endFrameSubscription();
  }
}

// Loaded by the fixture bootstrap before main constructs either native window.
// Native events and compositor traces distinguish a visible CDP document from
// a mapped window with a live frame sink. This never runs in the shipped app.
function recordBoardStartup({ app, contentTracing }, trace) {
  const state = { events: [], compositorReady: new Set(), tracing: false, stopRequested: false };
  // The first native window is the board. Workspace initialization (including
  // private-file ACL checks on Windows) precedes its loadURL. Await navigation
  // under the existing launch watchdog before checking Playwright's page list.
  const boardCreated = new Promise((resolve) =>
    app.once("browser-window-created", (_event, window) => resolve(window)),
  );
  const documentReady = boardCreated.then(waitForBoardDocument);
  // Subscribe before navigation, even when Playwright attaches after load.
  // Keep an early rejection available for the caller without an unhandled one.
  void documentReady.catch(() => {});
  state.waitForDocument = () => documentReady;
  state.waitForCompositor = (window) => waitForBoardCompositor(window, state.compositorReady);
  const recordApp = (event, details) => {
    if (state.events.length < 128) state.events.push({ event, at: performance.now(), details });
  };
  app.whenReady().then(() => recordApp("app-ready"));
  app.on("gpu-info-update", () => recordApp("gpu-info-update", app.getGPUFeatureStatus()));
  app.on("child-process-gone", (_event, details) => recordApp("child-process-gone", details));
  globalThis.boardStartup = state;
  // Start alongside main's readiness continuation, without gating its startup.
  // Stop through the API before interaction/quit: CLI tracing can hang Electron
  // shutdown while flushing a cold renderer on window-manager-less Xvfb.
  state.traceReady = trace
    ? app.whenReady().then(async () => {
        if (state.stopRequested) return;
        await contentTracing.startRecording({
          included_categories: [
            "cc",
            "gpu",
            "toplevel",
            "viz",
            "blink",
            "navigation",
            "devtools.timeline",
            "blink.user_timing",
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
    window.once("closed", () => state.compositorReady.delete(window.id));
    record("created");
    for (const event of ["show", "hide", "focus", "blur", "resize", "ready-to-show"])
      window.on(event, () => record(event));
    for (const event of ["did-start-loading", "did-navigate", "dom-ready", "did-finish-load"])
      window.webContents.on(event, () => record(event));
  });
}

module.exports = { recordBoardStartup, waitForBoardCompositor, waitForBoardDocument };
