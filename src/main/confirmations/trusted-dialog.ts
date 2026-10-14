import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import type { Session, IpcMainEvent, Event, WebContents } from "electron";
import type { DialogContent, DialogRequest } from "../../shared/confirmation";
import type { InterfaceTheme } from "../../shared/interface-theme";

import { RemovalReview, removalContent } from "./removal-review";

export const CONFIRMATION_URL = "app://confirmation/confirmation.html";
/** Dedicated session and origin prevent process sharing or board access to this page. */
export class TrustedDialog {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  private pending:
    | { id: string; request: DialogRequest; resolve: (answer: boolean) => void }
    | undefined;
  private feed: DialogContent["feed"];
  private removalFeed: DialogContent["removalFeed"];
  private readonly removals = new RemovalReview((content, signal) => this.request(content, signal));
  private unsubscribe: (() => void) | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private size: { width: number; height: number } | undefined;
  private disposed = false;
  private readonly parentContents: WebContents;
  private parentEnabled = true;
  private parentFocusable = true;
  private reachability: NodeJS.Timeout | undefined;
  private presenting = false;
  constructor(
    private readonly parent: BrowserWindow,
    private readonly session: Session,
    private readonly theme: () => InterfaceTheme,
    private readonly platform = process.platform,
  ) {
    this.parentContents = parent.webContents;
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
      !this.pending ||
      id !== this.pending.id
    )
      return;
    if (this.removalFeed) {
      if (accepted === false) {
        this.finish(false);
        return;
      }
      const ids = new Set(this.pending.request.removals?.map((item) => item.id));
      if (!this.pending.request.removals) {
        const item = this.removalFeed.current()[0];
        if (accepted !== true || !item) return;
        this.removalFeed.select([item.id]);
        this.finish(true);
        return;
      }
      if (
        !Array.isArray(accepted) ||
        accepted.length === 0 ||
        accepted.some((id: unknown) => typeof id !== "string" || !ids.has(id)) ||
        new Set(accepted).size !== accepted.length
      )
        return;
      this.removalFeed.select(accepted);
      this.finish(true);
      return;
    }
    if (typeof accepted !== "boolean") return;
    if (accepted && this.feed) {
      this.feed.act();
      return;
    }
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
    if (first) this.present();
    else this.syncBounds();
  };
  /** Called after the board's scale or resolved theme changes. */
  refresh(): void {
    if (!this.window || this.disposed) return;
    this.window.webContents.setZoomFactor(this.parentContents.getZoomFactor());
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
        // Reused requests must render and measure while this child is hidden.
        backgroundThrottling: false,
        preload: join(__dirname, "../../preload/confirmation.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
      },
    });
    this.window = window;
    window.webContents.setZoomFactor(this.parentContents.getZoomFactor());
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });
    window.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    window.on("hide", this.childUnavailable);
    window.on("minimize", this.childUnavailable);
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = undefined;
      this.finish(false);
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
    if (content.removal)
      return this.removals.request(content.removal.group, content.removal.item, signal);
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
      const { feed, removalFeed, ...renderContent } = content;
      delete renderContent.removal;
      this.removalFeed = removalFeed;
      this.feed = feed;
      const request: DialogRequest = {
        ...renderContent,
        id,
        theme: this.theme(),
        ...(feed ? { cleanup: feed.current() } : {}),
        ...(removalFeed ? removalContent(removalFeed.current()) : {}),
      };
      this.size = undefined;
      const answer = new Promise<boolean>((resolve) => {
        this.pending = { id, request, resolve };
      });
      this.unsubscribe = feed?.subscribe(() => {
        if (this.pending?.id !== id) return;
        this.pending.request = { ...this.pending.request, cleanup: feed.current() };
        this.refresh();
      });
      if (removalFeed)
        this.unsubscribe = removalFeed.subscribe(() => {
          if (!this.pending) return;
          // Any list change invalidates answers authored against the older list.
          this.pending.id = randomUUID();
          this.pending.request = {
            ...renderContent,
            id: this.pending.id,
            theme: this.theme(),
            ...removalContent(removalFeed.current()),
          };
          this.refresh();
        });
      const cancel = () => {
        if (this.pending && this.removalFeed === removalFeed) this.finish(false);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.parentEnabled = this.parent.isEnabled();
      if (this.platform === "darwin") {
        // Electron disables macOS windows with an attached translucent sheet,
        // which covers even a visible, focused child (#353). Block input without
        // creating that sheet; keep native keyboard focus in the trusted child.
        this.parentFocusable = this.parent.isFocusable();
        this.parent.setFocusable(false);
      } else {
        this.parent.setEnabled(false);
      }
      this.parentContents.prependListener("before-input-event", this.blockParentInput);
      this.parentContents.on("before-mouse-event", this.blockParentInput);
      this.parent.on("hide", this.parentUnavailable);
      this.parent.on("minimize", this.parentUnavailable);
      this.parent.on("move", this.syncBounds);
      this.parent.on("resize", this.syncBounds);
      this.parent.on("maximize", this.syncBounds);
      this.parent.on("unmaximize", this.syncBounds);
      this.parent.on("restore", this.syncBounds);
      this.parent.on("focus", this.restoreDialog);
      this.parentContents.send("confirmation:scrim", true);
      this.refresh();
      this.watchReachability();
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
  private readonly blockParentInput = (event: Event) => {
    event.preventDefault();
  };
  private readonly childUnavailable = () => {
    if (this.presenting || !this.size) return;
    const window = this.window;
    // Cocoa can deliver an earlier order-out notification after the next
    // request has shown the same child. Check its current native state (#353).
    if (
      window &&
      (window.isMinimized() ||
        (!window.isVisible() && !(this.platform === "darwin" && window.isFocused())))
    )
      this.finish(false);
  };
  private readonly parentUnavailable = () => {
    if (this.presenting) return;
    if (!this.parent.isVisible() || this.parent.isMinimized()) this.finish(false);
  };
  private present(): void {
    const window = this.window;
    if (!window || !this.pending) return;
    this.presenting = true;
    try {
      window.setParentWindow(this.parent);
      this.syncBounds();
      window.show();
      // Some window managers place a child when mapping it. Reapply after show.
      this.syncBounds();
      window.moveTop();
      this.focusDialog();
    } finally {
      this.presenting = false;
    }
  }
  /** Bound a failed show/focus or a page that never supplies a valid size. */
  private watchReachability(reordered = false): void {
    if (this.reachability || !this.pending) return;
    this.reachability = setTimeout(() => {
      this.reachability = undefined;
      const window = this.window;
      if (!window || !this.size) {
        this.finish(false);
      } else if (
        !window.isFocused() ||
        window.isMinimized() ||
        (this.platform !== "darwin" && !window.isVisible())
      ) {
        // macOS visibility includes occlusion reporting, which can disagree
        // with a currently key child. Key focus is the native reachability
        // signal there; desktop pixels remain the regression oracle.
        // A retry that still cannot acquire native focus must never strand the
        // board behind its scrim. Cancellation cannot grant any permission.
        if (reordered) this.finish(false);
        else {
          // Arm the final check first: native focus events during show must
          // not replace it with another initial attempt.
          this.watchReachability(true);
          this.present();
        }
      }
    }, 1000);
    this.reachability.unref();
  }
  private readonly focusDialog = () => {
    if (this.pending && this.window) {
      this.window.focus();
      // Give the web view keyboard input as well as activating its native window.
      this.window.webContents.focus();
    }
  };
  private readonly restoreDialog = () => {
    this.focusDialog();
    this.watchReachability();
  };
  private finish(accepted: boolean): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    if (!accepted) this.removalFeed?.select([]);
    clearTimeout(this.reachability);
    this.reachability = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.feed = undefined;
    this.removalFeed = undefined;
    this.window?.webContents.send("confirmation:render", null);
    this.window?.hide();
    this.parentContents.removeListener("before-input-event", this.blockParentInput);
    this.parentContents.removeListener("before-mouse-event", this.blockParentInput);
    this.parent.removeListener("hide", this.parentUnavailable);
    this.parent.removeListener("minimize", this.parentUnavailable);
    this.parent.removeListener("move", this.syncBounds);
    this.parent.removeListener("resize", this.syncBounds);
    this.parent.removeListener("maximize", this.syncBounds);
    this.parent.removeListener("unmaximize", this.syncBounds);
    this.parent.removeListener("restore", this.syncBounds);
    this.parent.removeListener("focus", this.restoreDialog);
    if (!this.parent.isDestroyed()) {
      this.parentContents.send("confirmation:scrim", false);
      if (this.platform === "darwin") this.parent.setFocusable(this.parentFocusable);
      else this.parent.setEnabled(this.parentEnabled);
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
