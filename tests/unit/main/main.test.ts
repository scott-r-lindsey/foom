import type { DialogContent } from "../../../src/shared/confirmation";
vi.mock("../../../src/main/confirmations/trusted-dialog", () => ({
  TrustedDialog: class {
    constructor(_parent: unknown, _session: unknown, theme: () => unknown) {
      theme();
    }
    request = async (content: unknown) => (await mock.message(content)).response === 1;
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
  attachTerminal: (_window: unknown, events: Record<string, (...args: never[]) => void>) => {
    mock.terminalEvents = events;
    return mock.terminals;
  },
}));
vi.mock("../../../src/main/workspace/workspace", () => ({
  Workspace: class {
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
    quiet = mock.workspace.quiet;
    exited = mock.workspace.exited;
    input = mock.workspace.input;
    removed = mock.workspace.removed;
    hook = mock.workspace.hook;
    dispose = mock.workspace.dispose;
    configure = mock.workspace.configure;
    addRepository = mock.workspace.addRepository;
    removeRepository = mock.workspace.removeRepository;
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
vi.mock("../../../src/main/window/window-state", () => ({
  loadWindowSize: mock.loadWindowSize,
  saveWindowSize: mock.saveWindowSize,
}));
vi.mock("../../../src/main/setup/setup", () => ({
  Setup: class {
    classify = mock.setup.classify;
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
  const appEvents = new Map<string, (event: { preventDefault(): void }) => void>();
  const windowEvents = new Map<
    string,
    (event: { preventDefault(): void }, input?: ShortcutInput) => void
  >();
  const readyEvents = new Map<string, () => void>();
  const window = {
    webContents: {
      getURL: () => "app://bundle/index.html",
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
      windowEvents.set(name, handler);
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
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    focus: vi.fn(),
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
    addRepository: vi.fn(),
    removeRepository: vi.fn(),
  };
  const ipc = { sendChanged: vi.fn(), sendState: vi.fn(), dispose: vi.fn() };
  const setup = {
    deps: undefined as ConstructorParameters<typeof Setup>[0] | undefined,
    classify: vi.fn(),
  };
  return {
    terminals: {
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
    setupIpc: { dispose: vi.fn(), zoom: vi.fn<(direction: string) => Promise<void>>() },
    attachSetup: vi.fn<(...args: unknown[]) => unknown>(),
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
    VerdictLog: vi.fn<(userData: string, classify: (input: unknown) => unknown) => void>(),
    listen: vi.fn(),
    theme: {
      themeSource: "system",
      shouldUseDarkColors: false,
      on: vi.fn<(name: string, handler: () => void) => void>(),
      removeListener: vi.fn(),
    },
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
  BrowserWindow: mock.BrowserWindow,
  nativeTheme: mock.theme,
  dialog: {
    showMessageBox: mock.message,
    showErrorBox: mock.errorBox,
    showOpenDialog: mock.openDialog,
  },
  app: {
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
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
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
  mock.lock.mockReturnValue(true);
  mock.packaged = false;
  mock.explicitProfile = false;
  mock.window.isMinimized.mockReturnValue(false);
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
    expect(mock.window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? "#05040a" : "#f3f0fa");
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
    webPreferences: { additionalArguments: ["--foom-development"] },
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
  expect(mock.construct.mock.calls[0]?.[0]).toMatchObject({
    title: "Foom",
    webPreferences: { additionalArguments: [] },
  });
});
