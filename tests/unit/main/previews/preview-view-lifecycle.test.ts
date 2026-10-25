import { expect, test, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import type { HostedPreview } from "../../../../src/main/previews/hosted-preview";
import { fixture } from "./host-fixture";
import { PreviewViewLifecycle } from "../../../../src/main/previews/preview-view-lifecycle";
import { PreviewFocus } from "../../../../src/main/previews/preview-focus";
import { PreviewSnapshots } from "../../../../src/main/previews/preview-snapshots";
import { canonicalRoot } from "../../../../src/main/previews/contained-files";

// Native creation is mocked; the owner is exercised directly without host composition.
test("late scroll restoration cannot load a released generation and cancellation releases listeners", async () => {
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
