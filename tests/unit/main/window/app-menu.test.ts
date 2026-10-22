import type * as Fs from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
const mock = vi.hoisted(() => ({
  read: vi.fn(() => Promise.resolve("Bundled license text")),
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
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof Fs>()),
  readFile: mock.read,
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
    getAppPath: () => process.cwd(),
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
import { attachAppMenu, showWindowlessMenu } from "../../../../src/main/window/app-menu";
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mock.handlers.clear();
  mock.packaged = false;
});
function fixture(platform: NodeJS.Platform = "linux", defaults = false) {
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
    isFocused: vi.fn(() => true),
    minimize: vi.fn(),
    isMaximized: vi.fn(() => false),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
  });
  const zoom = vi.fn<() => Promise<void>>().mockResolvedValue();
  const scale = vi.fn(() => Promise.resolve(110));
  const attached = attachAppMenu(
    window as unknown as BrowserWindow,
    zoom,
    undefined,
    undefined,
    defaults ? undefined : scale,
  );
  const trusted = { sender: contents, senderFrame: frame };
  const invoke = (channel: string, value?: unknown, event: unknown = trusted) =>
    mock.handlers.get(`app-menu:${channel}`)?.(event, value);
  /** Every handler, synchronous or not, as a promise. */
  const call = (channel: string, value?: unknown, event: unknown = trusted) =>
    Promise.resolve().then(() => invoke(channel, value, event));
  return { window, contents, attached, invoke, call, trusted, frame, zoom, scale };
}
test("validates each sender and command ID, projects data only and disposes handlers", async () => {
  const f = fixture();
  for (const channel of ["list", "shortcuts", "execute", "view", "version", "legal"]) {
    for (const event of [
      { sender: {}, senderFrame: f.frame },
      { sender: f.contents, senderFrame: null },
      { sender: f.contents, senderFrame: { ...f.frame } },
    ])
      await expect(f.call(channel, undefined, event)).rejects.toThrow("Untrusted");
  }
  f.frame.url = "https://evil.test";
  await expect(f.call("list")).rejects.toThrow("Untrusted");
  await expect(f.call("shortcuts")).rejects.toThrow("Untrusted");
  f.frame.url = "app://bundle/index.html";
  for (const id of [null, {}, "missing", "settings-menu", "size", "via-claude"])
    await expect(f.call("execute", id)).rejects.toThrow("Unavailable");
  expect(f.contents.send).not.toHaveBeenCalled();
  const list = await f.call("list");
  expect(list).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "command", id: "quit", enabled: true }),
      expect.objectContaining({ kind: "size", scale: 110 }),
      expect.objectContaining({ kind: "command", id: "settings", label: "Settings…" }),
    ]),
  );
  expect(await f.call("shortcuts")).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: "Tiles" })]),
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
    "add-repository",
    "shortcuts",
  ])
    await f.call("execute", id);
  expect(mock.quit).toHaveBeenCalledOnce();
  expect(f.window.close).toHaveBeenCalledOnce();
  expect(mock.about).not.toHaveBeenCalled();
  expect(mock.external).toHaveBeenCalledWith("https://github.com/scott-r-lindsey/foom");
  expect(f.contents.send).toHaveBeenCalledWith("board:command", "sidebar");
  expect(f.contents.send).toHaveBeenCalledWith("board:command", "add-repository");
  expect(f.contents.send).toHaveBeenCalledWith("app-menu:shortcuts");
  expect(f.zoom).toHaveBeenCalledWith("in");
  expect(f.contents.reload).toHaveBeenCalledOnce();
  f.window.isMaximized.mockReturnValue(true);
  await f.call("execute", "zoom");
  expect(f.window.unmaximize).toHaveBeenCalledOnce();
  mock.message.mockResolvedValue({ response: 0 });
  await f.call("execute", "licenses");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  f.zoom.mockRejectedValue(new Error("disk full"));
  // A failed step is logged, not thrown at the renderer.
  await f.call("execute", "zoom-reset");
  expect(log).toHaveBeenCalled();
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
test("keys prevented by the preview handoff cannot invoke board shortcuts", () => {
  const f = fixture();
  f.contents.emit(
    "before-input-event",
    { defaultPrevented: true, preventDefault: vi.fn() },
    {
      type: "keyDown",
      code: "F10",
      meta: false,
      control: false,
      shift: false,
      alt: false,
    },
  );
  expect(f.contents.send).not.toHaveBeenCalledWith("app-menu:open");
  f.attached.dispose();
});
test("packaged execution rejects developer commands and validates view state before updating menus", async () => {
  mock.packaged = true;
  const f = fixture("darwin");
  for (const id of ["reload", "force-reload", "devtools"])
    await expect(f.call("execute", id)).rejects.toThrow("Unavailable");
  for (const state of [
    null,
    {},
    { available: 1 },
    { available: true },
    { available: true, maximized: false },
    { available: true, maximized: false, tiles: "1" },
    { available: true, configAvailable: "yes", maximized: false, tiles: 1 },
    { available: true, maximized: false, tiles: -1 },
    { available: true, maximized: false, tiles: 257 },
    { available: true, maximized: false, tiles: 1.5 },
    { available: true, maximized: false, tiles: 1, sidebarCollapsed: "yes" },
  ])
    expect(() => f.invoke("view", state)).toThrow("Invalid");
  f.invoke("view", { available: true, maximized: false, tiles: 0 });
  await expect(f.call("execute", "tile-1")).rejects.toThrow("Unavailable");
  f.invoke("view", { available: true, maximized: true, tiles: 2, sidebarCollapsed: true });
  // The macOS menu bar still carries the board commands the wordmark menu leaves out.
  const bar = (mock.menu.mock.lastCall?.[0] ?? []) as MenuItemConstructorOptions[];
  const native = bar.flatMap((section) => (Array.isArray(section.submenu) ? section.submenu : []));
  expect(native).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "maximize", checked: true }),
      expect.objectContaining({ id: "toggle-sidebar", label: "Expand sidebar" }),
      expect.objectContaining({ id: "tile-3", enabled: false }),
    ]),
  );
  expect(JSON.stringify(await f.call("list"))).not.toContain('"maximize"');
  f.invoke("view", { available: false, configAvailable: true, maximized: false, tiles: 1 });
  await f.call("execute", "toggle-sidebar");
  expect(f.window.webContents.send).toHaveBeenCalledWith("board:command", "toggle-sidebar");
  await expect(f.call("execute", "maximize")).rejects.toThrow("Unavailable");
  f.attached.dispose();
});

