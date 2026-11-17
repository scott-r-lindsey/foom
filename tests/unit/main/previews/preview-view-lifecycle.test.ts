import { expect, test, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import type { HostedPreview } from "../../../../src/main/previews/hosted-preview";
import { fixture } from "./host-fixture";
import { PreviewViewLifecycle } from "../../../../src/main/previews/preview-view-lifecycle";
import { PreviewFocus } from "../../../../src/main/previews/preview-focus";
import { PreviewSnapshots } from "../../../../src/main/previews/preview-snapshots";
import { canonicalRoot } from "../../../../src/main/previews/contained-files";

// Native creation is mocked; the owner is exercised directly without host composition.
async function owner() {
  const f = await fixture();
  const entries = new Map<string, HostedPreview>();
  const board = f.window.webContents as unknown as WebContents;
  const apply = vi.fn();
  const snapshots = new PreviewSnapshots(board, entries, () => false, apply);
  const focus = new PreviewFocus(
    f.window as unknown as BrowserWindow,
    () => entries.values(),
    () => false,
    vi.fn(),
  );
  const lifecycle = new PreviewViewLifecycle(
    board,
    entries,
    (entry) => entries.set(entry.id, entry),
    (entry) => entries.delete(entry.id),
    () => false,
    vi.fn(),
    apply,
    vi.fn(async () => {}),
    focus,
    snapshots,
  );
  return { f, entries, apply, snapshots, focus, lifecycle };
}

test("late scroll restoration cannot load a released generation and cancellation releases listeners", async () => {
  const { f, entries, apply, snapshots, focus, lifecycle } = await owner();
  const record = f.registry.add(f.root, "a.html");
  const entry = lifecycle.create(record, canonicalRoot(f.root));
  const contents = entry.view.webContents;
  let restore = () => {};
  const execute = vi.spyOn(contents, "executeJavaScriptInIsolatedWorld");
  execute.mockResolvedValueOnce([0, 40]);
  await lifecycle.reload(record.id);
  const replacement = entries.get(record.id);
  if (!replacement) throw new Error("Missing replacement");
  vi.spyOn(replacement.view.webContents, "executeJavaScriptInIsolatedWorld").mockImplementation(
    () =>
      new Promise((resolve) => {
        restore = () => {
          resolve(undefined);
        };
      }),
  );
  replacement.view.webContents.emit("did-finish-load");
  lifecycle.cancel(record.id);
  expect(lifecycle.current(replacement)).toBe(false);
  restore();
  await Promise.resolve();
  expect(apply).not.toHaveBeenCalled();
  expect(replacement.loaded).toBe(false);
  expect(replacement.view.webContents.listenerCount("did-finish-load")).toBe(0);
  expect(contents.listenerCount("did-start-navigation")).toBe(0);
  expect(lifecycle.watcherCount).toBe(0);
  focus.dispose();
  snapshots.dispose();
  await f.host.dispose(false);
});

test("cancelling a generation during scroll capture prevents its late native reload", async () => {
  const { f, lifecycle, focus, snapshots } = await owner();
  const record = f.registry.add(f.root, "a.html");
  const entry = lifecycle.create(record, canonicalRoot(f.root));
  const contents = entry.view.webContents;
  const nativeReload = vi.spyOn(contents, "reload");
  let complete = () => {};
  vi.spyOn(contents, "executeJavaScriptInIsolatedWorld").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = () => {
          resolve([0, 40]);
        };
      }),
  );
  const reload = lifecycle.reload(record.id);
  lifecycle.cancel(record.id);
  complete();
  await reload;
  expect(nativeReload).not.toHaveBeenCalled();
  expect(lifecycle.current(entry)).toBe(false);
  focus.dispose();
  snapshots.dispose();
  await f.host.dispose(false);
});

