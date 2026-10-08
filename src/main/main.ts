import { InventoryWatch } from "./workspace/inventory-watch";
import { ControlRuntime } from "./control/runtime";
import { TrustedDialog } from "./confirmations/trusted-dialog";
import { selectProfile, clearParentHooks } from "./profile";
import { interfaceThemeSource, resolveInterfaceTheme } from "../shared/interface-themes";
import { app, BrowserWindow, dialog, nativeTheme, net, protocol, screen, session } from "electron";
import { WorktreeService } from "./workspace/worktrees";
import { attachTerminal } from "./terminals/terminal-ipc";
import { clipboard } from "electron";
import { SessionStore } from "./workspace/session-store";
import { HookReceiver } from "./agents/hook-receiver";
import { VerdictLog } from "./evaluator/verdict-log";
import { Workspace } from "./workspace/workspace";
import { attachWorkspace } from "./workspace/workspace-ipc";
import { InferenceKeys } from "./evaluator/inference-keys";
import { SettingsStore } from "./setup/settings";
import { Setup } from "./setup/setup";
import { attachSetup } from "./setup/setup-ipc";
import {
  initialSize,
  MINIMUM_SIZE,
  scaledSize,
  zoomShortcut,
  createBoardShortcuts,
} from "./window/appearance";
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
]);

