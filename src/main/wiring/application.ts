import { readFileSync } from "node:fs";
import { autoUpdater } from "electron";
import { Updates } from "../updates";
import { prepareLocalUpdate } from "../update-package";
import { getUpdateRelease } from "../update-http";
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
} from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { DialogContent } from "../../shared/confirmation";
import { interfaceThemeSource } from "../../shared/interface-themes";
import { builtinAgent } from "../../shared/providers/catalog";
import type { Settings } from "../../shared/setup";
import { isUserThemeId } from "../../shared/theme-validation";
import { loginPath } from "../agents/agents";
import { providerRevision, replaceConfigProviders } from "../agents/providers/registry";
import { configPart } from "../config/approval";
import { ConfigService } from "../config/service";
import type { TrustedDialog } from "../confirmations/trusted-dialog";
import { ForgeRuntime } from "../control/forge-runtime";
import type { PreviewBroker } from "../control/previews";
import { addTailSecrets } from "../evaluator/terminal-tail";
import type { PreviewHost } from "../previews/host";
import type { PreviewPlacement } from "../previews/placement";
import { clearParentHooks, selectProfile } from "../profile";
import { EnvironmentStore, safeStorageCipher } from "../setup/environment";
import { DEFAULT_SETTINGS, SettingsStore } from "../setup/settings";
import type { Setup } from "../setup/setup";
import type { attachTerminal } from "../terminals/terminal-ipc";
import { ThemeLibrary } from "../themes/library";
import type { attachAppMenu } from "../window/app-menu";
import type { Size } from "../window/appearance";
import { updateAttention } from "../window/attention-badge";
import type { Command } from "../window/commands";
import { TerminalViews } from "../window/terminal-views";
import { WindowAudio } from "../window/window-audio";
import { WindowIpcRouter } from "../window/window-ipc";
import type { WindowPlacement } from "../window/window-placement";
import { loadPlacements, savePlacements } from "../window/window-placement";
import { loadWindowSize, saveWindowSize } from "../window/window-state";
import type { Workspace } from "../workspace/workspace";
import type { attachWorkspace } from "../workspace/workspace-ipc";
import { WorktreeService } from "../workspace/worktrees";
import type { ApplicationWiring } from "./application-wiring";
import { buildWindow } from "./window";

export let worktrees: WorktreeService;
export let previewHosts: Map<number, PreviewHost>;

