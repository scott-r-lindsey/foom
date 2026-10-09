import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import type { Session, IpcMainEvent } from "electron";
import type { DialogContent, DialogRequest } from "../../shared/confirmation";
import type { InterfaceTheme } from "../../shared/interface-theme";

export const CONFIRMATION_URL = "app://confirmation/confirmation.html";
/** Dedicated session and origin prevent process sharing or board access to this page. */
export class TrustedDialog {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  private pending:
    | { id: string; request: DialogRequest; resolve: (answer: boolean) => void }
    | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private size: { width: number; height: number } | undefined;
  private disposed = false;
  private parentEnabled = true;
  constructor(
    private readonly parent: BrowserWindow,
    private readonly session: Session,
    private readonly theme: () => InterfaceTheme,
  ) {
    ipcMain.on("confirmation:answer", this.answer);
    ipcMain.on("confirmation:size", this.resize);
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
  private readonly resize = (event: IpcMainEvent, value: unknown) => {
    const contents = this.window?.webContents;
    if (
      !contents ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      event.senderFrame.url !== CONFIRMATION_URL ||
      !this.pending ||
      !value ||
      typeof value !== "object" ||
      !("width" in value) ||
      !("height" in value) ||
      typeof value.width !== "number" ||
      typeof value.height !== "number" ||
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height) ||
      value.width <= 0 ||
      value.height <= 0
    )
      return;
    const first = !this.size;
    this.size = { width: value.width, height: value.height };
    this.syncBounds();
    if (first) {
      this.window?.show();
      this.window?.focus();
      // Some window managers place a child when mapping it. Reapply after show.
      this.syncBounds();
    }
  };
  /** Called after the board's scale or resolved theme changes. */
  refresh(): void {
    if (!this.window || this.disposed) return;
    this.window.webContents.setZoomFactor(this.parent.webContents.getZoomFactor());
    const theme = this.theme();
    this.window.setBackgroundColor(theme.colors.surface);
    if (this.pending) {
      this.pending.request = { ...this.pending.request, theme };
      this.window.webContents.send("confirmation:render", this.pending.request);
      this.syncBounds();
    }
  }
  private prepare(): void {
    if (this.disposed || this.window) return;
    const window = new BrowserWindow({
      width: 440,
      height: 240,
      parent: this.parent,
      modal: false,
      frame: false,
      transparent: false,
      backgroundColor: this.theme().colors.surface,
      show: false,
      resizable: false,
      roundedCorners: true,
      hasShadow: true,
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
    window.webContents.setZoomFactor(this.parent.webContents.getZoomFactor());
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
  request(content: DialogContent, signal?: AbortSignal): Promise<boolean> {
    const result = this.queue.then(async () => {
      if (this.disposed || this.parent.isDestroyed() || signal?.aborted) return false;
      this.prepare();
      try {
        await this.ready;
      } catch {
        return false;
      }
      const window = this.window;
      if (!window || signal?.aborted) return false;
      const id = randomUUID();
      const request: DialogRequest = { ...content, id, theme: this.theme() };
      this.size = undefined;
      const answer = new Promise<boolean>((resolve) => {
        this.pending = { id, request, resolve };
      });
      const cancel = () => {
        if (this.pending?.id === id) this.finish(false);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.parentEnabled = this.parent.isEnabled();
      this.parent.setEnabled(false);
      this.parent.on("move", this.syncBounds);
      this.parent.on("resize", this.syncBounds);
      this.parent.on("maximize", this.syncBounds);
      this.parent.on("unmaximize", this.syncBounds);
      this.parent.on("restore", this.syncBounds);
      this.parent.on("focus", this.focusDialog);
      this.parent.webContents.send("confirmation:scrim", true);
      this.refresh();
      try {
        return await answer;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    });
    this.queue = result;
    return result;
  }
  private readonly syncBounds = () => {
    if (!this.pending || !this.size || this.parent.isDestroyed() || !this.window) return;
    const parent = this.parent.getContentBounds();
    const work = screen.getDisplayMatching(parent).workArea;
    let left = Math.max(parent.x + 24, work.x);
    let top = Math.max(parent.y + 24, work.y);
    let right = Math.min(parent.x + parent.width - 24, work.x + work.width);
    let bottom = Math.min(parent.y + parent.height - 24, work.y + work.height);
    // A parent moved entirely off screen has no intersection; keep its decision reachable.
    if (right <= left) {
      left = work.x;
      right = work.x + work.width;
    }
    if (bottom <= top) {
      top = work.y;
      bottom = work.y + work.height;
    }
    const zoom = this.window.webContents.getZoomFactor();
    const width = Math.max(1, Math.min(Math.ceil(this.size.width * zoom), right - left));
    const height = Math.max(1, Math.min(Math.ceil(this.size.height * zoom), bottom - top));
    const x = Math.max(
      left,
      Math.min(Math.round(parent.x + (parent.width - width) / 2), right - width),
    );
    const y = Math.max(
      top,
      Math.min(Math.round(parent.y + (parent.height - height) / 2), bottom - height),
    );
    this.window.setBounds({ x, y, width, height });
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
    this.parent.removeListener("maximize", this.syncBounds);
    this.parent.removeListener("unmaximize", this.syncBounds);
    this.parent.removeListener("restore", this.syncBounds);
    this.parent.removeListener("focus", this.focusDialog);
    if (!this.parent.isDestroyed()) {
      this.parent.webContents.send("confirmation:scrim", false);
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
    ipcMain.removeListener("confirmation:size", this.resize);
    this.window?.destroy();
    this.window = undefined;
  }
}
