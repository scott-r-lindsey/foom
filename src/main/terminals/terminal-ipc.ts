import { randomUUID } from "node:crypto";
import { readPaste } from "./image-clipboard";
import { normalizeImage } from "./image-decoder";
import { ImageFiles } from "./image-files";
import { imageLabel } from "../../shared/image-paste";
import type { TerminalPaste } from "../../shared/image-paste.d";
import { isChildInput, type ChildInput } from "../../shared/child-input";
import type { AgentEvidence } from "../../shared/agent-detection";
import { isTerminalSelection } from "../../shared/terminal-selection";
import { app, clipboard, ipcMain } from "electron";
import type { BrowserWindow, WebContents, IpcMainEvent, IpcMainInvokeEvent, Event } from "electron";
import { homedir } from "node:os";
import { TerminalHostClient } from "./terminal-host-client";
import { isReply } from "./terminal-reports";
import type { TerminalSpec, ShellState } from "../../shared/desktop";

/** Lifecycle hooks for owned terminals; the workspace evaluates and releases from these. */
export interface TerminalEvents {
  onForeground?(id: string, name: string): void;
  onEvidence?(id: string, evidence: AgentEvidence): void;
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
  kill(id: string, remoteHost?: string): Promise<void>;
  tail(id: string, lines: number): Promise<string[]>;
  screen(id: string): Promise<{ lines: string[]; title: string; cols?: number; rows?: number }>;
  owns(id: string): boolean;
  reply(id: string, data: string): Promise<void>;
  childInput(id: string, data: ChildInput): Promise<void>;
}

