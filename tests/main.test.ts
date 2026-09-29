import type { BrowserWindowConstructorOptions, Input } from "electron";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/terminal", () => ({ attachTerminal: vi.fn() }));

type ShortcutInput = Pick<Input, "type" | "key" | "control" | "shift" | "alt" | "meta">;

const mock = vi.hoisted(() => {
  const appEvents = new Map<string, () => void>();
  const windowEvents = new Map<
    string,
    (event: { preventDefault(): void }, input?: ShortcutInput) => void
  >();
  const readyEvents = new Map<string, () => void>();
  const window = {
    webContents: {
      copy: vi.fn(),
      paste: vi.fn(),
      setWindowOpenHandler: vi.fn<(handler: () => { action: "deny" }) => void>(),
      on: vi.fn(
        (
          name: string,
          handler: (event: { preventDefault(): void }, input?: ShortcutInput) => void,
        ) => {
          windowEvents.set(name, handler);
        },
      ),
    },
    once: vi.fn((name: string, handler: () => void) => {
      readyEvents.set(name, handler);
    }),
    removeMenu: vi.fn(),
    show: vi.fn(),
    loadURL: vi.fn<(url: string) => Promise<void>>(),
  };
  const state = { windows: [window] };
  const construct = vi.fn<(options: BrowserWindowConstructorOptions) => void>();
  class BrowserWindow {
    webContents = window.webContents;
    once = window.once;
    removeMenu = window.removeMenu;
    show = window.show;
    loadURL = window.loadURL;
    constructor(options: BrowserWindowConstructorOptions) {
      construct(options);
    }
    static getAllWindows() {
      return state.windows;
    }
  }
  return {
    BrowserWindow,
    construct,
    window,
    state,
    appEvents,
    windowEvents,
    readyEvents,
    ready: vi.fn<() => Promise<void>>(),
    quit: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
    protocolHandle:
      vi.fn<
        (scheme: string, handler: (request: Request) => Response | Promise<Response>) => void
      >(),
    fetch: vi.fn<(url: string) => Promise<Response>>(),
    permissionRequest:
      vi.fn<
        (
          handler: (
            contents: unknown,
            permission: string,
            callback: (allowed: boolean) => void,
          ) => void,
        ) => void
      >(),
    permissionCheck: vi.fn<(handler: () => boolean) => void>(),
  };
});
vi.mock("electron", () => ({
  BrowserWindow: mock.BrowserWindow,
  app: {
    whenReady: mock.ready,
    quit: mock.quit,
    on: (name: string, handler: () => void) => {
      mock.appEvents.set(name, handler);
    },
  },
  protocol: {
    registerSchemesAsPrivileged: mock.registerSchemesAsPrivileged,
    handle: mock.protocolHandle,
  },
  net: { fetch: mock.fetch },
  session: {
    defaultSession: {
      setPermissionRequestHandler: mock.permissionRequest,
      setPermissionCheckHandler: mock.permissionCheck,
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.appEvents.clear();
  mock.windowEvents.clear();
  mock.readyEvents.clear();
  mock.state.windows = [mock.window];
  mock.ready.mockResolvedValue();
  mock.window.loadURL.mockResolvedValue();
  mock.fetch.mockResolvedValue(new Response("asset"));
});

async function start() {
  await import("../src/main");
}

test("creates a sandboxed window, loads our document, and only shows it when ready", async () => {
  await start();
  const options = mock.construct.mock.calls[0]?.[0];
  expect(options?.show).toBe(false);
  expect(options?.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
  });
  expect(mock.window.loadURL).toHaveBeenCalledWith("app://bundle/index.html");
  expect(mock.window.show).not.toHaveBeenCalled();
  expect(mock.window.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({
    action: "deny",
  });
  mock.readyEvents.get("ready-to-show")?.();
  expect(mock.window.show).toHaveBeenCalledOnce();
  for (const name of ["will-navigate", "will-attach-webview"]) {
    const event = { preventDefault: vi.fn() };
    mock.windowEvents.get(name)?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  }
});

test("serves allowlisted local assets and rejects other hosts, paths, and methods", async () => {
  await start();
  const handler = mock.protocolHandle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing protocol handler");
  for (const asset of ["index.html", "styles.css", "renderer.js", "renderer.css"]) {
    expect((await handler(new Request(`app://bundle/${asset}`))).status).toBe(200);
    expect(mock.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(new RegExp(`/renderer/${asset.replace(".", "\\.")}$$`)),
    );
  }
  for (const url of [
    "app://other/index.html",
    "app://bundle/main.js",
    "app://bundle/../preload.js",
  ]) {
    expect((await handler(new Request(url))).status).toBe(404);
  }
  expect((await handler(new Request("app://bundle/index.html", { method: "POST" }))).status).toBe(
    404,
  );
  expect(mock.fetch).toHaveBeenCalledTimes(4);
});

test("denies requested and checked permissions", async () => {
  await start();
  const callback = vi.fn();
  mock.permissionRequest.mock.calls[0]?.[0](null, "media", callback);
  expect(callback).toHaveBeenCalledWith(false);
  expect(mock.permissionCheck.mock.calls[0]?.[0]()).toBe(false);
});

test("recreates a window on activation only when none remain", async () => {
  await start();
  mock.appEvents.get("activate")?.();
  expect(mock.construct).toHaveBeenCalledTimes(1);
  mock.state.windows = [];
  mock.appEvents.get("activate")?.();
  expect(mock.construct).toHaveBeenCalledTimes(2);
});

test.each(["darwin", "linux", "win32"])(
  "uses platform-appropriate window-close behavior on %s",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    await start();
    mock.appEvents.get("window-all-closed")?.();
    expect(mock.quit).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
  },
);

test("quits with a diagnostic if the document cannot load", async () => {
  const error = new Error("Load failed");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.loadURL.mockRejectedValue(error);
  await start();
  expect(log).toHaveBeenCalledWith("Unable to load the application:", error);
  expect(mock.quit).toHaveBeenCalledOnce();
});

test("quits with a diagnostic if startup fails", async () => {
  const error = new Error("Startup failed");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.ready.mockRejectedValue(error);
  await start();
  expect(log).toHaveBeenCalledWith("Unable to start the application:", error);
  expect(mock.quit).toHaveBeenCalledOnce();
});

test.each(["c", "C", "v", "V"])("handles Ctrl+Shift+%s without a menu", async (key) => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("before-input-event")?.(event, {
    type: "keyDown",
    key,
    control: true,
    shift: true,
    alt: false,
    meta: false,
  });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mock.window.webContents.copy).toHaveBeenCalledTimes(key.toLowerCase() === "c" ? 1 : 0);
  expect(mock.window.webContents.paste).toHaveBeenCalledTimes(key.toLowerCase() === "v" ? 1 : 0);
});

test.each<Partial<ShortcutInput>>([
  { type: "keyUp" },
  { control: false },
  { shift: false },
  { alt: true },
  { meta: true },
  { key: "w" },
])("leaves other keys to the terminal (%j)", async (overrides) => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("before-input-event")?.(event, {
    type: "keyDown",
    key: "c",
    control: true,
    shift: true,
    alt: false,
    meta: false,
    ...overrides,
  });
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(mock.window.webContents.copy).not.toHaveBeenCalled();
  expect(mock.window.webContents.paste).not.toHaveBeenCalled();
});
