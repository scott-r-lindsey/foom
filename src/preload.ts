import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { DesktopApi } from "./shared/desktop";

const desktop: DesktopApi = {
  async start(cols, rows) {
    const reply: unknown = await ipcRenderer.invoke("terminal:start", cols, rows);
    if (typeof reply !== "string") throw new Error("Invalid terminal response");
    return reply;
  },
  input(data) {
    for (let offset = 0; offset < data.length; offset += 65536) {
      ipcRenderer.send("terminal:input", data.slice(offset, offset + 65536));
    }
  },
  resize: (cols, rows) => {
    ipcRenderer.send("terminal:resize", cols, rows);
  },
  acknowledge: (count) => {
    ipcRenderer.send("terminal:ack", count);
  },
  onData(callback) {
    const listener = (_event: IpcRendererEvent, data: unknown) => {
      if (typeof data === "string") callback(data);
    };
    ipcRenderer.on("terminal:data", listener);
    return () => {
      ipcRenderer.removeListener("terminal:data", listener);
    };
  },
  onExit(callback) {
    const listener = (_event: IpcRendererEvent, code: unknown) => {
      if (typeof code === "number") callback(code);
    };
    ipcRenderer.on("terminal:exit", listener);
    return () => {
      ipcRenderer.removeListener("terminal:exit", listener);
    };
  },
};
contextBridge.exposeInMainWorld("desktop", desktop);
