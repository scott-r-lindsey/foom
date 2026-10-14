import fs from "node:fs";
import { MARKDOWN_CSP } from "../../../../src/main/previews/policy";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DialogContent } from "../../../../src/shared/confirmation";
import type { BrowserWindow } from "electron";
import { afterEach, expect, test, vi } from "vitest";
const fake = vi.hoisted(() => ({
  views: [] as FakeView[],
  packaged: false,
  external: vi.fn(async (_url: string) => {}),
  nextLoad: undefined as Promise<void> | undefined,
}));
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
  closeAllConnections = vi.fn(async () => {});
}
class FakeContents extends EventEmitter {
  session = new FakeSession();
  send = vi.fn();
  capturePage = vi.fn(() => Promise.resolve({ toDataURL: () => "data:image/png;base64,AA==" }));
  focus = vi.fn();
  executeJavaScript = vi.fn(async (_script: string) => {});
  isFocused = vi.fn(() => false);
  isDestroyed = vi.fn(() => false);
  setWindowOpenHandler =
    vi.fn<(handler: (details: { url: string }) => { action: string }) => void>();
  getURL = vi.fn(() => "");
  loadURL = vi.fn((url: string) => {
    this.getURL.mockReturnValue(url);
    this.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
    const result = fake.nextLoad;
    fake.nextLoad = undefined;
    return result ?? Promise.resolve();
  });
  executeJavaScriptInIsolatedWorld = vi.fn<() => Promise<unknown>>().mockResolvedValue([0, 1200]);
  reload = vi.fn(() => {
    this.emit("did-start-navigation", {
      url: this.getURL(),
      isMainFrame: true,
      isSameDocument: false,
    });
  });
  setZoomFactor = vi.fn();
  getZoomFactor = vi.fn(() => 1);
  close = vi.fn(() => {
    this.isDestroyed.mockReturnValue(true);
  });
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
  shell: { openExternal: fake.external },
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
  fake.external.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(
  confirm: (content: DialogContent, signal: AbortSignal) => Promise<boolean> = vi.fn(() =>
    Promise.resolve(false),
  ),
) {
  const root = await mkdtemp(join(tmpdir(), "foom-host-"));
  roots.push(root);
  await writeFile(join(root, "a.html"), "<input autofocus>");
  const window = Object.assign(new EventEmitter(), {
    webContents: new FakeContents(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isFocused: vi.fn(() => false),
    getContentBounds: vi.fn(() => ({ width: 800, height: 600 })),
  });
  partition = new FakeSession();
  const registry = new PreviewRegistry(join(root, "registry.json"));
  const validate = vi.fn(async (_worktree: string) => {});
  const changed = vi.fn();
  const host = new PreviewHost(
    window as unknown as BrowserWindow,
    registry,
    validate,
    changed,
    confirm,
  );
  const open = async () => {
    const id = await host.open(root, "a.html");
    const view = fake.views.at(-1);
    if (!view) throw new Error("Missing view");
    view.webContents.session = partition;
    return { id, view };
  };
  return { root, window, registry, validate, changed, host, open, confirm };
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
  expect(wc.setWindowOpenHandler.mock.calls[0]?.[0]?.({ url: "invalid" })).toEqual({
    action: "deny",
  });
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
test("serves bundled assets and wraps Markdown with its restrictive CSP", async () => {
  const f = await fixture();
  const { id } = await f.open();
  const serve = partition.protocol.handle.mock.calls[0]?.[1];
  if (!serve) throw new Error("Missing protocol");
  await writeFile(join(f.root, "a.md"), "# Safe </script>");
  const response = serve({ url: `foom-preview://${id}/a.md` });
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toBe(MARKDOWN_CSP);
  expect(await response.text()).toContain('"# Safe \\u003c/script>"');
  const read = vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("bundled"));
  const asset = serve({ url: `foom-preview://${id}/__foom__/markdown.js` });
  read.mockRestore();
  expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(await asset.text()).toBe("bundled");
  await f.host.dispose(false);
});
test("only a human mouse-down permits focus, and navigation/reload detach before loading", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const wc = view.webContents;
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).not.toHaveBeenCalled();
  // A detached, loading view that takes focus gives it straight back.
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  wc.emit("did-finish-load");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  wc.emit("before-mouse-event", {}, { type: "mouseMove" });
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).toHaveBeenCalledOnce();
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  wc.isFocused.mockReturnValue(true);
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  expect(wc.focus).toHaveBeenCalledOnce();
  wc.isFocused.mockReturnValue(false);
  // The human-focused preview is never asked to refocus itself.
  wc.emit("blur");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(2);
  expect(wc.focus).toHaveBeenCalledOnce();
  f.window.webContents.emit("focus");
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(3);
  f.window.webContents.isDestroyed.mockReturnValue(true);
  wc.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledTimes(3);
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
test("reload and allowed main-frame navigation replace native contents but preserve the preview and partition", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const wc = view.webContents;
  const bounds = { x: 10, y: 20, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  wc.emit("did-finish-load");
  wc.emit("before-mouse-event", {}, { type: "mouseDown" });
  wc.emit("focus");
  const navigation = { url: wc.getURL(), isMainFrame: true, isSameDocument: false };
  wc.emit("did-start-navigation", { ...navigation, isSameDocument: true });
  wc.emit("did-start-navigation", { ...navigation, isMainFrame: false });
  wc.emit("did-start-navigation", { ...navigation, url: "https://example.com" });
  expect(wc.close).not.toHaveBeenCalled();
  wc.emit("did-start-navigation", navigation);
  const reloaded = fake.views[1];
  if (!reloaded) throw new Error("Missing reloaded view");
  expect(wc.close).toHaveBeenCalledOnce();
  expect(f.window.webContents.focus).not.toHaveBeenCalled();
  expect(reloaded.webContents.focus).not.toHaveBeenCalled();
  expect(f.window.contentView.removeChildView).toHaveBeenCalledWith(view);
  expect(reloaded.options).toEqual(view.options);
  expect(reloaded.webContents.loadURL).toHaveBeenCalledWith(navigation.url);
  expect(partition.protocol.handle).toHaveBeenCalledOnce();
  expect(partition.clearStorageData).not.toHaveBeenCalled();
  reloaded.webContents.emit("did-finish-load");
  expect(reloaded.setBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 100, height: 100 });
  expect(f.window.contentView.addChildView).toHaveBeenLastCalledWith(reloaded);
  reloaded.webContents.emit("focus");
  expect(reloaded.webContents.focus).toHaveBeenCalledOnce();
  expect(f.window.webContents.focus).not.toHaveBeenCalled();
  f.window.webContents.emit("focus");
  vi.useFakeTimers();
  const markdown = `foom-preview://${id}/b.md`;
  reloaded.webContents.emit("did-start-navigation", { ...navigation, url: markdown });
  expect(fake.views).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(250);
  const linked = fake.views[2];
  expect(linked?.webContents.loadURL).toHaveBeenCalledWith(markdown);
  linked?.webContents.emit("did-finish-load");
  linked?.webContents.emit("focus");
  expect(linked?.webContents.focus).not.toHaveBeenCalled();
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  expect(f.registry.records.get(id)?.relativePath).toBe("a.html");
  await f.host.dispose(false);
});
test("focus handoff waits for attachment and yields to a later user focus change", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  // Native close can focus the board synchronously; that is not a human change.
  view.webContents.close.mockImplementation(() => {
    view.webContents.isDestroyed.mockReturnValue(true);
    f.window.webContents.emit("focus");
  });
  view.webContents.emit("did-start-navigation", {
    url: `foom-preview://${id}/b.md`,
    isMainFrame: true,
    isSameDocument: false,
  });
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  expect(replacement.webContents.focus).not.toHaveBeenCalled();
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  replacement.webContents.emit("did-finish-load");
  expect(replacement.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
});
test("hiding a loading replacement cancels its focus handoff", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  view.webContents.emit("did-start-navigation", {
    url: view.webContents.getURL(),
    isMainFrame: true,
    isSameDocument: false,
  });
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  f.host.bounds(id, { ...bounds, visible: false });
  replacement.webContents.emit("did-finish-load");
  f.host.bounds(id, bounds);
  expect(replacement.webContents.focus).not.toHaveBeenCalled();
  replacement.webContents.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  await f.host.dispose(false);
});
test("unsolicited focus returns to the board while a focused replacement is pending", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  const other = await f.open();
  const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  const replacement = fake.views[2];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-finish-load");
  replacement.webContents.emit("did-start-navigation", navigation);
  other.view.webContents.emit("focus");
  expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  // Hiding during the delay must also discard focus intent before re-showing.
  f.host.bounds(id, { ...bounds, visible: false });
  f.host.bounds(id, bounds);
  await vi.advanceTimersByTimeAsync(250);
  const delayed = fake.views[3];
  delayed?.webContents.emit("did-finish-load");
  expect(delayed?.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
});
test("handoff blocks board keys before detach through throttle and load, and disposes listeners", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
  f.host.bounds(id, bounds);
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  const event = { preventDefault: vi.fn() };
  const key = () => f.window.webContents.emit("before-input-event", event);
  key();
  expect(event.preventDefault).not.toHaveBeenCalled();
  view.webContents.emit("will-frame-navigate", {
    url: `foom-preview://${id}/b.md`,
    isMainFrame: true,
  });
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  f.window.webContents.emit("focus");
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-finish-load");
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(3);
  replacement.webContents.emit("focus");
  event.preventDefault.mockClear();
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(0);
  expect(replacement.webContents.focus).toHaveBeenCalledOnce();
  replacement.webContents.emit("did-start-navigation", navigation);
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseMove" });
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  key();
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(250);
  const delayed = fake.views[2];
  if (!delayed) throw new Error("Missing delayed replacement");
  delayed.webContents.emit("did-finish-load");
  expect(delayed.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
  expect(f.window.webContents.listenerCount("before-input-event")).toBe(0);
  expect(f.window.webContents.listenerCount("before-mouse-event")).toBe(0);
});
test("hiding or closing a pending handoff unblocks board input", async () => {
  for (const action of ["hide", "close"] as const) {
    const f = await fixture();
    const { id, view } = await f.open();
    const bounds = { x: 0, y: 0, width: 100, height: 100, visible: true };
    f.host.bounds(id, bounds);
    view.webContents.emit("did-finish-load");
    view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
    view.webContents.emit("focus");
    view.webContents.emit("did-start-navigation", {
      url: view.webContents.getURL(),
      isMainFrame: true,
      isSameDocument: false,
    });
    const event = { preventDefault: vi.fn() };
    f.window.webContents.emit("before-input-event", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    if (action === "hide") {
      f.host.bounds(id, { ...bounds, visible: false });
      await Promise.resolve();
    } else await f.host.close(id);
    f.window.webContents.emit("before-input-event", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await f.host.dispose(false);
  }
});
test("a failed replacement load cancels the input gate", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("focus");
  fake.nextLoad = Promise.reject(new Error("Load failed"));
  view.webContents.emit("did-start-navigation", {
    url: view.webContents.getURL(),
    isMainFrame: true,
    isSameDocument: false,
  });
  const event = { preventDefault: vi.fn() };
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await Promise.resolve();
  await Promise.resolve();
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await f.host.dispose(false);
});
test("rapid reloads stop the old script, bound recreation and cancel pending work on close", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-start-navigation", navigation);
  expect(replacement.webContents.close).toHaveBeenCalledOnce();
  for (let i = 0; i < 10; i++) replacement.webContents.emit("did-start-navigation", navigation);
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  await vi.advanceTimersByTimeAsync(249);
  expect(fake.views).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.views).toHaveLength(3);
  fake.views[2]?.webContents.emit("did-start-navigation", navigation);
  await f.host.close(id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fake.views).toHaveLength(3);
  await f.host.dispose(false);
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
  await f.host.open(f.root, "a.html", { id: first });
  await f.host.open(f.root, "a.html", { id: second });
  expect(fake.views).toHaveLength(0);
  expect(f.host.visible(first)).toBe(false);
  f.host.placed("missing", true);
  f.host.placed(first, false);
  expect(f.host.visible(first)).toBe(false);
  f.host.placed(first, true);
  expect(f.host.visible(first)).toBe(true);
  expect(f.registry.records.get(first)?.agentOpened).toBe(true);
  f.host.bounds(first, { x: 0, y: 0, width: 100, height: 100, visible: false });
  expect(fake.views).toHaveLength(0);
  f.host.bounds(first, { x: 0, y: 0, width: 100, height: 100, visible: true });
  expect(fake.views).toHaveLength(1);
  expect(f.host.visible(first)).toBe(true);
  await f.host.dispose(true);
  expect([...f.registry.records.keys()]).toEqual([first]);
  expect(f.registry.records.get(first)?.agentOpened).toBeUndefined();
  const restored = new PreviewRegistry(join(f.root, "registry.json"));
  await restored.load();
  expect([...restored.records.keys()]).toEqual([first]);
});

