import { afterEach, expect, test, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import { WindowMoves } from "../../../../src/main/window/window-moves";
import type { MoveContent } from "../../../../src/shared/windows";

const item: MoveContent = { kind: "terminal", id: "terminal" };
function fixture() {
  vi.useFakeTimers();
  const moves = new WindowMoves();
  function board(id: number) {
    const handlers = new Map<string, Parameters<WindowIpc["handle"]>[1]>();
    const ipc: WindowIpc = {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
      removeHandler: (name) => {
        handlers.delete(name);
      },
    };
    const port = {
      label: `Window ${String(id)}`,
      owns: vi.fn(() => true),
      send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
      move: vi.fn(async () => {}),
    };
    const dispose = moves.attach(id, ipc, port);
    const invoke = (channel: string, ...args: unknown[]) =>
      handlers.get(`windows:${channel}`)?.({} as IpcMainInvokeEvent, ...args);
    const ready = (accepted = true) => {
      const request = port.send.mock.calls.findLast(
        ([channel]) => channel === "windows:prepare-move",
      )?.[1];
      invoke("move-ready", request, accepted);
      return request;
    };
    return { port, invoke, ready, dispose, handlers };
  }
  const a = board(1),
    b = board(2),
    c = board(3);
  return { a, b, c };
}
afterEach(() => {
  vi.useRealTimers();
});

test("opaque tokens broadcast only to other boards, consume once and preserve the validated drop placement", async () => {
  const { a, b, c } = fixture();
  expect(a.invoke("list")).toEqual([
    { id: 2, label: "Window 2" },
    { id: 3, label: "Window 3" },
  ]);
  const token = a.invoke("begin-drag", item);
  expect(typeof token).toBe("string");
  expect(a.port.send).toHaveBeenLastCalledWith("windows:drag", null);
  expect(b.port.send).toHaveBeenLastCalledWith("windows:drag", token);
  const at = { tile: "tile", zone: "left" };
  const dropping = b.invoke("drop", token, at);
  const request = b.ready();
  await dropping;
  expect(a.port.move).toHaveBeenCalledExactlyOnceWith(item, 2);
  expect(b.port.send).toHaveBeenLastCalledWith("windows:finish-move", request, item);
  expect(c.port.send).toHaveBeenLastCalledWith("windows:drag", null);
  await expect(b.invoke("drop", token, at)).rejects.toThrow("token");
});

test("menu moves use the same transaction with default placement, including previews", async () => {
  const { a, b } = fixture();
  const preview: MoveContent = { kind: "preview", id: "preview" };
  const moving = a.invoke("move", preview, 2);
  const request = b.ready();
  await moving;
  expect(b.port.send).toHaveBeenCalledWith("windows:prepare-move", request, null);
  expect(a.port.move).toHaveBeenCalledWith(preview, 2);
});

test("replaced, cancelled, expired, forged and same-window drags never transfer", async () => {
  const { a, b } = fixture();
  const old = a.invoke("begin-drag", item);
  const token = a.invoke("begin-drag", item);
  await expect(b.invoke("drop", old, null)).rejects.toThrow();
  await expect(a.invoke("drop", token, null)).rejects.toThrow();
  b.invoke("end-drag", token);
  a.invoke("end-drag", "wrong");
  expect(b.port.send).toHaveBeenLastCalledWith("windows:drag", token);
  a.invoke("end-drag", token);
  await expect(b.invoke("drop", token, null)).rejects.toThrow();
  const expired = a.invoke("begin-drag", item);
  vi.setSystemTime(Date.now() + 15000);
  await expect(b.invoke("drop", expired, null)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(15000);
  expect(b.port.send).toHaveBeenLastCalledWith("windows:drag", null);
  await expect(b.invoke("drop", "forged", null)).rejects.toThrow();
  expect(a.port.move).not.toHaveBeenCalled();
});

test("refused or stalled placement consumes the token and leaves ownership intact", async () => {
  const { a, b } = fixture();
  const token = a.invoke("begin-drag", item);
  const dropping = b.invoke("drop", token, { tile: "full", zone: "right" });
  const refusal = expect(dropping).rejects.toThrow();
  const request = b.ready(false);
  await refusal;
  expect(b.port.send).toHaveBeenLastCalledWith("windows:finish-move", request, null);
  await expect(b.invoke("drop", token, null)).rejects.toThrow();
  const stalled = a.invoke("move", item, 2);
  const timeout = expect(stalled).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(5000);
  await timeout;
  expect(a.port.move).not.toHaveBeenCalled();
  expect(() => b.ready()).toThrow("Unknown");
});

test("ownership is checked at gesture start, at drop and after the destination round trip", async () => {
  const { a, b } = fixture();
  a.port.owns.mockReturnValue(false);
  expect(() => a.invoke("begin-drag", item)).toThrow();
  await expect(a.invoke("move", item, 2)).rejects.toThrow();
  a.port.owns.mockReturnValue(true);
  const token = a.invoke("begin-drag", item);
  a.port.owns.mockReturnValue(false);
  await expect(b.invoke("drop", token, null)).rejects.toThrow();
  a.port.owns.mockReturnValue(true);
  const moving = a.invoke("move", item, 2);
  a.port.owns.mockReturnValue(false);
  b.ready();
  await expect(moving).rejects.toThrow();
  expect(a.port.move).not.toHaveBeenCalled();
});

test("closed source/target and concurrent moves fail without committing placement", async () => {
  for (const closing of ["source", "target"] as const) {
    const { a, b, c } = fixture();
    const token = a.invoke("begin-drag", item);
    const moving = b.invoke("drop", token, null);
    await expect(a.invoke("move", item, 3)).rejects.toThrow();
    await expect(c.invoke("move", item, 2)).rejects.toThrow();
    expect(() => a.invoke("begin-drag", item)).toThrow();
    if (closing === "source") {
      a.dispose();
      b.ready();
    } else b.dispose();
    await expect(moving).rejects.toThrow();
    expect(a.port.move).not.toHaveBeenCalled();
    expect((closing === "source" ? a : b).handlers.size).toBe(0);
    await expect(c.invoke("move", item, closing === "source" ? 1 : 2)).rejects.toThrow();
  }
});

test("closing the drag source revokes its token; transfer errors abort placement and free both boards", async () => {
  const { a, b } = fixture();
  a.invoke("begin-drag", item);
  a.dispose();
  expect(b.port.send).toHaveBeenLastCalledWith("windows:drag", null);
  const f = fixture();
  f.a.port.move.mockRejectedValueOnce(new Error("transfer failed"));
  const moving = f.a.invoke("move", item, 2);
  f.b.ready();
  await expect(moving).rejects.toThrow("transfer failed");
  const retry = f.a.invoke("move", item, 2);
  f.b.ready();
  await retry;
});

test("all channels reject malformed payloads, excess fields and wrong-window placement replies", async () => {
  const { a, b, c } = fixture();
  expect(() => a.invoke("list", 1)).toThrow();
  for (const value of [
    null,
    [],
    {},
    "id",
    { kind: "bad", id: "a" },
    { kind: "terminal", id: "" },
    { ...item, extra: true },
    { ...item, id: "x".repeat(201) },
  ]) {
    expect(() => a.invoke("begin-drag", value)).toThrow();
    await expect(a.invoke("move", value, 2)).rejects.toThrow();
  }
  expect(() => a.invoke("begin-drag", item, 1)).toThrow();
  for (const args of [[], [null], ["", 1], ["x", "extra"]])
    expect(() => a.invoke("end-drag", ...args)).toThrow();
  for (const at of [
    undefined,
    [],
    {},
    { tile: "x", zone: "bad" },
    { tile: "", zone: "left" },
    { tile: "x", zone: "left", extra: 1 },
  ])
    await expect(b.invoke("drop", "token", at)).rejects.toThrow();
  await expect(b.invoke("drop", null, null)).rejects.toThrow();
  await expect(b.invoke("drop", "token", null, 1)).rejects.toThrow();
  for (const target of [null, "2", NaN, 2.5, 1, 999])
    await expect(a.invoke("move", item, target)).rejects.toThrow();
  await expect(a.invoke("move", item, 2, 3)).rejects.toThrow();
  for (const args of [[], [1, true], ["id", 1], ["id", true, 1]])
    expect(() => b.invoke("move-ready", ...args)).toThrow();
  const moving = a.invoke("move", item, 2);
  const request = b.port.send.mock.calls.findLast(
    ([channel]) => channel === "windows:prepare-move",
  )?.[1];
  expect(() => c.invoke("move-ready", request, true)).toThrow();
  b.ready(false);
  await expect(moving).rejects.toThrow();
});

test("existing pop-outs exclude token/menu moves until completion and release on errors", async () => {
  const moves = new WindowMoves();
  const handlers = new Map<string, Parameters<WindowIpc["handle"]>[1]>();
  const dispose = moves.attach(
    1,
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
      removeHandler: (name) => {
        handlers.delete(name);
      },
    },
    {
      label: "Window 1",
      owns: () => true,
      send: () => {},
      move: async () => {},
    },
  );
  let release: (() => void) | undefined;
  const popping = moves.popout(
    1,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await expect(moves.popout(1, async () => {})).rejects.toThrow();
  expect(() => handlers.get("windows:begin-drag")?.({} as IpcMainInvokeEvent, item)).toThrow();
  release?.();
  await popping;
  await expect(moves.popout(1, () => Promise.reject(new Error("failed")))).rejects.toThrow(
    "failed",
  );
  await moves.popout(1, async () => {});
  dispose();
  await expect(moves.popout(1, async () => {})).rejects.toThrow();
});
