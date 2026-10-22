import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fake, partition, fixture } from "./host-fixture";
import { PreviewRegistry } from "../../../../src/main/previews/registry";

test("restores only validated worktrees lazily, closes removed worktrees and preserves registry on quit", async () => {
  const f = await fixture();
  const a = f.registry.add(f.root, "a.html");
  const b = f.registry.add("/gone", "b.md");
  await f.registry.save();
  f.registry.records.clear();
  f.validate.mockImplementation((root) => {
    if (root === "/gone") return Promise.reject(new Error("removed"));
    return Promise.resolve();
  });
  await f.host.restore();
  expect(f.registry.records.has(a.id)).toBe(true);
  expect(f.registry.records.has(b.id)).toBe(false);
  expect(fake.views).toHaveLength(0);
  fake.packaged = true;
  f.host.bounds(a.id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  expect(fake.views[0]?.options).toMatchObject({ webPreferences: { devTools: false } });
  f.changed.mockClear();
  await f.host.dispose(true);
  await f.host.dispose(true);
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.registry.records.has(a.id)).toBe(true);
  expect(() => {
    f.host.bounds(a.id, { x: 0, y: 0, width: 1, height: 1, visible: true });
  }).toThrow();
  await expect(f.host.open(f.root, "a.html")).rejects.toThrow("closed");
  const fresh = await fixture();
  await fresh.open();
  fresh.registry.add("/gone", "b.md");
  fresh.validate.mockRejectedValue(new Error("removed"));
  await fresh.host.reconcile();
  expect(fresh.registry.records.size).toBe(0);
  await fresh.host.dispose(false);
});
test("invalid files, revoked inventory, failed saves and shutdown during open leave no view", async () => {
  const f = await fixture();
  await expect(f.host.open(f.root, "../a.html")).rejects.toThrow("path");
  await expect(f.host.open(f.root, "missing.html")).rejects.toThrow("unavailable");
  f.validate.mockRejectedValueOnce(new Error("unregistered"));
  await expect(f.host.open(f.root, "a.html")).rejects.toThrow("unregistered");
  const save = vi.spyOn(f.registry, "save").mockRejectedValueOnce(new Error("disk"));
  await expect(f.host.open(f.root, "a.html")).rejects.toThrow("disk");
  expect(f.registry.records.size).toBe(0);
  save.mockImplementationOnce(async () => {
    await f.host.dispose(false);
  });
  await expect(f.host.open(f.root, "a.html")).rejects.toThrow("closed");
  expect(fake.views).toHaveLength(0);
});

test("agent registry entries create no native view until shown and drop sidebar-only entries at quit", async () => {
  const f = await fixture();
  const first = "a".repeat(32);
  const second = "b".repeat(32);
  await f.host.open(f.root, "a.html", {
    id: first,
    openedBy: { terminalId: "terminal", agent: "claude" },
  });
  await f.host.open(f.root, "a.html", { id: second });
  expect(fake.views).toHaveLength(0);
  expect(f.host.visible(first)).toBe(false);
  f.host.placed("missing", true);
  f.host.placed(first, false);
  expect(f.host.visible(first)).toBe(false);
  f.host.placed(first, true);
  expect(f.host.visible(first)).toBe(true);
  expect(f.registry.records.get(first)?.agentOpened).toBe(true);
  expect(f.registry.records.get(first)?.openedBy).toEqual({
    terminalId: "terminal",
    agent: "claude",
  });
  f.host.bounds(first, { x: 0, y: 0, width: 100, height: 100, visible: false });
  expect(fake.views).toHaveLength(0);
  f.host.bounds(first, { x: 0, y: 0, width: 100, height: 100, visible: true });
  expect(fake.views).toHaveLength(1);
  expect(f.host.visible(first)).toBe(true);
  await f.host.dispose(true);
  expect([...f.registry.records.keys()]).toEqual([first]);
  expect(f.registry.records.get(first)?.agentOpened).toBeUndefined();
  expect(f.registry.records.get(first)?.openedBy).toBeUndefined();
  const restored = new PreviewRegistry(join(f.root, "registry.json"));
  await restored.load();
  expect([...restored.records.keys()]).toEqual([first]);
});

