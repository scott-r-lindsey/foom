import { hostsForStore } from "../setup/hosts";
import { checkReadiness } from "../setup/readiness";
import { clipboard, app, BrowserWindow, dialog, nativeTheme, screen, session } from "electron";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { resolveInterfaceTheme } from "../../shared/interface-themes";
import { builtinAgent } from "../../shared/providers/catalog";
import type { Settings } from "../../shared/setup";
import { attachConfig } from "../config/ipc";
import { TrustedDialog } from "../confirmations/trusted-dialog";
import { addTailSecrets } from "../evaluator/terminal-tail";
import { PreviewHost } from "../previews/host";
import { attachPreviews } from "../previews/ipc";
import { pickPreviewFile } from "../previews/pick";
import { PreviewPlacement } from "../previews/placement";
import { PreviewRegistry } from "../previews/registry";
import { attachEnvironment } from "../setup/environment-ipc";
import { Setup } from "../setup/setup";
import { attachSetup } from "../setup/setup-ipc";
import { attachSounds } from "../sounds/ipc";
import { SoundLibrary } from "../sounds/library";
import { attachThemes } from "../themes/ipc";
import { windowIcon } from "../window/app-icon";
import { attachAppMenu, showWindowlessMenu } from "../window/app-menu";
import type { Size } from "../window/appearance";
import { initialSize, MINIMUM_SIZE, scaledSize } from "../window/appearance";
import type { WindowPlacement } from "../window/window-placement";
import { placeWindow } from "../window/window-placement";
import { attachWindowScale } from "../window/window-scale";
import { attachWindowViews } from "../window/window-views-ipc";
import { attachWorkspace } from "../workspace/workspace-ipc";
import type { ApplicationWiring } from "./application-wiring";
import { initializeWorkspace } from "./workspace";

const manualOpenings = new WeakMap<ApplicationWiring, Promise<void>>();

