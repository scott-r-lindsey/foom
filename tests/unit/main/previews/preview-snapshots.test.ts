import { afterEach, expect, test, vi } from "vitest";
import { PreviewSnapshots } from "../../../../src/main/previews/preview-snapshots";
import { ownerFixture } from "./preview-owner-fixture";
afterEach(() => vi.useRealTimers());

test.each(["replace", "cancel", "dispose"] as const)(
  "late pixels and cover deadlines are inert after %s",
  async (action) => {
    vi.useFakeTimers();
    const f = ownerFixture();
    const apply = vi.fn();
    const snapshots = new PreviewSnapshots(f.webContents, f.entries, () => false, apply);
    let complete = () => {};
    f.native.capturePage.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => {
            resolve({ isEmpty: () => false, toDataURL: () => "old" });
          };
        }),
    );
    const capture = snapshots.capture(f.entry);
    await snapshots.cover(true);
    snapshots.obscured(f.entry);
    if (action === "replace") f.entries.set(f.entry.id, { ...f.entry });
    if (action === "cancel") snapshots.cancel(f.entry);
    if (action === "dispose") snapshots.dispose();
    apply.mockClear();
    f.board.send.mockClear();
    complete();
    await capture;
    await vi.advanceTimersByTimeAsync(250);
    expect(f.board.send).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    snapshots.dispose();
  },
);

test("paint acknowledgement gates covers and renderer replacement invalidates old versions", async () => {
  vi.useFakeTimers();
  const f = ownerFixture();
  const snapshots = new PreviewSnapshots(f.webContents, f.entries, () => false, vi.fn());
  await snapshots.capture(f.entry);
  snapshots.painted(f.entry.id, 1);
  await snapshots.cover(true);
  expect(snapshots.obscured(f.entry)).toBe(true);
  f.board.emit("did-start-loading");
  snapshots.painted(f.entry.id, 1);
  expect(snapshots.obscured(f.entry)).toBe(false);
  snapshots.painted(f.entry.id, 2);
  expect(snapshots.obscured(f.entry)).toBe(true);
  snapshots.dispose();
  expect(f.board.listenerCount("did-start-loading")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
