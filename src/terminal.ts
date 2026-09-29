import { app, ipcMain } from "electron";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, Event } from "electron";
import { homedir } from "node:os";
import { TerminalHostClient } from "./terminal-host-client";

/** The app window owns capabilities for multiple independent main-owned sessions. */
export function attachTerminal(
  window: BrowserWindow,
): Pick<TerminalHostClient, "runningCount" | "shutdown"> {
  // Capture before BrowserWindow is destroyed; its getter throws during closed.
  const contents = window.webContents;
  const owned = new Set<string>();
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === "app://bundle/index.html";
  const manager = new TerminalHostClient(
    (id, code) => {
      if (!contents.isDestroyed()) contents.send("terminal:exit", id, code);
    },
    {
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
      args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
      cwd,
      cols,
      rows,
    });
    owned.add(id);
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
  const input = (event: IpcMainEvent, id: unknown, data: unknown) => {
    if (trusted(event) && validId(id) && typeof data === "string" && data.length <= 65536)
      manager.write(id, data);
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
  contents.on("render-process-gone", detachViews);
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
    contents.removeListener("render-process-gone", detachViews);
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
    ipcMain.removeListener("terminal:input", input);
    ipcMain.removeListener("terminal:resize", resize);
    ipcMain.removeListener("terminal:ack", acknowledge);
  });
  return {
    get runningCount() {
      return manager.runningCount;
    },
    async shutdown() {
      await manager.shutdown();
      // Drop capabilities before queued renderer IPC or teardown callbacks run.
      owned.clear();
    },
  };
}
