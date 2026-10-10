import type { ThemeCatalog } from "../../../src/shared/theme-file";
import { interfaceThemes } from "../../../src/shared/interface-themes";
import { terminalThemes } from "../../../src/shared/terminal-themes";
vi.mock("../../../src/main/themes/library", () => ({
  ThemeLibrary: class {
    constructor(_root: string, changed: () => void) {
      mock.themeChanged = changed;
    }
    initialize = async () => {};
    snapshot = () => mock.catalog;
    dispose = vi.fn();
  },
}));
vi.mock("../../../src/main/themes/ipc", () => ({ attachThemes: vi.fn(() => vi.fn()) }));
import type { WindowPlacement } from "../../../src/main/window/window-placement";
vi.mock("../../../src/main/window/window-placement", () => ({
  loadPlacements: mock.loadPlacements,
  savePlacements: mock.savePlacements,
  placeWindow: (value: unknown) => value,
}));
vi.mock("../../../src/main/agents/codex-hook-status", () => ({
  CodexHookStatus: class {
    load = async () => {};
  },
}));
vi.mock("../../../src/main/sounds/ipc", () => ({ attachSounds: vi.fn(() => vi.fn()) }));
vi.mock("../../../src/main/window/attention-badge", () => ({ updateAttention: vi.fn() }));
import type { WorkspaceDependencies } from "../../../src/main/workspace/workspace";
import type { DialogContent } from "../../../src/shared/confirmation";
vi.mock("../../../src/main/confirmations/trusted-dialog", () => ({
  TrustedDialog: class {
    refresh = vi.fn();
    request: (content: unknown) => Promise<boolean>;
    constructor(parent: unknown, _session: unknown, theme: () => unknown) {
      theme();
      this.request = async (content: unknown) => {
        mock.confirmParent(parent);
        return (await mock.message(content)).response === 1;
      };
    }
    dispose = vi.fn();
  },
}));
import { join } from "node:path";
import type { Settings } from "../../../src/shared/setup";
import { setupState } from "../../fixtures/setup";
import type { BrowserWindowConstructorOptions, Input } from "electron";
import type { Setup } from "../../../src/main/setup/setup";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../../src/main/terminals/terminal-ipc", () => ({
  attachTerminal: (
    _window: unknown,
    events: Record<string, (...args: never[]) => void>,
    allow: (contents: unknown, id: string) => boolean,
    shellEnvironment: () => Record<string, string>,
  ) => {
    mock.allowView = allow;
    mock.shellEnvironment = shellEnvironment;
    mock.terminalEvents = events;
    return mock.terminals;
  },
}));
vi.mock("../../../src/main/setup/environment-ipc", () => ({
  attachEnvironment: (_window: unknown, _store: unknown, onChange: () => void) => {
    mock.environmentChanged = onChange;
    return { dispose: vi.fn() };
  },
}));
vi.mock("../../../src/main/workspace/workspace", () => ({
  Workspace: class {
    restore = async () => {};
    snapshot = () => ({
      terminals: [
        {
          id: "t1",
          agent: "claude",
          repository: "/repo",
          branch: "feature",
          worktree: "/tree",
          state: { state: "working" },
        },
        {
          id: "t2",
          agent: "shell",
          repository: "/repo",
          branch: null,
          worktree: "/tree2",
          state: null,
        },
      ],
    });
    output = mock.workspace.output;
    evidence = mock.workspace.evidence;
    shellState = mock.workspace.shellState;
    ownsSession = mock.workspace.ownsSession;
    initializeControl = mock.workspace.initializeControl;
    refresh = mock.workspace.refresh;
    quiet = mock.workspace.quiet;
    exited = mock.workspace.exited;
    input = mock.workspace.input;
    removed = mock.workspace.removed;
    hook = mock.workspace.hook;
    dispose = mock.workspace.dispose;
    configure = mock.workspace.configure;
    addRepository = mock.workspace.addRepository;
    removeRepository = mock.workspace.removeRepository;
    constructor(deps: WorkspaceDependencies) {
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
vi.mock("../../../src/main/setup/settings", () => ({ SettingsStore: { open: mock.openSettings } }));
vi.mock("../../../src/main/window/window-state", () => ({
  loadWindowSize: mock.loadWindowSize,
  saveWindowSize: mock.saveWindowSize,
}));
vi.mock("../../../src/main/setup/setup", () => ({
  Setup: class {
    state = () => Promise.resolve({ settings: mock.settingsStore.get() });
    constructor(deps: ConstructorParameters<typeof Setup>[0]) {
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
  const catalog: ThemeCatalog = { interface: [], terminal: [], errors: [] };
  const appEvents = new Map<string, (event: { preventDefault(): void }) => void>();
  const windowEvents = new Map<
    string,
    (event: { preventDefault(): void }, input?: ShortcutInput) => void
  >();
  const readyEvents = new Map<string, () => void>();
  const window = {
    webContents: {
      mainFrame: { url: "app://bundle/index.html" },
      removeListener: vi.fn(),
      getURL: () => "app://bundle/index.html",
      isCrashed: vi.fn(() => false),
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
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
      const previous = windowEvents.get(name);
      windowEvents.set(
        name,
        previous
          ? (event) => {
              previous(event);
              handler(event);
            }
          : handler,
      );
    }),
    removeMenu: vi.fn(),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 800 })),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1080, height: 768 })),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1080, height: 768 })),
    setBounds: vi.fn(),
    setMinimumSize: vi.fn(),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    show: vi.fn(),
    isFocused: vi.fn(() => true),
    close: vi.fn(),
    destroy: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
    setBackgroundColor: vi.fn(),
    loadURL: vi.fn<(url: string) => Promise<void>>(),
  };
  const state = { windows: [window] };
  const construct = vi.fn<(options: BrowserWindowConstructorOptions) => void>();
  class BrowserWindow {
    id = instances.length + 1;
    close = window.close;
    destroy = window.destroy;
    isFocused = window.isFocused;
    maximize = vi.fn();
    webContents = window.webContents;
    once = window.once;
    on = window.on;
    removeListener = vi.fn();
    removeMenu = window.removeMenu;
    getBounds = window.getBounds;
    getNormalBounds = window.getNormalBounds;
    getContentBounds = window.getContentBounds;
    setBounds = window.setBounds;
    setMinimumSize = window.setMinimumSize;
    isMaximized = window.isMaximized;
    isFullScreen = window.isFullScreen;
    show = window.show;
    isMinimized = window.isMinimized;
    restore = window.restore;
    focus = window.focus;
    setBackgroundColor = window.setBackgroundColor;
    loadURL = window.loadURL;
    constructor(options: BrowserWindowConstructorOptions) {
      if (this.id > 1)
        this.webContents = { ...window.webContents, mainFrame: { url: "app://bundle/index.html" } };
      instances.push(this);
      construct(options);
    }
    static getAllWindows() {
      return state.windows;
    }
  }
  const instances: BrowserWindow[] = [];
  const workspace = {
    deps: undefined as WorkspaceDependencies | undefined,
    output: vi.fn(),
    evidence: vi.fn(),
    shellState: vi.fn(),
    ownsSession: vi.fn(() => true),
    initializeControl: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    refresh: vi.fn(),
    quiet: vi.fn(),
    exited: vi.fn(),
    input: vi.fn(),
    removed: vi.fn(),
    hook: vi.fn(),
    dispose: vi.fn<() => Promise<void>>(),
    configure: vi.fn(),
    addRepository: vi.fn(),
    removeRepository: vi.fn(),
  };
  const ipc = {
    sendExecution: vi.fn(),
    sendChanged: vi.fn(),
    sendState: vi.fn(),
    dispose: vi.fn(),
  };
  const setup = {
    deps: undefined as ConstructorParameters<typeof Setup>[0] | undefined,
  };
  return {
    terminals: {
      dispose: vi.fn(() => Promise.resolve()),
      addWindow: vi.fn(),
      detachView: vi.fn(),
      runningSessions: () => [
        { id: "t1", command: "claude", cwd: "/tree" },
        { id: "t2", command: "bash", cwd: "/tree2" },
        { id: "t3", command: "bash", cwd: "/home" },
      ],
      setTheme: vi.fn(),
      runningCount: 0,
      shutdown: vi.fn<() => Promise<void>>(),
      owns: vi.fn<(id: string) => boolean>(),
    },
    allowView: (_contents: unknown, _id: string): boolean => false,
    shellEnvironment: undefined as (() => Record<string, string>) | undefined,
    environmentChanged: undefined as (() => void) | undefined,
    terminalEvents: {},
    workspace,
    ipc,
    attachWorkspace: vi.fn<
      (
        window: unknown,
        workspace: unknown,
        owns: (id: string) => boolean,
        request: (content: DialogContent) => Promise<boolean>,
      ) => typeof ipc
    >(() => ipc),
    setup,
    themeChanged: () => {},
    catalog,
    setupIpc: { dispose: vi.fn(), zoom: vi.fn<(direction: string) => Promise<void>>() },
    attachSetup: vi.fn<(...args: unknown[]) => unknown>(),
    loadPlacements: vi.fn<() => Promise<WindowPlacement[]>>(() => Promise.resolve([])),
    savePlacements: vi.fn(() => Promise.resolve()),
    instances,
    loadWindowSize: vi.fn<() => Promise<{ width: number; height: number } | undefined>>(),
    saveWindowSize: vi.fn<() => Promise<void>>(),
    openSettings: vi.fn<() => Promise<unknown>>(),
    settingsStore: {
      update: vi.fn(() => Promise.resolve()),
      get: (): Pick<Settings, "colorMode" | "interfaceScale" | "interfaceTheme"> => ({
        colorMode: "dark",
        interfaceScale: 120,
        interfaceTheme: "follow",
      }),
    },
    VerdictLog: vi.fn<(userData: string) => void>(),
    listen: vi.fn(),
    theme: {
      themeSource: "system",
      shouldUseDarkColors: false,
      on: vi.fn<(name: string, handler: () => void) => void>(),
      removeListener: vi.fn(),
    },
    confirmParent: vi.fn(),
    message: vi.fn<(content?: unknown) => Promise<{ response: number }>>(),
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
    lock: vi.fn(() => true),
    setPath: vi.fn(),
    packaged: false,
    explicitProfile: false,
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
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  BrowserWindow: mock.BrowserWindow,
  nativeTheme: mock.theme,
  clipboard: { writeText: vi.fn() },
  dialog: {
    showMessageBox: mock.message,
    showErrorBox: mock.errorBox,
    showOpenDialog: mock.openDialog,
  },
  app: {
    getVersion: () => "0.1.0",
    setAboutPanelOptions: vi.fn(),
    whenReady: mock.ready,
    get isPackaged() {
      return mock.packaged;
    },
    commandLine: { hasSwitch: () => mock.explicitProfile },
    setPath: mock.setPath,
    requestSingleInstanceLock: mock.lock,
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
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (data: Buffer) => data.toString(),
  },
  screen: {
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 1000, y: 700 }),
  },
  session: {
    fromPartition: () => ({
      protocol: { handle: vi.fn() },
      setPermissionRequestHandler: (
        callback: (
          contents: unknown,
          permission: string,
          answer: (allowed: boolean) => void,
        ) => void,
      ) => {
        callback({}, "camera", vi.fn());
      },
      setPermissionCheckHandler: (callback: () => boolean) => callback(),
    }),
    defaultSession: {
      setPermissionRequestHandler: mock.permissionRequest,
      setPermissionCheckHandler: mock.permissionCheck,
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mock.instances.length = 0;
  mock.loadPlacements.mockResolvedValue([]);
  mock.lock.mockReturnValue(true);
  mock.packaged = false;
  mock.explicitProfile = false;
  mock.window.isMinimized.mockReturnValue(false);
  mock.window.isFocused.mockReturnValue(true);
  mock.window.webContents.isCrashed.mockReturnValue(false);
  mock.terminals.runningCount = 0;
  mock.terminals.shutdown.mockResolvedValue();
  mock.workspace.dispose.mockResolvedValue();
  mock.attachWorkspace.mockImplementation(() => mock.ipc);
  mock.message.mockResolvedValue({ response: 0 });
  mock.theme.shouldUseDarkColors = false;
  mock.appEvents.clear();
  mock.windowEvents.clear();
  mock.readyEvents.clear();
  mock.catalog = { interface: [], terminal: [], errors: [] };
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

async function start(wait = true) {
  await import("../../../src/main/main");
  if (wait)
    await vi.waitFor(() => {
      expect(mock.window.loadURL.mock.calls.length + mock.quit.mock.calls.length).toBeGreaterThan(
        0,
      );
    });
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
  await start(false);
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
    "fonts/HackNerdFontMono-Regular.woff2",
    "fonts/HackNerdFontMono-Bold.woff2",
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
  expect(mock.fetch).toHaveBeenCalledTimes(11);
});

test("denies requested and checked permissions", async () => {
  await start();
  const callback = vi.fn();
  mock.permissionRequest.mock.calls[0]?.[0](null, "media", callback);
  expect(callback).toHaveBeenCalledWith(false);
  expect(mock.permissionCheck.mock.calls[0]?.[0]()).toBe(false);
});

test("registers activation to reopen a window", async () => {
  await start();
  expect(mock.appEvents.has("activate")).toBe(true);
});

test.each(["darwin", "linux", "win32"] as const)(
  "last-window policy follows %s",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    await start();
    mock.appEvents.get("window-all-closed")?.({ preventDefault: vi.fn() });
    expect(mock.quit).toHaveBeenCalledTimes(platform === "darwin" ? 0 : 1);
  },
);

