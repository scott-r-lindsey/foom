import { expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import { WindowAudio } from "../../../../src/main/window/window-audio";

function fixture(audio: WindowAudio, id: number) {
  const handlers = new Map<string, Parameters<WindowIpc["handle"]>[1]>();
  const ipc: WindowIpc = {
    handle: (key, fn) => {
      handlers.set(key, fn);
    },
    removeHandler: (key) => {
      handlers.delete(key);
    },
  };
  const window = Object.assign(new EventEmitter(), {
    id,
    isFocused: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  });
  const dispose = audio.attach(
    window as unknown as BrowserWindow,
    ipc,
    (session) => session === `session-${String(id)}`,
  );
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(`windows:${channel}`)?.({} as IpcMainInvokeEvent, ...args);
  return { window, dispose, invoke, handlers };
}
test("one window plays app sounds while focus suppression follows either board", () => {
  const audio = new WindowAudio();
  const a = fixture(audio, 1),
    b = fixture(audio, 2);
  expect(a.invoke("audio-state")).toEqual({ enabled: true, focusedId: null });
  expect(b.invoke("audio-state")).toEqual({ enabled: false, focusedId: null });
  b.invoke("audio-focus", "session-2");
  b.window.isFocused.mockReturnValue(true);
  b.window.emit("focus");
  expect(a.window.webContents.send).toHaveBeenLastCalledWith("windows:audio", {
    enabled: true,
    focusedId: "session-2",
  });
  b.invoke("audio-focus", null);
  expect(a.invoke("audio-state")).toEqual({ enabled: true, focusedId: null });
  b.invoke("refuse");
  expect(a.window.webContents.send).toHaveBeenLastCalledWith("windows:refuse");
  a.window.webContents.isDestroyed.mockReturnValue(true);
  b.window.emit("blur");
  a.dispose();
  expect(b.invoke("audio-state")).toEqual({ enabled: true, focusedId: null });
  expect(a.handlers.size).toBe(0);
  expect(a.window.listenerCount("focus")).toBe(0);
  b.dispose();
  expect(b.window.listenerCount("blur")).toBe(0);
});
test("audio context accepts only own view IDs or null and rejects extra arguments", () => {
  const f = fixture(new WindowAudio(), 1);
  for (const id of [undefined, {}, 1, "unknown", "session-2", "x".repeat(201)])
    expect(() => f.invoke("audio-focus", id)).toThrow("Invalid audio focus");
  expect(() => f.invoke("audio-focus", null, true)).toThrow();
  expect(() => f.invoke("audio-state", true)).toThrow();
  expect(() => f.invoke("refuse", true)).toThrow();
  f.invoke("audio-focus", "session-1");
  f.window.isFocused.mockReturnValue(true);
  expect(f.invoke("audio-state")).toEqual({ enabled: true, focusedId: "session-1" });
  f.dispose();
  expect(f.handlers.size).toBe(0);
});
