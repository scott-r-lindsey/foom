import { app, BrowserWindow, net, protocol, session } from "electron";
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
    backgroundColor: "#05040A",
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

  // Terminal control keys (for example Ctrl+W in vim) must reach the PTY.
  window.removeMenu();
  attachTerminal(window);
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
