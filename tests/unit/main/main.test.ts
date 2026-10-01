import type { BrowserWindowConstructorOptions, Input } from "electron";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../../src/main/terminals/terminal-ipc", () => ({
  attachTerminal: (_window: unknown, events: Record<string, (...args: never[]) => void>) => {
    mock.terminalEvents = events;
    return mock.terminals;
  },
}));
vi.mock("../../../src/main/workspace/workspace", () => ({
  Workspace: class {
    quiet = mock.workspace.quiet;
    exited = mock.workspace.exited;
    input = mock.workspace.input;
    removed = mock.workspace.removed;
    hook = mock.workspace.hook;
    dispose = mock.workspace.dispose;
    configure = mock.workspace.configure;
    constructor(deps: unknown) {
      mock.workspace.deps = deps;
    }
  },
}));
vi.mock("../../../src/main/workspace/workspace-ipc", () => ({
  attachWorkspace: mock.attachWorkspace,
}));
vi.mock("../../../src/main/agents/hook-receiver", () => ({
  HookReceiver: { listen: mock.listen },
}));
vi.mock("../../../src/main/evaluator/verdict-log", () => ({ VerdictLog: mock.VerdictLog }));
vi.mock("../../../src/main/evaluator/inference-keys", () => ({ InferenceKeys: vi.fn() }));
vi.mock("../../../src/main/setup/settings", () => ({ SettingsStore: { open: mock.openSettings } }));
vi.mock("../../../src/main/setup/setup", () => ({
  Setup: class {
    classify = mock.setup.classify;
    constructor(deps: unknown) {
      mock.setup.deps = deps;
    }
  },
}));
vi.mock("../../../src/main/setup/setup-ipc", () => ({ attachSetup: mock.attachSetup }));
vi.mock("../../../src/main/workspace/worktrees", () => ({
  WorktreeService: { open: mock.openWorktrees },
}));

type ShortcutInput = Pick<Input, "type" | "key" | "control" | "shift" | "alt" | "meta"> &
  Partial<Pick<Input, "code">>;

