import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { fake, partition, fixture } from "./host-fixture";

test("served and missing files reload with isolated scroll, release watchers and survive read/restore failures", async () => {
  vi.useFakeTimers();
  let notify: (() => void) | undefined;
  vi.spyOn(fs, "watch").mockImplementation(
    (_name: fs.PathLike, _options: unknown, listener?: fs.WatchListener<string>) => {
      notify = () => {
        if (typeof listener === "function") listener("change", "a.html");
      };
      return Object.assign(new EventEmitter(), { close: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    },
  );
  const f = await fixture();
  const { id, view } = await f.open();
  const handler = partition.protocol.handle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing protocol");
  await handler({ url: `foom-preview://${id}/a.html` });
  expect(f.host.watcherCount).toBe(1);
  expect(await (await handler({ url: `foom-preview://${id}/missing.html` })).text()).toBe(
    "File not found. Waiting for it to appear.",
  );
  notify?.();
  await vi.advanceTimersByTimeAsync(120);
  expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(999, [
    { code: "[window.scrollX, window.scrollY]" },
  ]);
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(
    new Error("closed"),
  );
  replacement.webContents.emit("did-finish-load");
  await Promise.resolve();
  expect(replacement.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(999, [
    { code: "window.scrollTo(0, 1200)" },
  ]);
  await handler({ url: `foom-preview://${id}/a.html` });
  replacement.webContents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(
    new Error("read failed"),
  );
  notify?.();
  await vi.advanceTimersByTimeAsync(500);
  const third = fake.views[2];
  third?.webContents.emit("did-finish-load");
  expect(third?.webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  await f.host.close(id);
  expect(f.host.watcherCount).toBe(0);
  await f.host.dispose(false);
});
test("closing while isolated scroll capture is pending cannot resurrect a preview", async () => {
  vi.useFakeTimers();
  let notify: (() => void) | undefined;
  vi.spyOn(fs, "watch").mockImplementation(
    (_name: fs.PathLike, _options: unknown, listener?: fs.WatchListener<string>) => {
      notify = () => {
        if (typeof listener === "function") listener("change", "a.html");
      };
      return Object.assign(new EventEmitter(), { close: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    },
  );
  const f = await fixture();
  const { id, view } = await f.open();
  await partition.protocol.handle.mock.calls[0]?.[1]({ url: `foom-preview://${id}/a.html` });
  let resolve: ((value: unknown) => void) | undefined;
  view.webContents.executeJavaScriptInIsolatedWorld.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  notify?.();
  await vi.advanceTimersByTimeAsync(120);
  notify?.();
  await vi.advanceTimersByTimeAsync(120);
  expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  await f.host.close(id);
  resolve?.([0, 100]);
  await Promise.resolve();
  expect(view.webContents.reload).not.toHaveBeenCalled();
  await f.host.dispose(false);
});

test("navigation beyond 64 historical directories watches only the current chapter", async () => {
  vi.useFakeTimers();
  const watches: {
    directory: string;
    notify: (name: string) => void;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.spyOn(fs, "watch").mockImplementation(
    (directory: fs.PathLike, _options: unknown, listener?: fs.WatchListener<string>) => {
      const close = vi.fn();
      watches.push({
        directory: String(directory),
        notify: (name) => listener?.("change", name),
        close,
      });
      return Object.assign(new EventEmitter(), { close, ref: vi.fn(), unref: vi.fn() });
    },
  );
  const f = await fixture();
  const { id } = await f.open();
  const handler = partition.protocol.handle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing protocol");
  for (let i = 0; i < 70; i++) {
    const directory = path.join(f.root, String(i));
    await mkdir(directory);
    await writeFile(path.join(directory, "chapter.md"), "# Chapter");
    const previous = fake.views.at(-1);
    previous?.webContents.emit("did-start-navigation", {
      url: `foom-preview://${id}/${String(i)}/chapter.md`,
      isMainFrame: true,
      isSameDocument: false,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect((await handler({ url: `foom-preview://${id}/${String(i)}/chapter.md` })).status).toBe(
      200,
    );
    expect(f.host.watcherCount).toBe(1);
    expect(
      watches
        .filter((watch) => watch.close.mock.calls.length === 0)
        .map((watch) => watch.directory),
    ).toEqual([fs.realpathSync.native(directory)]);
  }
  const current = fake.views.at(-1);
  watches[0]?.notify("chapter.md");
  await vi.advanceTimersByTimeAsync(120);
  expect(current?.webContents.reload).not.toHaveBeenCalled();
  watches.at(-1)?.notify("chapter.md");
  await vi.advanceTimersByTimeAsync(120);
  expect(current?.webContents.reload).toHaveBeenCalledOnce();
  await f.host.dispose(false);
});

test("reload replaces hashed asset and missing dependency names in a shared directory", async () => {
  vi.useFakeTimers();
  const listeners: ((name: string) => void)[] = [];
  vi.spyOn(fs, "watch").mockImplementation(
    (_directory: fs.PathLike, _options: unknown, listener?: fs.WatchListener<string>) => {
      listeners.push((name) => listener?.("change", name));
      return Object.assign(new EventEmitter(), { close: vi.fn(), ref: vi.fn(), unref: vi.fn() });
    },
  );
  const f = await fixture();
  const { id } = await f.open();
  const handler = partition.protocol.handle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing protocol");
  await writeFile(path.join(f.root, "asset-old.css"), "body {}");
  await handler({ url: `foom-preview://${id}/asset-old.css` });
  await handler({ url: `foom-preview://${id}/missing-old.css` });
  await f.host.reload(id);
  await vi.advanceTimersByTimeAsync(250);
  await writeFile(path.join(f.root, "asset-new.css"), "body {}");
  await handler({ url: `foom-preview://${id}/a.html` });
  await handler({ url: `foom-preview://${id}/asset-new.css` });
  await handler({ url: `foom-preview://${id}/missing-new.css` });
  const current = fake.views.at(-1);
  for (const notify of listeners) {
    notify("asset-old.css");
    notify("missing-old.css");
  }
  await vi.advanceTimersByTimeAsync(120);
  expect(current?.webContents.reload).not.toHaveBeenCalled();
  listeners.at(-1)?.("asset-new.css");
  await vi.advanceTimersByTimeAsync(120);
  expect(current?.webContents.reload).toHaveBeenCalledOnce();
  await f.host.dispose(false);
});

test("a resource read finishing after reload cannot restore the retired load's dependencies", async () => {
  vi.useFakeTimers();
  vi.spyOn(fs, "watch").mockImplementation(() =>
    Object.assign(new EventEmitter(), {
      close: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    }),
  );
  const f = await fixture();
  const { id } = await f.open();
  const handler = partition.protocol.handle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing protocol");
  await mkdir(path.join(f.root, "retired"));
  await writeFile(path.join(f.root, "retired", "asset.css"), "body {}");
  const realpath = fs.promises.realpath;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async (file) => {
    await gate;
    return realpath(file);
  });
  const retired = handler({ url: `foom-preview://${id}/retired/asset.css` });
  try {
    await f.host.reload(id);
    await vi.advanceTimersByTimeAsync(250);
    await handler({ url: `foom-preview://${id}/a.html` });
    expect(f.host.watcherCount).toBe(1);
    release();
    expect((await retired).status).toBe(200);
    expect(f.host.watcherCount).toBe(1);
  } finally {
    release();
    await retired;
    await f.host.dispose(false);
  }
});
