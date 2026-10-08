import { ipcMain, shell } from "electron";
import type { BrowserWindow } from "electron";
import { readFile } from "node:fs/promises";
import type { SoundLibrary } from "./library";
export function attachSounds(
  window: BrowserWindow,
  library: SoundLibrary,
  noticesFile: string,
): () => void {
  const handlers = new Map<string, (value: unknown) => Promise<unknown>>([
    [
      "sound:list",
      async () => {
        const list = await library.list();
        if (
          !window.webContents.isDestroyed() &&
          window.webContents.mainFrame.url === "app://bundle/index.html"
        )
          window.webContents.send("sound:changed");
        return list;
      },
    ],
    ["sound:read", (value) => library.read(value)],
    [
      "sound:open-folder",
      async () => {
        await library.initialize();
        if (await shell.openPath(library.user)) throw new Error("Unable to open sounds folder");
      },
    ],
    ["sound:notices", () => readFile(noticesFile, "utf8")],
  ]);
  for (const [channel, handler] of handlers)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (
        event.sender !== window.webContents ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== "app://bundle/index.html"
      )
        throw new Error("Untrusted IPC sender");
      if (args.length !== (channel === "sound:read" ? 1 : 0))
        throw new Error("Invalid sound arguments");
      return handler(args[0]).catch(() => {
        // Native filesystem errors can contain private paths. Keep them out of IPC.
        throw new Error("Unable to complete sound request");
      });
    });
  return () => {
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
  };
}