const mock = vi.hoisted(() => {
  const appEvents = new Map<string, (event: { preventDefault(): void }) => void>();
  const windowEvents = new Map<
    string,
    (event: { preventDefault(): void }, input?: ShortcutInput) => void
  >();
  const readyEvents = new Map<string, () => void>();
  const window = {
    webContents: {
      copy: vi.fn(),
      paste: vi.fn(),
      setZoomFactor: vi.fn(),
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
      // Several modules listen for the same window event; run them all.
      const previous = readyEvents.get(name);
      readyEvents.set(
        name,
        previous
          ? () => {
              previous();
              handler();
            }
          : handler,
      );
    }),
    on: vi.fn((name: string, handler: (event: { preventDefault(): void }) => void) => {
      windowEvents.set(name, handler);
    }),
    removeMenu: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1080, height: 768 })),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1080, height: 768 })),
    setBounds: vi.fn(),
    setMinimumSize: vi.fn(),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    show: vi.fn(),
    setBackgroundColor: vi.fn(),
    loadURL: vi.fn<(url: string) => Promise<void>>(),
  };
  const state = { windows: [window] };
  const construct = vi.fn<(options: BrowserWindowConstructorOptions) => void>();
  class BrowserWindow {
    webContents = window.webContents;
    once = window.once;
    on = window.on;
    removeMenu = window.removeMenu;
    getBounds = window.getBounds;
    getContentBounds = window.getContentBounds;
    setBounds = window.setBounds;
    setMinimumSize = window.setMinimumSize;
    isMaximized = window.isMaximized;
    isFullScreen = window.isFullScreen;
    show = window.show;
    setBackgroundColor = window.setBackgroundColor;
    loadURL = window.loadURL;
    constructor(options: BrowserWindowConstructorOptions) {
      construct(options);
    }
    static getAllWindows() {
      return state.windows;
    }
  }
  const workspace = {
    deps: undefined as unknown,
    quiet: vi.fn(),
    exited: vi.fn(),
    input: vi.fn(),
    removed: vi.fn(),
    hook: vi.fn(),
    dispose: vi.fn<() => Promise<void>>(),
    configure: vi.fn(),
  };
  const ipc = { sendChanged: vi.fn(), sendState: vi.fn(), dispose: vi.fn() };
  const setup = { deps: undefined as unknown, classify: vi.fn() };
  return {
    terminals: {
      runningCount: 0,
      shutdown: vi.fn<() => Promise<void>>(),
      owns: vi.fn<(id: string) => boolean>(),
    },
    terminalEvents: {},
    workspace,
    ipc,
    attachWorkspace: vi.fn<(...args: unknown[]) => typeof ipc>(() => ipc),
    setup,
    setupIpc: { dispose: vi.fn(), zoom: vi.fn<(direction: string) => Promise<void>>() },
    attachSetup: vi.fn<(...args: unknown[]) => unknown>(),
    openSettings: vi.fn<() => Promise<unknown>>(),
    settingsStore: {
      update: vi.fn(() => Promise.resolve()),
      get: () => ({ colorMode: "dark", interfaceScale: 120 }),
    },
    VerdictLog: vi.fn<(userData: string, classify: (input: unknown) => unknown) => void>(),
    listen: vi.fn(),
    theme: {
      themeSource: "system",
      shouldUseDarkColors: false,
      on: vi.fn<(name: string, handler: () => void) => void>(),
      removeListener: vi.fn(),
    },
    message: vi.fn<() => Promise<{ response: number }>>(),
    errorBox: vi.fn(),
    openDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
    openWorktrees: vi.fn<() => Promise<unknown>>(),
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
  nativeTheme: mock.theme,
  dialog: {
    showMessageBox: mock.message,
    showErrorBox: mock.errorBox,
    showOpenDialog: mock.openDialog,
  },
  app: {
    whenReady: mock.ready,
    getPath: () => "/test/user-data",
    quit: mock.quit,
    on: (name: string, handler: (event: { preventDefault(): void }) => void) => {
      mock.appEvents.set(name, handler);
    },
  },
  protocol: {
    registerSchemesAsPrivileged: mock.registerSchemesAsPrivileged,
    handle: mock.protocolHandle,
  },
  net: { fetch: mock.fetch },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 1000, y: 700 }),
  },
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
  mock.terminals.runningCount = 0;
  mock.terminals.shutdown.mockResolvedValue();
  mock.workspace.dispose.mockResolvedValue();
  mock.attachWorkspace.mockImplementation(() => mock.ipc);
  mock.message.mockResolvedValue({ response: 0 });
  mock.theme.shouldUseDarkColors = false;
  mock.appEvents.clear();
  mock.windowEvents.clear();
  mock.readyEvents.clear();
  mock.state.windows = [mock.window];
  mock.ready.mockResolvedValue();
  mock.openWorktrees.mockResolvedValue({ worktreeRoot: "/home/.foom/worktrees" });
  mock.openSettings.mockResolvedValue(mock.settingsStore);
  mock.attachSetup.mockImplementation(() => mock.setupIpc);
  mock.setupIpc.zoom.mockResolvedValue();
  mock.theme.themeSource = "system";
  mock.window.loadURL.mockResolvedValue();
  mock.fetch.mockResolvedValue(new Response("asset"));
});

async function start() {
  await import("../../../src/main/main");
}

test("loads worktree state from userData before creating a window", async () => {
  let finish: (() => void) | undefined;
  mock.openWorktrees.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          resolve({});
        };
      }),
  );
  await start();
  expect(mock.openWorktrees).toHaveBeenCalledWith("/test/user-data");
  expect(mock.construct).not.toHaveBeenCalled();
  finish?.();
  await vi.waitFor(() => {
    expect(mock.construct).toHaveBeenCalledOnce();
  });
});

test("reports persistence startup failures", async () => {
  const error = new Error("Cannot write state");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.openWorktrees.mockRejectedValueOnce(error);
  await start();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.construct).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("Unable to start the application:", error);
});