test("external requests always confirm, drop overlapping requests and revoke on close", async () => {
  let answer: (value: boolean) => void = () => {};
  const confirm = vi.fn(
    (_content: DialogContent, _signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  const f = await fixture(confirm);
  const { id, view } = await f.open();
  const popup = view.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
  const url = "https://example.com/full?secret=visible#fragment";
  expect(popup?.({ url })).toEqual({ action: "deny" });
  popup?.({ url: "http://example.com/dropped" });
  view.webContents.emit("will-frame-navigate", {
    url: "mailto:a@example.com",
    preventDefault: vi.fn(),
  });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0]?.[0]).toMatchObject({ facts: [{ label: "URL", value: url }] });
  answer(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.external).not.toHaveBeenCalled();
  popup?.({ url: "mailto:a@example.com" });
  answer(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.external).toHaveBeenCalledExactlyOnceWith("mailto:a@example.com");
  popup?.({ url });
  await f.host.close(id);
  answer(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(fake.external).toHaveBeenCalledTimes(1);
  for (const url of ["invalid", "javascript:alert(1)", "file:///tmp/test", "data:text/plain,x"])
    popup?.({ url });
  expect(confirm).toHaveBeenCalledTimes(3);
});
test("network needs disclosure, updates both policies, reloads and persists only off", async () => {
  const confirm = vi.fn(() => Promise.resolve(false));
  const f = await fixture(confirm);
  const { id, view } = await f.open();
  await expect(f.host.network("missing", true)).rejects.toThrow("Unknown");
  await f.host.network(id, true);
  expect(f.registry.records.get(id)?.network).toBe(false);
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: "This page can send files from this worktree to the internet",
    }),
    expect.any(AbortSignal),
  );
  confirm.mockResolvedValue(true);
  await f.host.network(id, true);
  await f.host.network(id, true);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(view.webContents.reload).toHaveBeenCalledOnce();
  const request = partition.webRequest.onBeforeRequest.mock.calls[0]?.[0];
  for (const [url, cancel] of [
    ["https://example.com", false],
    ["wss://example.com", false],
    ["http://example.com", true],
    ["ws://example.com", true],
  ] as const) {
    const callback = vi.fn();
    request?.({ url }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel });
  }
  const response = partition.protocol.handle.mock.calls[0]?.[1]({
    url: `foom-preview://${id}/a.html`,
  });
  expect(response?.headers.get("content-security-policy")).toContain(
    "connect-src 'self' https: wss:",
  );
  await f.registry.save();
  const restored = new PreviewRegistry(join(f.root, "registry.json"));
  await restored.load();
  expect(restored.records.get(id)?.network).toBe(false);
  await f.host.network(id, false);
  expect(f.registry.records.get(id)?.network).toBe(false);
  expect(partition.closeAllConnections).toHaveBeenCalledTimes(2);
  await f.host.dispose(false);
});
test("failed or overlapping reviews grant no network capability", async () => {
  const f = await fixture(vi.fn(() => Promise.reject(new Error("dialog unavailable"))));
  const { id } = await f.open();
  await f.host.network(id, true);
  expect(f.registry.records.get(id)?.network).toBe(false);
  await f.host.dispose(false);
});

