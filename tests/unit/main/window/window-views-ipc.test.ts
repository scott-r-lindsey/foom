import { expect, test, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import { attachWindowViews } from "../../../../src/main/window/window-views-ipc";
import { TerminalViews } from "../../../../src/main/window/terminal-views";

function fixture() {
  const handlers = new Map<string, Parameters<WindowIpc["handle"]>[1]>();
  const ipc: WindowIpc = {
    handle: (name, callback) => {
      handlers.set(name, callback);
    },
    removeHandler: (name) => {
      handlers.delete(name);
    },
  };
  const views = new TerminalViews();
  const target = {
    id: 2,
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const deps = {
    knows: (id: string) => ["a", "b", "c"].includes(id),
    find: vi.fn(() => target as unknown as BrowserWindow | undefined),
    detach: vi.fn(),
    publish: vi.fn(),
    popout: vi.fn(async () => {}),
  };
  const dispose = attachWindowViews({ id: 1 } as BrowserWindow, ipc, views, deps);
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(`windows:${channel}`)?.({} as IpcMainInvokeEvent, ...args);
  return { invoke, views, deps, target, dispose, handlers };
}
test("synchronizes reservations, refuses another window's view and detaches released views", () => {
  const f = fixture();
  f.views.claim("b", 2);
  expect(f.invoke("sync", ["a", "b", "c"])).toEqual(["a", "c"]);
  expect(f.invoke("views")).toEqual([
    { id: "b", window: 2 },
    { id: "a", window: 0 },
    { id: "c", window: 0 },
  ]);
  expect(f.invoke("sync", ["c"])).toEqual(["c"]);
  expect(f.deps.detach).toHaveBeenCalledExactlyOnceWith("a");
  expect(f.views.owner("a")).toBeUndefined();
  f.dispose();
  expect(f.views.snapshot()).toEqual([{ id: "b", window: 2 }]);
  expect(f.handlers.size).toBe(0);
});
test("selecting a foreign view focuses its window, with minimized and vanished-window handling", () => {
  const f = fixture();
  expect(f.invoke("select", "a")).toBe(true);
  expect(f.views.owner("a")).toBeUndefined();
  f.views.claim("a", 1);
  expect(f.invoke("select", "a")).toBe(true);
  f.views.claim("b", 2);
  expect(f.invoke("select", "b")).toBe(false);
  expect(f.target.restore).not.toHaveBeenCalled();
  f.target.isMinimized.mockReturnValue(true);
  expect(f.invoke("select", "b")).toBe(false);
  expect(f.target.restore).toHaveBeenCalledOnce();
  expect(f.target.show).toHaveBeenCalledTimes(2);
  expect(f.target.focus).toHaveBeenCalledTimes(2);
  expect(f.target.webContents.send).toHaveBeenCalledWith("app-menu:session", "b");
  f.deps.find.mockReturnValue(undefined);
  expect(f.invoke("select", "b")).toBe(true);
});
test("popout requires an owned, known session and propagates launch failure", async () => {
  const f = fixture();
  await expect(f.invoke("popout", "a")).rejects.toThrow("foreign");
  f.views.claim("a", 2);
  await expect(f.invoke("popout", "a")).rejects.toThrow("foreign");
  f.views.release("a", 2);
  f.views.claim("a", 1);
  await f.invoke("popout", "a");
  expect(f.deps.popout).toHaveBeenCalledWith("a");
  f.deps.popout.mockRejectedValueOnce(new Error("load failed"));
  await expect(f.invoke("popout", "a")).rejects.toThrow("load failed");
});
test("malformed IDs, lists, duplicate IDs, unknown sessions and extra arguments fail closed", async () => {
  const f = fixture();
  for (const value of [null, {}, "", "x".repeat(201), "unknown", 1]) {
    expect(() => f.invoke("select", value)).toThrow();
    await expect(f.invoke("popout", value)).rejects.toThrow();
  }
  for (const value of [null, {}, ["a", "a"], Array.from({ length: 257 }, () => "a"), [42]])
    expect(() => f.invoke("sync", value)).toThrow();
  for (const operation of ["views", "select", "sync"])
    expect(() => f.invoke(operation, "a", "extra")).toThrow();
  await expect(f.invoke("popout", "a", "extra")).rejects.toThrow();
  expect(f.views.snapshot()).toEqual([]);
  expect(f.deps.popout).not.toHaveBeenCalled();
});

test("a session removed during a snapshot race is released without reserving an unknown ID", () => {
  const f = fixture();
  expect(f.invoke("sync", ["a", "unknown"])).toEqual(["a"]);
  expect(f.views.owner("unknown")).toBeUndefined();
});
