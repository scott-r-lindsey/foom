import type { WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewPlacement } from "../../../../src/main/previews/placement";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import type { IpcMainInvokeEvent } from "electron";

afterEach(() => vi.useRealTimers());
function fixture() {
  let answer: ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined;
  const send = vi.fn<(channel: string, request: string, id: string, expiresAt: number) => void>();
  const destroyed = vi.fn(() => false);
  const removeHandler = vi.fn();
  const ipc: WindowIpc = {
    handle: (_channel, handler) => {
      answer = handler;
    },
    removeHandler,
  };
  const contents = { send, isDestroyed: destroyed } as unknown as WebContents;
  const placement = new PreviewPlacement(contents, ipc);
  return {
    placement,
    send,
    destroyed,
    ipc,
    removeHandler,
    answer: (...args: unknown[]) => {
      if (!answer) throw new Error("No handler");
      return answer({} as IpcMainInvokeEvent, ...args);
    },
  };
}
it("accepts only a matching, validated placement answer from the window router", async () => {
  const f = fixture();
  const id = "a".repeat(32);
  for (const result of ["landing", "empty", "column", "replace", "existing", "sidebar"]) {
    const pending = f.placement.place(id);
    const request = f.send.mock.lastCall?.[1];
    for (const args of [
      [],
      [request, "bad", result],
      [request, id, "invalid"],
      [3, id, result],
      [request, id, result, true],
    ])
      expect(() => f.answer(...args)).toThrow("Invalid preview placement");
    expect(() => f.answer("unknown", id, result)).toThrow("Unknown preview placement");
    expect(() => f.answer(request, "b".repeat(32), result)).toThrow("Unknown preview placement");
    f.answer(request, id, result);
    expect(await pending).toBe(result);
    expect(() => f.answer(request, id, result)).toThrow("Unknown preview placement");
  }
  f.placement.dispose();
  expect(f.removeHandler.mock.calls).toEqual([["preview:placed"]]);
});
it("defaults to sidebar on deadline, destruction or disposal and releases all pending requests", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const id = "a".repeat(32);
  const first = f.placement.place(id);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await first).toBe("sidebar");
  const second = f.placement.place(id);
  const third = f.placement.place(id);
  f.placement.dispose();
  expect(await second).toBe("sidebar");
  expect(await third).toBe("sidebar");
  f.destroyed.mockReturnValue(true);
  expect(await f.placement.place(id)).toBe("sidebar");
});
it("human moves accept a late placement after the deadline while bounding retained requests", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const id = "a".repeat(32);
  const pending = f.placement.place(id, true);
  const request = f.send.mock.lastCall?.[1];
  expect(f.send.mock.lastCall?.[3]).toBe(Number.MAX_SAFE_INTEGER);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toBe("sidebar");
  f.answer(request, id, "landing");
  expect(() => f.answer(request, id, "landing")).toThrow("Unknown preview placement");
  for (let i = 0; i < 256; i++) void f.placement.place(id, true);
  expect(await f.placement.place(id, true)).toBe("sidebar");
  f.placement.dispose();
});
