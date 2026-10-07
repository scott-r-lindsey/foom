import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import type { Session, IpcMainEvent } from "electron";
import type { DialogContent, DialogRequest } from "../../shared/confirmation";
import type { InterfaceTheme } from "../../shared/interface-theme";

export const CONFIRMATION_URL = "app://confirmation/confirmation.html";
/** Dedicated session and origin prevent process sharing or board access to this page. */
export class TrustedDialog {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  private pending: { id: string; resolve: (answer: boolean) => void } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private parentEnabled = true;
  constructor(
    private readonly parent: BrowserWindow,
    private readonly session: Session,
    private readonly theme: () => InterfaceTheme,
  ) {
    ipcMain.on("confirmation:answer", this.answer);
    this.prepare();
  }
  private readonly answer = (event: IpcMainEvent, id: unknown, accepted: unknown) => {
    const contents = this.window?.webContents;
    if (
      !contents ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      event.senderFrame.url !== CONFIRMATION_URL ||
      typeof accepted !== "boolean" ||
      !this.pending ||
      id !== this.pending.id
    )
      return;
    this.finish(accepted);
  };
  private prepare(): void {
    if (this.disposed || this.window) return;
    const window = new BrowserWindow({
      ...this.parent.getBounds(),
      parent: this.parent,
      modal: false,
      frame: false,
      transparent: false,
      backgroundColor: this.theme().colors.bg,
      show: false,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        session: this.session,
        preload: join(__dirname, "../../preload/confirmation.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    this.window = window;
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    window.on("close", (event) => {
      event.preventDefault();
      this.finish(false);
    });
    window.webContents.on("render-process-gone", () => {
      this.finish(false);
      window.destroy();
      this.window = undefined;
    });
    this.ready = window.loadURL(CONFIRMATION_URL);
    // A failed preload/page never approves; allow the next request to retry.
    void this.ready.catch(() => {
      this.finish(false);
      window.destroy();
      this.window = undefined;
    });
  }
  request(content: DialogContent): Promise<boolean> {
    const result = this.queue.then(async () => {
      if (this.disposed || this.parent.isDestroyed()) return false;
      this.prepare();
      try {
        await this.ready;
      } catch {
        return false;
      }
      const window = this.window;
      if (!window) return false;
      const id = randomUUID();
      const answer = new Promise<boolean>((resolve) => {
        this.pending = { id, resolve };
      });
      const request: DialogRequest = { ...content, id, theme: this.theme() };
      this.parentEnabled = this.parent.isEnabled();
      this.parent.setEnabled(false);
      this.parent.on("move", this.syncBounds);
      this.parent.on("resize", this.syncBounds);
      this.parent.on("focus", this.focusDialog);
      this.syncBounds();
      window.setBackgroundColor(request.theme.colors.bg);
      window.webContents.send("confirmation:render", request);
      window.show();
      window.focus();
      return answer;
    });
    this.queue = result;
    return result;
  }
  private readonly syncBounds = () => {
    if (this.pending && !this.parent.isDestroyed()) this.window?.setBounds(this.parent.getBounds());
  };
  private readonly focusDialog = () => {
    if (this.pending) this.window?.focus();
  };
  private finish(accepted: boolean): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    this.window?.webContents.send("confirmation:render", null);
    this.window?.hide();
    this.parent.removeListener("move", this.syncBounds);
    this.parent.removeListener("resize", this.syncBounds);
    this.parent.removeListener("focus", this.focusDialog);
    if (!this.parent.isDestroyed()) {
      this.parent.setEnabled(this.parentEnabled);
      this.parent.focus();
    }
    // Leave Electron's native IPC/close callback before resuming shutdown work.
    setImmediate(() => {
      pending.resolve(accepted);
    });
  }
  dispose(): void {
    this.disposed = true;
    this.finish(false);
    ipcMain.removeListener("confirmation:answer", this.answer);
    this.window?.destroy();
    this.window = undefined;
  }
}