test("quits with a diagnostic if the document cannot load", async () => {
  const error = new Error("Load failed");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.loadURL.mockRejectedValue(error);
  await start();
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to load the application:", error);
    expect(mock.quit).toHaveBeenCalledOnce();
  });
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
    code: `Key${key.toUpperCase()}`,
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
  { key: "w", code: "KeyW" },
])("leaves other keys to the terminal (%j)", async (overrides) => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("before-input-event")?.(event, {
    type: "keyDown",
    key: "c",
    code: "KeyC",
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
  expect(mock.construct.mock.calls[0]?.[0].backgroundColor).toBe(dark ? "#05040a" : "#f3f0fa");
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
      expect.objectContaining({
        title: `Quit with ${String(count)} ${count === 1 ? "terminal" : "terminals"} running?`,
        accept: "Stop all and quit",
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
      shift: platform === "linux",
      code: input.key === "F4" ? "F4" : `Key${input.key.toUpperCase()}`,
      ...input,
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    if (input.key === "w" || input.key === "F4") expect(mock.window.close).toHaveBeenCalledOnce();
    else expect(mock.quit).toHaveBeenCalledOnce();
  },
);

test("keeps the native background in sync with theme updates and removes its listener on close", async () => {
  await start();
  const update = mock.theme.on.mock.calls[0]?.[1];
  for (const dark of [true, false]) {
    mock.theme.shouldUseDarkColors = dark;
    update?.();
    expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? "#05040a" : "#f3f0fa");
  }
  mock.readyEvents.get("closed")?.();
  expect(mock.theme.removeListener).toHaveBeenCalledWith("updated", update);
});

test("defers an already-idle quit until the native close callback has unwound", async () => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(event);
  expect(mock.quit).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});

test("reveals a loaded board even without a hidden-window paint and does not show it twice", async () => {
  await start();
  await vi.waitFor(() => {
    expect(mock.window.show).toHaveBeenCalledOnce();
  });
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

  expect(mock.shellEnvironment?.()).toEqual({});
  mock.environmentChanged?.();
  const deps = mock.workspace.deps as {
    environment(target: string): unknown;
    receiver(): Promise<unknown>;
    onExecution(event: unknown): void;
    onState(state: unknown): void;
    onChange(): void;
    acknowledgeCodex(): Promise<void>;
  };
  expect(deps.environment("claude")).toEqual([[], []]);
  await deps.acknowledgeCodex();
  deps.onChange();
  expect(mock.ipc.sendChanged).toHaveBeenCalledOnce();
  deps.onExecution({ terminalId: "a" });
  expect(mock.ipc.sendExecution).toHaveBeenCalledWith({ terminalId: "a" });
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
  expect(mock.workspace.dispose).not.toHaveBeenCalled();
  expect(mock.setupIpc.dispose).toHaveBeenCalledOnce();
});

test("setup owns the settings, applies them to the workspace, and uses the local verdict classifier", async () => {
  await start();
  expect(mock.openSettings).toHaveBeenCalledWith("/test/user-data");
  const deps = mock.setup.deps as {
    store: unknown;
    worktreeRoot: string;
    apply(settings: unknown): void;
  };
  expect(deps.store).not.toBe(mock.settingsStore);
  expect(deps.worktreeRoot).toBe("/home/.foom/worktrees");
  // The saved mode and scale apply before the window exists.
  expect(mock.construct.mock.calls[0]?.[0].webPreferences?.zoomFactor).toBe(1.2);
  expect(mock.theme.themeSource).toBe("dark");
  const next = { hooks: false, colorMode: "light", interfaceScale: 90, interfaceTheme: "follow" };
  deps.apply(next);
  expect(mock.workspace.configure).toHaveBeenCalledWith(next);
  expect(mock.theme.themeSource).toBe("light");
  expect(mock.window.webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
  // The window opened at 120% and shrinks with the interface.
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    width: 1152,
    height: 768,
    minWidth: 1080,
    minHeight: 768,
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
  expect(mock.VerdictLog).toHaveBeenCalledWith("/test/user-data");
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
  key({ code: "Digit0", key: "0", shift: process.platform !== "darwin" });
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to change interface size:", expect.any(Error));
  });
});

