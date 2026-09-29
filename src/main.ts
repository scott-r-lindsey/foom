import { app, BrowserWindow, ipcMain, net, protocol, session } from "electron";
import type { DesktopApi } from "./shared/desktop";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const APP_URL = "app://bundle/index.html";
const rendererDirectory = path.join(__dirname, "renderer");
const assets = new Map([
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/renderer.js", "renderer.js"],
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
    backgroundColor: "#f6f7fb",
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

    ipcMain.handle("app:hello", (event): Awaited<ReturnType<DesktopApi["sayHello"]>> => {
      // Trust only our top-level document, never child frames or navigated pages.
      const frame = event.senderFrame;
      if (!frame || frame !== event.sender.mainFrame || frame.url !== APP_URL) {
        throw new Error("Untrusted IPC sender");
      }
      return "Hello from the main process!";
    });

    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error("Unable to start the application:", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
