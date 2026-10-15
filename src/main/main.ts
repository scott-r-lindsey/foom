import { setupOffers } from "./agents/setup-offers";
import { replaceConfigProviders, providerRevision } from "./agents/providers/registry";
import { builtinAgent } from "../shared/providers/catalog";
import { pickPreviewFile } from "./previews/pick";
import { ForgeTracking } from "./control/forge-tracking";
import { previewBackend } from "./previews/control-backend";
import type { PreviewBroker } from "./control/previews";
import { PreviewPlacement } from "./previews/placement";
import { PreviewHost } from "./previews/host";
import { PreviewRegistry } from "./previews/registry";
import { attachPreviews } from "./previews/ipc";
import type { Settings } from "../shared/setup";
import { ThemeLibrary } from "./themes/library";
import { ConfigService } from "./config/service";
import { ConfigGit, prepareIsolation } from "./config/git";
import { attachConfig } from "./config/ipc";
import { configPart } from "./config/approval";
import { DEFAULT_SETTINGS } from "./setup/settings";
import { attachThemes } from "./themes/ipc";
import { isUserThemeId } from "../shared/theme-validation";
import { WindowAudio } from "./window/window-audio";
import type { Command } from "./window/commands";
import { attachWindowViews } from "./window/window-views-ipc";
import { randomUUID } from "node:crypto";
import { WindowIpcRouter } from "./window/window-ipc";
import { TerminalViews } from "./window/terminal-views";
import { loadPlacements, savePlacements, placeWindow } from "./window/window-placement";
import type { WindowPlacement } from "./window/window-placement";
import { join } from "node:path";
import { CodexHookStatus } from "./agents/codex-hook-status";
import { SoundLibrary } from "./sounds/library";
import { attachSounds } from "./sounds/ipc";
import { attachAppMenu, showWindowlessMenu } from "./window/app-menu";
import { updateAttention } from "./window/attention-badge";
import { InventoryWatch } from "./workspace/inventory-watch";
import { ControlRuntime } from "./control/runtime";
import { TrustedDialog } from "./confirmations/trusted-dialog";
import type { DialogContent } from "../shared/confirmation";
import { selectProfile, clearParentHooks } from "./profile";
import { interfaceThemeSource, resolveInterfaceTheme } from "../shared/interface-themes";
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  session,
} from "electron";
import { WorktreeService } from "./workspace/worktrees";
import { attachTerminal } from "./terminals/terminal-ipc";
import { clipboard } from "electron";
import { SessionStore } from "./workspace/session-store";
import { HookReceiver } from "./agents/hook-receiver";
import { VerdictLog } from "./evaluator/verdict-log";
import { Workspace } from "./workspace/workspace";
import { attachWorkspace } from "./workspace/workspace-ipc";
import { SettingsStore } from "./setup/settings";
import { Setup } from "./setup/setup";
import { attachSetup } from "./setup/setup-ipc";
import { attachEnvironment } from "./setup/environment-ipc";
import {
  buildLaunchEnvironment,
  EnvironmentStore,
  inheritedEnvironment,
  safeStorageCipher,
} from "./setup/environment";
import { addTailSecrets } from "./evaluator/terminal-tail";
import { initialSize, MINIMUM_SIZE, scaledSize } from "./window/appearance";
import { loadWindowSize, saveWindowSize } from "./window/window-state";
import type { Size } from "./window/appearance";
import { attachWindowScale } from "./window/window-scale";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

clearParentHooks(process.env);
selectProfile(app);
const ownsProfile = app.requestSingleInstanceLock();

export let worktrees: WorktreeService;
let settings: SettingsStore;
let environment: EnvironmentStore;
let themes: ThemeLibrary;
let config: ConfigService;
let configRoot: string;
let disposeThemes = () => {};
/** A validated config file changed: every window re-applies, including interface size. */
function configApplied(previous: Settings) {
  for (const entry of windows.values()) entry.configChanged(previous);
}
function configStatusChanged() {
  const status = config.status();
  for (const { window } of windows.values())
    if (!window.webContents.isDestroyed() && window.webContents.mainFrame.url === APP_URL)
      window.webContents.send("config:changed", status);
}
function applyThemeSettings(next: Settings = settings.get()) {
  const catalog = themes.snapshot();
  nativeTheme.themeSource = interfaceThemeSource(next.interfaceTheme, next.colorMode, catalog);
  if (initialized)
    terminals.setTheme(
      isUserThemeId(next.terminalTheme)
        ? (catalog.terminal.find((entry) => entry.id === next.terminalTheme)?.theme ?? "follow")
        : next.terminalTheme,
    );
}
function themesChanged() {
  applyThemeSettings();
  for (const entry of windows.values()) {
    entry.updateBackground();
    void entry.setup
      .state()
      .then((state) => {
        if (
          !entry.window.webContents.isDestroyed() &&
          entry.window.webContents.mainFrame.url === APP_URL
        )
          entry.window.webContents.send("setup:changed", state);
        void entry.appMenu.refreshAgents();
      })
      .catch(() => {});
  }
}

