import { expect, test, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import type { PreviewHost } from "../../../../src/main/previews/host";
import { attachPreviews, parseBounds } from "../../../../src/main/previews/ipc";
const bounds = { x: 1.5, y: -2, width: 100, height: 200, visible: true };
test("bounds reject malformed, non-finite, oversized and negative dimensions", () => {
  expect(parseBounds(bounds)).toEqual(bounds);
  for (const value of [
    null,
    [],
    {},
    { ...bounds, extra: 1 },
    ...["x", "y", "width", "height"].flatMap((key) =>
      [NaN, Infinity, 20001, "1"].map((n) => ({ ...bounds, [key]: n })),
    ),
    { ...bounds, width: -1 },
    { ...bounds, height: -1 },
    { ...bounds, visible: 1 },
  ])
    expect(() => parseBounds(value)).toThrow("bounds");
});
test("board IPC accepts exact requests and routes only IDs to its window host", async () => {
  const handlers = new Map<string, Parameters<WindowIpc["handle"]>[1]>();
  const ipc: WindowIpc = {
    handle: (name, handler) => {
      handlers.set(name, handler);
    },
    removeHandler: (name) => {
      handlers.delete(name);
    },
  };
  const host = {
    open: vi.fn(() => Promise.resolve("a".repeat(32))),
    close: vi.fn(async () => {}),
    bounds: vi.fn(),
    cover: vi.fn(async () => {}),
  };
  const pick = vi.fn(() => Promise.resolve("a".repeat(32)));
  const dispose = attachPreviews(ipc, host as unknown as PreviewHost, pick);
  const invoke = (name: string, ...args: unknown[]) =>
    handlers.get(`preview:${name}`)?.({} as IpcMainInvokeEvent, ...args);
  const id = "a".repeat(32);
  await expect(invoke("pick", "/repo")).resolves.toBe(id);
  await invoke("close", id);
  invoke("bounds", id, bounds);
  expect(pick).toHaveBeenCalledWith("/repo");
  expect(host.close).toHaveBeenCalledWith(id);
  expect(host.bounds).toHaveBeenCalledWith(id, bounds);
  for (const args of [[], [1], [""], ["\0"], ["a".repeat(4097)], ["/repo", "a.html"]])
    expect(() => invoke("pick", ...args)).toThrow();
  for (const args of [[], [null], ["wrong"], [id, "extra"]])
    expect(() => invoke("close", ...args)).toThrow();
  for (const args of [[], ["wrong", bounds], [id, bounds, "extra"], [id, {}]])
    expect(() => invoke("bounds", ...args)).toThrow();
  await invoke("cover", true);
  expect(host.cover).toHaveBeenCalledWith(true);
  for (const args of [[], [null], [1], [true, false]])
    expect(() => invoke("cover", ...args)).toThrow();
  dispose();
  expect(handlers.size).toBe(0);
});
