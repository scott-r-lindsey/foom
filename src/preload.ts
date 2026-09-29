import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "./shared/desktop";

// Expose individual capabilities, never ipcRenderer or a generic send function.
const desktop: DesktopApi = {
  sayHello: async () => {
    const reply: unknown = await ipcRenderer.invoke("app:hello");
    if (typeof reply !== "string") throw new Error("Invalid hello response");
    return reply;
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);