test("a background macOS board cannot replace the focused window's native menu", () => {
  const f = fixture("darwin");
  mock.menu.mockClear();
  f.window.isFocused.mockReturnValue(false);
  f.invoke("view", { available: true, maximized: false, tiles: 2 });
  expect(mock.menu).not.toHaveBeenCalled();
  f.window.isFocused.mockReturnValue(true);
  f.window.emit("focus");
  expect(mock.menu).toHaveBeenCalledOnce();
});

test("windowless macOS menu keeps native New Window and Quit accelerators without stale board callbacks", () => {
  const open = vi.fn();
  showWindowlessMenu(open);
  const sections: MenuItemConstructorOptions[] = mock.menu.mock
    .lastCall?.[0] as MenuItemConstructorOptions[];
  const items = sections.flatMap((section) =>
    Array.isArray(section.submenu) ? section.submenu : [],
  );
  expect(items.map((item) => item.label)).toEqual([
    "About Foom",
    "Quit Foom",
    "Manual",
    "New Window",
  ]);
  for (const item of items) item.click?.({} as Electron.MenuItem, undefined, {});
  expect(mock.about).not.toHaveBeenCalled();
  expect(mock.quit).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledTimes(3);
  expect(open).toHaveBeenCalledWith("manual");
  expect(
    items
      .filter((item) => item.accelerator)
      .map((item) => [item.accelerator, item.registerAccelerator]),
  ).toEqual([
    ["Command+Q", true],
    ["Command+N", true],
  ]);
});

test.each(["darwin", "linux", "win32"] as const)(
  "%s app menus expose Settings directly and reject removed agent routes",
  async (platform) => {
    const f = fixture(platform);
    const list = JSON.stringify(await f.call("list"));
    expect(list).not.toContain("via-");
    expect(list).not.toContain("Via Settings UI");
    await f.call("execute", "settings");
    expect(f.contents.send).toHaveBeenLastCalledWith("board:command", "settings");
    for (const id of ["via-claude", "via-codex", "via-agy", "via-new-provider"])
      await expect(f.call("execute", id)).rejects.toThrow("Unavailable");
    f.window.emit("focus");
    await f.call("view", { available: false, configAvailable: true, maximized: false, tiles: 0 });
    expect(JSON.stringify(await f.call("list"))).not.toContain("via-");
    f.attached.dispose();
  },
);

test("an adapter with default services keeps the default scale", async () => {
  const f = fixture("linux", true);
  expect(await f.call("list")).toContainEqual(
    expect.objectContaining({ kind: "size", scale: 100 }),
  );
  await f.call("execute", "manual");
  await f.call("execute", "new-window");
  f.attached.dispose();
});

test("About publishes versions and legal commands only notify the board", async () => {
  const f = fixture();
  expect(await f.call("version")).toEqual({ app: "1", electron: process.versions.electron });
  await f.call("execute", "about");
  expect(f.contents.send).toHaveBeenCalledWith("board:command", "about");
  for (const id of ["licenses", "notices"]) {
    await f.call("execute", id);
    expect(f.contents.send).toHaveBeenCalledWith("app-menu:legal", id);
  }
  expect(mock.read).not.toHaveBeenCalled();
  expect(mock.message).not.toHaveBeenCalled();
  await expect(f.call("execute", "../../LICENSE")).rejects.toThrow("Unavailable");
  f.attached.dispose();
});

test("legal reads accept only fixed bundled IDs and propagate unavailable files", async () => {
  const f = fixture();
  for (const id of [null, {}, "../../LICENSE", "github", "LICENSE"])
    await expect(f.call("legal", id)).rejects.toThrow("Invalid legal document");
  expect(mock.read).not.toHaveBeenCalled();
  for (const [id, file] of [
    ["licenses", "LICENSE"],
    ["notices", "build/THIRD_PARTY_NOTICES.txt"],
  ]) {
    await expect(f.call("legal", id)).resolves.toBe("Bundled license text");
    expect(mock.read).toHaveBeenLastCalledWith(join(process.cwd(), file ?? ""), "utf8");
  }
  for (const text of ["", "x".repeat(1_048_577)]) {
    mock.read.mockResolvedValueOnce(text);
    await expect(f.call("legal", "notices")).rejects.toThrow("Invalid bundled legal text");
  }
  mock.read.mockRejectedValueOnce(new Error("missing"));
  await expect(f.call("legal", "notices")).rejects.toThrow("missing");
  f.attached.dispose();
});
