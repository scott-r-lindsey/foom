import { app, BrowserWindow, dialog, nativeTheme, net, protocol, session } from "electron";
import { attachTerminal } from "./terminal";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const APP_URL = "app://bundle/index.html";
const rendererDirectory = path.join(__dirname, "renderer");
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
  const window = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 480,
    minHeight: 420,
    title: "Foom",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#05040A" : "#F3F0FA",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
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
    if (input.type !== "keyDown" || !input.control || !input.shift || input.alt || input.meta) {
      return;
    }
    if (key === "c" || key === "v") {
      event.preventDefault();
      if (key === "c") window.webContents.copy();
      else window.webContents.paste();
    }
  });
  const terminals = attachTerminal(window);
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
          message: `${String(count)} ${count === 1 ? "agent is" : "agents are"} still working. Quit anyway?`,
          detail: "Quitting stops all terminals, including shells and servers.",
          buttons: ["Cancel", "Quit"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response !== 1) return;
      }
      await terminals.shutdown();
      quitting = true;
      app.quit();
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
      app.quit();
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
  window.once("ready-to-show", () => {
    window.show();
  });
  window.loadURL(APP_URL).catch((error: unknown) => {
    console.error("Unable to load the application:", error);
    app.quit();
  });
}

app
  .whenReady()
  .then(() => {
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
