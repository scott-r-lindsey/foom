import { app, BrowserWindow, dialog, nativeTheme, net, protocol, screen, session } from "electron";
import { WorktreeService } from "./workspace/worktrees";
import { attachTerminal } from "./terminals/terminal-ipc";
import { HookReceiver } from "./agents/hook-receiver";
import { VerdictLog } from "./evaluator/verdict-log";
import { Workspace } from "./workspace/workspace";
import { attachWorkspace } from "./workspace/workspace-ipc";
import { InferenceKeys } from "./evaluator/inference-keys";
import { SettingsStore } from "./setup/settings";
import { Setup } from "./setup/setup";
import { attachSetup } from "./setup/setup-ipc";
import {
  BASE_SIZE,
  MINIMUM_SIZE,
  scaledSize,
  zoomShortcut,
  boardShortcut,
} from "./window/appearance";
import { attachWindowScale } from "./window/window-scale";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export let worktrees: WorktreeService;
let settings: SettingsStore;

const APP_URL = "app://bundle/index.html";
const rendererDirectory = path.join(__dirname, "../renderer");
const assets = new Map([
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/tokens.css", "tokens.css"],
  ["/fonts/archivo-black.ttf", "fonts/archivo-black.ttf"],
  ["/fonts/courier-prime.ttf", "fonts/courier-prime.ttf"],
  ["/fonts/geist.ttf", "fonts/geist.ttf"],
  ["/fonts/geist-mono.ttf", "fonts/geist-mono.ttf"],
  ["/renderer.js", "renderer.js"],
  ["/renderer.css", "renderer.css"],
]);

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  // The window opens at the saved interface scale, sized to match and to fit.
  const scale = settings.get().interfaceScale;
  const area = screen.getPrimaryDisplay().workArea;
  const size = scaledSize(BASE_SIZE, scale, area);
  const minimum = scaledSize(MINIMUM_SIZE, scale, area);
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: minimum.width,
    minHeight: minimum.height,
    title: "Foom",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#05040A" : "#F3F0FA",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // Saved interface scale, so the first paint is already the right size.
      zoomFactor: scale / 100,
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  const updateBackground = () => {
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#05040A" : "#F3F0FA");
  };
  nativeTheme.on("updated", updateBackground);
  window.once("closed", () => {
    nativeTheme.removeListener("updated", updateBackground);
  });

  // Terminal control keys (for example Ctrl+W in vim) must reach the PTY.
  window.removeMenu();
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
    const command = boardShortcut(input, process.platform);
    if (command) {
      event.preventDefault();
      window.webContents.send("board:command", command);
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
    onQuiet: (id) => void workspace.quiet(id),
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
    terminals,
    acknowledgeCodex: async () => {
      await settings.update({ codexNotifierAcknowledged: true });
    },
    // Rules first, then whatever model tier setup has configured.
    verdicts: new VerdictLog(app.getPath("userData"), (input) => setup.classify(input)),
    receiver: () => HookReceiver.listen((signal) => void workspace.hook(signal)),
    onChange: () => {
      workspaceIpc.sendChanged();
    },
    onState: (state) => {
      workspaceIpc.sendState(state);
    },
  });
  const workspaceIpc = attachWorkspace(window, workspace, (id) => terminals.owns(id));
  const windowScale = attachWindowScale(
    window,
    (bounds) => screen.getDisplayMatching(bounds).workArea,
    scale,
  );
  const setup = new Setup({
    store: settings,
    keys: new InferenceKeys(app.getPath("userData")),
    worktreeRoot: worktrees.worktreeRoot,
    code: {
      worktrees,
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
      nativeTheme.themeSource = next.colorMode;
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
        const { response } = await dialog.showMessageBox(window, {
          type: "question",
          title: "Quit Foom?",
          message: `${String(count)} ${count === 1 ? "terminal is" : "terminals are"} still running. Quit anyway?`,
          detail: "Quitting stops all terminals, including shells and servers.",
          buttons: ["Cancel", "Quit"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response !== 1) return;
      }
      await terminals.shutdown();
      // Terminals have stopped: revoke every hook credential and stop listening.
      await workspace.dispose();
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
  // Keep the window and PTYs alive while the native confirmation is pending.
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

app
  .whenReady()
  .then(async () => {
    worktrees = await WorktreeService.open(app.getPath("userData"));
    settings = await SettingsStore.open(app.getPath("userData"));
    // Before the window exists, so its background already matches the saved mode.
    nativeTheme.themeSource = settings.get().colorMode;
    // Serve only known local assets; arbitrary filesystem access is never exposed.
    protocol.handle("app", (request) => {
      const url = new URL(request.url);
      const asset = url.host === "bundle" && assets.get(url.pathname);
      if (request.method !== "GET" || !asset) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(path.join(rendererDirectory, asset)).href);
    });

    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);

    createWindow();
  })
  .catch((error: unknown) => {
    console.error("Unable to start the application:", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  app.quit();
});