test("creates a sandboxed window, loads our document, and only shows it when ready", async () => {
  let loaded: (() => void) | undefined;
  mock.window.loadURL.mockReturnValueOnce(
    new Promise((resolve) => {
      loaded = resolve;
    }),
  );
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
  loaded?.();
  await Promise.resolve();
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
  for (const asset of [
    "index.html",
    "styles.css",
    "renderer.js",
    "renderer.css",
    "tokens.css",
    "fonts/archivo-black.ttf",
    "fonts/courier-prime.ttf",
    "fonts/geist.ttf",
    "fonts/geist-mono.ttf",
  ]) {
    expect((await handler(new Request(`app://bundle/${asset}`))).status).toBe(200);
    expect(mock.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(new RegExp(`/renderer/${asset.replace(".", "\\.")}$$`)),
    );
  }
  for (const url of [
    "app://other/index.html",
    "app://bundle/main.js",
    "app://bundle/fonts/unknown.ttf",
    "app://bundle/fonts/geist-OFL.txt",
    "app://bundle/../preload.js",
  ]) {
    expect((await handler(new Request(url))).status).toBe(404);
  }
  expect((await handler(new Request("app://bundle/index.html", { method: "POST" }))).status).toBe(
    404,
  );
  expect(mock.fetch).toHaveBeenCalledTimes(9);
});

test("denies requested and checked permissions", async () => {
  await start();
  const callback = vi.fn();
  mock.permissionRequest.mock.calls[0]?.[0](null, "media", callback);
  expect(callback).toHaveBeenCalledWith(false);
  expect(mock.permissionCheck.mock.calls[0]?.[0]()).toBe(false);
});

test("does not recreate a window on activation", async () => {
  await start();
  expect(mock.appEvents.has("activate")).toBe(false);
});

test.each(["darwin", "linux", "win32"] as const)(
  "quits after the last window closes on %s",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    await start();
    mock.appEvents.get("window-all-closed")?.({ preventDefault: vi.fn() });
    expect(mock.quit).toHaveBeenCalledOnce();
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

function quitting() {
  const event = { preventDefault: vi.fn() };
  mock.appEvents.get("before-quit")?.(event);
  return event;
}

test.each([true, false])("uses the native theme at window creation (dark: %s)", async (dark) => {
  mock.theme.shouldUseDarkColors = dark;
  await start();
  expect(mock.construct.mock.calls[0]?.[0].backgroundColor).toBe(dark ? "#05040A" : "#F3F0FA");
});

test("window close requests the same quit path without destroying the window", async () => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mock.quit).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});

test.each([1, 3])(
  "cancel preserves %s running terminals and permits another attempt",
  async (count) => {
    mock.terminals.runningCount = count;
    await start();
    expect(quitting().preventDefault).toHaveBeenCalledOnce();
    expect(mock.message).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        message: `${String(count)} ${count === 1 ? "terminal is" : "terminals are"} still running. Quit anyway?`,
        defaultId: 0,
        cancelId: 0,
      }),
    );
    await vi.waitFor(() => {
      expect(mock.message).toHaveResolved();
    });
    expect(mock.terminals.shutdown).not.toHaveBeenCalled();
    expect(mock.quit).not.toHaveBeenCalled();
    quitting();
    expect(mock.message).toHaveBeenCalledTimes(2);
  },
);

test("confirmed quit waits for termination, suppresses duplicate requests, then allows closing", async () => {
  mock.terminals.runningCount = 2;
  let confirm: (value: { response: number }) => void = () => {};
  let stop: () => void = () => {};
  mock.message.mockReturnValue(
    new Promise((resolve) => {
      confirm = resolve;
    }),
  );
  mock.terminals.shutdown.mockReturnValue(
    new Promise((resolve) => {
      stop = resolve;
    }),
  );
  await start();
  quitting();
  quitting();
  expect(mock.message).toHaveBeenCalledOnce();
  confirm({ response: 1 });
  await vi.waitFor(() => {
    expect(mock.terminals.shutdown).toHaveBeenCalledOnce();
  });
  quitting();
  expect(mock.message).toHaveBeenCalledOnce();
  expect(mock.quit).not.toHaveBeenCalled();
  stop();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(quitting().preventDefault).not.toHaveBeenCalled();
  const close = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(close);
  expect(close.preventDefault).not.toHaveBeenCalled();
});

test("quits without a confirmation when no PTYs are running", async () => {
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.message).not.toHaveBeenCalled();
  expect(mock.terminals.shutdown).toHaveBeenCalledOnce();
});

