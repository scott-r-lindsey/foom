import { afterEach, expect, test, vi } from "vitest";
import { PreviewFocus } from "../../../../src/main/previews/preview-focus";
import { ownerFixture } from "./preview-owner-fixture";
afterEach(() => vi.useRealTimers());

test("a newer click invalidates an outstanding terminal blur reply", async () => {
  vi.useFakeTimers();
  const f = ownerFixture();
  const focus = new PreviewFocus(
    f.browserWindow,
    () => f.entries.values(),
    () => false,
    vi.fn(),
  );
  focus.bind(f.entry, false);
  let finish = () => {};
  f.board.executeJavaScript.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  f.native.emit("before-mouse-event", {}, { type: "mouseDown" });
  focus.beginHandoff(f.entry.view.webContents);
  const key = { preventDefault: vi.fn() };
  f.board.emit("before-input-event", key, { key: "Escape" });
  expect(key.preventDefault).toHaveBeenCalledOnce();
  f.native.emit("before-mouse-event", {}, { type: "mouseDown" });
  finish();
  await Promise.resolve();
  expect(focus.owns(f.entry.view.webContents)).toBe(true);
  expect(f.board.focus).not.toHaveBeenCalled();
  focus.dispose();
  expect(f.window.listenerCount("blur")).toBe(0);
  expect(f.native.listenerCount("before-mouse-event")).toBe(0);
  expect(f.native.listenerCount("focus")).toBe(0);
  expect(f.board.listenerCount("before-input-event")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test("covered clicks are consumed and detached unsolicited focus returns to the board", () => {
  const f = ownerFixture();
  const activity = vi.fn();
  let covered = true;
  const focus = new PreviewFocus(
    f.browserWindow,
    () => f.entries.values(),
    () => covered,
    activity,
  );
  focus.bind(f.entry, false);
  const event = { preventDefault: vi.fn() };
  f.native.emit("before-mouse-event", event, { type: "mouseDown" });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(activity).not.toHaveBeenCalled();
  covered = false;
  f.entry.attached = false;
  f.native.emit("focus");
  expect(f.board.focus).toHaveBeenCalledOnce();
  expect(f.native.focus).not.toHaveBeenCalled();
  focus.dispose();
});