test("history is per tile, restores each scroll, truncates forward entries and reloads current URL", async () => {
  const f = await fixture();
  const { fake } = await import("./host-fixture");
  const { id, view } = await f.open();
  const other = await f.host.open(f.root, "a.html");
  const current = () => {
    const result = fake.views.findLast((view) => !view.webContents.isDestroyed());
    if (!result) throw new Error("Missing view");
    return result.webContents;
  };
  expect(f.host.navigation(id)).toEqual({ id, back: false, forward: false });
  const first = view.webContents;
  first.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce([0, 500]);
  first.emit("will-frame-navigate", {
    url: `foom-preview://${id}/chapter.md`,
    isMainFrame: true,
    preventDefault: vi.fn(),
  });
  await Promise.resolve();
  expect(f.host.navigation(id)).toEqual({ id, back: true, forward: false });
  expect(f.host.navigation(other)).toEqual({ id: other, back: false, forward: false });
  current().emit("did-start-navigation", {
    url: `foom-preview://${id}/asset.txt`,
    isMainFrame: true,
    isSameDocument: true,
  });
  current().executeJavaScriptInIsolatedWorld.mockResolvedValueOnce([0, 200]);
  await f.host.travel(id, "back");
  // Replacement throttling retains the pending entry until its timer runs.
  await vi.waitFor(() => {
    expect(current().getURL()).toBe(`foom-preview://${id}/a.html`);
  });
  current().emit("did-finish-load");
  expect(current().executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(999, [
    { code: "window.scrollTo(0, 500)" },
  ]);
  expect(f.host.navigation(id)).toEqual({ id, back: false, forward: true });
  await f.host.travel(id, "back");
  await f.host.travel(id, "forward");
  await vi.waitFor(() => {
    expect(current().getURL()).toBe(`foom-preview://${id}/chapter.md`);
  });
  current().emit("did-finish-load");
  expect(current().executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(999, [
    { code: "window.scrollTo(0, 200)" },
  ]);
  await f.host.reload(id);
  await vi.waitFor(() => {
    expect(current().getURL()).toBe(`foom-preview://${id}/chapter.md`);
  });
  expect(f.host.navigation(id)).toEqual({ id, back: true, forward: false });
  await f.host.travel(id, "back");
  await vi.waitFor(() => {
    expect(current().getURL()).toBe(`foom-preview://${id}/a.html`);
  });
  current().emit("will-frame-navigate", {
    url: `foom-preview://${id}/different.html`,
    isMainFrame: true,
    preventDefault: vi.fn(),
  });
  await vi.waitFor(() => {
    expect(current().getURL()).toBe(`foom-preview://${id}/different.html`);
  });
  expect(f.host.navigation(id)).toEqual({ id, back: true, forward: false });
  await f.host.close(id);
  expect(() => f.host.navigation(id)).toThrow("Unknown preview ID");
  expect(() => f.host.travel(id, "back")).toThrow("Unknown preview ID");
  await f.host.dispose(false);
});

test("retiring while a link scroll read is pending cannot navigate, and failed reads still navigate", async () => {
  const { f, lifecycle, focus, snapshots } = await owner();
  const record = f.registry.add(f.root, "a.html");
  const entry = lifecycle.create(record, canonicalRoot(f.root));
  const contents = entry.view.webContents;
  const load = vi.spyOn(contents, "loadURL").mockClear();
  let complete = (_value: unknown) => {};
  vi.spyOn(contents, "executeJavaScriptInIsolatedWorld").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = (value) => {
          resolve(value);
        };
      }),
  );
  contents.emit("will-frame-navigate", {
    url: `foom-preview://${record.id}/b.md`,
    isMainFrame: true,
    preventDefault: vi.fn(),
  });
  // Concurrent link requests cannot overtake the pending capture.
  contents.emit("will-frame-navigate", {
    url: `foom-preview://${record.id}/c.md`,
    isMainFrame: true,
    preventDefault: vi.fn(),
  });
  lifecycle.cancel(record.id);
  complete([0, 1]);
  await Promise.resolve();
  expect(load).not.toHaveBeenCalled();
  expect(lifecycle.navigation("missing")).toEqual({ id: "missing", back: false, forward: false });
  await lifecycle.travel("missing", "back");
  const second = lifecycle.create(record, canonicalRoot(f.root));
  vi.spyOn(second.view.webContents, "executeJavaScriptInIsolatedWorld").mockRejectedValueOnce(
    new Error("unloading"),
  );
  second.view.webContents.emit("will-frame-navigate", {
    url: `foom-preview://${record.id}/b.md`,
    isMainFrame: true,
    preventDefault: vi.fn(),
  });
  await Promise.resolve();
  expect(lifecycle.navigation(record.id).back).toBe(true);
  lifecycle.cancel(record.id);
  focus.dispose();
  snapshots.dispose();
  await f.host.dispose(false);
});

test("document history is bounded, native shortcuts traverse only human-focused previews", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { fake } = await import("./host-fixture");
  const { id, view } = await f.open();
  const latest = () => {
    const entry = fake.views.at(-1);
    if (!entry) throw new Error("Missing view");
    return entry.webContents;
  };
  for (let chapter = 0; chapter < 66; chapter++) {
    latest().emit("will-frame-navigate", {
      preventDefault: vi.fn(),
      url: `foom-preview://${id}/${String(chapter)}.md`,
      isMainFrame: true,
      isSameDocument: false,
    });
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(f.host.navigation(id)).toEqual({ id, back: true, forward: false });
  const navigate = async (key: string, focused: boolean) => {
    const contents = latest();
    if (focused) {
      f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
      contents.emit("did-finish-load");
      contents.emit("before-mouse-event", { preventDefault: vi.fn() }, { type: "mouseDown" });
      contents.emit("focus");
    }
    const event = { preventDefault: vi.fn() };
    contents.emit("before-input-event", event, {
      type: "keyDown",
      key,
      alt: true,
      control: false,
      shift: false,
    });
    await vi.advanceTimersByTimeAsync(250);
    return event;
  };
  expect((await navigate("ArrowLeft", false)).preventDefault).not.toHaveBeenCalled();
  expect((await navigate("ArrowLeft", true)).preventDefault).toHaveBeenCalled();
  expect(latest().getURL()).toBe(`foom-preview://${id}/64.md`);
  await navigate("ArrowRight", true);
  expect(latest().getURL()).toBe(`foom-preview://${id}/65.md`);
  for (let step = 0; step < 64; step++) {
    await f.host.travel(id, "back");
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(latest().getURL()).toBe(`foom-preview://${id}/2.md`);
  expect(f.host.navigation(id).back).toBe(false);
  expect(view.webContents.close).toHaveBeenCalled();
  await f.host.dispose(false);
});
