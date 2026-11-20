import { listTerminalFonts } from "../fonts/terminal-fonts";
import type { WindowIpc } from "../window/window-ipc";
import { ipcMain } from "electron";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { nextScale, scaleFromZoomFactor } from "../window/appearance";
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
  ipc: WindowIpc = ipcMain,
): { dispose(): void; zoom(direction: ZoomDirection): Promise<void> } {
  const contents = window.webContents;
  const cancelTrust = () => {
    setup.cancelHostTrust();
  };
  const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (!inPlace && mainFrame) cancelTrust();
  };
  contents.on("destroyed", cancelTrust);
  contents.on("render-process-gone", cancelTrust);
  contents.on("did-start-navigation", navigating);
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
  // Native zoom requests, shortcuts and explicit controls share write order.
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = pending.catch(() => undefined).then(work);
    pending = next;
    return next;
  };
  const ensureZoom = (scale: number) => {
    const factor = scale / 100;
    if (contents.getZoomFactor() !== factor) contents.setZoomFactor(factor);
  };
  const zoom = (direction: ZoomDirection) =>
    serial(async () => {
      const { settings } = await setup.state();
      // Adopt a native factor only in response to an explicit user zoom command.
      const current = scaleFromZoomFactor(contents.getZoomFactor());
      const scale = nextScale(current, direction);
      if (scale === settings.interfaceScale && contents.getZoomFactor() === scale / 100) return;
      const state = await setup.save({ interfaceScale: scale });
      ensureZoom(state.settings.interfaceScale);
      send("setup:changed", state);
    });
  const nativeZoom = (_event: Electron.Event, direction: "in" | "out") => {
    void zoom(direction).catch(() => {
      console.warn("Unable to change interface size");
    });
  };
  contents.on("zoom-changed", nativeZoom);
  const handlers = new Map<string, (...args: unknown[]) => unknown>([
    [
      "setup:terminal-fonts",
      (...args) => {
        if (args.length > 1 || (args.length === 1 && typeof args[0] !== "boolean"))
          throw new Error("Invalid font request");
        return listTerminalFonts(args[0] === true);
      },
    ],
    [
      "setup:readiness",
      (...args) => {
        if (args.length) throw new Error("Invalid readiness request");
        return setup.readiness();
      },
    ],
    [
      "setup:copy-host",
      (...args) => {
        if (args.length !== 1) throw new Error("Invalid host copy request");
        return setup.copyHost(args[0]);
      },
    ],
    [
      "setup:github-sign-in",
      (...args) => {
        if (args.length !== 2) throw new Error("Invalid sign-in request");
        return setup.githubSignIn(args[0], args[1]);
      },
    ],
    [
      "setup:state",
      (...args) => {
        if (args.length) throw new Error("Invalid settings request");
        return setup.state();
      },
    ],
    [
      "setup:local-agent-install",
      (...args) => {
        if (args.length !== 1) throw new Error("Invalid installer request");
        return setup.localAgentInstall(args[0]);
      },
    ],
    [
      "setup:repository-requirements",
      (...args) => {
        if (args.length !== 1) throw new Error("Invalid host requirements request");
        return setup.repositoryRequirements(args[0]);
      },
    ],
    [
      "setup:hosts",
      (...args) => {
        if (args.length !== 1) throw new Error("Invalid hosts request");
        return setup.hosts(args[0]);
      },
    ],
    [
      "setup:restart-update",
      (...args) => {
        if (args.length) throw new Error("Invalid update request");
        return setup.restartToUpdate();
      },
    ],
    [
      "setup:save",
      (...args) => {
        if (args.length < 1 || args.length > 2) throw new Error("Invalid settings command");
        const patch = args[0];
        const zooming = typeof patch === "object" && patch !== null && "interfaceScale" in patch;
        return serial(async () => {
          if (zooming) pointerZoom(true);
          try {
            const state = await setup.save(patch, ...args.slice(1));
            if (zooming) ensureZoom(state.settings.interfaceScale);
            send("setup:changed", state);
            return state;
          } finally {
            if (zooming) pointerZoom(false);
          }
        });
      },
    ],
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
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      return handler(...args);
    });
  return {
    dispose() {
      cancelTrust();
      contents.removeListener("zoom-changed", nativeZoom);
      contents.removeListener("destroyed", cancelTrust);
      contents.removeListener("render-process-gone", cancelTrust);
      contents.removeListener("did-start-navigation", navigating);
      for (const channel of handlers.keys()) ipc.removeHandler(channel);
    },
    /** A zoom shortcut: save the next scale and tell the renderer what changed. */
    zoom,
  };
}
