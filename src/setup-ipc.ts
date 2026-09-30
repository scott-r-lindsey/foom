import { ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { Setup } from "./setup";

const APP_URL = "app://bundle/index.html";

/**
 * Renderer access to setup. `Setup` validates every payload; keys can be written or
 * removed here but never read back.
 */
export function attachSetup(window: BrowserWindow, setup: Setup): () => void {
  const contents = window.webContents;
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === APP_URL;
  const handlers = new Map<string, (...args: unknown[]) => unknown>([
    ["setup:state", () => setup.state()],
    ["setup:save", (patch) => setup.save(patch)],
    ["setup:set-key", (provider, key) => setup.setKey(provider, key)],
    ["setup:remove-key", (provider) => setup.removeKey(provider)],
    ["setup:check", (config) => setup.check(config)],
  ]);
  for (const [channel, handler] of handlers)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      return handler(...args);
    });
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
  };
}