test("main intercepts board chords before terminal input", async () => {
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("before-input-event")?.(event, {
    type: "keyDown",
    key: "B",
    code: "KeyB",
    shift: true,
    alt: false,
    control: process.platform !== "darwin",
    meta: process.platform === "darwin",
  });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(mock.window.webContents.send).toHaveBeenCalledWith("board:command", "sidebar");
});

test("restores saved dimensions on startup", async () => {
  mock.loadWindowSize.mockResolvedValueOnce({ width: 1400, height: 900 });
  await start();
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({ width: 1400, height: 900 });
});
test("saves normal dimensions before quitting", async () => {
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.saveWindowSize).toHaveBeenCalledWith("/test/user-data", {
    x: 0,
    y: 0,
    width: 1100,
    height: 800,
  });
});
test("a window size write failure does not prevent quitting", async () => {
  const error = new Error("disk full");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.saveWindowSize.mockRejectedValueOnce(error);
  await start();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(log).toHaveBeenCalledWith("Unable to save the window size:", error);
});

test("Settings repository selection uses workspace lifecycle guards", async () => {
  const repository = { path: "/repo", name: "repo" };
  mock.openWorktrees.mockResolvedValue({
    worktreeRoot: "/trees",
    listRepositories: () => [repository],
  });
  mock.workspace.addRepository.mockResolvedValue(repository);
  mock.workspace.removeRepository.mockRejectedValueOnce(
    new Error("Close this repository's sessions first"),
  );
  await start();
  const code = mock.setup.deps?.code;
  if (!code) throw new Error("Missing setup code dependency");
  expect(code.worktrees.listRepositories()).toEqual([repository]);
  await expect(code.worktrees.addRepository(repository.path)).resolves.toEqual(repository);
  expect(mock.workspace.addRepository).toHaveBeenCalledWith(repository.path);
  await expect(code.worktrees.removeRepository(repository.path)).rejects.toThrow("Close");
  expect(mock.workspace.removeRepository).toHaveBeenCalledWith(repository.path);
});

