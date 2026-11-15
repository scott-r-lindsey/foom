const { appendFile } = require("node:fs/promises");
const { evidencePath } = require("../helpers/evidence.js");

// Test-owned observers only. No focus, input, attachment or scheduling decisions.
async function withPreviewFocusTrace(context, app, page, run) {
  try {
    await page.evaluate(() => {
      const events = [];
      let dropped = 0;
      const removers = [];
      const describe = (element) =>
        element instanceof Element
          ? { tag: element.tagName, class: element.getAttribute("class")?.slice(0, 160) }
          : null;
      const rect = (element) => {
        if (!(element instanceof Element)) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const snapshot = (point) => {
        const hit = point ? document.elementFromPoint(point.x, point.y) : null;
        return {
          time: Date.now(),
          focused: document.hasFocus(),
          active: describe(document.activeElement),
          viewport: { width: innerWidth, height: innerHeight },
          point,
          hit: describe(hit),
          hitBounds: rect(hit),
          terminalBounds: rect(document.querySelector(".xterm-screen")),
        };
      };
      for (const type of ["focus", "blur", "mousedown", "mouseup", "focusin", "focusout"]) {
        const listener = (event) => {
          const point = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : null;
          events.push({ type, target: describe(event.target), ...snapshot(point) });
          if (events.length > 128) {
            events.shift();
            dropped++;
          }
        };
        addEventListener(type, listener, true);
        removers.push(() => removeEventListener(type, listener, true));
      }
      globalThis.previewFocusTrace = {
        snapshot,
        finish(point) {
          for (const remove of removers) remove();
          delete globalThis.previewFocusTrace;
          return { events, dropped, final: snapshot(point) };
        },
      };
    });
    await app.evaluate(({ app, BrowserWindow, webContents }) => {
      const board = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === "app://bundle/index.html",
      );
      const events = [];
      const removers = [];
      const disposedChecks = [];
      let dropped = 0;
      let active = true;
      let clickPoint = null;
      const trace = (type, extra = {}) => {
        if (!active) return;
        events.push({
          type,
          time: Date.now(),
          windowFocused: !board.isDestroyed() && board.isFocused(),
          boardFocused: !board.webContents.isDestroyed() && board.webContents.isFocused(),
          viewCount: board.isDestroyed() ? 0 : board.contentView.children.length,
          nativeFocused: webContents.getFocusedWebContents()?.id ?? null,
          zoom: board.webContents.isDestroyed() ? null : board.webContents.getZoomFactor(),
          views: board.isDestroyed()
            ? []
            : board.contentView.children.slice(0, 16).map((view) => ({
                generation: view.webContents?.id,
                bounds: view.getBounds(),
                visible: view.getVisible(),
              })),
          ...extra,
        });
        if (events.length > 128) {
          events.shift();
          dropped++;
        }
      };
      const on = (target, type, listener) => {
        target.on(type, listener);
        removers.push(() => target.removeListener(type, listener));
        disposedChecks.push(() => !target.listeners(type).includes(listener));
      };
      const bind = (contents) => {
        const generation = contents.id;
        trace("created", { generation });
        for (const type of ["focus", "blur", "did-start-loading", "did-finish-load", "destroyed"])
          on(contents, type, () => trace(type, { generation }));
        on(contents, "did-start-navigation", (event) =>
          trace("navigation", {
            generation,
            mainFrame: event.isMainFrame,
            sameDocument: event.isSameDocument,
          }),
        );
        on(contents, "before-mouse-event", (event, mouse) => {
          if (mouse.type !== "mouseDown" && mouse.type !== "mouseUp") return;
          trace("native mouse", {
            generation,
            mouse: { type: mouse.type, x: mouse.x, y: mouse.y, button: mouse.button },
            prevented: event.defaultPrevented,
          });
        });
      };
      // Publish cleanup before installing any observers, so partial setup also disposes.
      globalThis.previewFocusTrace = {
        markClick(bounds, point) {
          clickPoint = point;
          trace("deliberate click focus requested", { bounds, point });
        },
        finish() {
          trace("finish");
          active = false;
          for (const remove of removers.reverse()) remove();
          delete globalThis.previewFocusTrace;
          return {
            events,
            dropped,
            clickPoint,
            disposed: disposedChecks.every((check) => check()),
          };
        },
      };
      bind(board.webContents);
      on(app, "web-contents-created", (_event, contents) => bind(contents));
      on(board, "focus", () => trace("window focus"));
      on(board, "blur", () => trace("window blur"));
      const wrap = (target, name, observe) => {
        const original = target[name];
        const wrapped = function (...args) {
          return observe(original, this, args);
        };
        target[name] = wrapped;
        disposedChecks.push(() => target[name] === original);
        removers.push(() => {
          if (target[name] === wrapped) target[name] = original;
        });
      };
      for (const name of ["addChildView", "removeChildView"])
        wrap(board.contentView, name, (original, receiver, args) => {
          const generation = args[0].webContents?.id;
          const result = Reflect.apply(original, receiver, args);
          trace(name, { generation });
          return result;
        });
      wrap(board.webContents, "executeJavaScript", (original, receiver, args) => {
        const blur =
          args[0] ===
          'if (document.activeElement?.closest(".xterm")) document.activeElement.blur()';
        if (blur) trace("cancellation blur requested");
        const result = Reflect.apply(original, receiver, args);
        if (blur)
          void result.then(
            () => trace("cancellation blur completed"),
            () => trace("cancellation blur rejected"),
          );
        return result;
      });
    });
    await run();
  } finally {
    // Flush and dispose before the harness quits the app, including body failures.
    // Both JUnit diagnostics and test-results/ are already uploaded on CI failure.
    const result = { name: context.name };
    try {
      result.native = await app.evaluate(() => globalThis.previewFocusTrace?.finish());
    } catch {
      result.nativeError = "Native focus trace unavailable";
    }
    try {
      result.dom = await page.evaluate(
        (point) => globalThis.previewFocusTrace?.finish(point),
        result.native?.clickPoint ?? null,
      );
    } catch {
      result.domError = "Board focus trace unavailable";
    }
    context.diagnostic(`Preview focus ordering: ${JSON.stringify(result)}`);
    await appendFile(
      evidencePath(`preview-focus-${process.pid}.jsonl`),
      `${JSON.stringify(result)}\n`,
    );
  }
}

module.exports = { withPreviewFocusTrace };
