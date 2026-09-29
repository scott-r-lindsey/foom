import { app, ipcMain } from "electron";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { homedir } from "node:os";
import { spawn } from "node-pty";
import type { IPty, IDisposable } from "node-pty";

export function attachTerminal(window: BrowserWindow): void {
  let terminal: IPty | undefined;
  let subscriptions: IDisposable[] = [];
  let pending = 0;
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.sender === window.webContents &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === "app://bundle/index.html";
  const stop = () => {
    for (const subscription of subscriptions) subscription.dispose();
    subscriptions = [];
    terminal?.kill();
    terminal = undefined;
    pending = 0;
  };
  const size = (cols: unknown, rows: unknown): cols is number =>
    typeof cols === "number" &&
    typeof rows === "number" &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 2 &&
    cols <= 500 &&
    rows >= 2 &&
    rows <= 300;
  ipcMain.handle("terminal:start", (event, cols: unknown, rows: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender");
    if (!size(cols, rows) || typeof rows !== "number") throw new Error("Invalid terminal size");
    stop();
    const shell =
      process.platform === "win32" ? "powershell.exe" : process.env["SHELL"] || "/bin/bash";
    const cwd = app.isPackaged ? homedir() : process.cwd();
    const pty = spawn(shell, process.platform === "win32" ? ["-NoLogo"] : ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Foom" },
    });
    terminal = pty;
    subscriptions = [
      pty.onData((data) => {
        pending += data.length;
        if (pending > 262144) pty.pause();
        window.webContents.send("terminal:data", data);
      }),
      pty.onExit(({ exitCode }) => {
        terminal = undefined;
        window.webContents.send("terminal:exit", exitCode);
      }),
    ];
    return `${shell} — ${cwd}`;
  });
  const input = (event: IpcMainEvent, data: unknown) => {
    if (trusted(event) && typeof data === "string" && data.length <= 65536) terminal?.write(data);
  };
  const resize = (event: IpcMainEvent, cols: unknown, rows: unknown) => {
    if (trusted(event) && size(cols, rows) && typeof rows === "number")
      terminal?.resize(cols, rows);
  };
  const acknowledge = (event: IpcMainEvent, count: unknown) => {
    if (
      !trusted(event) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > pending
    )
      return;
    pending -= count;
    if (pending < 65536) terminal?.resume();
  };
  ipcMain.on("terminal:input", input);
  ipcMain.on("terminal:resize", resize);
  ipcMain.on("terminal:ack", acknowledge);
  window.once("closed", () => {
    stop();
    ipcMain.removeHandler("terminal:start");
    ipcMain.removeListener("terminal:input", input);
    ipcMain.removeListener("terminal:resize", resize);
    ipcMain.removeListener("terminal:ack", acknowledge);
  });
}