test("fixed interface themes set the native base and exact background, even between two dark themes", async () => {
  let settings = setupState({ interfaceTheme: "deep-field" }).settings;
  vi.spyOn(mock.settingsStore, "get").mockImplementation(() => settings);
  await start();
  expect(mock.theme.themeSource).toBe("dark");
  expect(mock.construct.mock.calls[0]?.[0].backgroundColor).toBe("#080f1e");
  settings = { ...settings, interfaceTheme: "high-contrast" };
  mock.setup.deps?.apply(settings);
  expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith("#000000");
  settings = { ...settings, interfaceTheme: "moonlight" };
  mock.setup.deps?.apply(settings);
  expect(mock.theme.themeSource).toBe("light");
  expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith("#f5f7fc");
});

test("workspace content is routed to the trusted dialog service", async () => {
  await start();
  const request = mock.attachWorkspace.mock.calls[0]?.[3];
  if (typeof request !== "function") throw Error("Missing trusted dialog callback");
  await request({ title: "Remove?", accept: "Remove" });
  expect(mock.message).toHaveBeenCalledWith({ title: "Remove?", accept: "Remove" });
});

test("bypass defaults use a main-owned, cancel-first disclosure", async () => {
  await start();
  mock.message.mockResolvedValueOnce({ response: 0 });
  expect(await mock.setup.deps?.confirmBypass?.("claude")).toBe(false);
  expect(mock.message).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Save bypass defaults for Claude Code?",
      detail:
        "A worktree is not a sandbox. With these arguments, the agent can act as you anywhere on the machine. These defaults apply to future launches from Foom.",
      accept: "Save bypass defaults",
    }),
  );
  mock.message.mockResolvedValueOnce({ response: 1 });
  expect(await mock.setup.deps?.confirmBypass?.("codex")).toBe(true);
});

