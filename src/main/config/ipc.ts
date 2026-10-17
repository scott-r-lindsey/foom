import { ipcMain, shell } from "electron";
import type { BrowserWindow } from "electron";
import type { WindowIpc } from "../window/window-ipc";
import type { ConfigService } from "./service";

const CHANNELS = ["config:status", "config:decide", "config:open-folder"];

/** Settings → Foom config. Decisions name the held change's digest; main checks it. */
export function attachConfig(
  window: BrowserWindow,
  service: Pick<ConfigService, "status" | "decide" | "folder">,
  ipc: WindowIpc = ipcMain,
  openPath: (path: string) => Promise<string> = (path) => shell.openPath(path),
): () => void {
  for (const channel of CHANNELS)
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (
        event.sender !== window.webContents ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.url !== "app://bundle/index.html"
      )
        throw new Error("Untrusted IPC sender");
      const expected = channel === "config:decide" ? 2 : 0;
      if (args.length !== expected) throw new Error("Invalid config arguments");
      const [value, id] = args;
      if (channel === "config:status") return service.status();
      if (channel === "config:decide") {
        if (
          (value !== "allow" && value !== "keep") ||
          typeof id !== "string" ||
          !/^[0-9a-f]{64}$/.test(id)
        )
          throw new Error("Invalid config arguments");
        return service.decide(value, id);
      }
      if (await openPath(service.folder)) throw new Error("Unable to open the Foom config folder");
      return undefined;
    });
  return () => {
    for (const channel of CHANNELS) ipc.removeHandler(channel);
  };
}