export async function buildWindow(
  wiring: ApplicationWiring,
  savedSize?: Size,
  saved?: WindowPlacement,
  initialSession?: string,
): Promise<BrowserWindow> {
  if (wiring.quitting || wiring.quitPending || wiring.windows.size >= 32)
    throw new Error("Unable to open another window");
  const placement = saved
    ? placeWindow(saved, screen.getAllDisplays(), screen.getPrimaryDisplay())
    : undefined;
  const windowId = placement?.id ?? randomUUID();
  // Use most of the display while respecting the saved interface scale minimum.
  const scale = wiring.settings.get().interfaceScale;
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
      wiring.settings.get().interfaceTheme,
      nativeTheme.shouldUseDarkColors,
      wiring.themes.snapshot(),
    ).colors.bg,
    show: false,
    acceptFirstMouse: true,
    autoHideMenuBar: true,
    ...windowIcon(process.platform, path.join(__dirname, "../..")),
    webPreferences: {
      // Keep board and terminal paints alive across native occlusion/show transitions.
      backgroundThrottling: false,
      // Saved interface scale, so the first paint is already the right size.
      zoomFactor: scale / 100,
      preload: path.join(__dirname, "../../preload/preload.js"),
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

  const ipc = wiring.router.forWindow(window.webContents);
  if (placement?.maximized) window.maximize();
  if (initialSession) {
    const owner = wiring.views.owner(initialSession);
    const previous = owner === undefined ? undefined : wiring.windows.get(owner)?.window;
    wiring.views.transfer(initialSession, owner ?? window.id, window.id, () => {
      if (previous) {
        wiring.terminals.detachView(initialSession, previous.webContents);
        previous.webContents.send("windows:removed", initialSession);
      }
    });
  }
  // Keep the development identity when the document publishes its title.
  window.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  const updateBackground = () => {
    wiring.windows.get(window.id)?.confirmations.refresh();
    window.setBackgroundColor(
      resolveInterfaceTheme(
        wiring.settings.get().interfaceTheme,
        nativeTheme.shouldUseDarkColors,
        wiring.themes.snapshot(),
      ).colors.bg,
    );
  };
  nativeTheme.on("updated", updateBackground);
  const themeIpc = attachThemes(window, wiring.themes, ipc);
  const soundIpc = attachSounds(
    window,
    new SoundLibrary(path.join(__dirname, "../../sounds"), path.join(wiring.configRoot, "sounds")),
    path.join(__dirname, "../../sounds/NOTICES.txt"),
    ipc,
  );
  const configIpc = attachConfig(window, wiring.config, ipc);
  window.once("closed", () => {
    configIpc();
    soundIpc();
    themeIpc();
    nativeTheme.removeListener("updated", updateBackground);
  });

  const openWindow = (about: boolean | "manual" = false) => {
    void wiring
      .createWindow()
      .then(async (created) => {
        if (about === "manual") {
          await openManual(created.id);
        } else if (about) created.webContents.send("board:command", "about");
      })
      .catch((error: unknown) => {
        console.error("Unable to open window:", error);
      });
  };
  let manualPending = false;
  const openManual = (preferredOwner = window.id) => {
    const pending = manualOpenings.get(wiring);
    if (pending) return pending;
    const opening = (async () => {
      const existing = [...wiring.previewHosts.entries()].find(([, host]) =>
        [...host.registry.records.values()].some((record) => record.bundled === "manual"),
      );
      const owner = existing?.[0] ?? preferredOwner;
      const host = existing?.[1] ?? wiring.previewHosts.get(owner);
      if (!host) return;
      const id = await host.openManual();
      const target = wiring.windows.get(owner)?.window;
      if (target?.isMinimized()) target.restore();
      target?.show();
      target?.focus();
      target?.webContents.send("board:command", "manual");
      await wiring.previewPlacements.get(owner)?.place(id);
      host.focusManual(id);
    })().finally(() => {
      manualOpenings.delete(wiring);
    });
    manualOpenings.set(wiring, opening);
    return opening;
  };
  const appMenu = attachAppMenu(
    window,
    (direction) => setupIpc.zoom(direction),
    ipc,
    openWindow,
    async () => (await setup.state()).settings.interfaceScale,
    openManual,
    () => {
      if (!manualPending) return;
      manualPending = false;
      void openManual().catch(() => {
        console.warn("Unable to open manual");
      });
    },
    () => {
      wiring.previewHosts.get(window.id)?.reloadFocused();
    },
  );
  wiring.newWindowCommand = appMenu.newWindow;
  await initializeWorkspace(wiring, window);
  const confirmations = new TrustedDialog(
    window,
    session.fromPartition("confirmation"),
    () =>
      resolveInterfaceTheme(
        wiring.settings.get().interfaceTheme,
        nativeTheme.shouldUseDarkColors,
        wiring.themes.snapshot(),
      ),
    process.platform,
    wiring.removalPresentations,
  );
  void wiring.workspace.initializeControl().catch(() => {
    console.warn("Foom CLI discovery is unavailable.");
  });
  const previewHost = new PreviewHost(
    window,
    new PreviewRegistry(path.join(app.getPath("userData"), `previews-${windowId}.json`)),
    wiring.validatePreviewWorktree,
    () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("workspace:changed");
    },
    (content, signal) => confirmations.request(content, signal),
    app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked/build/manual")
      : path.join(__dirname, "../../manual"),
    (id) => {
      void previewPlacement.place(id, true).catch(() => {});
    },
  );
  wiring.previewHosts.set(window.id, previewHost);
  await previewHost.restore();
  const previewPlacement = new PreviewPlacement(window.webContents, ipc);
  wiring.previewPlacements.set(window.id, previewPlacement);
  const disposePreviews = attachPreviews(
    ipc,
    previewHost,
    (worktree) => pickPreviewFile(window, previewHost, wiring.validatePreviewWorktree, worktree),
    (id) =>
      wiring.moves.popout(window.id, async () => {
        const targetWindow = await wiring.createWindow();
        const target = wiring.previewHosts.get(targetWindow.id);
        if (!target) throw new Error("Preview window unavailable");
        await previewHost.moveTo(id, target);
        await wiring.previewPlacements.get(targetWindow.id)?.place(id, true);
      }),
    (id) => wiring.agentPreviews?.humanClose(id),
    (text) => clipboard.writeText(text),
  );
  const workspaceIpc = attachWorkspace(
    window,
    wiring.workspace,
    (id) => wiring.terminals.owns(id),
    (content) => confirmations.request(content),
    ipc,
    () => [...previewHost.registry.records.values()],
    () => wiring.agentPreviews?.history ?? [],
  );
  window.on("focus", () => {
    // A trusted dialog can return focus to a crashed board during quit.
    if (!window.webContents.isCrashed()) wiring.workspace.refresh();
  });
  const windowScale = attachWindowScale(
    window,
    (bounds) => screen.getDisplayMatching(bounds).workArea,
    scale,
  );
  const applySettings = (next: Settings) => {
    updateBackground();
    // Each window remembers its own 100% size and only the origin has an anchor.
    windowScale.apply(next.interfaceScale);
    window.webContents.setZoomFactor(next.interfaceScale / 100);
    previewHost.refresh();
    confirmations.refresh();
  };
  const setup = new Setup({
    launchHostRecipe: async (target) => {
      const id = await wiring.workspace.startHostRecipe(target);
      wiring.revealSession(id);
    },
    copyText: (text) => clipboard.writeText(text),
    confirmRemoteSessions: (content) => confirmations.request(content),
    hosts: hostsForStore(
      wiring.settings,
      wiring.worktrees.listRepositories.bind(wiring.worktrees),
      app.getVersion(),
    ),
    updates: () =>
      wiring.updates.state(
        wiring.workspace
          .snapshot()
          .terminals.filter(
            (terminal) => terminal.kind === "agent" && !terminal.exited && !terminal.dormant,
          ).length,
      ),
    restartToUpdate: () => wiring.updates.restartToUpdate(),
    readiness: () =>
      checkReadiness(
        wiring.worktrees.listRepositories().map((repo) => repo.path),
        (host) => wiring.forgeRuntime.hostStatus(host),
      ),
    gitReadiness: () =>
      checkReadiness([], wiring.forgeRuntime.hostStatus.bind(wiring.forgeRuntime)),
    themes: () => wiring.themes.snapshot(),
    forgeIds: () =>
      (wiring.config.status().forgePlugins ?? [])
        .filter((entry) => !entry.reason)
        .map((entry) => entry.id),
    store: wiring.settings,
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
    worktreeRoot: wiring.worktrees.worktreeRoot,
    code: {
      worktrees: {
        listRepositories: () => wiring.worktrees.listRepositories(),
        addRepository: (path) => wiring.workspace.addRepository(path),
        removeRepository: (path) => wiring.workspace.removeRepository(path),
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
      wiring.updates.configure(next.checkForUpdates);
      if (next.setupComplete && wiring.claimSetupManual()) manualPending = true;
      wiring.forgeRuntime.configure();
      wiring.workspace.configure(next);
      wiring.applyThemeSettings(next);
      // Resize before zooming, including windows other than the requesting one.
      applySettings(next);
      for (const entry of wiring.windows.values())
        if (entry.window !== window) entry.applySettings(next);
      wiring.publishSettings();
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
    wiring.environment,
    () => {
      addTailSecrets(wiring.environment.redactions());
    },
    ipc,
  );
  wiring.windows.set(window.id, {
    window,
    confirmations,
    workspaceIpc,
    setup,
    updateBackground,
    applySettings,
    appMenu,
    placement: () => ({
      id: windowId,
      display: screen.getDisplayMatching(window.getNormalBounds()).id,
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    }),
  });
  const disposeAudio = wiring.audio.attach(
    window,
    ipc,
    (id) => wiring.views.owner(id) === window.id,
    (id) => {
      wiring.workspace.focusOrchestrator(id);
    },
  );
  const disposeMoves = wiring.moves.attach(window.id, ipc, {
    label: `Window ${String(window.id)}`,
    owns: (content) =>
      content.kind === "preview"
        ? previewHost.registry.records.has(content.id)
        : (wiring.terminals.owns(content.id) || wiring.workspace.ownsSession(content.id)) &&
          !wiring.workspace
            .snapshot()
            .terminals.some((row) => row.id === content.id && row.dormant && row.exited) &&
          (wiring.views.owner(content.id) === undefined ||
            wiring.views.owner(content.id) === window.id),
    send: (channel, ...args) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(channel, ...args);
    },
    move: async (content, target, committed) => {
      const destination = wiring.windows.get(target)?.window;
      if (!destination || destination.isDestroyed()) throw new Error("Window unavailable");
      if (content.kind === "preview") {
        const host = wiring.previewHosts.get(target);
        if (!host) throw new Error("Preview window unavailable");
        await previewHost.moveTo(content.id, host, committed);
        // Reuse the pop-out inventory/placement round trip. The reserved board
        // keeps geometry staged while its source refreshes preview display facts.
        await wiring.previewPlacements.get(target)?.place(content.id, true);
      } else {
        if (
          !wiring.views.transfer(content.id, window.id, target, () => {
            wiring.terminals.detachView(content.id, window.webContents);
          })
        )
          throw new Error("Terminal view unavailable");
        committed();
        window.webContents.send("windows:removed", content.id);
        wiring.publishViews();
      }
    },
  });
  const disposeViews = attachWindowViews(window, ipc, wiring.views, {
    knows: (id) => wiring.terminals.owns(id) || wiring.workspace.ownsSession(id),
    find: (id) => wiring.windows.get(id)?.window,
    detach: (id) => {
      wiring.terminals.detachView(id, window.webContents);
    },
    publish: wiring.publishViews,
    popout: (id) =>
      wiring.moves.popout(window.id, () => wiring.createWindow(undefined, undefined, id)),
  });
  wiring.attention();
  window.once("closed", () => {
    disposePreviews();
    previewPlacement.dispose();
    wiring.previewPlacements.delete(window.id);
    if (!wiring.quitting)
      void previewHost
        .dispose(false, async () => {
          const recoveryWindow = await wiring.createWindow();
          return wiring.previewHosts.get(recoveryWindow.id);
        })
        .then(() => {
          wiring.previewHosts.delete(window.id);
        })
        .catch(() => {
          console.warn("Unable to close previews");
        });
    appMenu.dispose();
    confirmations.dispose();
    setupIpc.dispose();
    environmentIpc.dispose();
    workspaceIpc.dispose();
    wiring.windows.delete(window.id);
    if (!wiring.windows.size && process.platform === "darwin") showWindowlessMenu(openWindow);
    disposeMoves();
    disposeViews();
    disposeAudio();
    wiring.attention();
    if (!wiring.quitting)
      void wiring.saveWindows().catch((error: unknown) => {
        console.error("Unable to save windows:", error);
      });
  });
  window.on("close", (event) => {
    if (wiring.quitting) return;
    if (wiring.quitPending || (wiring.windows.size === 1 && process.platform !== "darwin")) {
      event.preventDefault();
      void wiring.requestQuit();
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
    await window.loadURL(wiring.APP_URL);
    show();
  } catch (error) {
    console.error("Unable to load the application:", error);
    window.destroy();
    throw error;
  }
  wiring.publishViews();
  return window;
}
