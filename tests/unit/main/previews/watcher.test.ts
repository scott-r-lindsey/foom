import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewWatcher, scrollPosition } from "../../../../src/main/previews/watcher";
let root: string;
const watches: {
  event: (event: fs.WatchEventType, name: string | null) => void;
  handle: EventEmitter & { close: ReturnType<typeof vi.fn> };
}[] = [];
function fixture() {
  vi.useFakeTimers();
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "foom-watcher-")));
  vi.spyOn(fs, "watch").mockImplementation(
    (_name: fs.PathLike, _options: unknown, callback?: fs.WatchListener<string>) => {
      const handle = Object.assign(new EventEmitter(), {
        close: vi.fn(),
        ref: vi.fn(),
        unref: vi.fn(),
      });
      watches.push({
        event: (event, name) => {
          callback?.(event, name);
        },
        handle,
      });
      return handle;
    },
  );
  const changed = vi.fn();
  return { changed, watcher: new PreviewWatcher(root, changed) };
}
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  watches.splice(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("filters names, shares directories, debounces 20 writes, and closes pending work", async () => {
  const { watcher, changed } = fixture();
  await watcher.record(path.join(root, "a.html"));
  await watcher.record(path.join(root, "style.css"));
  expect(watcher.count).toBe(1);
  const watch = watches[0];
  if (!watch) throw new Error("Missing watch");
  watch.event("change", "other");
  vi.advanceTimersByTime(1000);
  expect(changed).not.toHaveBeenCalled();
  for (let i = 0; i < 20; i++) {
    watch.event("rename", "a.html");
    vi.advanceTimersByTime(10);
    expect(changed).not.toHaveBeenCalled();
  }
  vi.advanceTimersByTime(109);
  expect(changed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(changed).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(changed).toHaveBeenCalledOnce();
  watch.event("change", "style.css");
  watcher.close();
  vi.advanceTimersByTime(1000);
  expect(changed).toHaveBeenCalledOnce();
  expect(watcher.count).toBe(0);
  expect(watch.handle.close).toHaveBeenCalledOnce();
  await watcher.record(path.join(root, "a.html"));
  watch.event("change", null);
  expect(watcher.count).toBe(0);
});
test("unknown names reload and continuous writes cannot starve the maximum wait", async () => {
  const { watcher, changed } = fixture();
  await watcher.record(path.join(root, "a"));
  for (let i = 0; i < 10; i++) {
    watches[0]?.event("change", null);
    vi.advanceTimersByTime(100);
  }
  expect(changed).toHaveBeenCalledOnce();
  watches[0]?.event("change", null);
  vi.advanceTimersByTime(120);
  expect(changed).toHaveBeenCalledTimes(2);
  watcher.close();
});
test("caps directory handles, refuses escaped parents, handles subscription errors", async () => {
  const { watcher, changed } = fixture();
  await watcher.record(path.resolve(root, "..", "outside"));
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(path.dirname(root), path.join(root, "link"), kind);
  await watcher.record(path.join(root, "link", "a"));
  expect(watcher.count).toBe(0);
  vi.mocked(fs.watch).mockImplementationOnce(() => {
    throw new Error("gone");
  });
  await watcher.record(path.join(root, "gone", "a"));
  for (let i = 0; i < 65; i++) {
    const directory = path.join(root, String(i));
    fs.mkdirSync(directory);
    await watcher.record(path.join(directory, "a"));
  }
  expect(watcher.count).toBe(64);
  watches[0]?.handle.emit("error", new Error("deleted directory"));
  vi.advanceTimersByTime(120);
  expect(changed).toHaveBeenCalledOnce();
  expect(watcher.count).toBe(63);
  watcher.close();
});
test("watches the nearest existing parent of a missing nested file", async () => {
  const { watcher } = fixture();
  await watcher.record(path.join(root, "missing", "nested", "a"));
  expect(watcher.count).toBe(1);
  watcher.close();
  const other = new PreviewWatcher(root, vi.fn());
  fs.rmSync(root, { recursive: true });
  await other.record(path.join(root, "a"));
  expect(other.count).toBe(0);
  other.close();
});
test("validates isolated-world scroll coordinates", () => {
  expect(scrollPosition(new Array<unknown>(2))).toBeUndefined();
  expect(scrollPosition([12, 1200])).toEqual([12, 1200]);
  for (const value of [null, {}, [], [1], [1, 2, 3], [NaN, 1], [Infinity, 0], [1e10, 0], ["1", 0]])
    expect(scrollPosition(value)).toBeUndefined();
});

test("watches requested directory symlinks as well as their targets", async () => {
  const { watcher, changed } = fixture();
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  fs.symlinkSync(
    target,
    path.join(root, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await watcher.record(path.join(root, "alias", "a.html"));
  expect(watcher.count).toBe(2);
  watches[0]?.event("rename", "alias");
  vi.advanceTimersByTime(120);
  expect(changed).toHaveBeenCalledOnce();
  watcher.close();
});

test("new generations cancel pending events and ignore retired handles, including errors", async () => {
  const { watcher, changed } = fixture();
  await watcher.record(path.join(root, "old.css"));
  const old = watches[0];
  old?.event("change", "old.css");
  watcher.beginGeneration();
  await watcher.record(path.join(root, "new.css"));
  old?.event("change", null);
  old?.handle.emit("error", new Error("late error"));
  vi.advanceTimersByTime(1000);
  expect(changed).not.toHaveBeenCalled();
  expect(watcher.count).toBe(1);
  expect(old?.handle.close).toHaveBeenCalledOnce();
  watches[1]?.event("change", "old.css");
  vi.advanceTimersByTime(120);
  expect(changed).not.toHaveBeenCalled();
  watches[1]?.event("change", "new.css");
  vi.advanceTimersByTime(120);
  expect(changed).toHaveBeenCalledOnce();
  watcher.close();
  watcher.beginGeneration();
  await watcher.record(path.join(root, "closed.css"));
  expect(watcher.count).toBe(0);
});

test("resource recorders expire on generation replacement and close", async () => {
  const { watcher } = fixture();
  const retired = watcher.recorder();
  await retired(path.join(root, "old.css"));
  expect(watcher.count).toBe(1);
  watcher.beginGeneration();
  await retired(path.join(root, "old.css"));
  expect(watcher.count).toBe(0);
  const current = watcher.recorder();
  await current(path.join(root, "new.css"));
  expect(watcher.count).toBe(1);
  watcher.close();
  await current(path.join(root, "late.css"));
  expect(watcher.count).toBe(0);
});
