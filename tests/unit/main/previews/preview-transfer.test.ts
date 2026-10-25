import { afterEach, expect, test, vi } from "vitest";
import { PreviewTransfer } from "../../../../src/main/previews/preview-transfer";
import { PreviewRegistry } from "../../../../src/main/previews/registry";
import type { PreviewBounds } from "../../../../src/shared/previews";
afterEach(() => vi.useRealTimers());

function owner() {
  const registry = new PreviewRegistry("unused.json");
  const save = vi.spyOn(registry, "save").mockResolvedValue();
  const port = {
    registry,
    disposed: vi.fn(() => false),
    closed: vi.fn(() => false),
    boardDestroyed: vi.fn(() => false),
    bounds: vi.fn<() => PreviewBounds | undefined>(),
    validateRecord: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    changed: vi.fn(),
    close: vi.fn(async () => {}),
    updateBounds: vi.fn(),
    landing: vi.fn(),
    placeMoved: vi.fn(),
  };
  return { port, transfer: new PreviewTransfer(port), save };
}

test("native cleanup retains discovery and callbacks see exactly one owner after transfer", async () => {
  vi.useFakeTimers();
  const source = owner();
  const target = owner();
  const record = source.port.registry.add("checkout", "a.html");
  record.network = true;
  let release = () => {};
  source.port.release.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const assertOwner = () => {
    expect(source.port.registry.records.has(record.id)).toBe(false);
    expect(target.port.registry.records.get(record.id)?.network).toBe(false);
  };
  source.port.changed.mockImplementation(assertOwner);
  target.port.changed.mockImplementation(assertOwner);
  const move = source.transfer.moveTo(record.id, target.transfer);
  await Promise.resolve();
  expect(source.port.registry.records.get(record.id)).toBe(record);
  expect(target.port.registry.records.has(record.id)).toBe(false);
  const close = source.transfer.followClose(record.id);
  release();
  await move;
  await close;
  expect(target.port.close).toHaveBeenCalledWith(record.id);
  expect(target.transfer.isIncoming(record.id)).toBe(true);
  target.transfer.forgetIncoming(record.id);
  expect(vi.getTimerCount()).toBe(0);
});

test("validation failure after release restores source bounds without transferring ownership", async () => {
  const source = owner();
  const target = owner();
  const record = source.port.registry.add("checkout", "a.html");
  const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
  source.port.bounds.mockReturnValueOnce(bounds);
  target.port.validateRecord.mockResolvedValueOnce().mockRejectedValueOnce(new Error("gone"));
  await expect(source.transfer.moveTo(record.id, target.transfer)).rejects.toThrow("gone");
  expect(source.port.registry.records.get(record.id)).toBe(record);
  expect(source.port.updateBounds).toHaveBeenCalledWith(record, bounds);
  expect(target.port.registry.records.size).toBe(0);
  expect(source.transfer.isMoving(record.id)).toBe(false);
});

test("closing an unattached destination returns its record and placement to the source", async () => {
  vi.useFakeTimers();
  const source = owner();
  const target = owner();
  const record = source.port.registry.add("checkout", "a.html");
  await source.transfer.moveTo(record.id, target.transfer);
  await target.transfer.recover();
  expect(source.port.registry.records.has(record.id)).toBe(true);
  expect(target.port.registry.records.size).toBe(0);
  expect(source.port.landing).toHaveBeenCalledWith(record.id);
  expect(source.port.placeMoved).toHaveBeenCalledWith(record.id);
  expect(vi.getTimerCount()).toBe(0);
});

test("a failed persistence transaction can still return its incoming record during destination shutdown", async () => {
  vi.useFakeTimers();
  const source = owner();
  const target = owner();
  const record = source.port.registry.add("checkout", "a.html");
  source.save.mockRejectedValueOnce(new Error("disk unavailable"));
  let recovery: Promise<void> | undefined;
  target.port.changed.mockImplementationOnce(() => {
    target.port.closed.mockReturnValue(true);
    recovery = target.transfer.recover();
  });
  await expect(source.transfer.moveTo(record.id, target.transfer)).rejects.toThrow(
    "disk unavailable",
  );
  await recovery;
  expect(source.port.registry.records.has(record.id)).toBe(true);
  expect(target.port.registry.records.size).toBe(0);
  expect(source.port.placeMoved).toHaveBeenCalledWith(record.id);
  expect(vi.getTimerCount()).toBe(0);
});

test("a checkout removed before the landing deadline cannot regain a native view", async () => {
  vi.useFakeTimers();
  const source = owner();
  const target = owner();
  const record = source.port.registry.add("checkout", "a.html");
  await source.transfer.moveTo(record.id, target.transfer);
  target.port.validateRecord.mockRejectedValueOnce(new Error("removed checkout"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(target.port.validateRecord).toHaveBeenCalledTimes(3);
  expect(target.port.landing).not.toHaveBeenCalled();
  expect(target.port.registry.records.has(record.id)).toBe(true);
  target.transfer.forgetIncoming(record.id);
  expect(vi.getTimerCount()).toBe(0);
});
