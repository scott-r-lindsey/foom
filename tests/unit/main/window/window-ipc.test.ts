import { beforeEach, expect, test, vi } from "vitest";
import type { IpcMainInvokeEvent, WebContents } from "electron";
const mock = vi.hoisted(() => ({
  handle:
    vi.fn<
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void
    >(),
  removeHandler: vi.fn(),
}));
vi.mock("electron", () => ({ ipcMain: mock }));
import { WindowIpcRouter } from "../../../../src/main/window/window-ipc";
beforeEach(() => vi.clearAllMocks());
function contents() {
  return {
    mainFrame: {
      get url() {
        return "app://bundle/index.html";
      },
    },
  } as WebContents;
}
function event(sender: WebContents): IpcMainInvokeEvent {
  return { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
}
test("routes each registered window without replacing handlers and removes the last registration", () => {
  const router = new WindowIpcRouter();
  const a = contents(),
    b = contents();
  const first = router.forWindow(a),
    second = router.forWindow(b);
  const handleA = vi.fn(() => "a"),
    handleB = vi.fn(() => "b");
  first.handle("test", handleA);
  second.handle("test", handleB);
  const dispatch = mock.handle.mock.calls[0]?.[1];
  expect(mock.handle).toHaveBeenCalledTimes(1);
  expect(dispatch?.(event(a), "payload")).toBe("a");
  expect(handleA).toHaveBeenCalledWith(event(a), "payload");
  expect(dispatch?.(event(b))).toBe("b");
  expect(() => {
    first.handle("test", handleA);
  }).toThrow("Duplicate");
  first.removeHandler("test");
  first.removeHandler("test");
  expect(mock.removeHandler).not.toHaveBeenCalled();
  expect(() => dispatch?.(event(a))).toThrow("Untrusted");
  expect(dispatch?.(event(b))).toBe("b");
  second.removeHandler("test");
  expect(mock.removeHandler).toHaveBeenCalledWith("test");
  expect(() => dispatch?.(event(b))).toThrow("Untrusted");
});
test("unknown windows, subframes, absent frames and other pages never reach a handler", () => {
  const router = new WindowIpcRouter();
  const a = contents();
  const handler = vi.fn();
  router.forWindow(a).handle("test", handler);
  const dispatch = mock.handle.mock.calls[0]?.[1];
  for (const sender of [
    event(contents()),
    { ...event(a), senderFrame: null },
    { ...event(a), senderFrame: contents().mainFrame },
  ])
    expect(() => dispatch?.(sender)).toThrow("Untrusted");
  vi.spyOn(a.mainFrame, "url", "get").mockReturnValue("https://example.com");
  expect(() => dispatch?.(event(a))).toThrow("Untrusted");
  expect(handler).not.toHaveBeenCalled();
});
