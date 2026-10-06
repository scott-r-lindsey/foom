import { app, ipcMain } from "electron";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, Event } from "electron";
import { homedir } from "node:os";
import { TerminalHostClient } from "./terminal-host-client";
import { isReply } from "./terminal-reports";
import type { TerminalSpec, ShellState } from "../../shared/desktop";

/** Lifecycle hooks for owned terminals; the workspace evaluates and releases from these. */
export interface TerminalEvents {
  onShellState?(id: string, state: ShellState): void;
  onOutput?(id: string): void;
  onQuiet?(id: string): void;
  onExit?(id: string, code: number): void;
  onInput?(id: string): void;
  onRemoved?(id: string): void;
}

export interface TerminalControl
  extends Pick<TerminalHostClient, "runningCount" | "shutdown" | "stop" | "setTheme"> {
  runningSessions(): readonly { id: string; command: string; cwd: string }[];
  /** Main-only launch: the window may use the new terminal like one it created. */
  create(spec: TerminalSpec): Promise<string>;
  kill(id: string): Promise<void>;
  tail(id: string, lines: number): Promise<string[]>;
  owns(id: string): boolean;
}

/** The app window owns capabilities for multiple independent main-owned sessions. */
export function attachTerminal(
  window: BrowserWindow,
  events: TerminalEvents = {},
): TerminalControl {
  // Capture before BrowserWindow is destroyed; its getter throws during closed.
  const contents = window.webContents;
  const owned = new Set<string>();
  const running = new Map<string, { id: string; command: string; cwd: string }>();
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === "app://bundle/index.html";
  const manager = new TerminalHostClient(
    (id, code) => {
      running.delete(id);
      if (!contents.isDestroyed()) contents.send("terminal:exit", id, code);
      if (owned.has(id)) events.onExit?.(id, code);
    },
    {
      onOutput: (id) => {
        if (owned.has(id)) events.onOutput?.(id);
      },
      onShellState: (id, state) => {
        if (owned.has(id)) events.onShellState?.(id, state);
      },
      onQuiet: (id) => {
        if (owned.has(id)) events.onQuiet?.(id);
      },
      onActivity: (batch) => {
        if (contents.isDestroyed() || contents.mainFrame.url !== "app://bundle/index.html") return;
        const entries = batch.filter(({ id }) => owned.has(id));
        if (entries.length) contents.send("terminal:activity", entries);
      },
    },
  );
  const validId = (id: unknown): id is string => typeof id === "string" && owned.has(id);
  const size = (cols: unknown, rows: unknown): boolean =>
    typeof cols === "number" &&
    typeof rows === "number" &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 2 &&
    cols <= 500 &&
    rows >= 2 &&
    rows <= 300;
  let rendererAlive = true;
  const rendererLoaded = () => {
    rendererAlive = true;
  };
  contents.on("did-finish-load", rendererLoaded);
  let flushToken = 0;
  let pendingFlush: { token: number; ids: string[]; resolve: () => void } | undefined;
  const flushed = (event: IpcMainEvent, ids: unknown, token: unknown) => {
    if (!trusted(event) || !pendingFlush || token !== pendingFlush.token || !Array.isArray(ids))
      return;
    if (
      ids.length === pendingFlush.ids.length &&
      ids.every((id, index) => id === pendingFlush?.ids[index])
    )
      pendingFlush.resolve();
  };
  ipcMain.on("terminal:views-flushed", flushed);
  const flushViews = (ids: string[]) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pendingFlush = undefined;
        resolve();
      };
      // A crashed/unresponsive renderer must not prevent native process cleanup.
      const timer = setTimeout(done, 3000);
      pendingFlush = { token: ++flushToken, ids, resolve: done };
      contents.send("terminal:flush-views", ids, flushToken);
    });
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  handlers.set("terminal:create", async (event, cols, rows) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender");
    if (!size(cols, rows) || typeof cols !== "number" || typeof rows !== "number")
      throw new Error("Invalid terminal size");
    const command =
      process.platform === "win32" ? "powershell.exe" : process.env["SHELL"] || "/bin/bash";
    const cwd = app.isPackaged ? homedir() : process.cwd();
    const id = await manager.create({
      command,
      shellIntegration: true,
      args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
      cwd,
      cols,
      rows,
    });
    owned.add(id);
    running.set(id, { id, command, cwd });
    return { id, title: `${command} — ${cwd}` };
  });
  for (const operation of ["attach", "detach", "kill"] as const) {
    handlers.set(`terminal:${operation}`, async (event, id) => {
      if (!trusted(event)) throw new Error("Untrusted IPC sender");
      if (!validId(id)) throw new Error("Unknown or foreign terminal ID");
      if (operation === "attach")
        await manager.attach(id, (token, data) => {
          contents.send("terminal:data", id, token, data);
        });
      else if (operation === "detach") manager.detach(id);
      else {
        await manager.kill(id);
        owned.delete(id);
        running.delete(id);
        if (!contents.isDestroyed()) contents.send("terminal:availability", [id], false);
        events.onRemoved?.(id);
      }
    });
  }
  handlers.set("terminal:tail", async (event, id, lines) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender");
    if (!validId(id)) throw new Error("Unknown or foreign terminal ID");
    if (typeof lines !== "number" || !Number.isSafeInteger(lines) || lines < 1 || lines > 10000)
      throw new Error("Invalid tail length");
    return manager.tail(id, lines);
  });
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
  const input = (event: IpcMainEvent, id: unknown, data: unknown, origin: unknown) => {
    if (origin !== undefined && origin !== "wheel") return;
    if (trusted(event) && validId(id) && typeof data === "string" && data.length <= 65536) {
      manager.write(id, data);
      if (origin !== "wheel" && isReply(data)) events.onInput?.(id);
    }
  };
  const resize = (event: IpcMainEvent, id: unknown, cols: unknown, rows: unknown) => {
    if (
      trusted(event) &&
      validId(id) &&
      size(cols, rows) &&
      typeof cols === "number" &&
      typeof rows === "number"
    )
      manager.resize(id, cols, rows);
  };
  const acknowledge = (event: IpcMainEvent, id: unknown, token: unknown, count: unknown) => {
    if (trusted(event) && validId(id) && typeof token === "string" && typeof count === "number")
      manager.acknowledge(id, token, count);
  };
  const detachViews = () => {
    for (const id of owned) manager.detach(id);
  };
  const navigating = (_event: Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) detachViews();
  };
  const rendererGone = () => {
    rendererAlive = false;
    pendingFlush?.resolve();
    detachViews();
  };
  contents.on("render-process-gone", rendererGone);
  contents.on("did-start-navigation", navigating);
  ipcMain.on("terminal:input", input);
  ipcMain.on("terminal:resize", resize);
  ipcMain.on("terminal:ack", acknowledge);
  let quitting = false;
  const willQuit = (event: Event) => {
    if (!manager.hasPendingExits) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void manager.dispose();
    void manager
      .waitForExit()
      .then(() => {
        app.removeListener("will-quit", willQuit);
        app.quit();
      })
      .catch((error: unknown) => {
        quitting = false;
        console.error("Unable to finish terminal shutdown:", error);
      });
  };
  app.on("will-quit", willQuit);
  window.once("closed", () => {
    contents.removeListener("render-process-gone", rendererGone);
    contents.removeListener("did-finish-load", rendererLoaded);
    contents.removeListener("did-start-navigation", navigating);
    void manager.dispose();
    void manager
      .waitForExit()
      .then(() => {
        app.removeListener("will-quit", willQuit);
      })
      .catch((error: unknown) => {
        console.error("Unable to finish terminal shutdown:", error);
      });
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    ipcMain.removeListener("terminal:views-flushed", flushed);
    pendingFlush?.resolve();
    ipcMain.removeListener("terminal:input", input);
    ipcMain.removeListener("terminal:resize", resize);
    ipcMain.removeListener("terminal:ack", acknowledge);
  });
  return {
    runningSessions: () => [...running.values()],
    async create(spec) {
      const id = await manager.create(spec);
      owned.add(id);
      running.set(id, { id, command: spec.command, cwd: spec.cwd });
      return id;
    },
    async kill(id) {
      await manager.kill(id);
      owned.delete(id);
      running.delete(id);
      if (!contents.isDestroyed()) contents.send("terminal:availability", [id], false);
    },
    setTheme: (choice) => {
      manager.setTheme(choice);
    },
    stop: (id) => manager.stop(id),
    tail: (id, lines) => manager.tail(id, lines),
    owns: (id) => owned.has(id),
    get runningCount() {
      return manager.runningCount;
    },
    async shutdown() {
      const ids = [...owned];
      // Stop queued renderer attachment work before stopping the native hosts.
      if (!contents.isDestroyed() && rendererAlive)
        contents.send("terminal:availability", ids, false);
      try {
        if (!contents.isDestroyed() && rendererAlive) await flushViews(ids);
        await manager.shutdown();
        owned.clear();
        running.clear();
      } catch (error) {
        // A failed quit leaves the window open and its capabilities valid.
        if (!contents.isDestroyed()) contents.send("terminal:availability", ids, true);
        throw error;
      }
    },
  };
}