test("worktree removal closes its previews and watches while retaining other checkouts", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const handler = partition.protocol.handle.mock.calls[0]?.[1];
  handler?.({ url: `foom-preview://${id}/a.html` });
  expect(f.host.watcherCount).toBe(1);
  const other = f.registry.add("/another/checkout", "a.html");
  await f.host.closeWorktree("/unknown");
  expect(view.webContents.close).not.toHaveBeenCalled();
  await f.host.closeWorktree(f.root);
  expect(f.host.watcherCount).toBe(0);
  expect(view.webContents.close).toHaveBeenCalledOnce();
  expect(f.registry.records.has(id)).toBe(false);
  expect(f.registry.records.has(other.id)).toBe(true);
  await f.host.dispose(false);
});

test("open revalidates after saving so removal cannot race a new watch", async () => {
  const f = await fixture();
  f.validate.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("being removed"));
  await expect(f.open()).rejects.toThrow("being removed");
  expect(f.host.watcherCount).toBe(0);
  expect(f.registry.records.size).toBe(0);
  expect(fake.views).toHaveLength(0);
});

test("moving destroys the source before creating fresh target contents, retaining ID and attribution", async () => {
  const source = await fixture(() => Promise.resolve(true));
  const target = await fixture();
  const { id, view } = await source.open();
  const record = source.registry.records.get(id);
  if (!record) throw new Error("Missing record");
  record.agentOpened = true;
  record.openedBy = { terminalId: "agent-session", agent: "claude" };
  await source.host.network(id, true);
  let finish: () => void = () => {
    throw new Error("Cleanup did not start");
  };
  partition.clearStorageData.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const moving = source.host.moveTo(id, target.host);
  await vi.waitFor(() => {
    expect(view.webContents.close).toHaveBeenCalled();
  });
  expect(source.registry.records.has(id)).toBe(true);
  expect(target.registry.records.has(id)).toBe(false);
  const count = fake.views.length;
  source.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  expect(fake.views.length).toBe(count);
  await expect(source.host.moveTo(id, target.host)).rejects.toThrow("Unable to move");
  finish();
  await moving;
  expect(source.registry.records.has(id)).toBe(false);
  expect(target.registry.records.get(id)).toEqual({ ...record, network: false });
  expect(source.host.watcherCount).toBe(0);
  expect(fake.views.length).toBe(count);
  target.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  expect(fake.views.at(-1)).not.toBe(view);
  expect(fake.views.at(-1)?.webContents.loadURL).toHaveBeenCalledWith(
    `foom-preview://${id}/a.html`,
  );
  expect(target.window.webContents.focus).not.toHaveBeenCalled();
  expect(source.changed).toHaveBeenCalled();
  expect(target.changed).toHaveBeenCalled();
  await source.host.dispose(false);
  await target.host.dispose(false);
});

test("close during a move follows the ID to its new host", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id } = await source.open();
  const moving = source.host.moveTo(id, target.host);
  const closing = source.host.close(id);
  await moving;
  await closing;
  expect(source.registry.records.has(id)).toBe(false);
  expect(target.registry.records.has(id)).toBe(false);
  await source.host.dispose(false);
  await target.host.dispose(false);
});

test("invalid moves retain the original preview and disposal during cleanup cannot resurrect it", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id } = await source.open();
  await expect(source.host.moveTo("unknown", target.host)).rejects.toThrow();
  await expect(source.host.moveTo(id, source.host)).rejects.toThrow();
  target.registry.records.set(id, {
    id,
    worktree: source.root,
    relativePath: "a.html",
    network: false,
  });
  await expect(source.host.moveTo(id, target.host)).rejects.toThrow();
  target.registry.records.clear();
  for (let i = 0; i < 256; i++) target.registry.add(target.root, "a.html");
  await expect(source.host.moveTo(id, target.host)).rejects.toThrow();
  target.registry.records.clear();
  const moving = source.host.moveTo(id, target.host);
  const disposed = source.host.dispose(false);
  await expect(moving).rejects.toThrow();
  await disposed;
  expect(target.registry.records.has(id)).toBe(false);
  await target.host.dispose(false);
  await expect(source.host.moveTo(id, target.host)).rejects.toThrow();
});

