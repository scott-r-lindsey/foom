import { join as requirePath } from "node:path";
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
    registry: {
      records: new Map([
        [
          "a".repeat(32),
          { id: "a".repeat(32), worktree: "/repo", relativePath: "a.html", network: false },
        ],
      ]),
    },
    open: vi.fn(() => Promise.resolve("a".repeat(32))),
    reload: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    bounds: vi.fn(),
    painted: vi.fn(),
    cover: vi.fn(async () => {}),
    network: vi.fn(async () => {}),
  };
  const humanClose = vi.fn();
  const pick = vi.fn(() => Promise.resolve("a".repeat(32)));
  const popout = vi.fn(async () => {});
  const copy = vi.fn();
  const dispose = attachPreviews(
    ipc,
    host as unknown as PreviewHost,
    pick,
    popout,
    humanClose,
    copy,
  );
  const invoke = (name: string, ...args: unknown[]) =>
    handlers.get(`preview:${name}`)?.({} as IpcMainInvokeEvent, ...args);
  const id = "a".repeat(32);
  await expect(invoke("pick", "/repo")).resolves.toBe(id);
  invoke("copy-path", id);
  expect(copy).toHaveBeenCalledExactlyOnceWith(requirePath("/repo", "a.html"));
  for (const args of [[], ["unknown"], ["b".repeat(32)], [id, "arbitrary"]])
    expect(() => invoke("copy-path", ...args)).toThrow();
  expect(copy).toHaveBeenCalledTimes(1);
  const moving = invoke("popout", id);
  expect(() => invoke("popout", id)).toThrow("in progress");
  await moving;
  expect(popout).toHaveBeenCalledWith(id);
  await invoke("reload", id);
  expect(host.reload).toHaveBeenCalledWith(id);
  expect(() => invoke("reload", "b".repeat(32))).toThrow("Unknown preview ID");
  await invoke("close", id);
  invoke("bounds", id, bounds);
  await invoke("network", id, true);
  expect(host.network).toHaveBeenCalledWith(id, true);
  for (const args of [[], [id], [id, 1], ["wrong", true], [id, false, "extra"]])
    expect(() => invoke("network", ...args)).toThrow();
  expect(pick).toHaveBeenCalledWith("/repo");
  expect(host.close).toHaveBeenCalledWith(id);
  expect(humanClose).toHaveBeenCalledExactlyOnceWith(id);
  expect(() => invoke("close", "b".repeat(32))).toThrow("Unknown preview ID");
  expect(humanClose).toHaveBeenCalledTimes(1);
  expect(() => invoke("popout", "b".repeat(32))).toThrow("Unknown preview ID");
  expect(host.bounds).toHaveBeenCalledWith(id, bounds);
  for (const args of [[], [1], [""], ["\0"], ["a".repeat(4097)], ["/repo", "a.html"]])
    expect(() => invoke("pick", ...args)).toThrow();
  for (const args of [[], [null], ["wrong"], [id, "extra"]])
    for (const name of ["close", "popout", "reload"]) expect(() => invoke(name, ...args)).toThrow();
  for (const args of [[], ["wrong", bounds], [id, bounds, "extra"], [id, {}]])
    expect(() => invoke("bounds", ...args)).toThrow();
  invoke("painted", id, 1);
  expect(host.painted).toHaveBeenCalledWith(id, 1);
  for (const args of [[], [id], [id, 0], [id, NaN], [id, 1.5], [id, "1"], ["wrong", 1], [id, 1, 2]])
    expect(() => invoke("painted", ...args)).toThrow();
  await invoke("cover", true);
  expect(host.cover).toHaveBeenCalledWith(true);
  for (const args of [[], [null], [1], [true, false]])
    expect(() => invoke("cover", ...args)).toThrow();
  dispose();
  expect(handlers.size).toBe(0);
  const disposeWithoutObserver = attachPreviews(ipc, host as unknown as PreviewHost, pick, popout);
  await invoke("close", id);
  disposeWithoutObserver();
});