test("cover snapshots loaded views, detaches before capture resolves, and restores without focus", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 1, y: 2, width: 100, height: 80, visible: true });
  view.webContents.emit("did-finish-load");
  let release: (() => void) | undefined;
  view.webContents.capturePage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ toDataURL: () => "data:image/png;base64,AA==" });
        };
      }),
  );
  const covering = f.host.cover(true);
  expect(f.window.contentView.removeChildView).toHaveBeenCalledWith(view);
  f.host.bounds(id, { x: 3, y: 4, width: 100, height: 80, visible: true });
  release?.();
  await covering;
  expect(f.window.webContents.send).toHaveBeenLastCalledWith("preview:snapshots", [
    {
      id,
      bounds: { x: 3, y: 4, width: 100, height: 80, visible: true },
      image: "data:image/png;base64,AA==",
    },
  ]);
  await f.host.cover(true);
  expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);
  await f.host.cover(false);
  expect(f.window.contentView.addChildView).toHaveBeenLastCalledWith(view);
  expect(view.webContents.focus).not.toHaveBeenCalled();
  expect(f.window.webContents.send).toHaveBeenLastCalledWith("preview:snapshots", []);
  await f.host.dispose(false);
  await f.host.cover(true);
});
test("cover handles loading pages, failed capture, stale capture and close", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 80, visible: true });
  await f.host.cover(true);
  expect(view.webContents.capturePage).not.toHaveBeenCalled();
  view.webContents.capturePage.mockRejectedValueOnce(new Error("capture failed"));
  view.webContents.emit("did-finish-load");
  await Promise.resolve();
  await f.host.cover(false);
  let release: (() => void) | undefined;
  view.webContents.capturePage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => {
          resolve({ toDataURL: () => "data:image/png;base64,AA==" });
        };
      }),
  );
  const covering = f.host.cover(true);
  await f.host.cover(false);
  release?.();
  await covering;
  expect(f.window.webContents.send).toHaveBeenLastCalledWith("preview:snapshots", []);
  await f.host.cover(true);
  await f.host.close(id);
  expect(f.window.webContents.send).toHaveBeenLastCalledWith("preview:snapshots", []);
  f.window.webContents.isDestroyed.mockReturnValue(true);
  await f.host.cover(false);
});
test("every preview forwards native input to the board dispatcher without taking focus", async () => {
  const f = await fixture();
  const { view } = await f.open();
  const handler = vi.fn();
  f.window.webContents.on("before-input-event", handler);
  const event = { preventDefault: vi.fn() };
  const input = { type: "keyDown", key: "B", control: true, shift: true };
  view.webContents.emit("before-input-event", event, input);
  expect(handler).toHaveBeenCalledWith(event, input);
  expect(view.webContents.focus).not.toHaveBeenCalled();
  await f.host.dispose(false);
});

