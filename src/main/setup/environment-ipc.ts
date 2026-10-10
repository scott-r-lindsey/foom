import { ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { WindowIpc } from "../window/window-ipc";
import type { EnvironmentStore } from "./environment";

const APP_URL = "app://bundle/index.html";

/**
 * Renderer access to Environment settings. The store validates every payload and
 * replies with names, plain values and masked secrets only; errors never carry values.
 */
export function attachEnvironment(
  window: BrowserWindow,
  store: Pick<EnvironmentStore, "state" | "save" | "remove" | "readShell" | "import">,
  onChange: () => void = () => undefined,
  ipc: WindowIpc = ipcMain,
): { dispose(): void } {
  const contents = window.webContents;
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === APP_URL;
  const changed = async <T>(result: Promise<T>) => {
    const value = await result;
    onChange();
    return value;
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>([
    ["environment:state", () => store.state()],
    ["environment:save", (change) => changed(store.save(change))],
    ["environment:remove", (scope, name) => changed(store.remove(scope, name))],
    ["environment:read-shell", () => store.readShell()],
    ["environment:import", (names) => changed(store.import(names))],
  ]);
  for (const [channel, handler] of handlers)
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      return handler(...args);
    });
  return {
    dispose() {
      for (const channel of handlers.keys()) ipc.removeHandler(channel);
    },
  };
}
