// Vitest isolates this module per test file. Keep hoisted mocks and registration
// together, before start() dynamically imports the application; never cache it globally.
import type * as UpdatePackageModule from "../../../src/main/update-package";

const updateMock = vi.hoisted(() => ({
  updater: {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn<(event: string, callback: () => void) => void>(),
    removeListener: vi.fn(),
  },
  prepareUpdate: vi.fn(() =>
    Promise.resolve({
      url: "file:///test/feed.json",
      dispose: () => Promise.resolve(),
    }),
  ),
  getRelease: vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({ draft: false, prerelease: false, tag_name: "v0.1.0" }),
  ),
}));

vi.mock("../../../src/main/update-package", async (original) => ({
  ...(await original<typeof UpdatePackageModule>()),
  prepareLocalUpdate: updateMock.prepareUpdate,
}));

vi.mock("../../../src/main/update-activity", () => ({
  UpdateActivity: class {
    flags() {
      return Promise.resolve("?d=1&w=1&m=1");
    }
  },
}));

vi.mock("../../../src/main/update-http", () => ({ getUpdateRelease: updateMock.getRelease }));

const forgeHostStatus = vi.hoisted(() => vi.fn(() => Promise.resolve("ready" as const)));

const readinessCheck = vi.hoisted(() =>
  vi.fn((repositories: readonly string[], status: (host: string) => Promise<string>) => {
    const result = { git: "ready", platform: "linux", forges: [] };
    return repositories.length ? status("github.com").then(() => result) : Promise.resolve(result);
  }),
);

vi.mock("../../../src/main/setup/readiness", () => ({ checkReadiness: readinessCheck }));

import type * as ForgeRuntimeModule from "../../../src/main/control/forge-runtime";

import type { WorkspaceTerminal } from "../../../src/shared/workspace";

const forgeAvailable = vi.hoisted(() => vi.fn(() => Promise.resolve(false)));

vi.mock("../../../src/main/control/forge-runtime", async (original) => {
  const actual = await original<typeof ForgeRuntimeModule>();
  return {
    ForgeRuntime: class extends actual.ForgeRuntime {
      override available = forgeAvailable;
      override hostStatus = forgeHostStatus;
    },
  };
});

const forgeUi = vi.hoisted(() => ({
  supported: true,
  rows: undefined as WorkspaceTerminal[] | undefined,
  events: new Map<string, () => void>(),
  notices: [] as { title: string; body: string; click?: () => void }[],
}));

vi.mock("../../../src/main/agents/setup-offers", () => ({
  setupOffers: {
    load: vi.fn(() => Promise.resolve()),
    answered: vi.fn(() => false),
    answer: vi.fn(() => Promise.resolve()),
  },
}));

import type { PreviewRecord } from "../../../src/shared/previews";

import type {
  ForgeProviderFactory,
  ForgeWorktree,
  ForgeInspection,
} from "../../../src/main/control/forge.d";

const forgeMock = vi.hoisted(() => ({
  open: vi.fn<
    (
      directory: string,
      inspect: (
        tree: ForgeWorktree,
        orchestrator?: boolean,
      ) => Promise<string | ForgeInspection | undefined>,
      changed: () => void,
      provider?: ForgeProviderFactory,
    ) => Promise<unknown>
  >(),
}));

vi.mock("../../../src/main/control/forge-tracking", () => ({
  ForgeTracking: { open: forgeMock.open },
}));

const previewMock = vi.hoisted(() => ({
  copyText: undefined as ((text: string) => void | Promise<void>) | undefined,
  popout: undefined as ((id: string) => Promise<void>) | undefined,
  humanClose: undefined as ((id: string) => void) | undefined,
  pick: undefined as ((worktree: string) => Promise<string | null>) | undefined,
  pickFile: vi.fn(() => Promise.resolve("a".repeat(32))),
  hosts: [] as {
    validate: (worktree: string) => Promise<void>;
    changed: () => void;
    confirm: (content: unknown, signal: AbortSignal) => Promise<boolean>;
    reconcile: () => Promise<void>;
    closeWorktree: (worktree: string) => Promise<void>;
    dispose: (persist: boolean, replacement?: () => Promise<unknown>) => Promise<void>;
    placeMoved: (id: string) => void;
    moveTo: (id: string, target: unknown) => Promise<void>;
  }[],
}));