test.each(["dialog", "shutdown"])(
  "keeps the app open and allows retry after %s failure",
  async (failure) => {
    mock.terminals.runningCount = 1;
    const error = new Error("failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mock.message.mockResolvedValue({ response: 1 });
    if (failure === "dialog") mock.message.mockRejectedValueOnce(error);
    else mock.terminals.shutdown.mockRejectedValueOnce(error);
    await start();
    quitting();
    await vi.waitFor(() => {
      expect(mock.errorBox).toHaveBeenCalledOnce();
    });
    expect(log).toHaveBeenCalledWith("Unable to quit the application:", error);
    expect(mock.quit).not.toHaveBeenCalled();
    quitting();
    await vi.waitFor(() => {
      expect(mock.quit).toHaveBeenCalledOnce();
    });
  },
);

test.each([
  { platform: "darwin", key: "w", meta: true, control: false, alt: false },
  { platform: "darwin", key: "q", meta: true, control: false, alt: false },
  { platform: "linux", key: "q", meta: false, control: true, alt: false },
  { platform: "win32", key: "F4", meta: false, control: false, alt: true },
] as const)(
  "routes the quit shortcut through app.quit ($platform $key)",
  async ({ platform, ...input }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    await start();
    const event = { preventDefault: vi.fn() };
    mock.windowEvents.get("before-input-event")?.(event, {
      type: "keyDown",
      shift: false,
      ...input,
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mock.quit).toHaveBeenCalledOnce();
  },
);

test("keeps the native background in sync with theme updates and removes its listener on close", async () => {
  await start();
  const update = mock.theme.on.mock.calls[0]?.[1];
  for (const dark of [true, false]) {
    mock.theme.shouldUseDarkColors = dark;
    update?.();
    expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? "#05040A" : "#F3F0FA");
  }
  mock.readyEvents.get("closed")?.();
  expect(mock.theme.removeListener).toHaveBeenCalledWith("updated", update);
});

test("defers an already-idle quit until the native close callback has unwound", async () => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(event);
  await Promise.resolve();
  expect(mock.terminals.shutdown).toHaveBeenCalledOnce();
  expect(mock.quit).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});

test("reveals a loaded board even without a hidden-window paint and does not show it twice", async () => {
  await start();
  expect(mock.window.show).toHaveBeenCalledOnce();
  mock.readyEvents.get("ready-to-show")?.();
  expect(mock.window.show).toHaveBeenCalledOnce();
});

test("routes terminal events, hook signals and state through the workspace", async () => {
  await start();
  const events = mock.terminalEvents as {
    onQuiet(id: string): void;
    onExit(id: string, code: number): void;
    onInput(id: string): void;
    onRemoved(id: string): void;
  };
  events.onQuiet("a");
  events.onExit("a", 1);
  events.onInput("a");
  events.onRemoved("a");
  expect(mock.workspace.quiet).toHaveBeenCalledWith("a");
  expect(mock.workspace.exited).toHaveBeenCalledWith("a", 1);
  expect(mock.workspace.input).toHaveBeenCalledWith("a");
  expect(mock.workspace.removed).toHaveBeenCalledWith("a");

  const deps = mock.workspace.deps as {
    receiver(): Promise<unknown>;
    onState(state: unknown): void;
    onChange(): void;
    acknowledgeCodex(): Promise<void>;
  };
  await deps.acknowledgeCodex();
  deps.onChange();
  expect(mock.ipc.sendChanged).toHaveBeenCalledOnce();
  deps.onState({ id: "a" });
  expect(mock.ipc.sendState).toHaveBeenCalledWith({ id: "a" });
  mock.listen.mockResolvedValue("receiver");
  await expect(deps.receiver()).resolves.toBe("receiver");
  const onSignal = mock.listen.mock.calls[0]?.[0] as (signal: unknown) => void;
  onSignal({ terminalId: "key" });
  expect(mock.workspace.hook).toHaveBeenCalledWith({ terminalId: "key" });

  const owns = mock.attachWorkspace.mock.calls[0]?.[2] as (id: string) => boolean;
  mock.terminals.owns.mockReturnValue(true);
  expect(owns("a")).toBe(true);
  mock.readyEvents.get("closed")?.();
  expect(mock.ipc.dispose).toHaveBeenCalledOnce();
  expect(mock.workspace.dispose).toHaveBeenCalledOnce();
  expect(mock.setupIpc.dispose).toHaveBeenCalledOnce();
});