/** The app window owns capabilities for multiple independent main-owned sessions. */
export function attachTerminal(
  window: BrowserWindow,
  events: TerminalEvents = {},
  allowView: (contents: WebContents, id: string) => boolean = () => true,
  /** Environment settings for shells: the All sessions layer. */
  shellEnvironment: () => Record<string, string> = () => ({}),
  copyOnSelect: () => boolean = () => false,
  remoteProfile?: string,
) {
  const windows = new Map<
    WebContents,
    { alive: boolean; dispose(): void; flush(ids: string[]): Promise<void> }
  >();
  const attached = new Map<string, WebContents>();
  const leases = new Map<string, AbortController>();
  const pasteQueues = new Map<string, Promise<unknown>>();
  const queuedPastes = new Map<string, number>();
  const pasteRecipients = new Set<string>();
  const imageSessions = new Map<string, string>();
  const images = new ImageFiles(() => app.getPath("userData"));
  void images.start().catch(() => {
    console.error("Image paste cleanup failed");
  });
  const invalidatePaste = (id: string) => {
    leases.get(id)?.abort();
    leases.delete(id);
  };
  const closeImages = (id: string) => {
    invalidatePaste(id);
    pasteRecipients.delete(id);
    const imageSession = imageSessions.get(id);
    imageSessions.delete(id);
    void (async () => {
      try {
        await pasteQueues.get(id);
      } finally {
        if (imageSession) await images.close(imageSession);
      }
    })().catch(() => {
      console.error("Image paste cleanup failed");
    });
  };
  const broadcast = (channel: string, ...args: unknown[]) => {
    for (const [contents, state] of windows)
      if (
        state.alive &&
        !contents.isDestroyed() &&
        !contents.isCrashed() &&
        contents.getURL() === "app://bundle/index.html"
      )
        contents.send(channel, ...args);
  };
  // Capture before BrowserWindow is destroyed; its getter throws during closed.
  const owned = new Set<string>();
  const running = new Map<string, { id: string; command: string; cwd: string }>();
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    windows.has(event.sender) &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === "app://bundle/index.html";
  const manager = new TerminalHostClient(
    (id, code) => {
      closeImages(id);
      running.delete(id);
      broadcast("terminal:exit", id, code);
      if (owned.has(id)) events.onExit?.(id, code);
    },
    {
      onForeground: (id, name) => {
        if (owned.has(id)) events.onForeground?.(id, name);
      },
      onEvidence: (id, evidence) => {
        if (owned.has(id)) events.onEvidence?.(id, evidence);
      },
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
        const entries = batch.filter(({ id }) => owned.has(id));
        if (entries.length) broadcast("terminal:activity", entries);
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
      env: shellEnvironment(),
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
      if (operation === "attach") {
        if (!allowView(event.sender, id))
          throw new Error("Terminal view belongs to another window");
        const owner = attached.get(id);
        if (owner && owner !== event.sender)
          throw new Error("Terminal view belongs to another window");
        invalidatePaste(id);
        leases.set(id, new AbortController());
        attached.set(id, event.sender);
        try {
          await manager.attach(id, (token, data) => {
            if (attached.get(id) === event.sender && windows.has(event.sender))
              event.sender.send("terminal:data", id, token, data);
          });
        } catch (error) {
          if (attached.get(id) === event.sender) {
            invalidatePaste(id);
            attached.delete(id);
          }
          throw error;
        }
      } else if (operation === "detach") {
        if (attached.get(id) === event.sender) {
          invalidatePaste(id);
          attached.delete(id);
          manager.detach(id);
        }
      } else {
        await manager.kill(id);
        closeImages(id);
        owned.delete(id);
        running.delete(id);
        invalidatePaste(id);
        attached.delete(id);
        broadcast("terminal:availability", [id], false);
        events.onRemoved?.(id);
      }
    });
  }
  handlers.set("terminal:paste", (event, id): Promise<TerminalPaste> => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender");
    if (!validId(id) || attached.get(id) !== event.sender)
      throw new Error("Unknown or unattached terminal ID");
    const imageSession = imageSessions.get(id);
    const lease = leases.get(id);
    if (!lease || lease.signal.aborted || !running.has(id))
      return Promise.resolve({ kind: "cancelled" });
    const live = () =>
      !lease.signal.aborted &&
      leases.get(id) === lease &&
      running.has(id) &&
      attached.get(id) === event.sender;
    // Snapshot each gesture immediately, preserving order with a bounded FIFO.
    const queued = queuedPastes.get(id) ?? 0;
    if (queued >= 16) return Promise.resolve({ kind: "failed" });
    queuedPastes.set(id, queued + 1);
    const snapshotReady = readPaste(lease.signal).catch(() => ({ kind: "failed" }) as const);
    const previous = pasteQueues.get(id) ?? Promise.resolve();
    const operation = previous.then(async (): Promise<TerminalPaste> => {
      try {
        if (!live()) return { kind: "cancelled" };
        const snapshot = await snapshotReady;
        if (!live()) return { kind: "cancelled" };
        if (snapshot.kind !== "image") return snapshot;
        if (!imageSession || !pasteRecipients.has(id)) return { kind: "unsupported" };
        const png = await normalizeImage(snapshot.bytes, lease.signal);
        if (!live()) return { kind: "cancelled" };
        const size = png.length;
        const remote = await manager.imagePath(id, png, lease.signal);
        const path = remote ?? (await images.put(imageSession, png, lease.signal));
        if (!live()) {
          if (!remote) await images.discard(imageSession, path, size);
          return { kind: "cancelled" };
        }
        return {
          kind: "text",
          text: imageLabel(path, remote ? false : process.platform === "win32"),
        };
      } catch {
        return { kind: live() ? "failed" : "cancelled" };
      }
    });
    pasteQueues.set(id, operation);
    void operation.finally(() => {
      const remaining = (queuedPastes.get(id) ?? 1) - 1;
      if (remaining) queuedPastes.set(id, remaining);
      else queuedPastes.delete(id);
      if (pasteQueues.get(id) === operation) pasteQueues.delete(id);
    });
    return operation;
  });
  handlers.set("terminal:copy-selection", async (event, id, text) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender");
    if (!validId(id) || attached.get(id) !== event.sender)
      throw new Error("Unknown or unattached terminal ID");
    if (!isTerminalSelection(text)) throw new Error("Invalid terminal selection");
    if (copyOnSelect()) await clipboard.writeText(text);
  });
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
    if (
      trusted(event) &&
      validId(id) &&
      (!attached.has(id) || attached.get(id) === event.sender) &&
      typeof data === "string" &&
      data.length <= 65536
    ) {
      manager.write(id, data);
      if (origin !== "wheel" && isReply(data)) events.onInput?.(id);
    }
  };
  const resize = (event: IpcMainEvent, id: unknown, cols: unknown, rows: unknown) => {
    if (
      trusted(event) &&
      validId(id) &&
      (!attached.has(id) || attached.get(id) === event.sender) &&
      size(cols, rows) &&
      typeof cols === "number" &&
      typeof rows === "number"
    )
      manager.resize(id, cols, rows);
  };
  const acknowledge = (event: IpcMainEvent, id: unknown, token: unknown, count: unknown) => {
    if (
      trusted(event) &&
      validId(id) &&
      attached.get(id) === event.sender &&
      typeof token === "string" &&
      typeof count === "number"
    )
      manager.acknowledge(id, token, count);
  };
  const addWindow = (window: BrowserWindow) => {
    const contents = window.webContents;
    if (windows.has(contents)) throw new Error("Window already registered");
    let flushToken = 0;
    let pendingFlush: { token: number; ids: string[]; resolve(): void } | undefined;
    const detachViews = () => {
      for (const [id, owner] of attached)
        if (owner === contents) {
          invalidatePaste(id);
          attached.delete(id);
          manager.detach(id);
        }
    };
    const rendererLoaded = () => {
      state.alive = true;
    };
    const rendererGone = () => {
      state.alive = false;
      pendingFlush?.resolve();
      detachViews();
    };
    const navigating = (_event: Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame) detachViews();
    };
    const flushed = (event: IpcMainEvent, ids: unknown, token: unknown) => {
      if (
        !trusted(event) ||
        event.sender !== contents ||
        !pendingFlush ||
        token !== pendingFlush.token ||
        !Array.isArray(ids)
      )
        return;
      if (
        ids.length === pendingFlush.ids.length &&
        ids.every((id, index) => id === pendingFlush?.ids[index])
      )
        pendingFlush.resolve();
    };
    const state = {
      alive: true,
      flush: (ids: string[]) =>
        new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            pendingFlush = undefined;
            resolve();
          };
          const timer = setTimeout(done, 3000);
          pendingFlush = { token: ++flushToken, ids, resolve: done };
          contents.send("terminal:flush-views", ids, flushToken);
        }),
      dispose: () => {
        windows.delete(contents);
        rendererGone();
        contents.removeListener("render-process-gone", rendererGone);
        contents.removeListener("did-finish-load", rendererLoaded);
        contents.removeListener("did-start-navigation", navigating);
        ipcMain.removeListener("terminal:views-flushed", flushed);
      },
    };
    windows.set(contents, state);
    contents.on("render-process-gone", rendererGone);
    contents.on("did-finish-load", rendererLoaded);
    contents.on("did-start-navigation", navigating);
    ipcMain.on("terminal:views-flushed", flushed);
    window.once("closed", state.dispose);
  };
  addWindow(window);
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
  const dispose = async () => {
    for (const state of windows.values()) state.dispose();
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    ipcMain.removeListener("terminal:input", input);
    ipcMain.removeListener("terminal:resize", resize);
    ipcMain.removeListener("terminal:ack", acknowledge);
    await manager.dispose();
    await manager.waitForExit();
    await Promise.allSettled([...pasteQueues.values()]);
    await images.dispose();
    app.removeListener("will-quit", willQuit);
  };
  return {
    detachView: (id: string, contents: WebContents) => {
      if (attached.get(id) === contents) {
        invalidatePaste(id);
        attached.delete(id);
        manager.detach(id);
      }
    },
    addWindow,
    dispose,
    runningSessions: () => [...running.values()],
    async create(spec: TerminalSpec) {
      const id = await manager.create(
        spec.remote && remoteProfile
          ? { ...spec, remote: { ...spec.remote, profile: remoteProfile } }
          : spec,
      );
      owned.add(id);
      if (spec.imagePaste) {
        pasteRecipients.add(id);
        imageSessions.set(id, randomUUID());
      }
      running.set(id, { id, command: spec.command, cwd: spec.cwd });
      broadcast("terminal:availability", [id], true, true);
      return id;
    },
    async kill(id: string, remoteHost?: string) {
      if (remoteHost === undefined) await manager.kill(id);
      else if (remoteProfile) await manager.kill(id, remoteHost, remoteProfile);
      else await manager.kill(id, remoteHost);
      closeImages(id);
      owned.delete(id);
      running.delete(id);
      invalidatePaste(id);
      attached.delete(id);
      broadcast("terminal:availability", [id], false);
    },
    setTheme: (choice: Parameters<TerminalControl["setTheme"]>[0]) => {
      manager.setTheme(choice);
    },
    stop: (id: string) => manager.stop(id),
    tail: (id: string, lines: number) => manager.tail(id, lines),
    screen: async (id: string) => {
      if (!owned.has(id)) throw new Error("Unknown terminal");
      return manager.screen(id);
    },
    reply: async (id: string, data: string) => {
      if (!owned.has(id)) throw new Error("Unknown terminal");
      await manager.reply(id, data);
    },
    childInput: async (id: string, data: ChildInput) => {
      if (!owned.has(id)) throw new Error("Unknown terminal");
      if (!isChildInput(data)) throw new Error("Invalid child input");
      await manager.childInput(id, data);
    },
    owns: (id: string) => owned.has(id),
    get runningCount() {
      return manager.runningCount;
    },
    async shutdown() {
      const ids = [...owned];
      // Stop queued renderer attachment work before stopping the native hosts.
      broadcast("terminal:availability", ids, false);
      try {
        await Promise.all(
          [...windows]
            .filter(([contents, state]) => state.alive && !contents.isDestroyed())
            .map(([, state]) => state.flush(ids)),
        );
        await manager.shutdown();
        for (const id of ids) closeImages(id);
        attached.clear();
        owned.clear();
        running.clear();
      } catch (error) {
        // A failed quit leaves the window open and its capabilities valid.
        broadcast("terminal:availability", ids, true);
        throw error;
      }
    },
  };
}