export function runApplication() {
  clearParentHooks(process.env);
  selectProfile(app);
  const ownsProfile = app.requestSingleInstanceLock();

  let settings: SettingsStore;
  let firstSetupManualAvailable = false;
  // Seeded from this profile's persisted setup state, then claimed once across all windows.
  function claimSetupManual(): boolean {
    if (!firstSetupManualAvailable) return false;
    firstSetupManualAvailable = false;
    return true;
  }
  const forgeRuntime = new ForgeRuntime(
    () => settings.get(),
    async () => (await loginPath()).path,
  );
  let environment: EnvironmentStore;
  let themes: ThemeLibrary;
  let config: ConfigService;
  let configRoot: string;
  let disposeThemes = () => {};
  /** A validated config file changed: every window re-applies, including interface size. */
  function configApplied() {
    forgeRuntime.configure();
    const next = settings.get();
    if (initialized) workspace.configure(next);
    for (const entry of windows.values()) entry.applySettings(next);
    publishSettings();
  }
  /** Each setup owns its scan state; persisted choices are shared. */
  function publishSettings() {
    queueMicrotask(() => {
      for (const entry of windows.values()) {
        entry.updateBackground();
        void entry.setup
          .state()
          .then((state) => {
            if (!entry.window.webContents.isDestroyed())
              entry.window.webContents.send("setup:changed", state);
          })
          .catch((error: unknown) => {
            console.error("Unable to refresh settings:", error);
          });
      }
    });
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
        })
        .catch(() => {});
    }
  }

  const APP_URL = "app://bundle/index.html";
  registerSchemes();

  const router = new WindowIpcRouter();
  const views = new TerminalViews();
  const audio = new WindowAudio();
  const previewPlacements = new Map<number, PreviewPlacement>();
  let agentPreviews: PreviewBroker | undefined;
  previewHosts = new Map<number, PreviewHost>();
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
      applySettings(next: Settings): void;
      appMenu: ReturnType<typeof attachAppMenu>;
    }
  >();
  const publishViews = () => {
    const snapshot = views.snapshot();
    for (const { window } of windows.values())
      if (!window.webContents.isDestroyed())
        window.webContents.send(
          "windows:changed",
          snapshot.map((view) => ({
            ...view,
            window: view.window === window.id ? 0 : view.window,
          })),
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
      [...windows.values()].find(({ window }) => window.isFocused()) ??
      windows.values().next().value;
    void (async () => {
      const owner = views.owner(id);
      const target =
        (owner === undefined ? undefined : windows.get(owner)?.window) ?? entry?.window;
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
      [...windows.values()].find(({ window }) => window.isFocused()) ??
      windows.values().next().value;
    if (!newWindowCommand) return;
    const targets = process.platform === "win32" ? [...windows.values()] : [entry];
    const snapshot = workspace.snapshot();
    if (updates.state(0).status === "downloaded") publishSettings();
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
      [...windows.values()].find(({ window }) => window.isFocused()) ??
      windows.values().next().value;
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
      .then(() => buildWindow(wiring, savedSize, saved, initialSession));
    windowQueue = next;
    return next;
  }

  const packageInfo: unknown = JSON.parse(
    readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"),
  );
  const updates = new Updates({
    nightlyDate:
      typeof packageInfo === "object" && packageInfo !== null && "foomNightlyDate" in packageInfo
        ? packageInfo.foomNightlyDate
        : undefined,
    packaged: app.isPackaged,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    updater: autoUpdater,
    getRelease: (url, signal) => getUpdateRelease(app.getVersion(), process.platform, url, signal),
    prepareUpdate: (update, signal) => prepareLocalUpdate(app.getPath("userData"), update, signal),
    quit: () => {
      app.quit();
    },
    exit: () => {
      app.exit(0);
    },
    changed: publishSettings,
    requestQuit,
  });
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
      await forgeRuntime.close();
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
      // checkpoint. Let that cancelled close unwind before closing windows, including
      // the explicit update restart. Keep requestQuit pending until this decision.
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          const restarting = updates.quitting();
          updates.dispose();
          if (!restarting) app.quit();
          resolve();
        });
      });
    } catch (error) {
      console.error("Unable to quit the application:", error);
      dialog.showErrorBox("Unable to quit Foom", "Could not stop all terminals. Please try again.");
    } finally {
      quitPending = false;
    }
  }

  // Mutable bindings stay live across feature callbacks and later window launches.
  const wiring = {
    APP_URL,
    updates,
    get agentPreviews() {
      return agentPreviews;
    },
    set agentPreviews(value: typeof agentPreviews) {
      agentPreviews = value;
    },
    applyThemeSettings,
    attention,
    audio,
    get config() {
      return config;
    },
    set config(value: typeof config) {
      config = value;
    },
    claimSetupManual,
    configApplied,
    get configRoot() {
      return configRoot;
    },
    set configRoot(value: typeof configRoot) {
      configRoot = value;
    },
    configStatusChanged,
    createWindow,
    set disposeThemes(value: typeof disposeThemes) {
      disposeThemes = value;
    },
    get environment() {
      return environment;
    },
    set environment(value: typeof environment) {
      environment = value;
    },
    forgeRuntime,
    get initialized() {
      return initialized;
    },
    set initialized(value: typeof initialized) {
      initialized = value;
    },
    set newWindowCommand(value: typeof newWindowCommand) {
      newWindowCommand = value;
    },
    previewHosts,
    previewPlacements,
    publishSettings,
    publishViews,
    get quitPending() {
      return quitPending;
    },
    get quitting() {
      return quitting;
    },
    removingPreviewWorktrees,
    requestPairing,
    requestQuit,
    requestTrusted,
    revealSession,
    router,
    saveWindows,
    get settings() {
      return settings;
    },
    set settings(value: typeof settings) {
      settings = value;
      firstSetupManualAvailable = !value.get().setupComplete;
    },
    get terminals() {
      return terminals;
    },
    set terminals(value: typeof terminals) {
      terminals = value;
    },
    get themes() {
      return themes;
    },
    set themes(value: typeof themes) {
      themes = value;
    },
    themesChanged,
    validatePreviewWorktree,
    views,
    windows,
    get workspace() {
      return workspace;
    },
    set workspace(value: typeof workspace) {
      workspace = value;
    },
    get worktrees() {
      return worktrees;
    },
    set worktrees(value: typeof worktrees) {
      worktrees = value;
    },
  };

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
        await startApplication(wiring);
      })
      .catch((error: unknown) => {
        console.error("Unable to start the application:", error);
        app.quit();
      });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
  }

  return wiring;
}