test("selects dev userData before locking and before readiness", async () => {
  await start();
  expect(mock.setPath).toHaveBeenCalledWith("userData", join("/test/user-data", "Foom Dev"));
  expect(mock.setPath.mock.invocationCallOrder[0]).toBeLessThan(
    mock.lock.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mock.lock.mock.invocationCallOrder[0]).toBeLessThan(
    mock.ready.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    title: "Foom Dev",
    webPreferences: {
      additionalArguments: ["--foom-development", expect.stringMatching(/^--foom-window-id=/)],
    },
  });
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("page-title-updated")?.(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
});

test("duplicate launches exit without opening profile stores or shutdown writers", async () => {
  mock.lock.mockReturnValue(false);
  await start();
  expect(mock.quit).toHaveBeenCalledOnce();
  expect(mock.ready).not.toHaveBeenCalled();
  expect(mock.openWorktrees).not.toHaveBeenCalled();
  expect(mock.openSettings).not.toHaveBeenCalled();
  expect(mock.saveWindowSize).not.toHaveBeenCalled();
  expect(mock.appEvents.size).toBe(0);
});

test.each([false, true])(
  "second launch reveals and focuses existing window (minimized: %s)",
  async (minimized) => {
    await start();
    mock.window.show.mockClear();
    mock.window.isMinimized.mockReturnValue(minimized);
    mock.appEvents.get("second-instance")?.({ preventDefault: vi.fn() });
    expect(mock.window.restore).toHaveBeenCalledTimes(minimized ? 1 : 0);
    expect(mock.window.show).toHaveBeenCalledOnce();
    expect(mock.window.focus).toHaveBeenCalledOnce();
    mock.state.windows = [];
    mock.appEvents.get("second-instance")?.({ preventDefault: vi.fn() });
    expect(mock.window.focus).toHaveBeenCalledOnce();
  },
);

