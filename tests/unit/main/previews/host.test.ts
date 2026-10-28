import fs from "node:fs";
import { MARKDOWN_CSP } from "../../../../src/main/previews/policy";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DialogContent } from "../../../../src/shared/confirmation";
import { expect, test, vi } from "vitest";
import { fake, partition, fixture } from "./host-fixture";
import { PreviewRegistry } from "../../../../src/main/previews/registry";
import { navigationAllowed, requestAllowed } from "../../../../src/main/previews/partition";

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
  const response: Response = await serve({ url: `foom-preview://${id}/a.html` });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("<input autofocus>");
  expect((await serve({ url: `foom-preview://${id}/missing` })).status).toBe(404);
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
  const response = await serve({ url: `foom-preview://${id}/a.md` });
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toBe(MARKDOWN_CSP);
  expect(await response.text()).toContain('"# Safe \\u003c/script>"');
  const read = vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("bundled"));
  const asset = await serve({ url: `foom-preview://${id}/__foom__/markdown.js` });
  read.mockRestore();
  expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(await asset.text()).toBe("bundled");
  await f.host.dispose(false);
});
test("protocol requests retain the root identity captured when the preview opened", async () => {
  const f = await fixture();
  const { id } = await f.open();
  const serve = partition.protocol.handle.mock.calls[0]?.[1];
  if (!serve) throw new Error("Missing protocol");
  const root = fs.realpathSync.native(f.root);
  const originalStat = fs.promises.stat;
  vi.spyOn(fs.promises, "stat").mockImplementation(async (name) => {
    const stat = await originalStat(name, { bigint: true });
    if (name === root) stat.ino += 1n;
    return stat;
  });
  const read = vi.spyOn(fs, "readSync");
  const response = await serve({ url: `foom-preview://${id}/a.html` });
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("Preview file unavailable");
  expect(read).not.toHaveBeenCalled();
  await f.host.dispose(false);
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
  const response = await partition.protocol.handle.mock.calls[0]?.[1]({
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

test("bundled manual has a fixed isolated root, is reusable and never persists or enables network", async () => {
  const f = await fixture(undefined, true);
  await expect(f.host.openManual()).rejects.toThrow("Manual unavailable");
  await writeFile(join(f.root, "manual.html"), "<h1>Manual</h1>");
  const id = await f.host.openManual();
  expect(await f.host.openManual()).toBe(id);
  expect(f.registry.records.size).toBe(1);
  expect(f.validate).not.toHaveBeenCalled();
  const view = fake.views.at(-1);
  if (!view) throw new Error("Missing manual view");
  const serve = partition.protocol.handle.mock.calls.at(-1)?.[1];
  if (!serve) throw new Error("Missing manual handler");
  expect(await (await serve({ url: `foom-preview://${id}/manual.html` })).text()).toBe(
    "<h1>Manual</h1>",
  );
  expect((await serve({ url: `foom-preview://${id}/%2e%2e/secret` })).status).not.toBe(200);
  await expect(f.host.network(id, true)).rejects.toThrow("no network");
  f.host.focusManual("unknown");
  f.host.bounds(id, { x: 0, y: 0, width: 200, height: 200, visible: true });
  f.host.focusManual(id);
  view.webContents.emit("did-finish-load");
  expect(view.webContents.focus).toHaveBeenCalled();
  f.host.focusManual(id);
  await f.host.reconcile();
  expect(f.registry.records.has(id)).toBe(true);
  await f.registry.save();
  expect(JSON.parse(fs.readFileSync(join(f.root, "registry.json"), "utf8"))).toEqual([]);
  const other = await fixture(undefined, true);
  await writeFile(join(other.root, "manual.html"), "<h1>Bundled manual</h1>");
  await f.host.moveTo(id, other.host);
  other.host.bounds(id, { x: 0, y: 0, width: 200, height: 200, visible: true });
  const moved = fake.views.at(-1);
  if (!moved) throw new Error("Missing moved manual");
  moved.webContents.emit("did-finish-load");
  other.host.focusManual(id);
  expect(moved.webContents.focus).toHaveBeenCalled();
  await other.host.dispose(true);
  await f.host.dispose(true);
  expect(f.registry.records.size).toBe(0);
  await expect(f.host.openManual()).rejects.toThrow("Manual unavailable");
  const plain = await fixture();
  await expect(plain.host.openManual()).rejects.toThrow("Manual unavailable");
});

test("manual reload validates ownership, preserves network and only routes focused native previews", async () => {
  const f = await fixture(() => Promise.resolve(true));
  const { id, view } = await f.open();
  const wc = view.webContents;
  expect(() => f.host.reload("b".repeat(32))).toThrow("Unknown preview ID");
  f.host.bounds(id, { x: 0, y: 0, width: 300, height: 200, visible: true });
  wc.emit("did-finish-load");
  f.window.isFocused.mockReturnValue(true);
  f.host.reloadFocused();
  expect(wc.reload).not.toHaveBeenCalled();
  await f.host.reload(id);
  expect(wc.reload).toHaveBeenCalledOnce();
  const replacement = fake.views.at(-1);
  if (!replacement) throw new Error("Missing replacement");
  const next = replacement.webContents;
  next.emit("did-finish-load");
  expect(next.focus).not.toHaveBeenCalled();
  await f.host.network(id, true);
  await vi.waitFor(() => {
    expect(fake.views.at(-1)).not.toBe(replacement);
  });
  const focused = fake.views.at(-1);
  if (!focused) throw new Error("Missing network replacement");
  focused.webContents.emit("did-finish-load");
  focused.webContents.emit(
    "before-mouse-event",
    { preventDefault: vi.fn() },
    { type: "mouseDown" },
  );
  focused.webContents.isFocused.mockReturnValue(true);
  f.window.isFocused.mockReturnValue(false);
  f.host.reloadFocused();
  expect(focused.webContents.reload).not.toHaveBeenCalled();
  f.window.isFocused.mockReturnValue(true);
  f.host.reloadFocused();
  await vi.waitFor(() => {
    expect(focused.webContents.reload).toHaveBeenCalledOnce();
  });
  expect(f.registry.records.get(id)?.network).toBe(true);
  await f.host.dispose(true);
  expect(() => f.host.reload(id)).toThrow("Unknown preview ID");
  f.host.reloadFocused();
});

test("preview requests yield while filesystem resolution is pending", async () => {
  const f = await fixture();
  const { id } = await f.open();
  const serve = partition.protocol.handle.mock.calls[0]?.[1];
  if (!serve) throw new Error("Missing protocol");
  const realpath = fs.promises.realpath;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resolve = vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async (file) => {
    await gate;
    return realpath(file);
  });
  const response = serve({ url: `foom-preview://${id}/a.html` });
  try {
    expect(resolve).toHaveBeenCalled();
    let completed = false;
    void Promise.resolve(response).then(() => {
      completed = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(completed).toBe(false);
    expect(f.host.visible(id)).toBe(false);
  } finally {
    release();
    await response;
    await f.host.dispose(false);
  }
});

test("opening validates and closes the document without reading its body", async () => {
  const f = await fixture();
  const open = fs.promises.open;
  const reads: ReturnType<typeof vi.spyOn>[] = [];
  const closes: ReturnType<typeof vi.spyOn>[] = [];
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    reads.push(vi.spyOn(handle, "read"), vi.spyOn(handle, "readFile"));
    closes.push(vi.spyOn(handle, "close"));
    return handle;
  });
  await f.open();
  expect(closes).not.toHaveLength(0);
  for (const read of reads) expect(read).not.toHaveBeenCalled();
  for (const close of closes) expect(close).toHaveBeenCalledOnce();
  await f.host.dispose(false);
});

test("pending document validation cannot create a preview after host disposal", async () => {
  const f = await fixture();
  const realpath = fs.promises.realpath;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async (file) => {
    started();
    await gate;
    return realpath(file);
  });
  const opening = f.host.open(f.root, "a.html");
  const refused = expect(opening).rejects.toThrow("Preview host closed");
  await entered;
  await f.host.dispose(false);
  release();
  await refused;
  expect(f.registry.records.size).toBe(0);
  expect(fake.views).toHaveLength(0);
});

test("concurrent manual opens reuse one record and disposal cancels pending opens", async () => {
  const f = await fixture(undefined, true);
  await writeFile(join(f.root, "manual.html"), "<h1>Manual</h1>");
  const [first, second] = await Promise.all([f.host.openManual(), f.host.openManual()]);
  expect(first).toBe(second);
  expect(f.registry.records.size).toBe(1);
  expect(fake.views).toHaveLength(1);
  await f.host.dispose(false);

  const pending = await fixture(undefined, true);
  await writeFile(join(pending.root, "manual.html"), "<h1>Manual</h1>");
  const realpath = fs.promises.realpath;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(fs.promises, "realpath").mockImplementationOnce(async (file) => {
    await gate;
    return realpath(file);
  });
  const opening = pending.host.openManual();
  const refused = expect(opening).rejects.toThrow("Manual unavailable");
  await pending.host.dispose(false);
  release();
  await refused;
  expect(pending.registry.records.size).toBe(0);
});
