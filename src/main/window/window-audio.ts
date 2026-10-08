import type { BrowserWindow } from "electron";
import type { WindowIpc } from "./window-ipc";

/** One renderer plays app sounds; focus suppression follows the focused board. */
export class WindowAudio {
  private readonly windows = new Map<number, { window: BrowserWindow; focusedId: string | null }>();
  private state(id: number) {
    const focused = [...this.windows.values()].find((entry) => entry.window.isFocused());
    return {
      enabled: this.windows.keys().next().value === id,
      focusedId: focused?.focusedId ?? null,
    };
  }
  private publish = () => {
    for (const [id, entry] of this.windows)
      if (!entry.window.webContents.isDestroyed())
        entry.window.webContents.send("windows:audio", this.state(id));
  };
  attach(window: BrowserWindow, ipc: WindowIpc, ownsView: (id: string) => boolean): () => void {
    const entry = { window, focusedId: null as string | null };
    this.windows.set(window.id, entry);
    ipc.handle("windows:audio-state", (_event, ...args) => {
      if (args.length) throw new Error("Invalid audio request");
      return this.state(window.id);
    });
    ipc.handle("windows:audio-focus", (_event, ...args) => {
      const [id] = args;
      if (
        args.length !== 1 ||
        !(id === null || (typeof id === "string" && id.length <= 200 && ownsView(id)))
      )
        throw new Error("Invalid audio focus");
      entry.focusedId = id;
      this.publish();
    });
    ipc.handle("windows:refuse", (_event, ...args) => {
      if (args.length) throw new Error("Invalid audio request");
      this.windows.values().next().value?.window.webContents.send("windows:refuse");
    });
    window.on("focus", this.publish);
    window.on("blur", this.publish);
    this.publish();
    return () => {
      this.windows.delete(window.id);
      window.removeListener("focus", this.publish);
      window.removeListener("blur", this.publish);
      for (const channel of ["windows:audio-state", "windows:audio-focus", "windows:refuse"])
        ipc.removeHandler(channel);
      this.publish();
    };
  }
}