test("packaged builds keep their default profile and identity", async () => {
  mock.packaged = true;
  await start();
  expect(mock.setPath).not.toHaveBeenCalled();
  expect(mock.construct.mock.calls[0]?.[0]?.title).toBe("Foom");
  expect(mock.construct.mock.calls[0]?.[0]?.webPreferences?.devTools).toBe(false);
  expect(mock.construct.mock.calls[0]?.[0]?.webPreferences?.additionalArguments).toEqual([
    expect.stringMatching(/^--foom-window-id=/),
  ]);
});

test("session ID copying uses the main clipboard capability", async () => {
  await start();
  const { clipboard } = await import("electron");
  await mock.workspace.deps?.copyText?.("saved-session-id");
  expect(vi.mocked(clipboard).writeText.mock.calls).toEqual([["saved-session-id"]]);
});

test("window focus refreshes external workspace inventory", async () => {
  await import("../../../src/main/main");
  await start();
  mock.windowEvents.get("focus")?.({ preventDefault: vi.fn() });
  expect(mock.workspace.refresh).toHaveBeenCalledOnce();
  mock.window.webContents.isCrashed.mockReturnValue(true);
  mock.windowEvents.get("focus")?.({ preventDefault: vi.fn() });
  expect(mock.workspace.refresh).toHaveBeenCalledOnce();
});

test("control startup publishes private discovery and binds trusted pairing callbacks", async () => {
  const { ControlRuntime } = await import("../../../src/main/control/runtime");
  const error = new Error("Private profile unavailable");
  const startControl = vi.spyOn(ControlRuntime, "start").mockRejectedValueOnce(error);
  mock.openWorktrees.mockResolvedValue({ worktreeRoot: "/trees", listRepositories: () => [] });
  try {
    await start();
    expect(startControl).not.toHaveBeenCalled();
    const control = mock.workspace.deps?.control;
    if (!control) throw new Error("Expected control startup capability");
    await expect(control()).rejects.toBe(error);
    expect(startControl).toHaveBeenCalledExactlyOnceWith(
      "/test/user-data",
      expect.any(Function),
      expect.any(Object),
    );
    expect(startControl.mock.calls[0]?.[1]?.()).toMatchObject([{ id: "t1" }, { id: "t2" }]);
    expect(mock.workspace.initializeControl).toHaveBeenCalled();
    const pairing = startControl.mock.calls[0]?.[2];
    expect(pairing?.repository("/foreign")).toBeUndefined();
    const { worktrees } = await import("../../../src/main/main");
    vi.spyOn(worktrees, "listRepositories").mockReturnValue([{ path: "/repo", name: "Repo" }]);
    expect(pairing?.repository("/repo")).toBe("/repo");
    await pairing?.approve("/repo", "ABCD1234", new AbortController().signal);
    expect(mock.message).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Pair this CLI with Foom?",
      }),
    );
    await newWindow();
    const second = mock.instances[1];
    if (!second) throw new Error("Missing second board");
    mock.window.isFocused.mockReturnValue(false);
    second.isFocused = vi.fn(() => true);
    await pairing?.approve("/repo", "NEXT1234", new AbortController().signal);
    expect(mock.confirmParent).toHaveBeenLastCalledWith(second);
    mock.readyEvents.get("closed")?.();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(pairing?.approve("/repo", "STOP1234", cancelled.signal)).resolves.toBe(false);
    expect(mock.instances).toHaveLength(2);
    await pairing?.approve("/repo", "OPEN1234", new AbortController().signal);
    expect(mock.instances).toHaveLength(3);
    expect(mock.confirmParent).toHaveBeenLastCalledWith(mock.instances[2]);
    mock.readyEvents.get("closed")?.();
    const opening = new AbortController();
    mock.window.loadURL.mockImplementationOnce(() => {
      opening.abort();
      return Promise.resolve();
    });
    await expect(pairing?.approve("/repo", "LATE1234", opening.signal)).resolves.toBe(false);
    expect(mock.confirmParent).toHaveBeenCalledTimes(3);
  } finally {
    startControl.mockRestore();
  }
});

async function invokeWindow(index: number, channel: string, ...args: unknown[]) {
  const { ipcMain } = await import("electron");
  const window = mock.instances[index];
  const handler = vi.mocked(ipcMain).handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!window || !handler) throw new Error(`Missing window or handler: ${channel}`);
  return handler(
    {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    } as unknown as Parameters<typeof handler>[0],
    ...args,
  ) as unknown;
}
async function newWindow() {
  const count = mock.instances.length;
  await invokeWindow(0, "app-menu:execute", "new-window");
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(count + 1);
  });
}