const APP_URL = "app://bundle/index.html";
const rendererDirectory = path.join(__dirname, "../renderer");
const assets = new Map([
  ["/index.html", "index.html"],
  ["/confirmation.html", "confirmation.html"],
  ["/confirmation.js", "confirmation.js"],
  ["/confirmation.css", "confirmation.css"],
  ["/styles.css", "styles.css"],
  ["/tokens.css", "tokens.css"],
  ["/fonts/archivo-black.ttf", "fonts/archivo-black.ttf"],
  ["/fonts/courier-prime.ttf", "fonts/courier-prime.ttf"],
  ["/fonts/geist.ttf", "fonts/geist.ttf"],
  ["/fonts/geist-mono.ttf", "fonts/geist-mono.ttf"],
  ["/fonts/HackNerdFontMono-Regular.woff2", "fonts/HackNerdFontMono-Regular.woff2"],
  ["/fonts/HackNerdFontMono-Bold.woff2", "fonts/HackNerdFontMono-Bold.woff2"],
  ["/renderer.js", "renderer.js"],
  ["/renderer.css", "renderer.css"],
]);

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "foom-preview", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const router = new WindowIpcRouter();
const views = new TerminalViews();
const audio = new WindowAudio();
const previewPlacements = new Map<number, PreviewPlacement>();
let agentPreviews: PreviewBroker | undefined;
export const previewHosts = new Map<number, PreviewHost>();
const removingPreviewWorktrees = new Set<string>();
async function validatePreviewWorktree(path: string): Promise<void> {
  if (removingPreviewWorktrees.has(path)) throw new Error("Worktree is being removed");
  for (const repository of worktrees.listRepositories()) {
    if ((await worktrees.listWorktrees(repository.path)).some((tree) => tree.path === path)) {
      await worktrees.launchIdentity(repository.path, path);
      if (removingPreviewWorktrees.has(path)) throw new Error("Worktree is being removed");
      return;
    }
  }
  throw new Error("Unknown preview worktree");
}
let terminals: ReturnType<typeof attachTerminal>;
let workspace: Workspace;
let newWindowCommand: Command | undefined;
let initialized = false;
let windowQueue: Promise<unknown> = Promise.resolve();
let quitting = false;
let quitPending = false;
let savingWindows = Promise.resolve();
const windows = new Map<
  number,
  {
    window: BrowserWindow;
    placement(): WindowPlacement;
    confirmations: TrustedDialog;
    workspaceIpc: ReturnType<typeof attachWorkspace>;
    setup: Setup;
    updateBackground(): void;
    configChanged(previous: Settings): void;
    appMenu: ReturnType<typeof attachAppMenu>;
  }
