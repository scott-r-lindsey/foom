import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, expect, test, vi } from "vitest";
const fake = vi.hoisted(() => ({ views: [] as FakeView[], packaged: false }));
class FakeSession extends EventEmitter {
  protocol = {
    handle: vi.fn<(scheme: string, handler: (request: { url: string }) => Response) => void>(),
    unhandle: vi.fn(),
  };
  webRequest = {
    onBeforeRequest:
      vi.fn<
        (
          handler:
            | ((details: { url: string }, callback: (value: { cancel: boolean }) => void) => void)
            | null,
        ) => void
      >(),
  };
  setPermissionRequestHandler =
    vi.fn<
      (
        handler: (contents: null, permission: string, callback: (allowed: boolean) => void) => void,
      ) => void
    >();
  setPermissionCheckHandler = vi.fn<(handler: () => boolean) => void>();
  setDevicePermissionHandler = vi.fn<(handler: () => boolean) => void>();
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
}
class FakeContents extends EventEmitter {
  session = new FakeSession();
  focus = vi.fn();
  isFocused = vi.fn(() => false);
  isDestroyed = vi.fn(() => false);
  setWindowOpenHandler = vi.fn<(handler: () => { action: string }) => void>();
  loadURL = vi.fn(async () => {});
  setZoomFactor = vi.fn();
  getZoomFactor = vi.fn(() => 1);
  close = vi.fn();
}
class FakeView {
  webContents = new FakeContents();
  setBounds = vi.fn();
  setVisible = vi.fn();
  constructor(readonly options: unknown) {
    fake.views.push(this);
  }
}
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return fake.packaged;
    },
  },
  session: { fromPartition: () => partition },
  WebContentsView: FakeView,
}));
let partition: FakeSession;
const { PreviewHost, navigationAllowed, requestAllowed } = await import(
  "../../../../src/main/previews/host"
);
import { PreviewRegistry } from "../../../../src/main/previews/registry";
const roots: string[] = [];
afterEach(async () => {
  fake.views.splice(0);
  fake.packaged = false;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foom-host-"));
  roots.push(root);
  await writeFile(join(root, "a.html"), "<input autofocus>");
  const window = Object.assign(new EventEmitter(), {
    webContents: new FakeContents(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: vi.fn(() => ({ width: 800, height: 600 })),
  });
  partition = new FakeSession();
  const registry = new PreviewRegistry(join(root, "registry.json"));
  const validate = vi.fn(async (_worktree: string) => {});
  const changed = vi.fn();
  const host = new PreviewHost(window as unknown as BrowserWindow, registry, validate, changed);
  const open = async () => {
    const id = await host.open(root, "a.html");
    const view = fake.views.at(-1);
    if (!view) throw new Error("Missing view");
    view.webContents.session = partition;
    return { id, view };
  };
  return { root, window, registry, validate, changed, host, open };
}
test("requests and navigation admit only own origin, with data/blob only for assets", () => {
  const origin = `foom-preview://${"a".repeat(32)}`;
  for (const url of [origin + "/a.html", "data:text/plain,x", "blob:" + origin + "/id"])
    expect(requestAllowed(url, origin)).toBe(true);
  for (const url of [
    "https://example.com",
    "file:///tmp/a",
    "app://bundle/index.html",
    "invalid",
    "foom-preview://other/a.md",
  ]) {
    expect(requestAllowed(url, origin)).toBe(false);
    expect(navigationAllowed(url, origin)).toBe(false);
  }
  expect(navigationAllowed(origin + "/a.MD#x", origin)).toBe(true);
  expect(navigationAllowed(origin + "/a.html", origin)).toBe(false);
});
test("loads detached, denies capabilities, and attaches only loaded visible views", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const wc = view.webContents;
  expect(view.options).toMatchObject({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      disableDialogs: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: true,
    },
  });
  expect(f.window.contentView.addChildView).not.toHaveBeenCalled();
  const permission = partition.setPermissionRequestHandler.mock.calls[0]?.[0];
  const callback = vi.fn();
  permission?.(null, "camera", callback);
  expect(callback).toHaveBeenCalledWith(false);
  expect(partition.setPermissionCheckHandler.mock.calls[0]?.[0]?.()).toBe(false);
  expect(partition.setDevicePermissionHandler.mock.calls[0]?.[0]?.()).toBe(false);
  const event = { preventDefault: vi.fn() };
  partition.emit("will-download", event);
  wc.emit("will-attach-webview", event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(wc.setWindowOpenHandler.mock.calls[0]?.[0]?.()).toEqual({ action: "deny" });
  const request = partition.webRequest.onBeforeRequest.mock.calls[0]?.[0];
  request?.({ url: "http://example.com" }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: true });
  request?.({ url: `foom-preview://${id}/a.html` }, callback);
  expect(callback).toHaveBeenLastCalledWith({ cancel: false });
  const serve = partition.protocol.handle.mock.calls[0]?.[1];
  if (!serve) throw new Error("Missing protocol");
  const response: Response = serve({ url: `foom-preview://${id}/a.html` });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<input autofocus>");
  expect(serve({ url: `foom-preview://${id}/missing` }).status).toBe(404);
  f.host.bounds(id, { x: 10.5, y: 20, width: 300, height: 200, visible: true });
  expect(f.window.contentView.addChildView).not.toHaveBeenCalled();
  wc.emit("did-finish-load");
  expect(f.window.contentView.addChildView).toHaveBeenCalledOnce();
  f.window.webContents.getZoomFactor.mockReturnValue(1.5);
  f.window.emit("resize");
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 16, y: 30, width: 450, height: 300 });
  expect(wc.setZoomFactor).toHaveBeenLastCalledWith(1.5);
  f.host.bounds(id, { x: -10, y: 1000, width: 20000, height: 20000, visible: true });
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 600, width: 800, height: 0 });
  f.host.bounds(id, { x: 0, y: 0, width: 0, height: 20, visible: true });
  f.host.bounds(id, { x: 0, y: 0, width: 20, height: 20, visible: false });
  await f.host.close(id);
  expect(wc.close).toHaveBeenCalledOnce();
  expect(partition.clearStorageData).toHaveBeenCalledOnce();
  expect(partition.clearCache).toHaveBeenCalledOnce();
  expect(partition.protocol.unhandle).toHaveBeenCalledWith("foom-preview");
  expect(() => {
    f.host.bounds(id, { x: 0, y: 0, width: 1, height: 1, visible: true });
  }).toThrow("Unknown");
  await expect(f.host.close(id)).rejects.toThrow("Unknown");
});
test("only a human mouse-down permits focus, and navigation/reload detach before loading", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const wc = view.webContents;
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  wc.emit("focus");
  expect(f.window.webContents.focus).not.toHaveBeenCalled();
  expect(wc.focus).not.toHaveBeenCalled();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  wc.emit("did-finish-load");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  wc.emit("before-mouse-event", {}, { type: "mouseMove" });
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).toHaveBeenCalledOnce();
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  wc.isFocused.mockReturnValue(true);
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).toHaveBeenCalledOnce();
  wc.isFocused.mockReturnValue(false);
  wc.emit("blur");
  f.window.webContents.emit("focus");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  f.window.webContents.isDestroyed.mockReturnValue(true);
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  f.window.webContents.isDestroyed.mockReturnValue(false);
  const blocked = { url: "http://example.com", isMainFrame: true, preventDefault: vi.fn() };
  wc.emit("will-frame-navigate", blocked);
  wc.emit("will-redirect", blocked);
  expect(blocked.preventDefault).toHaveBeenCalledTimes(2);
  wc.emit("will-frame-navigate", {
    ...blocked,
    url: `foom-preview://${id}/a.md`,
    isMainFrame: false,
  });
  wc.emit("will-frame-navigate", { ...blocked, url: `foom-preview://${id}/a.md` });
  expect(f.window.contentView.removeChildView).toHaveBeenCalledOnce();
  wc.emit("did-start-navigation", {}, "", true, true);
  wc.emit("did-start-navigation", {}, "", false, false);
  wc.emit("did-start-loading");
  wc.emit("did-finish-load");
  expect(f.window.contentView.addChildView).toHaveBeenCalledTimes(2);
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  wc.emit("focus");
  await f.host.close(id);
});
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
  await f.host.dispose(true);
  await f.host.dispose(true);
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