test("new windows share one workspace and route reservations, focus and popout independently", async () => {
  await start();
  await newWindow();
  expect(mock.terminals.addWindow).toHaveBeenCalledOnce();
  expect(mock.openWorktrees).toHaveBeenCalledOnce();
  expect(await invokeWindow(0, "windows:sync", ["t1"])).toEqual(["t1"]);
  expect(await invokeWindow(1, "windows:sync", ["t1", "t2"])).toEqual(["t2"]);
  expect(await invokeWindow(0, "windows:views")).toEqual([
    { id: "t1", window: 0 },
    { id: "t2", window: 2 },
  ]);
  expect(await invokeWindow(1, "windows:select", "t1")).toBe(false);
  expect(mock.window.focus).toHaveBeenCalled();
  expect(mock.allowView({}, "t3")).toBe(false);
  expect(mock.allowView(mock.instances[1]?.webContents, "t1")).toBe(false);
  expect(mock.allowView(mock.instances[1]?.webContents, "t2")).toBe(true);
  await invokeWindow(0, "windows:popout", "t1");
  expect(mock.instances).toHaveLength(3);
  expect(mock.terminals.detachView).toHaveBeenCalledWith("t1", mock.instances[0]?.webContents);
  expect(mock.construct.mock.calls[2]?.[0].webPreferences?.additionalArguments).toContain(
    "--foom-initial-session=t1",
  );
  await invokeWindow(1, "windows:sync", []);
  expect(mock.terminals.detachView).toHaveBeenCalledWith("t2", mock.instances[1]?.webContents);
  expect(await invokeWindow(2, "windows:audio-state")).toMatchObject({ enabled: false });
  await invokeWindow(2, "windows:audio-focus", "t1");
  mock.workspace.deps?.onChange?.();
  expect(mock.ipc.sendChanged).toHaveBeenCalledTimes(3);
});

test("restores separate window identities, scales and maximization, keeping expanded bounds on screen", async () => {
  mock.loadPlacements.mockResolvedValue([
    {
      id: "first",
      display: 1,
      bounds: { x: 1850, y: 1000, width: 50, height: 50 },
      maximized: true,
      scale: 150,
    },
    {
      id: "second",
      display: 1,
      bounds: { x: 20, y: 30, width: 1200, height: 900 },
      maximized: false,
      scale: 90,
    },
  ]);
  await start();
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(2);
  });
  expect(mock.instances[0]?.maximize).toHaveBeenCalledOnce();
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    x: 570,
    y: 120,
    width: 1350,
    height: 960,
  });
  expect(mock.construct.mock.calls[1]?.[0].webPreferences?.zoomFactor).toBe(0.9);
  const store = mock.setup.deps?.store;
  expect(store?.get().interfaceScale).toBe(90);
  await store?.update({ interfaceScale: 100, colorMode: "light" });
  expect(mock.settingsStore.update).toHaveBeenLastCalledWith({ colorMode: "light" });
  expect(store?.get().interfaceScale).toBe(100);
  await store?.update({ colorMode: "dark" });
  expect(store?.get().interfaceScale).toBe(100);
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.savePlacements).toHaveBeenCalledWith("/test/user-data", [
    expect.objectContaining({ id: "first", scale: 150 }),
    expect.objectContaining({ id: "second", scale: 100 }),
  ]);
});

test("macOS closing the last window retains app services and activation opens another board", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  await start();
  const event = { preventDefault: vi.fn() };
  mock.windowEvents.get("close")?.(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  mock.readyEvents.get("closed")?.();
  expect(mock.terminals.shutdown).not.toHaveBeenCalled();
  expect(mock.workspace.dispose).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(mock.savePlacements).toHaveBeenCalledWith("/test/user-data", []);
  });
  mock.appEvents.get("activate")?.(event);
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(2);
  });
  expect(mock.terminals.addWindow).toHaveBeenCalledOnce();
  mock.appEvents.get("activate")?.(event);
  await Promise.resolve();
  expect(mock.instances).toHaveLength(2);
});

test("quit without a board reopens a parent for the running-session confirmation", async () => {
  await start();
  mock.readyEvents.get("closed")?.();
  mock.terminals.runningCount = 1;
  quitting();
  await vi.waitFor(() => {
    expect(mock.message).toHaveBeenCalledOnce();
  });
  expect(mock.instances).toHaveLength(2);
  expect(mock.terminals.shutdown).not.toHaveBeenCalled();
});

test("failed placement saves do not stop quit, and a later save can recover", async () => {
  const error = new Error("Read only profile");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.savePlacements.mockRejectedValueOnce(error);
  await start();
  mock.readyEvents.get("closed")?.();
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to save windows:", error);
  });
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
  expect(mock.savePlacements).toHaveBeenCalledTimes(2);
});

