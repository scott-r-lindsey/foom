import fs from "node:fs";
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