test.each(["Escape", "blur", "deadline"] as const)(
  "%s releases a stuck handoff only after blurring terminal DOM focus and revokes late focus",
  async (reason) => {
    vi.useFakeTimers();
    const f = await fixture();
    const { id, view } = await f.open();
    f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
    view.webContents.emit("did-finish-load");
    view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
    const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
    view.webContents.emit("did-start-navigation", navigation);
    const replacement = fake.views[1];
    if (!replacement) throw new Error("Missing replacement");
    f.window.isFocused.mockReturnValue(reason !== "blur");
    // A load can finish without the OS granting focus; it must still time out.
    if (reason === "deadline") replacement.webContents.emit("did-finish-load");
    let blurred = () => {};
    f.window.webContents.executeJavaScript.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        blurred = resolve;
      }),
    );
    const event = { preventDefault: vi.fn() };
    if (reason === "Escape")
      replacement.webContents.emit("before-input-event", event, { key: "Escape" });
    else if (reason === "blur") f.window.emit("blur");
    else {
      await vi.advanceTimersByTimeAsync(1499);
      expect(f.window.webContents.executeJavaScript).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(f.window.webContents.executeJavaScript).toHaveBeenCalledOnce();
    expect(f.window.webContents.executeJavaScript).toHaveBeenCalledWith(
      'if (document.activeElement?.closest(".xterm")) document.activeElement.blur()',
    );
    event.preventDefault.mockClear();
    f.window.webContents.emit("before-input-event", event, { key: "x" });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    blurred();
    await Promise.resolve();
    event.preventDefault.mockClear();
    f.window.webContents.emit("before-input-event", event, { key: "x" });
    expect(event.preventDefault).not.toHaveBeenCalled();
    replacement.webContents.focus.mockClear();
    replacement.webContents.emit("did-finish-load");
    replacement.webContents.emit("focus");
    expect(replacement.webContents.focus).not.toHaveBeenCalled();
    expect(f.window.webContents.focus).toHaveBeenCalledTimes(reason === "blur" ? 1 : 2);
    await f.host.dispose(false);
    expect(f.window.listenerCount("blur")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a cancelled handoff cannot be revived by a delayed replacement or stale blur completion", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  const navigation = { url: view.webContents.getURL(), isMainFrame: true, isSameDocument: false };
  view.webContents.emit("did-start-navigation", navigation);
  const replacement = fake.views[1];
  if (!replacement) throw new Error("Missing replacement");
  replacement.webContents.emit("did-start-navigation", navigation);
  let blurred = () => {};
  f.window.webContents.executeJavaScript.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      blurred = resolve;
    }),
  );
  f.window.emit("blur");
  f.window.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  await vi.advanceTimersByTimeAsync(250);
  const delayed = fake.views[2];
  if (!delayed) throw new Error("Missing delayed replacement");
  delayed.webContents.emit("did-finish-load");
  expect(delayed.webContents.focus).not.toHaveBeenCalled();
  delayed.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  delayed.webContents.emit("did-start-navigation", navigation);
  blurred();
  await Promise.resolve();
  const event = { preventDefault: vi.fn() };
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await f.host.dispose(false);
  await vi.advanceTimersByTimeAsync(2000);
  expect(vi.getTimerCount()).toBe(0);
});