>();
const publishViews = () => {
  const snapshot = views.snapshot();
  for (const { window } of windows.values())
    if (!window.webContents.isDestroyed())
      window.webContents.send(
        "windows:changed",
        snapshot.map((view) => ({ ...view, window: view.window === window.id ? 0 : view.window })),
      );
};
const saveWindows = () => {
  const placements = [...windows.values()].map((entry) => entry.placement());
  savingWindows = savingWindows
    .catch(() => undefined)
    .then(() => savePlacements(app.getPath("userData"), placements));
  return savingWindows;
};
/** Shows a session in the window that owns its view, or the focused board. */
const revealSession = (id: string) => {
  const entry =
    [...windows.values()].find(({ window }) => window.isFocused()) ?? windows.values().next().value;
  void (async () => {
    const owner = views.owner(id);
    const target = (owner === undefined ? undefined : windows.get(owner)?.window) ?? entry?.window;
    if (!target) {
      await createWindow(undefined, undefined, id);
      return;
    }
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    target.webContents.send("app-menu:session", id);
  })().catch((error: unknown) => {
    console.error("Unable to reveal session:", error);
  });
};
const attention = () => {
  const entry =
    [...windows.values()].find(({ window }) => window.isFocused()) ?? windows.values().next().value;
  if (!newWindowCommand) return;
  const targets = process.platform === "win32" ? [...windows.values()] : [entry];
  const snapshot = workspace.snapshot();
  for (const current of targets)
    updateAttention(current?.window, snapshot, newWindowCommand, revealSession);
};
/** Keep an actor's pending removals on one board even while its dialog owns focus. */
const removalDialogs = new Map<string, { dialog: TrustedDialog; pending: number }>();
/** A trusted dialog on the focused board, or the first; opens a board when none exists. */
async function requestTrusted(content: DialogContent, signal: AbortSignal): Promise<boolean> {
  const cancelled = () => signal.aborted || quitting || quitPending;
  if (cancelled()) return false;
  let entry =
    [...windows.values()].find(({ window }) => window.isFocused()) ?? windows.values().next().value;
  if (!entry) {
    await createWindow();
    entry = windows.values().next().value;
  }
  if (!entry || cancelled()) return false;
  const group = content.removal?.group;
  if (group === undefined) return entry.confirmations.request(content, signal);
  const batch = removalDialogs.get(group) ?? { dialog: entry.confirmations, pending: 0 };
  removalDialogs.set(group, batch);
  batch.pending++;
  try {
    return await batch.dialog.request(content, signal);
  } finally {
    if (--batch.pending === 0) removalDialogs.delete(group);
  }
}
function requestPairing(
  repository: string,
  code: string,
  signal: AbortSignal,
  expiresAt: number,
): Promise<boolean> {
  return requestTrusted(
    {
      title: "Pair this CLI with Foom?",
      accept: "Grant read-only access for 10 minutes",
      glyph: "link",
      pairing: { code, expiresAt },
      facts: [
        { label: "Repository", value: repository, mono: true },
        { label: "Grants", value: "Read-only session metadata for 10 minutes" },
        { label: "Never", value: "Terminal output, or changes to sessions" },
      ],
    },
    signal,
  );
}
function createWindow(
  savedSize?: Size,
  saved?: WindowPlacement,
  initialSession?: string,
): Promise<BrowserWindow> {
  const next = windowQueue
    .catch(() => undefined)
    .then(() => buildWindow(savedSize, saved, initialSession));
  windowQueue = next;
  return next;
}
async function buildWindow(savedSize?: Size, saved?: WindowPlacement, initialSession?: string) {
  if (quitting || quitPending || windows.size >= 32)
    throw new Error("Unable to open another window");
  const placement = saved
    ? placeWindow(saved, screen.getAllDisplays(), screen.getPrimaryDisplay())
    : undefined;
  const windowId = placement?.id ?? randomUUID();
  // Use most of the display while respecting the saved interface scale minimum.
  let scale = placement?.scale ?? settings.get().interfaceScale;
  const area = placement
    ? screen.getDisplayMatching(placement.bounds).workArea
    : screen.getPrimaryDisplay().workArea;
  const size = initialSize(scale, area, placement?.bounds ?? savedSize);
  const minimum = scaledSize(MINIMUM_SIZE, scale, area);
  const window = new BrowserWindow({
    ...(placement
      ? {
          x: Math.max(area.x, Math.min(placement.bounds.x, area.x + area.width - size.width)),
          y: Math.max(area.y, Math.min(placement.bounds.y, area.y + area.height - size.height)),
        }
      : {}),
    width: size.width,
    height: size.height,
    minWidth: minimum.width,
    minHeight: minimum.height,
    title: app.isPackaged ? "Foom" : "Foom Dev",
    backgroundColor: resolveInterfaceTheme(
      settings.get().interfaceTheme,
      nativeTheme.shouldUseDarkColors,
      themes.snapshot(),
    ).colors.bg,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // Keep board and terminal paints alive across native occlusion/show transitions.
      backgroundThrottling: false,
      // Saved interface scale, so the first paint is already the right size.
      zoomFactor: scale / 100,
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      additionalArguments: [
        ...(app.isPackaged ? [] : ["--foom-development"]),
        `--foom-window-id=${windowId}`,
        ...(initialSession ? [`--foom-initial-session=${initialSession}`] : []),
      ],
      webviewTag: false,
    },
  });

  const ipc = router.forWindow(window.webContents);
  if (placement?.maximized) window.maximize();
  if (initialSession) {
    const owner = views.owner(initialSession);
    const previous = owner === undefined ? undefined : windows.get(owner)?.window;
    if (previous) {
      terminals.detachView(initialSession, previous.webContents);
      views.release(initialSession, previous.id);
      previous.webContents.send("windows:removed", initialSession);
    }
    views.claim(initialSession, window.id);
  }
  // Keep the development identity when the document publishes its title.
  window.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  const updateBackground = () => {
    windows.get(window.id)?.confirmations.refresh();
    window.setBackgroundColor(
      resolveInterfaceTheme(
        settings.get().interfaceTheme,
        nativeTheme.shouldUseDarkColors,
        themes.snapshot(),
      ).colors.bg,
    );
  };
  nativeTheme.on("updated", updateBackground);
  const themeIpc = attachThemes(window, themes, ipc);
  const soundIpc = attachSounds(
    window,
    new SoundLibrary(path.join(__dirname, "../sounds"), path.join(configRoot, "sounds")),
    path.join(__dirname, "../sounds/NOTICES.txt"),
    ipc,
  );
  const configIpc = attachConfig(window, config, ipc);
  window.once("closed", () => {
    configIpc();
    soundIpc();
    themeIpc();
    nativeTheme.removeListener("updated", updateBackground);
  });

  const openWindow = () => {
    void createWindow().catch((error: unknown) => {
      console.error("Unable to open window:", error);
    });
  };
  const appMenu = attachAppMenu(
    window,
    (direction) => setupIpc.zoom(direction),
    ipc,
    openWindow,
    async () => (await setup.state()).settings.interfaceScale,
    async () => {
      if (!initialized || !config.ready) return [];
      const report = await workspace.scanAgents(false);
      const current = settings.get();
      return current.setupComplete
        ? report.agents
            .filter((agent) => agent.path && current.agents[agent.id])
            .map((agent) => agent.id)
        : [];
    },
  );
  newWindowCommand = appMenu.newWindow;
  // Terminal events and state updates only arrive after both objects exist.
  if (!initialized)
    terminals = attachTerminal(
      window,
      {
        onOutput: (id) => {
          workspace.output(id);
        },
        onEvidence: (id, evidence) => {
          void workspace.evidence(id, evidence);
        },
        onQuiet: (id) => void workspace.quiet(id),
        onForeground: (id, name) => {
          workspace.foreground(id, name);
        },
        onShellState: (id, state) => {
          workspace.shellState(id, state);
        },
        onExit: (id, code) => void workspace.exited(id, code),
        onInput: (id) => {
          workspace.input(id);
        },
        onRemoved: (id) => {
          workspace.removed(id);
        },
      },
      (contents, id) => {
        const entry = [...windows.values()].find((entry) => entry.window.webContents === contents);
        if (!entry) return false;
        const accepted = views.claim(id, entry.window.id);
        if (accepted) publishViews();
        return accepted;
      },
      () =>
        buildLaunchEnvironment({
          layers: environment.layers("shell"),
          base: inheritedEnvironment(),
        }).env,
    );
  else terminals.addWindow(window);
  if (!initialized) {
    await setupOffers.load(app.getPath("userData"));
    if (settings.get().agyPluginOfferAnswered && !setupOffers.answered("agy"))
      await setupOffers.answer("agy");
    const codexHooks = new CodexHookStatus(join(app.getPath("userData"), "codex-hook-health.json"));
    await codexHooks.load();
    const forge = await ForgeTracking.open(
      app.getPath("userData"),
      async (tree) => {
        if (!worktrees.listRepositories().some((repo) => repo.path === tree.repository))
          return undefined;
        const owned = (await worktrees.listWorktrees(tree.repository)).find(
          (row) => row.path === tree.path,
        );
        if (
          !owned?.managed ||
          owned.branch !== tree.branch ||
          (await worktrees.launchIdentity(tree.repository, tree.path)) !== tree.identity
        )
          return undefined;
        return (await worktrees.forgeRemote(tree.repository)) ?? "";
      },
      () => {
        workspace.refresh();
      },
    ).catch(() => undefined);
    workspace = new Workspace({
      pluginStagingRoot: app.getPath("userData"),
      ...(forge === undefined ? {} : { forge }),
      codexHooks,
      worktrees,
      watcher: new InventoryWatch(
        (repository) => worktrees.watchPaths(repository),
        () => {
          workspace.refresh();
        },
      ),
      terminals,
      agentPluginDirectory: app.getPath("userData"),
      sessions: new SessionStore(app.getPath("userData")),
      copyText: (text) => clipboard.writeText(text),
      acknowledgeAgyPluginOffer: async () => {
        await settings.update({ agyPluginOfferAnswered: true });
      },
      acknowledgeCodex: async () => {
        await settings.update({ codexNotifierAcknowledged: true });
      },
      // Local rules classify each terminal; the log stores verdict metadata only.
      verdicts: new VerdictLog(app.getPath("userData")),
      config: {
        root: configRoot,
        cliDirectory: path.join(__dirname, "../console").replace("app.asar", "app.asar.unpacked"),
        check: async () => {
          if (!config.ready) throw new Error("Foom config is unavailable");
          if (await worktrees.managesPath(configRoot))
            throw new Error("Foom config cannot be inside a repository Foom manages");
        },
      },
      control: () =>
        ControlRuntime.start(
          app.getPath("userData"),
          () => workspace.snapshot().terminals,
          {
            repository: (path) =>
              worktrees.listRepositories().find((entry) => entry.path === path)?.path,
            approve: requestPairing,
          },
          workspace.orchestration,
          (id, state) => {
            workspace.mcpConnectionChanged(id, state);
          },
          () => {
            workspace.refresh();
          },
          previewBackend(
            previewHosts,
            previewPlacements,
            (id) => {
              const owner = views.owner(id);
              return (
                (owner === undefined ? undefined : windows.get(owner)) ??
                [...windows.values()].find(({ window }) => window.isFocused()) ??
                windows.values().next().value
              )?.window.id;
            },
            (id) => workspace.snapshot().terminals.find((row) => row.id === id)?.agent ?? "agent",
          ),
        ).then((runtime) => {
          agentPreviews = runtime.service.previews;
          return runtime;
        }),
      dialog: requestTrusted,
      placeChild: (id, parentId) => {
        const owner = views.owner(parentId);
        const target =
          (owner === undefined ? undefined : windows.get(owner)) ??
          [...windows.values()].find(({ window }) => window.isFocused()) ??
          windows.values().next().value;
        target?.window.webContents.send("app-menu:session", id, true);
      },
      reveal: (id) => {
        revealSession(id);
      },
      receiver: () => HookReceiver.listen((signal) => void workspace.hook(signal)),
      environment: (target) => environment.layers(target),
      prepareWorktreeRemoval: async (worktree) => {
        removingPreviewWorktrees.add(worktree);
        const release = () => {
          removingPreviewWorktrees.delete(worktree);
        };
        try {
          await Promise.all([...previewHosts.values()].map((host) => host.closeWorktree(worktree)));
          return release;
        } catch (error) {
          release();
          throw error;
        }
      },
      onChange: () => {
        for (const entry of windows.values()) entry.workspaceIpc.sendChanged();
        for (const host of previewHosts.values())
          void host.reconcile().catch(() => {
            console.warn("Unable to reconcile previews");
          });
        attention();
      },
      onExecution: (event) => {
        for (const entry of windows.values()) entry.workspaceIpc.sendExecution(event);
      },
      onState: (state) => {
        for (const entry of windows.values()) entry.workspaceIpc.sendState(state);
        attention();
      },
    });
    await workspace.restore();
    initialized = true;
  }
  const confirmations = new TrustedDialog(window, session.fromPartition("confirmation"), () =>
    resolveInterfaceTheme(
      settings.get().interfaceTheme,
      nativeTheme.shouldUseDarkColors,
      themes.snapshot(),
    ),
  );
  void workspace.initializeControl().catch(() => {
    console.warn("Foom CLI discovery is unavailable.");
  });
  const previewHost = new PreviewHost(
    window,
    new PreviewRegistry(path.join(app.getPath("userData"), `previews-${windowId}.json`)),
    validatePreviewWorktree,
    () => {
      if (!window.webContents.isDestroyed()) window.webContents.send("workspace:changed");
    },
    (content, signal) => confirmations.request(content, signal),
  );
  previewHosts.set(window.id, previewHost);
  await previewHost.restore();
  const previewPlacement = new PreviewPlacement(window.webContents, ipc);
  previewPlacements.set(window.id, previewPlacement);
  const disposePreviews = attachPreviews(
    ipc,
    previewHost,
    (worktree) => pickPreviewFile(window, previewHost, validatePreviewWorktree, worktree),
    (id) => agentPreviews?.humanClose(id),
  );
  const workspaceIpc = attachWorkspace(
    window,
    workspace,
    (id) => terminals.owns(id),
    (content) => confirmations.request(content),
    ipc,
    () => [...previewHost.registry.records.values()],
    () => agentPreviews?.history ?? [],
  );
  window.on("focus", () => {
    // A trusted dialog can return focus to a crashed board during quit.
    if (!window.webContents.isCrashed()) workspace.refresh();
  });
  const windowScale = attachWindowScale(
    window,
    (bounds) => screen.getDisplayMatching(bounds).workArea,
    scale,
  );
  const setup = new Setup({
    themes: () => themes.snapshot(),
    store: {
      get: () => ({ ...settings.get(), interfaceScale: scale }),
      update: async (patch) => {
        const { interfaceScale, ...shared } = patch;
        const next = await settings.update(shared);
        if (interfaceScale !== undefined) scale = interfaceScale;
        return { ...next, interfaceScale: scale };
      },
    },
    confirmBypass: async (agent, args) => {
      return confirmations.request({
        title: `Save bypass defaults for ${builtinAgent(agent)?.name ?? agent}?`,
        glyph: "shield",
        subject: "Future launches from Foom",
        arguments: args,
        detail:
          "A worktree is not a sandbox. With these arguments, the agent can act as you anywhere on the machine.",
        accept: "Save bypass defaults",
      });
    },
    worktreeRoot: worktrees.worktreeRoot,
    code: {
      worktrees: {
        listRepositories: () => worktrees.listRepositories(),
        addRepository: (path) => workspace.addRepository(path),
        removeRepository: (path) => workspace.removeRepository(path),
      },
      home: app.getPath("home"),
      pickFolder: async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Where do you keep your code?",
          defaultPath: app.getPath("home"),
          properties: ["openDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    },
    apply: (next) => {
      workspace.configure(next);
      applyThemeSettings(next);
      updateBackground();
      // Resize first: the page then zooms into a window that already fits it.
      windowScale.apply(next.interfaceScale);
      window.webContents.setZoomFactor(next.interfaceScale / 100);
      previewHost.refresh();
      confirmations.refresh();
      // Each setup owns its scan state; persisted choices are shared.
      queueMicrotask(() => {
        for (const entry of windows.values()) {
          entry.updateBackground();
          void entry.setup
            .state()
            .then((state) => {
              if (!entry.window.webContents.isDestroyed())
                entry.window.webContents.send("setup:changed", state);
              void entry.appMenu.refreshAgents();
            })
            .catch((error: unknown) => {
              console.error("Unable to refresh settings:", error);
            });
        }
      });
    },
  });
  // A click on + or − grows the window from the pointer, so the button stays under it.
  const setupIpc = attachSetup(
    window,
    setup,
    (active) => {
      windowScale.anchorAt(active ? screen.getCursorScreenPoint() : undefined);
    },
    ipc,
  );
  const environmentIpc = attachEnvironment(
    window,
    environment,
    () => {
      addTailSecrets(environment.redactions());
    },
    ipc,
  );
  windows.set(window.id, {
    window,
    confirmations,
    workspaceIpc,
    setup,
    updateBackground,
    configChanged: (previous) => {
      if (settings.get().interfaceScale !== previous.interfaceScale)
        scale = settings.get().interfaceScale;
      setup.refresh();
    },
    appMenu,
    placement: () => ({
      id: windowId,
      display: screen.getDisplayMatching(window.getNormalBounds()).id,
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      scale,
    }),
  });
  const disposeAudio = audio.attach(window, ipc, (id) => views.owner(id) === window.id);
  const disposeViews = attachWindowViews(window, ipc, views, {
    knows: (id) => terminals.owns(id) || workspace.ownsSession(id),
    find: (id) => windows.get(id)?.window,
    detach: (id) => {
      terminals.detachView(id, window.webContents);
    },
    publish: publishViews,
    popout: (id) => createWindow(undefined, undefined, id),
  });
  attention();
  window.once("closed", () => {
    disposePreviews();
    previewHosts.delete(window.id);
    previewPlacement.dispose();
    previewPlacements.delete(window.id);
    if (!quitting)
      void previewHost.dispose(false).catch(() => {
        console.warn("Unable to close previews");
      });
    appMenu.dispose();
    confirmations.dispose();
    setupIpc.dispose();
    environmentIpc.dispose();
    workspaceIpc.dispose();
    windows.delete(window.id);
    if (!windows.size && process.platform === "darwin") showWindowlessMenu(openWindow);
    disposeViews();
    disposeAudio();
    attention();
    if (!quitting)
      void saveWindows().catch((error: unknown) => {
        console.error("Unable to save windows:", error);
      });
  });
  window.on("close", (event) => {
    if (quitting) return;
    if (quitPending || (windows.size === 1 && process.platform !== "darwin")) {
      event.preventDefault();
      void requestQuit();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  // The detached board need not schedule a terminal paint. Reveal after load even
  // if the hidden-window compositor has not emitted ready-to-show yet.
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    window.show();
  };
  window.once("ready-to-show", show);
  try {
    await window.loadURL(APP_URL);
    show();
  } catch (error) {
    console.error("Unable to load the application:", error);
    window.destroy();
    throw error;
  }
  publishViews();
  return window;
}
let quitRequest: Promise<void> | undefined;
function requestQuit(): Promise<void> {
  quitRequest ??= performQuit().finally(() => {
    quitRequest = undefined;
  });
  return quitRequest;
}
async function performQuit() {
  if (!initialized) {
    disposeThemes();
    quitting = true;
    app.quit();
    return;
  }
  try {
    let entry =
      [...windows.values()].find(({ window }) => window.isFocused()) ??
      windows.values().next().value;
    if (!entry) {
      await createWindow();
      entry = windows.values().next().value;
    }
    if (!entry) return;
    const { window, confirmations } = entry;
    quitPending = true;
    const count = terminals.runningCount;
    if (count > 0) {
      const snapshot = workspace.snapshot();
      const accepted = await confirmations.request(
        {
          title: `Quit with ${String(count)} ${count === 1 ? "terminal" : "terminals"} running?`,
          accept: "Stop all and quit",
          glyph: "power",
          subject: "Each one is stopped",
          sessions: terminals.runningSessions().map((session) => {
            const entry = snapshot.terminals.find((item) => item.id === session.id);
            return {
              id: session.id,
              name: builtinAgent(entry?.agent)?.name ?? path.basename(session.command),
              location: entry?.config
                ? "Foom config"
                : entry
                  ? `${path.basename(entry.repository)} › ${entry.branch ?? entry.worktree}`
                  : session.cwd,
              state: entry?.state?.state ?? "quiet_ok",
            };
          }),
        },
        undefined,
        // A person asked Foom to quit, possibly from the Dock while another app is frontmost.
        { activate: true },
      );
      if (!accepted) return;
    }
    await saveWindows().catch((error: unknown) => {
      console.error("Unable to save windows:", error);
    });
    await workspace.prepareQuit();
    try {
      await terminals.shutdown();
    } catch (error) {
      workspace.cancelQuit();
      throw error;
    }
    // Terminals have stopped: revoke every hook credential and stop listening.
    await workspace.dispose();
    await terminals.dispose();
    try {
      await saveWindowSize(app.getPath("userData"), window.getNormalBounds());
    } catch (error) {
      console.error("Unable to save the window size:", error);
    }
    for (const current of windows.values()) current.confirmations.dispose();
    for (const host of previewHosts.values()) await host.dispose(true);
    previewHosts.clear();
    await config.dispose();
    disposeThemes();
    quitting = true;
    // A resolved shutdown can resume inside a native close callback's microtask
    // checkpoint. Let that cancelled close unwind before asking Electron to quit.
    setImmediate(() => {
      app.quit();
    });
  } catch (error) {
    console.error("Unable to quit the application:", error);
    dialog.showErrorBox("Unable to quit Foom", "Could not stop all terminals. Please try again.");
  } finally {
    quitPending = false;
  }
}

if (!ownsProfile) {
  // Do not initialize persistence, sessions, IPC, or shutdown writers in the loser.
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit();
    }
  });
  app.on("activate", () => {
    if (!windows.size)
      void createWindow().catch((error: unknown) => {
        console.error("Unable to open window:", error);
      });
  });
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === APP_URL,
    );
    if (!window) return; // Startup will show the first window once it has loaded.
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app
    .whenReady()
    .then(async () => {
      configRoot = path.join(app.getPath("home"), ".foom", "config");
      worktrees = await WorktreeService.open(app.getPath("userData"), undefined, [configRoot]);
      settings = await SettingsStore.open(app.getPath("userData"));
      environment = await EnvironmentStore.open(
        app.getPath("userData"),
        safeStorageCipher(safeStorage),
      );
      addTailSecrets(environment.redactions());
      config = new ConfigService({
        root: configRoot,
        git: new ConfigGit(
          configRoot,
          await prepareIsolation(path.join(app.getPath("userData"), "config-git")),
        ),
        defaults: configPart(DEFAULT_SETTINGS),
        apply: (values) => {
          const previous = settings.get();
          settings.setConfig(values);
          applyThemeSettings();
          configApplied(previous);
        },
        baseline: {
          get: () => settings.configDigest(),
          set: (value) => settings.setConfigDigest(value),
        },
        themeBaseline: {
          get: (file) => settings.themeDigest(file),
          set: (file, value) => settings.setThemeDigest(file, value),
        },
        pluginBaseline: {
          get: (file) => settings.themeDigest(file),
          set: (file, value) => settings.setThemeDigest(file, value),
        },
        applyPlugins: (providers) => {
          const before = providerRevision();
          replaceConfigProviders(providers);
          if (before !== providerRevision() && initialized)
            void workspace
              .scanAgents(true)
              .then(() => {
                workspace.refresh();
              })
              .catch(() => {
                console.error("Unable to refresh agent plugins");
              });
        },
        confirmPlugin: (content) => requestTrusted(content, new AbortController().signal),
        confirmArguments: (content) => requestTrusted(content, new AbortController().signal),
        acknowledgeBypass: async (agents) => {
          const acknowledged = { ...settings.get().agentBypassAcknowledged };
          for (const agent of agents) acknowledged[agent] = true;
          await settings.update({ agentBypassAcknowledged: acknowledged });
        },
        onStatus: configStatusChanged,
        onThemeDecision: () => {
          void themes.reload();
        },
      });
      themes = new ThemeLibrary(configRoot, themesChanged, (file, text, theme) =>
        config.reviewTheme(file, text, theme),
      );
      disposeThemes = () => {
        themes.dispose();
      };
      try {
        const values = await config.initialize(settings.legacyConfig());
        await settings.attachConfig(
          (patch) => config.write(patch),
          values,
          settings.configDigest(),
        );
      } catch (error) {
        // Settings stay in the profile until the folder is usable.
        console.error("Foom config is unavailable:", error);
      }
      await themes.initialize();
      applyThemeSettings();
      // Serve only known local assets; arbitrary filesystem access is never exposed.
      const assetHandler = (request: Request) => {
        const url = new URL(request.url);
        const confirmationAsset = [
          "/confirmation.html",
          "/confirmation.js",
          "/confirmation.css",
        ].includes(url.pathname);
        const allowed =
          url.host === "bundle"
            ? !confirmationAsset
            : url.host === "confirmation" &&
              (confirmationAsset ||
                url.pathname === "/tokens.css" ||
                url.pathname.startsWith("/fonts/"));
        const asset = allowed && assets.get(url.pathname);
        if (request.method !== "GET" || !asset) {
          return new Response("Not found", { status: 404 });
        }
        return net.fetch(pathToFileURL(path.join(rendererDirectory, asset)).href);
      };
      protocol.handle("app", assetHandler);
      const confirmationSession = session.fromPartition("confirmation");
      confirmationSession.protocol.handle("app", assetHandler);
      confirmationSession.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });
      confirmationSession.setPermissionCheckHandler(() => false);

      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false);
      });
      session.defaultSession.setPermissionCheckHandler(() => false);

      const placements = await loadPlacements(app.getPath("userData"));
      if (placements.length)
        for (const placement of placements) await createWindow(undefined, placement);
      else await createWindow(await loadWindowSize(app.getPath("userData")));
      workspace.configure(settings.get());
      void workspace.restartSaved();
    })
    .catch((error: unknown) => {
      console.error("Unable to start the application:", error);
      app.quit();
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