test("setup owns the settings, applies them to the workspace, and classifies verdicts", async () => {
  await start();
  expect(mock.openSettings).toHaveBeenCalledWith("/test/user-data");
  const deps = mock.setup.deps as {
    store: unknown;
    worktreeRoot: string;
    apply(settings: unknown): void;
  };
  expect(deps.store).toBe(mock.settingsStore);
  expect(deps.worktreeRoot).toBe("/home/.foom/worktrees");
  // The saved mode and scale apply before the window exists.
  expect(mock.construct.mock.calls[0]?.[0].webPreferences?.zoomFactor).toBe(1.2);
  expect(mock.theme.themeSource).toBe("dark");
  const next = { hooks: false, colorMode: "light", interfaceScale: 90 };
  deps.apply(next);
  expect(mock.workspace.configure).toHaveBeenCalledWith(next);
  expect(mock.theme.themeSource).toBe("light");
  expect(mock.window.webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
  // The window opened at 120% and shrinks with the interface.
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    width: 1080,
    height: 768,
    minWidth: 576,
    minHeight: 504,
  });
  expect(mock.window.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 810, height: 576 });
  // The code folder picker is main's own dialog.
  const { code } = mock.setup.deps as { code: { pickFolder(): Promise<string | null> } };
  mock.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/home/me/code"] });
  await expect(code.pickFolder()).resolves.toBe("/home/me/code");
  mock.openDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  await expect(code.pickFolder()).resolves.toBeNull();
  mock.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
  await expect(code.pickFolder()).resolves.toBeNull();
  expect(mock.attachSetup.mock.calls[0]?.[1]).toBeInstanceOf(Object);
  // A click on + grows the window from the pointer instead of the top-left corner.
  const pointerZoom = mock.attachSetup.mock.calls[0]?.[2] as (active: boolean) => void;
  pointerZoom(true);
  deps.apply({ ...next, interfaceScale: 80 });
  pointerZoom(false);
  // Shrinking toward the pointer at (1000, 700) moves the corner toward it.
  expect(mock.window.setBounds).toHaveBeenLastCalledWith({
    x: 111,
    y: 78,
    width: 720,
    height: 512,
  });
  const classify = mock.VerdictLog.mock.calls[0]?.[1];
  classify?.({ terminalId: "a" });
  expect(mock.setup.classify).toHaveBeenCalledWith({ terminalId: "a" });
});

test("confirmed quit disposes the workspace only after terminals stop", async () => {
  const order: string[] = [];
  mock.terminals.shutdown.mockImplementation(() => {
    order.push("terminals");
    return Promise.resolve();
  });
  mock.workspace.dispose.mockImplementation(() => {
    order.push("workspace");
    return Promise.resolve();
  });
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(order).toEqual(["terminals", "workspace"]);
});

test("zoom shortcuts change the interface size instead of reaching the terminal", async () => {
  await start();
  const input = mock.windowEvents.get("before-input-event");
  const key = (overrides: Partial<ShortcutInput>) => {
    const event = { preventDefault: vi.fn() };
    const shortcut: ShortcutInput = {
      type: "keyDown",
      key: "+",
      code: "Equal",
      control: process.platform !== "darwin",
      meta: process.platform === "darwin",
      shift: true,
      alt: false,
      ...overrides,
    };
    input?.(event, shortcut);
    return event.preventDefault;
  };
  expect(key({})).toHaveBeenCalledOnce();
  expect(mock.setupIpc.zoom).toHaveBeenCalledWith("in");
  // Plain Ctrl+- stays with the terminal (readline undo) on Linux and Windows.
  if (process.platform !== "darwin") {
    expect(key({ code: "Minus", key: "-", shift: false })).not.toHaveBeenCalled();
  }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.setupIpc.zoom.mockRejectedValueOnce(new Error("disk full"));
  key({ code: "Digit0", key: "0", shift: false });
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to change the interface size:", expect.any(Error));
  });
});
