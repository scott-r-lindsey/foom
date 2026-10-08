import { ipcMain } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
export interface WindowIpc {
  handle(channel: string, handler: Handler): void;
  removeHandler(channel: string): void;
}

/** One app-level dispatcher per channel; registration never grants frame/page trust. */
export class WindowIpcRouter {
  private readonly channels = new Map<string, Map<WebContents, Handler>>();

  forWindow(contents: WebContents): WindowIpc {
    return {
      handle: (channel, handler) => {
        let handlers = this.channels.get(channel);
        if (!handlers) {
          handlers = new Map();
          this.channels.set(channel, handlers);
          ipcMain.handle(channel, (event, ...args: unknown[]) => {
            const target = this.channels.get(channel)?.get(event.sender);
            if (
              !target ||
              !event.senderFrame ||
              event.senderFrame !== event.sender.mainFrame ||
              event.senderFrame.url !== "app://bundle/index.html"
            )
              throw new Error("Untrusted IPC sender");
            return target(event, ...args);
          });
        }
        if (handlers.has(contents)) throw new Error("Duplicate window IPC registration");
        handlers.set(contents, handler);
      },
      removeHandler: (channel) => {
        const handlers = this.channels.get(channel);
        if (!handlers?.delete(contents)) return;
        if (!handlers.size) {
          this.channels.delete(channel);
          ipcMain.removeHandler(channel);
        }
      },
    };
  }
}