vi.mock("../../../src/main/previews/host", () => ({
  PreviewHost: class {
    registry = { records: new Map<string, PreviewRecord>() };
    open = vi.fn((_worktree: string, _path: string, _agent?: { id: string }) =>
      Promise.resolve("preview"),
    );
    openManual = vi.fn(() => {
      const id = "f".repeat(32);
      this.registry.records.set(id, {
        id,
        worktree: "foom:manual",
        relativePath: "manual.html",
        network: false,
        bundled: "manual",
      });
      return id;
    });
    focusManual = vi.fn();
    reloadFocused = vi.fn();
    moveTo = vi.fn((_id: string, _target: unknown) => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
    visible = vi.fn(() => false);
    placed = vi.fn();
    restore = async () => {};
    refresh = vi.fn();
    reconcile = vi.fn(async () => {});
    closeWorktree = vi.fn((_worktree: string) => Promise.resolve());
    dispose = vi.fn(async (_persist: boolean, _replacement?: () => Promise<unknown>) => {});
    constructor(
      _window: unknown,
      _registry: unknown,
      validate: (worktree: string) => Promise<void>,
      changed: () => void,
      confirm: (content: unknown, signal: AbortSignal) => Promise<boolean>,
      _bundledRoot: string | undefined,
      placeMoved: (id: string) => void,
    ) {
      previewMock.hosts.push({
        validate,
        changed,
        confirm,
        placeMoved,
        reconcile: this.reconcile,
        closeWorktree: this.closeWorktree,
        dispose: this.dispose,
        moveTo: this.moveTo,
      });
    }
  },
}));

vi.mock("../../../src/main/previews/ipc", () => ({
  attachPreviews: (
    _ipc: unknown,
    _host: unknown,
    pick: (worktree: string) => Promise<string | null>,
    popout: (id: string) => Promise<void>,
    humanClose: (id: string) => void,
    copyText: (text: string) => void | Promise<void>,
  ) => {
    previewMock.copyText = copyText;
    previewMock.popout = popout;
    previewMock.pick = pick;
    previewMock.humanClose = humanClose;
    return () => {};
  },
}));

vi.mock("../../../src/main/previews/pick", () => ({ pickPreviewFile: previewMock.pickFile }));

import type { ThemeCatalog } from "../../../src/shared/theme-file";

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

vi.mock("../../../src/main/config/service", () => ({
  ConfigService: class {
    folder = "/home/.foom/config";
    ready = true;
    constructor(deps: ConfigServiceDependencies) {
      mock.config.deps = deps;
    }
    initialize = (legacy: unknown) => mock.config.initialize(legacy);
    write = (patch: unknown) => mock.config.write(patch);
    status = () => mock.config.status;
    dispose = () => Promise.resolve();
  },
}));

vi.mock("../../../src/main/config/ipc", () => ({ attachConfig: mock.attachConfig }));

import type { WindowPlacement } from "../../../src/main/window/window-placement";

import type { ConfigServiceDependencies } from "../../../src/main/config/service";

import type * as SettingsModule from "../../../src/main/setup/settings";

vi.mock("../../../src/main/window/window-placement", () => ({
  loadPlacements: mock.loadPlacements,
  savePlacements: mock.savePlacements,
  placeWindow: (value: unknown) => value,
}));

vi.mock("../../../src/main/sounds/ipc", () => ({ attachSounds: vi.fn(() => vi.fn()) }));

vi.mock("../../../src/main/window/attention-badge", () => ({ updateAttention: vi.fn() }));

import type { WorkspaceDependencies } from "../../../src/main/workspace/workspace-types";

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

import type { Settings } from "../../../src/shared/setup";

import type { ConfigSettings } from "../../../src/shared/config";

import type { BrowserWindowConstructorOptions, Input } from "electron";

import type { Setup } from "../../../src/main/setup/setup";

import { beforeEach, expect, vi } from "vitest";

vi.mock("../../../src/main/terminals/terminal-ipc", () => ({
  attachTerminal: (
    _window: unknown,
    events: Record<string, (...args: never[]) => void>,
    allow: (contents: unknown, id: string) => boolean,
    shellEnvironment: () => Record<string, string>,
    copyOnSelect: () => boolean,
  ) => {
    mock.allowView = allow;
    mock.shellEnvironment = shellEnvironment;
    mock.copyOnSelect = copyOnSelect;
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
    restartSaved = async () => {};
    prepareQuit = async () => {};
    cancelQuit = () => {};
    snapshot = () => ({
      terminals: forgeUi.rows ?? [
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
    foreground = mock.workspace.foreground;
    shellState = mock.workspace.shellState;
    mcpConnectionChanged = mock.workspace.mcpConnectionChanged;
    ownsSession = mock.workspace.ownsSession;
    initializeControl = mock.workspace.initializeControl;
    refresh = mock.workspace.refresh;
    focusOrchestrator = mock.workspace.focusOrchestrator;
    quiet = mock.workspace.quiet;
    exited = mock.workspace.exited;
    input = mock.workspace.input;
    removed = mock.workspace.removed;
    hook = mock.workspace.hook;
    dispose = mock.workspace.dispose;
    configure = mock.workspace.configure;
    scanAgents = mock.workspace.scanAgents;
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

vi.mock("../../../src/main/setup/settings", async (original) => ({
  ...(await original<typeof SettingsModule>()),
  SettingsStore: { open: mock.openSettings },
}));

vi.mock("../../../src/main/window/window-state", () => ({
  loadWindowSize: mock.loadWindowSize,
  saveWindowSize: mock.saveWindowSize,
}));

vi.mock("../../../src/main/setup/setup", () => ({
  Setup: class {
    state = mock.setupState;
    refresh = mock.setupRefresh;
    constructor(deps: ConstructorParameters<typeof Setup>[0]) {
      mock.setup.deps = deps;
    }
  },
}));

vi.mock("../../../src/main/setup/setup-ipc", () => ({ attachSetup: mock.attachSetup }));

vi.mock("../../../src/main/workspace/worktrees", () => ({
  WorktreeService: { open: mock.openWorktrees },
}));

export type ShortcutInput = Pick<Input, "type" | "key" | "control" | "shift" | "alt" | "meta"> &
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
    isDestroyed: vi.fn(() => false),
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
    isDestroyed = window.isDestroyed;
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
    foreground: vi.fn(),
    shellState: vi.fn(),
    mcpConnectionChanged: vi.fn(),
    ownsSession: vi.fn(() => true),
    scanAgents: vi.fn((_refresh?: boolean) =>
      Promise.resolve({
        agents: [
          { id: "claude", path: "/bin/claude" },
          { id: "codex", path: null },
        ],
      }),
    ),
    initializeControl: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    refresh: vi.fn(),
    focusOrchestrator: vi.fn(),
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
    copyOnSelect: (): boolean => false,
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
        router?: unknown,
        previews?: () => readonly unknown[],
      ) => typeof ipc
    >(() => ipc),
    setup,
    themeChanged: () => {},
    catalog,
    setupIpc: { dispose: vi.fn(), zoom: vi.fn<(direction: string) => Promise<void>>() },
    attachSetup: vi.fn<(...args: unknown[]) => unknown>(),
    loadPlacements: vi.fn<() => Promise<WindowPlacement[]>>(() => Promise.resolve([])),
    savePlacements: vi.fn<
      (_userData: string, placements: readonly WindowPlacement[]) => Promise<void>
    >(() => Promise.resolve()),
    instances,
    loadWindowSize: vi.fn<() => Promise<{ width: number; height: number } | undefined>>(),
    saveWindowSize: vi.fn<() => Promise<void>>(),
    openSettings: vi.fn<() => Promise<unknown>>(),
    config: {
      deps: undefined as ConfigServiceDependencies | undefined,
      initialize: vi.fn<(legacy: unknown) => Promise<unknown>>(),
      write: vi.fn<(patch: unknown) => Promise<void>>(() => Promise.resolve()),
      status: { folder: "/home/.foom/config", available: true, changes: [] },
    },
    attachConfig: vi.fn(() => vi.fn()),
    setupRefresh: vi.fn(),
    setupState: vi.fn<() => Promise<{ settings: Partial<Settings> }>>(),
    managesPath: vi.fn(() => Promise.resolve(false)),
    settingsStore: {
      profileTag: () => "a".repeat(32),
      legacyConfig: vi.fn<() => ConfigSettings | undefined>(() => ({ terminalFontSize: 16 })),
      configDigest: vi.fn(() => null),
      attachConfig: vi.fn(() => Promise.resolve()),
      setConfig: vi.fn(),
      themeDigest: vi.fn<(_file: string) => string | null>(() => null),
      setThemeDigest: vi.fn((_file: string, _digest: string | null) => Promise.resolve()),
      setConfigDigest: vi.fn(() => Promise.resolve()),
      configText: vi.fn(() => null),
      setConfigText: vi.fn(() => Promise.resolve()),
      update: vi.fn(() => Promise.resolve()),
      get: (): Pick<
        Settings,
        "interfaceScale" | "interfaceTheme" | "forges" | "forgeHosts" | "copyOnSelect"
      > &
        Partial<
          Pick<
            Settings,
            "agentBypassAcknowledged" | "showPullRequests" | "setupComplete" | "checkForUpdates"
          >
        > => ({
        forges: { github: true },
        forgeHosts: { "github.com": "github" },
        showPullRequests: false,
        copyOnSelect: false,
        interfaceScale: 120,
        interfaceTheme: "follow",
        agentBypassAcknowledged: { claude: false, codex: false, agy: true },
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
    exit: vi.fn(),
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
  autoUpdater: updateMock.updater,
  powerMonitor: {
    on: (name: string, listener: () => void) => {
      forgeUi.events.set(name, listener);
    },
  },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  Notification: class {
    static isSupported() {
      return forgeUi.supported;
    }
    constructor(private readonly options: { title: string; body: string; click?: () => void }) {}
    on(_event: string, listener: () => void) {
      this.options.click = listener;
    }
    show() {
      forgeUi.notices.push(this.options);
    }
  },
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
    getAppPath: () => process.cwd(),
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
    exit: mock.exit,
    once: (name: string, handler: (event: { preventDefault(): void }) => void) => {
      mock.appEvents.set(name, handler);
    },
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
  forgeAvailable.mockResolvedValue(false);
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
  forgeUi.rows = undefined;
  forgeUi.notices = [];
  forgeUi.events.clear();
  forgeUi.supported = true;
  forgeMock.open.mockResolvedValue({
    track: vi.fn(),
    read: vi.fn(),
    close: vi.fn(),
    pause: vi.fn(),
    invalidate: vi.fn(),
  });
  mock.openWorktrees.mockResolvedValue({
    worktreeRoot: "/home/.foom/worktrees",
    listRepositories: () => [],
    managesPath: mock.managesPath,
  });
  mock.config.initialize.mockResolvedValue({});
  mock.setupState.mockResolvedValue({ settings: mock.settingsStore.get() });
  mock.openSettings.mockResolvedValue(mock.settingsStore);
  mock.attachSetup.mockImplementation(() => mock.setupIpc);
  mock.setupIpc.zoom.mockResolvedValue();
  mock.theme.themeSource = "system";
  mock.window.loadURL.mockResolvedValue();
  mock.fetch.mockResolvedValue(new Response("asset"));
});

export async function start(wait = true) {
  await import("../../../src/main/main");
  if (wait)
    await vi.waitFor(() => {
      expect(mock.window.loadURL.mock.calls.length + mock.quit.mock.calls.length).toBeGreaterThan(
        0,
      );
    });
}

export function quitting() {
  const event = { preventDefault: vi.fn() };
  mock.appEvents.get("before-quit")?.(event);
  return event;
}

export async function invokeWindow(index: number, channel: string, ...args: unknown[]) {
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

export async function newWindow() {
  const count = mock.instances.length;
  await invokeWindow(0, "app-menu:execute", "new-window");
  await vi.waitFor(() => {
    expect(mock.instances).toHaveLength(count + 1);
  });
}

export {
  updateMock,
  forgeHostStatus,
  readinessCheck,
  forgeAvailable,
  forgeUi,
  forgeMock,
  previewMock,
  mock,
};