test("a target closed during native cleanup leaves a fresh preview in the original window", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id, view } = await source.open();
  const bounds = { x: 10, y: 20, width: 100, height: 100, visible: true };
  source.host.bounds(id, bounds);
  const moving = source.host.moveTo(id, target.host);
  await target.host.dispose(false);
  await expect(moving).rejects.toThrow("Unable to move");
  expect(source.registry.records.has(id)).toBe(true);
  expect(target.registry.records.has(id)).toBe(false);
  expect(fake.views.at(-1)).not.toBe(view);
  fake.views.at(-1)?.webContents.emit("did-finish-load");
  expect(fake.views.at(-1)?.setBounds).toHaveBeenCalledWith({
    x: 10,
    y: 20,
    width: 100,
    height: 100,
  });
  await source.host.dispose(false);
});

test("moves revalidate checkout identity and never restore a view for a removed checkout", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id, view } = await source.open();
  source.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  target.validate.mockRejectedValueOnce(new Error("Checkout replaced"));
  await expect(source.host.moveTo(id, target.host)).rejects.toThrow("Checkout replaced");
  expect(view.webContents.close).not.toHaveBeenCalled();
  expect(source.registry.records.has(id)).toBe(true);
  target.validate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Removed"));
  source.validate.mockRejectedValueOnce(new Error("Removed"));
  const count = fake.views.length;
  await expect(source.host.moveTo(id, target.host)).rejects.toThrow("Removed");
  expect(view.webContents.close).toHaveBeenCalled();
  expect(fake.views.length).toBe(count);
  expect(target.registry.records.has(id)).toBe(false);
  await source.host.dispose(false);
  await target.host.dispose(false);
});

test("a late preview load cannot touch a destroyed owning board while its native contents still exists", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  f.window.getContentBounds.mockClear();
  f.window.webContents.isDestroyed.mockReturnValue(true);
  view.webContents.emit("did-finish-load");
  expect(view.webContents.isDestroyed()).toBe(false);
  expect(f.window.getContentBounds).not.toHaveBeenCalled();
  expect(f.window.contentView.addChildView).not.toHaveBeenCalled();
  expect(view.webContents.capturePage).not.toHaveBeenCalled();
  await f.host.dispose(false);
});

test("late source load events cannot reattach a preview after it moves even before native destruction finishes", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id, view } = await source.open();
  source.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.close.mockImplementation(() => {});
  await source.host.moveTo(id, target.host);
  source.window.getContentBounds.mockClear();
  view.webContents.emit("did-finish-load");
  expect(view.webContents.isDestroyed()).toBe(false);
  expect(source.window.getContentBounds).not.toHaveBeenCalled();
  expect(source.window.contentView.addChildView).not.toHaveBeenCalled();
  expect(view.webContents.capturePage).not.toHaveBeenCalled();
  expect(source.registry.records.has(id)).toBe(false);
  expect(target.registry.records.has(id)).toBe(true);
  view.webContents.isDestroyed.mockReturnValue(true);
  await source.host.dispose(false);
  await target.host.dispose(false);
});

test("an unplaced move gets a landing view after five seconds and a late board can supply geometry", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id } = await source.open();
  vi.useFakeTimers();
  await source.host.moveTo(id, target.host);
  const count = fake.views.length;
  await vi.advanceTimersByTimeAsync(4999);
  expect(fake.views).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.views).toHaveLength(count + 1);
  const view = fake.views.at(-1);
  view?.webContents.emit("did-finish-load");
  expect(target.window.contentView.addChildView).toHaveBeenCalledWith(view);
  expect(view?.setBounds).toHaveBeenLastCalledWith({ x: 300, y: 40, width: 500, height: 560 });
  target.host.bounds(id, { x: 310, y: 50, width: 400, height: 300, visible: true });
  expect(view?.setBounds).toHaveBeenLastCalledWith({ x: 310, y: 50, width: 400, height: 300 });
  await target.host.dispose(false);
  expect(source.registry.records.has(id)).toBe(false);
  await source.host.dispose(false);
});