async function startApplication(wiring: ApplicationWiring): Promise<void> {
  wiring.configRoot = path.join(app.getPath("home"), ".foom", "config");
  wiring.worktrees = await WorktreeService.open(
    app.getPath("userData"),
    undefined,
    [wiring.configRoot],
    wiring.forgeRuntime.provider,
  );
  wiring.settings = await SettingsStore.open(app.getPath("userData"));
  const placements = await loadPlacements(app.getPath("userData"));
  const legacy = wiring.settings.legacyConfig();
  const migratedScale = legacy?.interfaceScale ?? placements[0]?.scale;
  wiring.environment = await EnvironmentStore.open(
    app.getPath("userData"),
    safeStorageCipher(safeStorage),
  );
  addTailSecrets(wiring.environment.redactions());
  wiring.config = new ConfigService({
    root: wiring.configRoot,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: (values) => {
      wiring.settings.setConfig(values);
      wiring.applyThemeSettings();
      wiring.configApplied();
    },
    baseline: {
      get: () => wiring.settings.configDigest(),
      set: (value) => wiring.settings.setConfigDigest(value),
    },
    appliedText: {
      get: () => wiring.settings.configText(),
      set: (text) => wiring.settings.setConfigText(text),
    },
    themeBaseline: {
      get: (file) => wiring.settings.themeDigest(file),
      set: (file, value) => wiring.settings.setThemeDigest(file, value),
    },
    applyForges: (plugins) => {
      wiring.forgeRuntime.replace(plugins);
    },
    applyPlugins: (providers) => {
      const before = providerRevision();
      replaceConfigProviders(providers);
      if (before !== providerRevision() && wiring.initialized)
        void wiring.workspace
          .scanAgents(true)
          .then(() => {
            wiring.workspace.refresh();
            wiring.publishSettings();
          })
          .catch(() => {
            console.error("Unable to refresh agent plugins");
          });
    },
    confirmArguments: (content) => wiring.requestTrusted(content, new AbortController().signal),
    acknowledgeBypass: async (agents) => {
      const acknowledged = { ...wiring.settings.get().agentBypassAcknowledged };
      for (const agent of agents) acknowledged[agent] = true;
      await wiring.settings.update({ agentBypassAcknowledged: acknowledged });
    },
    onStatus: wiring.configStatusChanged,
    onThemeDecision: () => {
      void wiring.themes.reload();
    },
  });
  wiring.themes = new ThemeLibrary(wiring.configRoot, wiring.themesChanged, (file, text, theme) =>
    wiring.config.reviewTheme(file, text, theme),
  );
  wiring.disposeThemes = () => {
    wiring.themes.dispose();
  };
  try {
    const values = await wiring.config.initialize(legacy);
    await wiring.settings.attachConfig(
      (patch) => wiring.config.write(patch),
      values,
      wiring.settings.configDigest(),
    );
    // Existing shared choices win. Otherwise adopt the first legacy window once,
    // through the shared writer, before any window can paint at a different size.
    if (values.interfaceScale === undefined && migratedScale !== undefined)
      await wiring.settings.update({ interfaceScale: migratedScale });
  } catch (error) {
    // Settings stay in the profile until the folder is usable.
    console.error("Foom config is unavailable:", error);
  }
  await wiring.themes.initialize();
  wiring.applyThemeSettings();
  attachAssetSecurity();
  if (placements.length)
    for (const placement of placements) await wiring.createWindow(undefined, placement);
  else await wiring.createWindow(await loadWindowSize(app.getPath("userData")));
  wiring.workspace.configure(wiring.settings.get());
  void wiring.workspace.restartSaved();
  wiring.updates.configure(wiring.settings.get().checkForUpdates);
}

const rendererDirectory = path.join(__dirname, "../../renderer");
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

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: "foom-preview", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function attachAssetSecurity() {
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
}
