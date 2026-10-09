import { ipcMain, shell } from "electron";
import type { BrowserWindow } from "electron";
import type { WindowIpc } from "../window/window-ipc";
import type { ThemeLibrary } from "./library";
export function attachThemes(
  window: BrowserWindow,
  library: ThemeLibrary,
  ipc: WindowIpc = ipcMain,
): () => void {
  const channels = ["theme:list", "theme:open-folder"];
  for (const channel of channels)
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (
        event.sender !== window.webContents ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== "app://bundle/index.html"
      )
        throw new Error("Untrusted IPC sender");
      if (
        channel === "theme:list"
          ? args.length !== 0
          : args.length !== 1 || (args[0] !== "theme" && args[0] !== "terminal-theme")
      )
        throw new Error("Invalid theme arguments");
      const action = async () => {
        if (channel === "theme:list") {
          await library.reload();
          return library.snapshot();
        }
        const kind = args[0];
        if (kind !== "theme" && kind !== "terminal-theme") throw new Error("Invalid theme kind");
        if (await shell.openPath(library.folder(kind)))
          throw new Error("Unable to open themes folder");
        return undefined;
      };
      return action().catch(() => {
        throw new Error("Unable to complete theme request");
      });
    });
  return () => {
    for (const channel of channels) ipc.removeHandler(channel);
  };
}