async function createWindow(savedSize?: Size) {
  // Use most of the display while respecting the saved interface scale minimum.
  const scale = settings.get().interfaceScale;
  const area = screen.getPrimaryDisplay().workArea;
  const size = initialSize(scale, area, savedSize);
  const minimum = scaledSize(MINIMUM_SIZE, scale, area);
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: minimum.width,
    minHeight: minimum.height,
    title: app.isPackaged ? "Foom" : "Foom Dev",
    backgroundColor: resolveInterfaceTheme(
      settings.get().interfaceTheme,
      nativeTheme.shouldUseDarkColors,
    ).colors.bg,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // Saved interface scale, so the first paint is already the right size.
      zoomFactor: scale / 100,
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: app.isPackaged ? [] : ["--foom-development"],
      webviewTag: false,
    },
  });

  // Keep the development identity when the document publishes its title.
  window.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  const updateBackground = () => {
    window.setBackgroundColor(
      resolveInterfaceTheme(settings.get().interfaceTheme, nativeTheme.shouldUseDarkColors).colors
        .bg,
    );
  };
  nativeTheme.on("updated", updateBackground);
  window.once("closed", () => {
    nativeTheme.removeListener("updated", updateBackground);
  });

  // Terminal control keys (for example Ctrl+W in vim) must reach the PTY.
  window.removeMenu();
  const boardShortcuts = createBoardShortcuts(process.platform);
  window.on("blur", boardShortcuts.reset);
  window.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const quitShortcut =
      process.platform === "darwin"
        ? input.meta && !input.control && !input.alt && (key === "w" || key === "q")
        : !input.meta &&
          ((input.control && !input.alt && key === "q") ||
            (input.alt && !input.control && key === "f4"));
    if (input.type === "keyDown" && !input.shift && quitShortcut) {
      event.preventDefault();
      app.quit();
      return;
    }
    const { handled, command } = boardShortcuts.handle(input);
    if (handled) {
      event.preventDefault();
      if (command) window.webContents.send("board:command", command);
      return;
    }
    const zoom = zoomShortcut(input, process.platform);
    if (zoom) {
      event.preventDefault();
      setupIpc.zoom(zoom).catch((error: unknown) => {
        console.error("Unable to change the interface size:", error);
      });
      return;
    }
    if (input.type !== "keyDown" || !input.control || !input.shift || input.alt || input.meta) {
      return;
    }
    if (key === "c" || key === "v") {
      event.preventDefault();
      if (key === "c") window.webContents.copy();
      else window.webContents.paste();
    }
  });
  // Terminal events and state updates only arrive after both objects exist.
  const terminals = attachTerminal(window, {
    onOutput: (id) => {
      workspace.output(id);
    },
    onEvidence: (id, evidence) => {
      void workspace.evidence(id, evidence);
    },
    onQuiet: (id) => void workspace.quiet(id),
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
  });
  const workspace: Workspace = new Workspace({
    worktrees,
    watcher: new InventoryWatch(
      (repository) => worktrees.watchPaths(repository),
      () => {
        workspace.refresh();
      },
    ),
    terminals,
    sessions: new SessionStore(app.getPath("userData")),
    copyText: (text) => clipboard.writeText(text),
    acknowledgeCodex: async () => {
      await settings.update({ codexNotifierAcknowledged: true });
    },
    // Rules first, then whatever model tier setup has configured.
    verdicts: new VerdictLog(app.getPath("userData"), (input) => setup.classify(input)),
    control: () => ControlRuntime.start(app.getPath("userData")),
    receiver: () => HookReceiver.listen((signal) => void workspace.hook(signal)),
    onChange: () => {
      workspaceIpc.sendChanged();
    },
    onState: (state) => {
      workspaceIpc.sendState(state);
    },
  });
  await workspace.restore();
  const confirmations = new TrustedDialog(window, session.fromPartition("confirmation"), () =>
    resolveInterfaceTheme(settings.get().interfaceTheme, nativeTheme.shouldUseDarkColors),
  );
  const workspaceIpc = attachWorkspace(
    window,
    workspace,
    (id) => terminals.owns(id),
    (content) => confirmations.request(content),
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
    store: settings,
    confirmBypass: async (agent) => {
      const names = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };
      return confirmations.request({
        title: `Save bypass defaults for ${names[agent]}?`,
        detail:
          "A worktree is not a sandbox. With these arguments, the agent can act as you anywhere on the machine. These defaults apply to future launches from Foom.",
        accept: "Save bypass defaults",
      });
    },
    keys: new InferenceKeys(app.getPath("userData")),
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
      terminals.setTheme(next.terminalTheme);
      nativeTheme.themeSource = interfaceThemeSource(next.interfaceTheme, next.colorMode);
      updateBackground();
      // Resize first: the page then zooms into a window that already fits it.
      windowScale.apply(next.interfaceScale);
      window.webContents.setZoomFactor(next.interfaceScale / 100);
    },
  });
  // A click on + or − grows the window from the pointer, so the button stays under it.
  const setupIpc = attachSetup(window, setup, (active) => {
    windowScale.anchorAt(active ? screen.getCursorScreenPoint() : undefined);
  });
  window.once("closed", () => {
    confirmations.dispose();
    setupIpc.dispose();
    workspaceIpc.dispose();
    void workspace.dispose();
  });
  let quitting = false;
  let quitPending = false;
  const requestQuit = async () => {
    if (quitPending) return;
    quitPending = true;
    try {
      const count = terminals.runningCount;
      if (count > 0) {
        const snapshot = workspace.snapshot();
        const accepted = await confirmations.request({
          title: `Quit with ${String(count)} ${count === 1 ? "terminal" : "terminals"} running?`,
          accept: "Stop all and quit",
          sessions: terminals.runningSessions().map((session) => {
            const entry = snapshot.terminals.find((item) => item.id === session.id);
            return {
              id: session.id,
              name:
                entry?.agent === "claude"
                  ? "Claude Code"
                  : entry?.agent === "codex"
                    ? "Codex"
                    : entry?.agent === "agy"
                      ? "Antigravity"
                      : path.basename(session.command),
              location: entry
                ? `${path.basename(entry.repository)} › ${entry.branch ?? entry.worktree}`
                : session.cwd,
              state: entry?.state?.state ?? "quiet_ok",
            };
          }),
        });
        if (!accepted) return;
      }
      await terminals.shutdown();
      // Terminals have stopped: revoke every hook credential and stop listening.
      await workspace.dispose();
      try {
        await saveWindowSize(app.getPath("userData"), window.getNormalBounds());
      } catch (error) {
        console.error("Unable to save the window size:", error);
      }
      confirmations.dispose();
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
  };
  // Keep the window and PTYs alive while the trusted confirmation is pending.
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit();
    }
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
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
  window
    .loadURL(APP_URL)
    .then(show)
    .catch((error: unknown) => {
      console.error("Unable to load the application:", error);
      app.quit();
    });
}

if (!ownsProfile) {
  // Do not initialize persistence, sessions, IPC, or shutdown writers in the loser.
  app.quit();
} else {
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
      worktrees = await WorktreeService.open(app.getPath("userData"));
      settings = await SettingsStore.open(app.getPath("userData"));
      // Before the window exists, so its background already matches the saved mode.
      nativeTheme.themeSource = interfaceThemeSource(
        settings.get().interfaceTheme,
        settings.get().colorMode,
      );
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

      await createWindow(await loadWindowSize(app.getPath("userData")));
    })
    .catch((error: unknown) => {
      console.error("Unable to start the application:", error);
      app.quit();
    });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
