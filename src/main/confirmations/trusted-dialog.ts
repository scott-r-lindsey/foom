import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, powerMonitor, screen } from "electron";
import type {
  Session,
  IpcMainEvent,
  Event,
  Input,
  MouseInputEvent,
  Rectangle,
  WebContents,
} from "electron";
import type { DialogContent, DialogRequest } from "../../shared/confirmation";
import type { InterfaceTheme } from "../../shared/interface-theme";

import { RemovalReview, removalContent } from "./removal-review";

export const CONFIRMATION_URL = "app://confirmation/confirmation.html";
/** Dedicated session and origin prevent process sharing or board access to this page. */
export class TrustedDialog {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  private pending:
    | {
        id: string;
        request: DialogRequest;
        resolve: (answer: boolean) => void;
        activate: boolean;
      }
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
  private bounds: Rectangle | undefined;
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
    // A trusted renderer/ID alone is not evidence that the person can see consent.
    if (accepted !== false && !this.isReachable()) {
      this.finish(false);
      return;
    }
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
      // Nonmodal is essential on macOS (#353). Linux still needs the native
      // dialog window type for transient stacking with multiple board windows.
      ...(this.platform === "linux" ? { type: "dialog" as const } : {}),
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
  /**
   * `activate` is only for confirmations a person started in Foom (quit, Settings).
   * Agent, CLI and preview requests never bring Foom in front of another app.
   */
  request(
    content: DialogContent,
    signal?: AbortSignal,
    { activate = false }: { activate?: boolean } = {},
  ): Promise<boolean> {
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
      this.bounds = undefined;
      const answer = new Promise<boolean>((resolve) => {
        this.pending = { id, request, resolve, activate };
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
      } else if (this.platform === "win32") {
        this.parent.setEnabled(false);
      }
      this.parentContents.prependListener("before-input-event", this.blockParentInput);
      // Linux must stay enabled: disabled native parents swallow the clicks
      // needed to recover an invisible child. Both guards still consume input.
      this.parentContents.prependListener("before-mouse-event", this.blockParentInput);
      this.parent.on("hide", this.parentUnavailable);
      this.parent.on("minimize", this.parentUnavailable);
      this.parent.on("move", this.syncBounds);
      this.parent.on("resize", this.syncBounds);
      this.parent.on("maximize", this.syncBounds);
      this.parent.on("unmaximize", this.syncBounds);
      this.parent.on("restore", this.restoreDialog);
      this.parent.on("show", this.restoreDialog);
      powerMonitor.on("resume", this.restoreDialog);
      powerMonitor.on("unlock-screen", this.restoreDialog);
      screen.on("display-metrics-changed", this.restoreDialog);
      screen.on("display-removed", this.restoreDialog);
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
    this.bounds = { x, y, width, height };
    this.window.setBounds(this.bounds);
  };
  private readonly blockParentInput = (event: Event, input: Input | MouseInputEvent) => {
    event.preventDefault();
    if (input.type === "mouseDown" || input.type === "keyDown") this.restoreDialog();
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
    if (!window || !this.pending || !this.size || this.presenting) return;
    this.presenting = true;
    try {
      window.setParentWindow(this.parent);
      this.syncBounds();
      // On macOS, window.focus() cannot activate an app behind another app.
      // Only steal activation for a measured request a person started.
      if (this.platform === "darwin" && this.pending.activate) app.focus({ steal: true });
      window.show();
      // Some window managers place a child when mapping it. Reapply after show.
      this.syncBounds();
      window.moveTop();
      this.focusDialog();
    } catch {
      this.finish(false);
    } finally {
      this.presenting = false;
    }
  }
  /** Native visibility/focus can both be true for an off-screen mapped child. */
  private isReachable(): boolean {
    const window = this.window;
    const expected = this.bounds;
    if (!window || !this.size || !expected || this.presenting) return false;
    if (
      !window.isFocused() ||
      window.isMinimized() ||
      (this.platform !== "darwin" && !window.isVisible())
    )
      return false;
    // Read back actual native geometry: setBounds may have been refused. Require
    // the complete measured card, on the parent's display, not a visible sliver.
    const actual = window.getBounds();
    const work = screen.getDisplayMatching(this.parent.getContentBounds()).workArea;
    return (
      actual.width > 0 &&
      actual.height > 0 &&
      actual.x >= work.x &&
      actual.y >= work.y &&
      actual.x + actual.width <= work.x + work.width &&
      actual.y + actual.height <= work.y + work.height &&
      Math.abs(actual.x - expected.x) <= 2 &&
      Math.abs(actual.y - expected.y) <= 2 &&
      Math.abs(actual.width - expected.width) <= 2 &&
      Math.abs(actual.height - expected.height) <= 2
    );
  }
  /** Bound presentation failure and keep checking after the initial show. */
  private watchReachability(reordered = false, delay = 1000): void {
    if (this.reachability || !this.pending) return;
    this.reachability = setTimeout(() => {
      this.reachability = undefined;
      if (!this.window || !this.size) this.finish(false);
      else if (!this.isReachable()) {
        if (reordered) this.finish(false);
        else {
          // Arm the final check before native show/focus events can reenter.
          this.watchReachability(true);
          this.present();
        }
      } else this.watchReachability(false, 5000);
    }, delay);
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
    this.present();
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
    this.parent.removeListener("restore", this.restoreDialog);
    this.parent.removeListener("show", this.restoreDialog);
    powerMonitor.removeListener("resume", this.restoreDialog);
    powerMonitor.removeListener("unlock-screen", this.restoreDialog);
    screen.removeListener("display-metrics-changed", this.restoreDialog);
    screen.removeListener("display-removed", this.restoreDialog);
    this.parent.removeListener("focus", this.restoreDialog);
    if (!this.parent.isDestroyed()) {
      this.parentContents.send("confirmation:scrim", false);
      if (this.platform === "darwin") this.parent.setFocusable(this.parentFocusable);
      else if (this.platform === "win32") this.parent.setEnabled(this.parentEnabled);
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