test("blur failure keeps PTY input gated and Escape can retry", async () => {
  const f = await fixture();
  const { id, view } = await f.open();
  f.host.bounds(id, { x: 0, y: 0, width: 100, height: 100, visible: true });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("before-mouse-event", {}, { type: "mouseDown" });
  view.webContents.emit("did-start-navigation", {
    url: view.webContents.getURL(),
    isMainFrame: true,
    isSameDocument: false,
  });
  f.window.webContents.executeJavaScript.mockRejectedValueOnce(new Error("Board unavailable"));
  f.window.emit("blur");
  await Promise.resolve();
  await Promise.resolve();
  const event = { preventDefault: vi.fn() };
  f.window.webContents.emit("before-input-event", event, { key: "x" });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  f.window.webContents.isDestroyed.mockReturnValue(true);
  f.window.webContents.executeJavaScript.mockRejectedValueOnce(new Error("Destroyed"));
  f.window.webContents.emit("before-input-event", event, { key: "Escape" });
  await Promise.resolve();
  await Promise.resolve();
  event.preventDefault.mockClear();
  f.window.webContents.emit("before-input-event", event);
  expect(event.preventDefault).not.toHaveBeenCalled();
});

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
  handler({ url: `foom-preview://${id}/a.html` });
  expect(f.host.watcherCount).toBe(1);
  expect(await handler({ url: `foom-preview://${id}/missing.html` }).text()).toBe(
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
  partition.protocol.handle.mock.calls[0]?.[1]({ url: `foom-preview://${id}/a.html` });
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
