import { expect, test, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import { attachViews } from "../../../../src/main/data/view-ipc";
import { viewChanges } from "../../../../src/main/data/view-changes";
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
test("view IPC checks the registered main frame, exact argument counts, lifetime and ownership", async () => {
  const frame = { url: "app://bundle/index.html" };
  const events = new Map<string, (...args: unknown[]) => void>();
  const contents = {
    mainFrame: frame,
    on: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
      events.set(name, handler);
    }),
    removeListener: vi.fn(),
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  };
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const removeHandler = vi.fn();
  const ipc: WindowIpc = {
    handle: (name, handler) => {
      handlers.set(name, handler);
    },
    removeHandler,
  };
  const read = vi.fn(() => []);
  const dispose = attachViews({ webContents: contents } as unknown as BrowserWindow, ipc, read);
  const invoke = (
    name: string,
    args: unknown[],
    sender: unknown = { sender: contents, senderFrame: frame },
  ) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error("Missing handler");
    return handler(sender as IpcMainInvokeEvent, ...args);
  };
  try {
    const request = { id: "one", view: "repositories", params: {} };
    for (const name of handlers.keys()) {
      for (const sender of [
        { sender: {}, senderFrame: frame },
        { sender: contents, senderFrame: null },
        { sender: contents, senderFrame: { url: frame.url } },
      ])
        expect(() => invoke(name, [], sender)).toThrow();
      expect(() => invoke(name, [])).toThrow();
      expect(() => invoke(name, [request, "extra", "extra", "extra"])).toThrow();
    }
    frame.url = "https://untrusted.test/";
    expect(() => invoke("data:subscribe", [request])).toThrow();
    frame.url = "app://bundle/index.html";
    invoke("data:subscribe", [request]);
    await flush();
    expect(contents.send).toHaveBeenCalledWith(
      "data:snapshot",
      expect.objectContaining({ id: "one", data: [] }),
    );
    invoke("data:ack", ["one", 1, viewChanges.revision]);
    viewChanges.publish("repositories");
    await flush();
    expect(contents.send).toHaveBeenCalledTimes(2);
    invoke("data:unsubscribe", ["one"]);
    viewChanges.publish("repositories");
    await flush();
    expect(contents.send).toHaveBeenCalledTimes(2);
    for (const [name, args] of [
      ["did-start-navigation", [null, "app://bundle/index.html", false, true]],
      ["render-process-gone", []],
      ["destroyed", []],
    ] as const) {
      invoke("data:subscribe", [request]);
      events.get("did-start-navigation")?.(null, "about:blank", true, true);
      events.get("did-start-navigation")?.(null, "about:blank", false, false);
      events.get(name)?.(...args);
      await flush();
    }
    expect(contents.send).toHaveBeenCalledTimes(2);
    contents.isDestroyed.mockReturnValue(true);
    invoke("data:subscribe", [request]);
    await flush();
    expect(contents.send).toHaveBeenCalledTimes(2);
    invoke("data:unsubscribe", ["one"]);
    contents.isDestroyed.mockReturnValue(false);
    frame.url = "https://navigated.test/";
    // Read already admitted under the trusted frame cannot push to a later document.
    frame.url = "app://bundle/index.html";
    invoke("data:subscribe", [request]);
    frame.url = "https://navigated.test/";
    await flush();
    expect(contents.send).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
  }
  expect(removeHandler).toHaveBeenCalledTimes(3);
  expect(contents.removeListener).toHaveBeenCalledTimes(3);
});
