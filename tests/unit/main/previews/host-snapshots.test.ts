import { expect, test, vi } from "vitest";
import { fixture } from "./host-fixture";

test("cover waits for painted pixels, blocks native input, and hides without detaching", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 1, y: 2, width: 100, height: 80, visible: true });
  let release: (() => void) | undefined;
  view.webContents.capturePage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => {
          resolve({
            isEmpty: (): boolean => false,
            toDataURL: (): string => "data:image/png;base64,AA==",
          });
        };
      }),
  );
  view.webContents.emit("did-finish-load");
  await f.host.cover(true);
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
  const event = { preventDefault: vi.fn() };
  view.webContents.emit("before-mouse-event", event, { type: "mouseDown" });
  view.webContents.emit("before-input-event", event, { key: "x" });
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  release?.();
  await Promise.resolve();
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
  f.host.painted(id, 999);
  f.host.painted("missing", 1);
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
  f.host.painted(id, 1);
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
  expect(f.window.contentView.removeChildView).not.toHaveBeenCalled();
  await f.host.cover(false);
  f.host.painted(id, 1);
  await f.host.cover(true);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
  await f.host.cover(false);
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
  expect(f.window.contentView.addChildView).toHaveBeenCalledTimes(1);
  expect(view.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
  await f.host.cover(true);
});
test("cover bounds failed or missing captures, discards closed captures and cancels deadlines", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  vi.useFakeTimers();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 80, visible: true });
  await f.host.cover(true);
  expect(view.webContents.capturePage).not.toHaveBeenCalled();
  view.webContents.capturePage.mockRejectedValueOnce(new Error("capture failed"));
  view.webContents.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(250);
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
  await f.host.cover(false);
  let release: (() => void) | undefined;
  view.webContents.capturePage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => {
          resolve({
            isEmpty: (): boolean => false,
            toDataURL: (): string => "data:image/png;base64,AA==",
          });
        };
      }),
  );
  await f.host.cover(true);
  await f.host.close(id);
  release?.();
  await Promise.resolve();
  expect(f.window.webContents.send).toHaveBeenLastCalledWith("preview:snapshots", []);
  f.window.webContents.isDestroyed.mockReturnValue(true);
  await f.host.cover(false);
});
test("snapshots refresh after load and resize or native input settles, never periodically", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  vi.useFakeTimers();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 80, visible: true });
  view.webContents.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(120);
  const count = view.webContents.capturePage.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(count);
  view.webContents.emit("input-event", {}, { type: "mouseWheel" });
  await vi.advanceTimersByTimeAsync(119);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(count + 1);
  f.host.bounds(id, { x: 0, y: 0, width: 200, height: 80, visible: true });
  await vi.advanceTimersByTimeAsync(120);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(count + 2);
  view.webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true, toDataURL: () => "" });
  f.host.refresh();
  await vi.advanceTimersByTimeAsync(120);
  await f.host.dispose(false);
});
test("a replacement board must paint its own cache and a preview opened under a cover has a deadline", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.host.cover(true);
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 80, visible: true });
  view.webContents.emit("did-finish-load");
  await Promise.resolve();
  f.host.painted(id, 1);
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
  await f.host.cover(false);
  f.window.webContents.emit("did-start-loading");
  f.host.painted(id, 1);
  view.webContents.capturePage.mockRejectedValueOnce(new Error("unavailable"));
  await f.host.cover(true);
  expect(view.setVisible).toHaveBeenLastCalledWith(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(view.setVisible).toHaveBeenLastCalledWith(false);
  await f.host.cover(false);
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 80, visible: false });
  f.host.painted(id, 2);
  await f.host.dispose(false);
});
test("resize settlement during a pending capture schedules one fresh capture afterwards", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  vi.useFakeTimers();
  let release: (() => void) | undefined;
  view.webContents.capturePage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ isEmpty: () => false, toDataURL: () => "data:image/png;base64,AA==" });
        };
      }),
  );
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 80, visible: true });
  view.webContents.emit("did-finish-load");
  f.host.bounds(id, { x: 0, y: 0, width: 200, height: 80, visible: true });
  await vi.advanceTimersByTimeAsync(120);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);
  release?.();
  await vi.advanceTimersByTimeAsync(120);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(2);
  await f.host.dispose(false);
});
