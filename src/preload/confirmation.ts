import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { ConfirmationWindowApi, DialogRequest } from "../shared/confirmation";
let current: DialogRequest | null = null;
const listeners = new Set<(request: DialogRequest | null) => void>();
ipcRenderer.on("confirmation:render", (_event: IpcRendererEvent, request: DialogRequest | null) => {
  current = request;
  for (const listener of listeners) listener(request);
});
const api: ConfirmationWindowApi = {
  render(callback) {
    listeners.add(callback);
    callback(current);
    return () => {
      listeners.delete(callback);
    };
  },
  answer(id, accepted) {
    ipcRenderer.send("confirmation:answer", id, accepted);
  },
};
contextBridge.exposeInMainWorld("confirmation", api);
