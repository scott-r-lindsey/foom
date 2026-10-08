import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  InventoryWatch,
  inventoryWatchPaths,
} from "../../../../src/main/workspace/inventory-watch";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const handles: { change(): void; error(): void; close: ReturnType<typeof vi.fn> }[] = [];
  const paths = vi
    .fn<(path: string) => Promise<string[]>>()
    .mockResolvedValue(["/git", "/git/refs"]);
  const changed = vi.fn();
  const watch = vi.fn((_path: string, change: () => void) => {
    const handle = {
      change,
      error: () => {},
      close: vi.fn(),
      on: (_event: "error", error: () => void) => {
        handle.error = error;
      },
    };
    handles.push(handle);
    return handle;
  });
  return { handles, paths, changed, watch, watcher: new InventoryWatch(paths, changed, watch) };
}

test("debounces bursts, rebuilds watches, and disposes removed repositories and pending timers", async () => {
  const f = fixture();
  f.watcher.sync([{ path: "/repo" }]);
  await Promise.resolve();
  f.watcher.sync([{ path: "/repo" }]);
  expect(f.paths).toHaveBeenCalledTimes(1);
  f.handles[0]?.change();
  await vi.advanceTimersByTimeAsync(250);
  f.handles[1]?.change();
  await vi.advanceTimersByTimeAsync(299);
  expect(f.changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.changed).toHaveBeenCalledTimes(1);
  expect(f.paths).toHaveBeenCalledTimes(2);
  expect(f.handles[0]?.close).toHaveBeenCalledOnce();
  f.handles[2]?.change();
  f.watcher.sync([]);
  await vi.runAllTimersAsync();
  expect(f.changed).toHaveBeenCalledTimes(1);
  f.handles[2]?.change();
  f.handles[2]?.error();
  f.watcher.dispose();
  f.watcher.sync([{ path: "/repo" }]);
  expect(f.paths).toHaveBeenCalledTimes(2);
});

test.each(["throw", "paths"])(
  "watch %s errors close handles and leave focus refresh as the backstop",
  async (failure) => {
    const f = fixture();
    if (failure === "throw")
      f.watch.mockImplementationOnce(() => {
        throw new Error("unsupported");
      });
    if (failure === "paths") f.paths.mockRejectedValueOnce(new Error("gone"));
    f.watcher.sync([{ path: "/repo" }]);
    await Promise.resolve();
    f.handles[0]?.change();
    await vi.runAllTimersAsync();
    expect(f.changed).toHaveBeenCalledOnce();
    f.watcher.sync([{ path: "/repo" }]);
    expect(f.paths).toHaveBeenCalledOnce();
    for (const handle of f.handles) expect(handle.close).toHaveBeenCalledOnce();
    f.watcher.dispose();
  },
);

test("a continuous deleted-directory event stream cannot starve inventory refresh", async () => {
  const f = fixture();
  f.watcher.sync([{ path: "/repo" }]);
  await Promise.resolve();
  f.paths.mockResolvedValue(["/git"]);
  for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
    expect(f.changed).not.toHaveBeenCalled();
    f.handles[1]?.change();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.paths).toHaveBeenCalledTimes(2);
  expect(f.handles[1]?.close).toHaveBeenCalledOnce();
  f.handles[1]?.change();
  await vi.runAllTimersAsync();
  expect(f.changed).toHaveBeenCalledOnce();
  f.handles[2]?.change();
  await vi.advanceTimersByTimeAsync(300);
  expect(f.changed).toHaveBeenCalledTimes(2);
  f.watcher.dispose();
});

test.each(["before", "after"])(
  "a deleted-directory error %s a parent event preserves the debounced rebuild",
  async (order) => {
    const f = fixture();
    f.watcher.sync([{ path: "/repo" }]);
    await Promise.resolve();
    f.paths.mockResolvedValue(["/git"]);
    if (order === "before") f.handles[1]?.error();
    f.handles[0]?.change();
    if (order === "after") f.handles[1]?.error();
    expect(f.handles[0]?.close).not.toHaveBeenCalled();
    expect(f.handles[1]?.close).toHaveBeenCalledOnce();
    expect(f.changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.paths).toHaveBeenCalledTimes(2);
    expect(f.changed).toHaveBeenCalledOnce();
    expect(f.handles[1]?.close).toHaveBeenCalledOnce();
    f.handles[2]?.change();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.changed).toHaveBeenCalledTimes(2);
    f.watcher.dispose();
  },
);

test("watch errors alone refresh after settling without retries or closing healthy watches", async () => {
  const f = fixture();
  f.watcher.sync([{ path: "/repo" }]);
  await Promise.resolve();
  f.handles[1]?.error();
  f.handles[1]?.error();
  await vi.advanceTimersByTimeAsync(299);
  expect(f.changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.handles[0]?.close).not.toHaveBeenCalled();
  expect(f.handles[1]?.close).toHaveBeenCalledOnce();
  await vi.runAllTimersAsync();
  expect(f.paths).toHaveBeenCalledOnce();
  f.watcher.dispose();
});

test.each(["remove", "dispose"])(
  "does not install watches after %s during path discovery",
  async (action) => {
    const f = fixture();
    let finish: (paths: string[]) => void = () => {};
    f.paths.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    f.watcher.sync([{ path: "/repo" }]);
    if (action === "remove") f.watcher.sync([]);
    else f.watcher.dispose();
    finish(["/git"]);
    await Promise.resolve();
    expect(f.watch).not.toHaveBeenCalled();
    f.watcher.dispose();
  },
);

test("validates paths and refuses redirected metadata while tolerating absent optional directories", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-watch-paths-")));
  try {
    expect(await inventoryWatchPaths(root)).toEqual([root]);
    for (const path of ["relative", `${root}/../other`, `${root}\0`])
      await expect(inventoryWatchPaths(path)).rejects.toThrow("Invalid");
    await writeFile(join(root, "refs"), "not a directory");
    await expect(inventoryWatchPaths(root)).rejects.toThrow("Invalid");
    await rm(join(root, "refs"));
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, "refs"), "junction");
    await expect(inventoryWatchPaths(root)).rejects.toThrow("Invalid");
    await expect(inventoryWatchPaths(join(root, "refs"))).rejects.toThrow("redirected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
