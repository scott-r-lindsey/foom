// Test-owned observation only. No focus/input injection, timers or extra waits.
const PREFIX = "Quit ordering: ";
const LIMIT = 192;
const active = new WeakMap();
function recordQuitOrdering(app, event) {
  active.get(app)?.record("harness", { event });
}

function orderingBuffer() {
  const events = [];
  let total = 0;
  return {
    record(source, event) {
      if (JSON.stringify(event).length > 2048) event = { event: "record:oversized" };
      events.push({ observedMs: Math.round(performance.now()), source, ...event });
      total++;
      if (events.length > LIMIT) events.shift();
    },
    snapshot: () => ({ total, dropped: total - events.length, events: [...events] }),
  };
}

// Playwright's exported debug transport includes in-flight server actionability
// logs, unlike its public logger (which only reports API start/end). Keep only
// fixed phrases; never retain selectors, element HTML or arbitrary log text.
function actionabilityEvent(message) {
  const phrases = [
    "waiting for element to be visible, enabled and stable",
    "element is not visible",
    "element is outside of the viewport",
    "element is not enabled",
    "element is not stable",
    "element is visible, enabled and stable",
    "scrolling into view if needed",
    "done scrolling",
    "intercepts pointer events",
    "element was detached from the DOM",
    "retrying click action",
    "performing click action",
    "click action done",
    "waiting for scheduled navigations to finish",
    "navigations have finished",
  ];
  if (message.includes("locator resolved to")) return "locator resolved";
  if (message.includes("waiting for getByRole") || message.includes("waiting for locator("))
    return "waiting for locator";
  return phrases.find((phrase) => message.includes(phrase));
}

function observeActionability(record) {
  const { debug } = require("playwright-core/lib/utilsBundle");
  const previousNamespaces = debug.disable();
  const previousLog = debug.log;
  debug.enable([previousNamespaces, "pw:api"].filter(Boolean).join(","));
  debug.log = function (...args) {
    if (this.namespace === "pw:api") {
      const event = actionabilityEvent(String(args[0]));
      if (event) record("playwright", { event });
    } else {
      previousLog.apply(this, args);
    }
  };
  return () => {
    debug.log = previousLog;
    debug.enable(previousNamespaces);
  };
}

function installNativeOrdering({ app, BrowserWindow, ipcMain, screen }, { prefix, limit }) {
  let sequence = 0;
  const emit = (event, facts = {}) => {
    if (sequence >= limit) return;
    process.stderr.write(
      prefix +
        JSON.stringify({
          event,
          sequence: ++sequence,
          ms: Math.round(performance.now()),
          ...facts,
        }) +
        "\n",
    );
  };
  for (const child of BrowserWindow.getAllWindows()) {
    if (child.webContents.getURL() !== "app://confirmation/confirmation.html") continue;
    let presented = null;
    let requestId;
    const state = () => {
      if (child.isDestroyed()) return { destroyed: true };
      const parent = child.getParentWindow();
      return {
        presented,
        focused: child.isFocused(),
        visible: child.isVisible(),
        minimized: child.isMinimized(),
        contentsFocused: child.webContents.isFocused(),
        bounds: child.getBounds(),
        parentBounds: parent && !parent.isDestroyed() ? parent.getContentBounds() : null,
        workArea: screen.getDisplayMatching(child.getBounds()).workArea,
      };
    };
    const send = child.webContents.send;
    child.webContents.send = function (channel, ...args) {
      if (channel === "confirmation:render") {
        presented = args[0]?.presented === true;
        requestId = args[0]?.id;
        emit("native:render", state());
      }
      return send.call(this, channel, ...args);
    };
    for (const name of [
      "focus",
      "blur",
      "show",
      "hide",
      "move",
      "resize",
      "minimize",
      "restore",
      "closed",
    ])
      child.on(name, () => emit(`native:${name}`, state()));
    child.webContents.on("before-mouse-event", (_event, input) => {
      if (["mouseDown", "mouseUp"].includes(input.type)) emit(`native:${input.type}`, state());
    });
    ipcMain.prependListener("confirmation:answer", (event, id, accepted) => {
      if (event.sender !== child.webContents) return;
      emit("native:answer", {
        ...state(),
        topFrame: event.senderFrame === child.webContents.mainFrame,
        matchingRequest: requestId === undefined ? null : id === requestId,
        accepted: accepted === true,
      });
    });
    emit("native:installed", state());
  }
  for (const name of ["before-quit", "will-quit"])
    app.on(name, (event) => emit(`native:${name}`, { prevented: event.defaultPrevented }));
}

function installRendererOrdering({ prefix, limit }) {
  let sequence = 0;
  const emit = (event, facts = {}) => {
    if (sequence >= limit) return;
    console.info(
      prefix +
        JSON.stringify({
          event,
          sequence: ++sequence,
          ms: Math.round(performance.now()),
          ...facts,
        }),
    );
  };
  window.confirmation.render((request) =>
    emit("renderer:render", {
      pending: request !== null,
      presented: request?.presented === true,
    }),
  );
  for (const name of ["pointerdown", "pointerup", "click"])
    document.addEventListener(
      name,
      (event) => {
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        emit(`renderer:${name}`, {
          trusted: event.isTrusted,
          button:
            button?.textContent === "Stop all and quit" ? "accept" : button ? "other" : "none",
          disabled: button?.disabled === true,
          focused: document.hasFocus(),
        });
      },
      true,
    );
  emit("renderer:installed");
}

function startQuitOrdering(app) {
  const buffer = orderingBuffer();
  const record = buffer.record;
  active.set(app, buffer);
  const options = { prefix: PREFIX, limit: LIMIT };
  const receive = (source, value) => {
    if (!value.startsWith(PREFIX)) return;
    if (value.length > 2048) {
      record(source, { event: "record:oversized" });
      return;
    }
    try {
      record(source, JSON.parse(value.slice(PREFIX.length)));
    } catch {
      record(source, { event: "record:malformed" });
    }
  };
  const onConsole = (message) => {
    const value = message.text();
    receive("renderer", value);
  };
  const lines = require("node:readline").createInterface({ input: app.process().stderr });
  lines.on("line", (line) => {
    receive("main", line);
  });
  const pages = [];
  const restore = observeActionability(record);
  return {
    async install() {
      await app.evaluate(installNativeOrdering, options);
      for (const page of app.windows()) {
        if (page.url() !== "app://confirmation/confirmation.html") continue;
        // Fixture owners may dispose their dialog before the app cleanup runs.
        // Playwright can still enumerate its cached page during that close.
        if (page.isClosed()) {
          record("harness", { event: "harness:renderer-closed-before-install" });
          continue;
        }
        pages.push(page);
        page.on("console", onConsole);
        try {
          await page.evaluate(installRendererOrdering, options);
        } catch (error) {
          if (!page.isClosed()) throw error;
          record("harness", { event: "harness:renderer-closed-before-install" });
        }
      }
    },
    record: (event) => record("harness", { event }),
    snapshot: buffer.snapshot,
    stop() {
      active.delete(app);
      restore();
      lines.close();
      for (const page of pages) page.removeListener("console", onConsole);
    },
  };
}

module.exports = { orderingBuffer, actionabilityEvent, startQuitOrdering, recordQuitOrdering };
