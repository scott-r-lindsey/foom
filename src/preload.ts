import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { DesktopApi } from "./shared/desktop";

const desktop: DesktopApi = {
  async create(cols, rows) {
    const reply: unknown = await ipcRenderer.invoke("terminal:create", cols, rows);
    if (
      typeof reply !== "object" ||
      reply === null ||
      !("id" in reply) ||
      typeof reply.id !== "string" ||
      !("title" in reply) ||
      typeof reply.title !== "string"
    )
      throw new Error("Invalid terminal response");
    return { id: reply.id, title: reply.title };
  },
  async attach(id) {
    await ipcRenderer.invoke("terminal:attach", id);
  },
  async detach(id) {
    await ipcRenderer.invoke("terminal:detach", id);
  },
  async kill(id) {
    await ipcRenderer.invoke("terminal:kill", id);
  },
  input(id, data) {
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(offset + 65536, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      ipcRenderer.send("terminal:input", id, data.slice(offset, end));
      offset = end;
    }
  },
  resize: (id, cols, rows) => {
    ipcRenderer.send("terminal:resize", id, cols, rows);
  },
  acknowledge: (id, token, count) => {
    ipcRenderer.send("terminal:ack", id, token, count);
  },
  onData(callback) {
    const listener = (_event: IpcRendererEvent, id: unknown, token: unknown, data: unknown) => {
      if (typeof id === "string" && typeof token === "string" && typeof data === "string")
        callback(id, token, data);
    };
    ipcRenderer.on("terminal:data", listener);
    return () => {
      ipcRenderer.removeListener("terminal:data", listener);
    };
  },
  onExit(callback) {
    const listener = (_event: IpcRendererEvent, id: unknown, code: unknown) => {
      if (typeof id === "string" && typeof code === "number" && Number.isInteger(code))
        callback(id, code);
    };
    ipcRenderer.on("terminal:exit", listener);
    return () => {
      ipcRenderer.removeListener("terminal:exit", listener);
    };
  },
};
contextBridge.exposeInMainWorld("desktop", desktop);
