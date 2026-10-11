"use strict";
// Sandboxed board preload: only electron is available here.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", {
  config: () => ipcRenderer.invoke("spike:config"),
  terminalWrite: (data) => ipcRenderer.send("spike:pty-write", String(data)),
  terminalResize: (cols, rows) => ipcRenderer.send("spike:pty-resize", Number(cols), Number(rows)),
  onTerminal: (callback) => ipcRenderer.on("spike:pty-data", (_event, data) => callback(String(data))),
  bounds: (list) => ipcRenderer.send("spike:bounds", list),
  overlay: (open) => ipcRenderer.invoke("spike:overlay", Boolean(open)),
  onShortcut: (callback) => ipcRenderer.on("spike:shortcut", (_event, name) => callback(String(name))),
});
