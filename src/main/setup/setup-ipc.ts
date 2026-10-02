import { ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { nextScale } from "../window/appearance";
import type { ZoomDirection } from "../window/appearance";
import type { Setup } from "./setup";

const APP_URL = "app://bundle/index.html";

/**
 * Renderer access to setup. `Setup` validates every payload; keys can be written or
 * removed here but never read back.
 */
export function attachSetup(
  window: BrowserWindow,
  setup: Setup,
  /**
   * Called around a save that changes the interface size from the page, such as the
   * + and − buttons: true before, false after. Shortcuts don't call it.
   */
  pointerZoom: (active: boolean) => void = () => undefined,
): { dispose(): void; zoom(direction: ZoomDirection): Promise<void> } {
  const contents = window.webContents;
  const trusted = (event: IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === APP_URL;
  /** Progress and changes go only to the app document. */
  const send = (channel: string, ...args: unknown[]) => {
    if (!contents.isDestroyed() && contents.mainFrame.url === APP_URL)
      contents.send(channel, ...args);
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>([
    ["setup:state", () => setup.state()],
    [
      "setup:save",
      async (patch) => {
        const zooming = typeof patch === "object" && patch !== null && "interfaceScale" in patch;
        if (zooming) pointerZoom(true);
        try {
          return await setup.save(patch);
        } finally {
          if (zooming) pointerZoom(false);
        }
      },
    ],
    ["setup:set-key", (provider, key) => setup.setKey(provider, key)],
    ["setup:remove-key", (provider) => setup.removeKey(provider)],
    [
      "setup:check",
      (id, config, timeoutMs) => {
        if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
          throw new Error("Invalid check ID");
        return setup.check(id, config, timeoutMs, (update) => {
          send("setup:check-progress", id, update);
        });
      },
    ],
    [
      "setup:check-cancel",
      (id) => {
        if (typeof id === "string") setup.cancel(id);
      },
    ],
    ["setup:models", (endpoint) => setup.models(endpoint)],
    ["setup:code-suggestions", () => setup.codeSuggestions()],
    [
      "setup:scan-code",
      (id, folder) => {
        if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
          throw new Error("Invalid scan ID");
        return setup.scanCode(folder, (progress) => {
          send("setup:scan-progress", id, progress);
        });
      },
    ],
    [
      "setup:apply-repositories",
      async (selected) => {
        const result = await setup.applyRepositories(selected);
        send("workspace:changed");
        return result;
      },
    ],
  ]);
  for (const [channel, handler] of handlers)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      return handler(...args);
    });
  return {
    dispose() {
      for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    },
    /** A zoom shortcut: save the next scale and tell the renderer what changed. */
    async zoom(direction) {
      const { settings } = await setup.state();
      const scale = nextScale(settings.interfaceScale, direction);
      if (scale === settings.interfaceScale) return;
      send("setup:changed", await setup.save({ interfaceScale: scale }));
    },
  };
}
