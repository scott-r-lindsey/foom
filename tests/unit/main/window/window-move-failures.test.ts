import { afterEach, expect, test, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { WindowMoves } from "../../../../src/main/window/window-moves";
import { TerminalViews } from "../../../../src/main/window/terminal-views";
import type { WindowIpc } from "../../../../src/main/window/window-ipc";
import { PreviewTransfer } from "../../../../src/main/previews/preview-transfer";
import { PreviewRegistry } from "../../../../src/main/previews/registry";
import type { MoveContent } from "../../../../src/shared/windows";

function preview() {
  const registry = new PreviewRegistry("unused.json");
  const save = vi.spyOn(registry, "save").mockResolvedValue();
  const validateRecord = vi.fn(async () => {});
  const transfer = new PreviewTransfer({
    registry,
    disposed: () => false,
    closed: () => false,
    boardDestroyed: () => false,
    bounds: () => undefined,
    validateRecord,
    release: async () => {},
    changed: () => {},
    close: async () => {},
    updateBounds: () => {},
    landing: () => {},
    placeMoved: () => {},
  });
  return { registry, transfer, save, validateRecord };
}
function boards(
  item: MoveContent,
  owns: (window: number) => boolean,
  move: (committed: () => void) => Promise<void>,
) {
  const moves = new WindowMoves();
  function board(window: number) {
    const handlers = new Map<string, Parameters<WindowIpc["handle"]>[1]>();
    const send = vi.fn<(channel: string, ...args: unknown[]) => void>();
    moves.attach(
      window,
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
        removeHandler: (channel) => {
          handlers.delete(channel);
        },
      },
      {
        label: `Window ${String(window)}`,
        owns: () => owns(window),
        send,
        move: (_item, _target, committed) => move(committed),
      },
    );
    const invoke = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)?.({} as IpcMainInvokeEvent, ...args);
    return { send, invoke };
  }
  const source = board(1),
    target = board(2);
  const moving = source.invoke("windows:move", item, 2);
  const request = target.send.mock.calls[0]?.[1];
  target.invoke("windows:move-ready", request, true);
  return { moving, target, request };
}
afterEach(() => vi.useRealTimers());

for (const failure of ["validation", "source save", "target save"] as const)
  test(`preview ${failure} failure finishes placement only if ownership committed`, async () => {
    vi.useFakeTimers();
    const source = preview(),
      target = preview();
    const record = source.registry.add("checkout", "plan.md");
    record.network = true;
    const error = new Error("disk unavailable");
    if (failure === "validation") target.validateRecord.mockRejectedValueOnce(error);
    else (failure === "source save" ? source.save : target.save).mockRejectedValueOnce(error);
    const item: MoveContent = { kind: "preview", id: record.id };
    const result = boards(
      item,
      (window) => (window === 1 ? source : target).registry.records.has(record.id),
      (committed) => source.transfer.moveTo(record.id, target.transfer, false, committed),
    );
    await expect(result.moving).rejects.toThrow("disk unavailable");
    const committed = failure !== "validation";
    expect(source.registry.records.has(record.id)).toBe(!committed);
    expect(target.registry.records.has(record.id)).toBe(committed);
    expect(result.target.send).toHaveBeenLastCalledWith(
      "windows:finish-move",
      result.request,
      committed ? item : null,
    );
    if (committed) expect(target.registry.records.get(record.id)?.network).toBe(false);
    if (failure !== "target save") expect(target.save).not.toHaveBeenCalled();
    target.transfer.forgetIncoming(record.id);
    expect(vi.getTimerCount()).toBe(0);
  });

for (const afterCommit of [false, true])
  test(`terminal persistence failure ${afterCommit ? "after" : "before"} reservation commit preserves its owner and placement`, async () => {
    const views = new TerminalViews();
    const item: MoveContent = { kind: "terminal", id: "terminal" };
    views.claim(item.id, 1);
    const persist = vi.fn(() => Promise.reject(new Error("disk unavailable")));
    const result = boards(
      item,
      (window) => views.owner(item.id) === window,
      async (committed) => {
        // Terminal ownership itself has no disk write. Exercise a failing side
        // effect on either side of the real shared reservation transfer.
        if (!afterCommit) await persist();
        views.transfer(item.id, 1, 2, () => {});
        committed();
        await persist();
      },
    );
    await expect(result.moving).rejects.toThrow("disk unavailable");
    expect(views.owner(item.id)).toBe(afterCommit ? 2 : 1);
    expect(result.target.send).toHaveBeenLastCalledWith(
      "windows:finish-move",
      result.request,
      afterCommit ? item : null,
    );
  });
