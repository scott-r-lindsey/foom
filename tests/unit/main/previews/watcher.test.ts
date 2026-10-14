import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewWatcher, scrollPosition } from "../../../../src/main/previews/watcher";
const root = path.resolve("preview-fixture");
const watches: {
  event: (event: fs.WatchEventType, name: string | null) => void;
  handle: EventEmitter & { close: ReturnType<typeof vi.fn> };
}[] = [];
function fixture() {
  vi.useFakeTimers();
  vi.spyOn(fs.realpathSync, "native").mockImplementation((name) => String(name));
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
  watches.splice(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test("filters names, shares directories, debounces 20 writes, and closes pending work", () => {
  const { watcher, changed } = fixture();
  watcher.record(path.join(root, "a.html"));
  watcher.record(path.join(root, "style.css"));
  expect(watcher.count).toBe(1);
  const watch = watches[0];
  if (!watch) throw new Error("Missing watch");
  watch.event("change", "other");
  vi.advanceTimersByTime(1000);
  expect(changed).not.toHaveBeenCalled();
  for (let i = 0; i < 20; i++) {
    watch.event("rename", "a.html");
    vi.advanceTimersByTime(10);
  }
  vi.advanceTimersByTime(119);
  expect(changed).toHaveBeenCalledOnce();
  watch.event("change", "style.css");
  watcher.close();
  vi.advanceTimersByTime(1000);
  expect(changed).toHaveBeenCalledOnce();
  expect(watcher.count).toBe(0);
  expect(watch.handle.close).toHaveBeenCalledOnce();
  watcher.record(path.join(root, "a.html"));
  watch.event("change", null);
  expect(watcher.count).toBe(0);
});
test("unknown names reload and continuous writes cannot starve the maximum wait", () => {
  const { watcher, changed } = fixture();
  watcher.record(path.join(root, "a"));
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
test("caps directory handles, refuses escaped parents, handles subscription errors", () => {
  const { watcher, changed } = fixture();
  watcher.record(path.resolve(root, "..", "outside"));
  vi.mocked(fs.realpathSync.native).mockReturnValueOnce(path.resolve(root, "..", "outside"));
  watcher.record(path.join(root, "link", "a"));
  vi.mocked(fs.watch).mockImplementationOnce(() => {
    throw new Error("gone");
  });
  watcher.record(path.join(root, "gone", "a"));
  for (let i = 0; i < 65; i++) watcher.record(path.join(root, String(i), "a"));
  expect(watcher.count).toBe(64);
  watches[0]?.handle.emit("error", new Error("deleted directory"));
  vi.advanceTimersByTime(120);
  expect(changed).toHaveBeenCalledOnce();
  expect(watcher.count).toBe(63);
  watcher.close();
});
test("watches the nearest existing parent of a missing nested file", () => {
  const { watcher } = fixture();
  vi.mocked(fs.realpathSync.native).mockImplementation((name) => {
    if (String(name) !== root) throw new Error("missing");
    return root;
  });
  watcher.record(path.join(root, "missing", "nested", "a"));
  expect(watcher.count).toBe(1);
  watcher.close();
  const other = new PreviewWatcher(root, vi.fn());
  vi.mocked(fs.realpathSync.native).mockImplementation(() => {
    throw new Error("missing root");
  });
  other.record(path.join(root, "a"));
  expect(other.count).toBe(0);
  other.close();
});
test("validates isolated-world scroll coordinates", () => {
  expect(scrollPosition(new Array<unknown>(2))).toBeUndefined();
  expect(scrollPosition([12, 1200])).toEqual([12, 1200]);
  for (const value of [null, {}, [], [1], [1, 2, 3], [NaN, 1], [Infinity, 0], [1e10, 0], ["1", 0]])
    expect(scrollPosition(value)).toBeUndefined();
});

test("watches requested directory symlinks as well as their targets", () => {
  const { watcher, changed } = fixture();
  vi.mocked(fs.realpathSync.native).mockImplementation((name) =>
    String(name) === path.join(root, "alias") ? path.join(root, "target") : String(name),
  );
  watcher.record(path.join(root, "alias", "a.html"));
  expect(watcher.count).toBe(2);
  watches[0]?.event("rename", "alias");
  vi.advanceTimersByTime(120);
  expect(changed).toHaveBeenCalledOnce();
  watcher.close();
});
