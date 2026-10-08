import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  menu: vi.fn(),
  quit: vi.fn(),
  about: vi.fn(),
  hide: vi.fn(),
  responder: vi.fn(),
  external: vi.fn(),
  message: vi.fn(),
  packaged: false,
}));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mock.packaged;
    },
    quit: mock.quit,
    showAboutPanel: mock.about,
    hide: mock.hide,
    getVersion: () => "1",
    setAboutPanelOptions: vi.fn(),
  },
  Menu: {
    buildFromTemplate: (items: MenuItemConstructorOptions[]) => items,
    setApplicationMenu: mock.menu,
    sendActionToFirstResponder: mock.responder,
  },
  dialog: { showMessageBox: mock.message },
  shell: { openExternal: mock.external },
  ipcMain: {
    handle: (name: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      mock.handlers.set(name, fn),
    removeHandler: (name: string) => mock.handlers.delete(name),
  },
}));
import { attachAppMenu } from "../../../../src/main/window/app-menu";
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mock.handlers.clear();
  mock.packaged = false;
});
function fixture(platform: NodeJS.Platform = "linux") {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const frame = { url: "app://bundle/index.html" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    send: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    cut: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    selectAll: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    toggleDevTools: vi.fn(),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    removeMenu: vi.fn(),
    minimize: vi.fn(),
    isMaximized: vi.fn(() => false),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
  });
  const zoom = vi.fn<() => Promise<void>>().mockResolvedValue();
  const attached = attachAppMenu(window as unknown as BrowserWindow, zoom);
  const trusted = { sender: contents, senderFrame: frame };
  const invoke = (channel: string, value?: unknown, event: unknown = trusted) =>
    mock.handlers.get(`app-menu:${channel}`)?.(event, value);
  return { window, contents, attached, invoke, trusted, frame, zoom };
}
test("validates each sender and command ID, projects data only and disposes handlers", () => {
  const f = fixture();
  for (const channel of ["list", "execute", "view"]) {
    for (const event of [
      { sender: {}, senderFrame: f.frame },
      { sender: f.contents, senderFrame: null },
      { sender: f.contents, senderFrame: { ...f.frame } },
    ])
      expect(() => f.invoke(channel, undefined, event)).toThrow("Untrusted");
  }
  f.frame.url = "https://evil.test";
  expect(() => f.invoke("list")).toThrow("Untrusted");
  f.frame.url = "app://bundle/index.html";
  for (const id of [null, {}, "missing"])
    expect(() => f.invoke("execute", id)).toThrow("Unavailable");
  expect(f.invoke("list")).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "quit", enabled: true })]),
  );
  expect(mock.menu).toHaveBeenCalledWith(null);
  f.attached.dispose();
  expect(mock.handlers.size).toBe(0);
  expect(f.contents.listenerCount("before-input-event")).toBe(0);
  expect(f.window.listenerCount("blur")).toBe(0);
});
test("dispatches native actions, zoom failures and keyboard gestures", async () => {
  const f = fixture("darwin");
  mock.message.mockResolvedValue({ response: 1 });
  for (const id of [
    "about",
    "quit",
    "close-window",
    "github",
    "licenses",
    "copy",
    "paste",
    "cut",
    "undo",
    "redo",
    "selectAll",
    "hide",
    "hide-others",
    "minimize",
    "zoom",
    "front",
    "reload",
    "force-reload",
    "devtools",
    "sidebar",
    "zoom-in",
  ])
    f.invoke("execute", id);
  await Promise.resolve();
  expect(mock.quit).toHaveBeenCalledOnce();
  expect(f.window.close).toHaveBeenCalledOnce();
  expect(mock.about).toHaveBeenCalledOnce();
  expect(mock.external).toHaveBeenCalledWith("https://github.com/scott-r-lindsey/foom");
  expect(f.contents.send).toHaveBeenCalledWith("board:command", "sidebar");
  expect(f.contents.reload).toHaveBeenCalledOnce();
  f.window.isMaximized.mockReturnValue(true);
  f.invoke("execute", "zoom");
  expect(f.window.unmaximize).toHaveBeenCalledOnce();
  mock.message.mockResolvedValue({ response: 0 });
  f.invoke("execute", "licenses");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  f.zoom.mockRejectedValue(new Error("disk full"));
  f.invoke("execute", "zoom-reset");
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalled();
  });
  const event = { preventDefault: vi.fn() };
  f.contents.emit("before-input-event", event, {
    type: "keyDown",
    code: "KeyQ",
    meta: true,
    control: false,
    shift: false,
    alt: false,
  });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  f.contents.emit("before-input-event", event, {
    type: "keyDown",
    code: "KeyC",
    meta: false,
    control: true,
    shift: false,
    alt: false,
  });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  f.attached.dispose();
  const linux = fixture();
  linux.contents.emit("before-input-event", event, {
    type: "keyDown",
    code: "F10",
    meta: false,
    control: false,
    shift: false,
    alt: false,
  });
  expect(linux.contents.send).toHaveBeenCalledWith("app-menu:open");
  linux.attached.dispose();
});
test("packaged execution rejects developer commands and validates view state before updating menus", () => {
  mock.packaged = true;
  const f = fixture("darwin");
  for (const id of ["reload", "force-reload", "devtools"])
    expect(() => f.invoke("execute", id)).toThrow("Unavailable");
  for (const state of [
    null,
    {},
    { available: 1 },
    { available: true },
    { available: true, maximized: false },
    { available: true, maximized: false, tiles: "1" },
    { available: true, maximized: false, tiles: 0 },
    { available: true, maximized: false, tiles: 257 },
    { available: true, maximized: false, tiles: 1.5 },
  ])
    expect(() => f.invoke("view", state)).toThrow("Invalid");
  f.invoke("view", { available: true, maximized: true, tiles: 2 });
  expect(f.invoke("list")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "maximize", checked: true }),
      expect.objectContaining({ id: "tile-3", enabled: false }),
    ]),
  );
  f.invoke("view", { available: false, maximized: false, tiles: 1 });
  expect(() => f.invoke("execute", "maximize")).toThrow("Unavailable");
  f.attached.dispose();
});