test("reports failed New Window loads and lets a subsequent window open", async () => {
  await start();
  const error = new Error("Unable to load board");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.loadURL.mockRejectedValueOnce(error);
  await newWindow();
  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith("Unable to open window:", error);
  });
  await newWindow();
  expect(mock.terminals.addWindow).toHaveBeenCalledTimes(2);
});

test("app attention reveals the owning board, including minimized and windowless cases", async () => {
  const { updateAttention } = await import("../../../src/main/window/attention-badge");
  await start();
  await newWindow();
  await invokeWindow(1, "windows:sync", ["t1"]);
  const reveal = vi.mocked(updateAttention).mock.lastCall?.[3];
  if (!reveal) throw new Error("Missing attention action");
  mock.window.isMinimized.mockReturnValue(true);
  reveal("t1");
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith("app-menu:session", "t1");
  });
  expect(mock.window.restore).toHaveBeenCalled();
  reveal("unshown");
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith("app-menu:session", "unshown");
  });
  mock.readyEvents.get("closed")?.();
  const reopen = vi.mocked(updateAttention).mock.lastCall?.[3];
  reopen?.("t1");
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(3);
  });
  expect(mock.construct.mock.calls[2]?.[0].webPreferences?.additionalArguments).toContain(
    "--foom-initial-session=t1",
  );
});

test("routes output, evidence and shell state into app-owned workspace", async () => {
  await start();
  const events = mock.terminalEvents as {
    onOutput(id: string): void;
    onEvidence(id: string, evidence: unknown): void;
    onShellState(id: string, state: unknown): void;
  };
  events.onOutput("t1");
  events.onEvidence("t1", { text: "untrusted" });
  events.onShellState("t1", "ready");
  expect(mock.workspace.output).toHaveBeenCalledWith("t1");
  expect(mock.workspace.evidence).toHaveBeenCalledWith("t1", { text: "untrusted" });
  expect(mock.workspace.shellState).toHaveBeenCalledWith("t1", "ready");
});

test("concurrent windowless quit requests share one parent and recover from a failed load", async () => {
  await start();
  mock.readyEvents.get("closed")?.();
  const error = new Error("Board failed to load");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.window.loadURL.mockRejectedValueOnce(error);
  quitting();
  quitting();
  await vi.waitFor(() => {
    expect(mock.errorBox).toHaveBeenCalledOnce();
  });
  expect(mock.instances).toHaveLength(2);
  expect(log).toHaveBeenCalledWith("Unable to quit the application:", error);
  expect(mock.terminals.shutdown).not.toHaveBeenCalled();
  quitting();
  await vi.waitFor(() => {
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});

test("Windows attention refresh updates every live window so prior overlays clear", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const { updateAttention } = await import("../../../src/main/window/attention-badge");
  await start();
  await newWindow();
  vi.mocked(updateAttention).mockClear();
  mock.workspace.deps?.onChange?.();
  expect(vi.mocked(updateAttention).mock.calls.map((call) => call[0])).toEqual(mock.instances);
});

test("a discovery initialization failure leaves the main window usable", async () => {
  mock.workspace.initializeControl.mockRejectedValueOnce(new Error("private profile"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await start();
  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalledWith("Foom CLI discovery is unavailable.");
  });
  expect(mock.attachWorkspace).toHaveBeenCalled();
});

test("live theme catalog changes update native colors, terminal palettes and all settings subscribers", async () => {
  await start();
  const settings = {
    ...mock.settingsStore.get(),
    interfaceTheme: "user:custom.json" as const,
    terminalTheme: "user:term.json" as const,
  };
  vi.spyOn(mock.settingsStore, "get").mockReturnValue(settings);
  mock.catalog = {
    interface: [{ id: "user:custom.json", theme: interfaceThemes.moonlight }],
    terminal: [{ id: "user:term.json", name: "Custom", theme: terminalThemes.dracula }],
    errors: [],
  };
  expect(mock.setup.deps?.themes?.()).toEqual(mock.catalog);
  mock.themeChanged();
  await vi.waitFor(() => {
    expect(mock.window.webContents.send).toHaveBeenCalledWith("setup:changed", expect.anything());
  });
  expect(mock.theme.themeSource).toBe("light");
  expect(mock.terminals.setTheme).toHaveBeenLastCalledWith(terminalThemes.dracula);
  mock.catalog = { interface: [], terminal: [], errors: [] };
  mock.themeChanged();
  expect(mock.terminals.setTheme).toHaveBeenLastCalledWith("follow");
  mock.window.webContents.send.mockClear();
  mock.window.webContents.isDestroyed.mockReturnValue(true);
  mock.themeChanged();
  await Promise.resolve();
  expect(mock.window.webContents.send).not.toHaveBeenCalled();
});