test("closing an unshown destination returns the same ID and fresh contents to its live source", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id, view } = await source.open();
  source.host.bounds(id, { x: 10, y: 20, width: 200, height: 100, visible: true });
  await source.host.moveTo(id, target.host);
  target.window.webContents.isDestroyed.mockReturnValue(true);
  await target.host.dispose(false);
  expect(target.registry.records.has(id)).toBe(false);
  expect(source.registry.records.has(id)).toBe(true);
  expect(source.validate).toHaveBeenCalledWith(source.root);
  expect(source.placeMoved).toHaveBeenCalledWith(id);
  const restored = fake.views.at(-1);
  expect(restored).not.toBe(view);
  restored?.webContents.emit("did-finish-load");
  expect(source.window.contentView.addChildView).toHaveBeenCalledWith(restored);
  await source.host.dispose(false);
});

test("recovery revalidates a removed source and never resurrects its contents", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id } = await source.open();
  await source.host.moveTo(id, target.host);
  const count = fake.views.length;
  source.validate.mockRejectedValue(new Error("Removed checkout"));
  await target.host.dispose(false);
  expect(fake.views).toHaveLength(count);
  expect(source.registry.records.has(id)).toBe(false);
  expect(target.registry.records.has(id)).toBe(false);
  await source.host.dispose(false);
});

test("quit persists an unshown human move of an agent preview", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id } = await source.open();
  const record = source.registry.records.get(id);
  if (!record) throw new Error("Missing preview");
  record.agentOpened = true;
  await source.host.moveTo(id, target.host);
  await target.host.dispose(true);
  expect(target.registry.records.has(id)).toBe(true);
  expect(source.registry.records.has(id)).toBe(false);
  await source.host.dispose(false);
});

test("an unshown move whose source closed can recover into a replacement board", async () => {
  const source = await fixture();
  const target = await fixture();
  const recovery = await fixture();
  const { id } = await source.open();
  source.window.getContentBounds.mockReturnValue({ width: 1100, height: 800 });
  source.host.bounds(id, { x: 1000, y: 700, width: 100, height: 100, visible: true });
  await source.host.moveTo(id, target.host);
  await source.host.dispose(false);
  await target.host.dispose(false, () => Promise.resolve(recovery.host));
  expect(recovery.registry.records.has(id)).toBe(true);
  expect(target.registry.records.has(id)).toBe(false);
  fake.views.at(-1)?.webContents.emit("did-finish-load");
  expect(recovery.window.contentView.addChildView).toHaveBeenCalledWith(fake.views.at(-1));
  expect(recovery.placeMoved).toHaveBeenCalledWith(id);
  expect(fake.views.at(-1)?.setBounds).toHaveBeenLastCalledWith({
    x: 300,
    y: 40,
    width: 500,
    height: 560,
  });
  await recovery.host.dispose(false);
});

test("a slow unshown page keeps board geometry at the deadline and returns on close", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id } = await source.open();
  vi.useFakeTimers();
  await source.host.moveTo(id, target.host);
  target.host.bounds(id, { x: 20, y: 30, width: 100, height: 100, visible: true });
  const view = fake.views.at(-1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(view?.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 30, width: 100, height: 100 });
  expect(target.window.contentView.addChildView).not.toHaveBeenCalled();
  target.window.isDestroyed.mockReturnValue(true);
  Object.defineProperty(target.window, "webContents", {
    get() {
      throw new Error("Destroyed window");
    },
  });
  await target.host.dispose(false);
  expect(source.registry.records.has(id)).toBe(true);
  expect(view?.webContents.close).toHaveBeenCalled();
  await source.host.dispose(false);
});

test("closing an unshown destination waits for the ownership write before returning it", async () => {
  const source = await fixture();
  const target = await fixture();
  const { id } = await source.open();
  let saved: () => void = () => {
    throw new Error("Save did not start");
  };
  vi.spyOn(target.registry, "save").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
  );
  const moving = source.host.moveTo(id, target.host);
  await vi.waitFor(() => {
    expect(target.registry.records.has(id)).toBe(true);
  });
  const closing = target.host.dispose(false);
  expect(source.registry.records.has(id)).toBe(false);
  saved();
  await moving;
  await closing;
  expect(source.registry.records.has(id)).toBe(true);
  expect(target.registry.records.has(id)).toBe(false);
  await source.host.dispose(false);
});
