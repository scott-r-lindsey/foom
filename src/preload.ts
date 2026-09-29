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
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(offset + 65536, data.length);
      // IPC limits use UTF-16 code units. Keep a surrogate pair in the same write.
      const before = data.charCodeAt(end - 1);
      const after = data.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      ipcRenderer.send("terminal:input", data.slice(offset, end));
      offset = end;
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
