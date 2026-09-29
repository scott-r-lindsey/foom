import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron";
import { beforeEach, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => {
  const appEvents = new Map<string, () => void>();
  const windowEvents = new Map<string, (event: { preventDefault(): void }) => void>();
  const readyEvents = new Map<string, () => void>();
  const window = {
    webContents: {
      setWindowOpenHandler: vi.fn<(handler: () => { action: "deny" }) => void>(),
      on: vi.fn((name: string, handler: (event: { preventDefault(): void }) => void) => {
        windowEvents.set(name, handler);
      }),
    },
    once: vi.fn((name: string, handler: () => void) => {
      readyEvents.set(name, handler);
    }),
    show: vi.fn(),
    loadURL: vi.fn<(url: string) => Promise<void>>(),
  };
  const state = { windows: [window] };
  const construct = vi.fn<(options: BrowserWindowConstructorOptions) => void>();
  class BrowserWindow {
    webContents = window.webContents;
    once = window.once;
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
    ipcHandle: vi.fn<(channel: string, handler: (event: IpcMainInvokeEvent) => string) => void>(),
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
  ipcMain: { handle: mock.ipcHandle },
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

function ipcEvent(url: string, isMainFrame = true, detached = false): IpcMainInvokeEvent {
  const frame = { url };
  // A deliberately minimal Electron event fixture; runtime guards are what we exercise.
  return {
    senderFrame: detached ? null : frame,
    sender: { mainFrame: isMainFrame ? frame : {} },
  } as unknown as IpcMainInvokeEvent;
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
  for (const asset of ["index.html", "styles.css", "renderer.js"]) {
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
  expect(mock.fetch).toHaveBeenCalledTimes(3);
});

test("accepts only the trusted top-level frame for IPC", async () => {
  await start();
  const handler = mock.ipcHandle.mock.calls[0]?.[1];
  if (!handler) throw new Error("Missing IPC handler");
  expect(handler(ipcEvent("app://bundle/index.html"))).toBe("Hello from the main process!");
  for (const event of [
    ipcEvent("https://evil.example"),
    ipcEvent("app://bundle/index.html", false),
    ipcEvent("app://bundle/index.html", true, true),
  ]) {
    expect(() => handler(event)).toThrow("Untrusted IPC sender");
  }
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
