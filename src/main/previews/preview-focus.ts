import type { BrowserWindow, WebContents } from "electron";
import type { HostedPreview } from "./hosted-preview";

interface FocusState {
  clicked: boolean;
  restoreFocus: boolean;
}
const HANDOFF_DEADLINE_MS = 1500;
/** Human click grants and asynchronous keyboard handoff, scoped to a board. */
export class PreviewFocus {
  private readonly listeners = new Map<HostedPreview, () => void>();
  private readonly states = new WeakMap<HostedPreview, FocusState>();
  private readonly board: WebContents;
  private lastFocused: WebContents;
  private pendingFocus: WebContents | undefined;
  private manualFocus: string | undefined;
  private handoffTimer: ReturnType<typeof setTimeout> | undefined;
  private handoffVersion = 0;
  constructor(
    private readonly window: BrowserWindow,
    private readonly entries: () => Iterable<HostedPreview>,
    private readonly covered: () => boolean,
    private readonly activity: (entry: HostedPreview) => void,
  ) {
    this.board = window.webContents;
    this.lastFocused = this.board;
    this.board.on("focus", this.boardFocused);
    this.board.prependListener("before-input-event", this.boardInput);
    this.board.on("before-mouse-event", this.boardMouse);
    window.on("blur", this.releaseHandoff);
  }
  private state(entry: HostedPreview): FocusState {
    let state = this.states.get(entry);
    if (!state) {
      state = { clicked: false, restoreFocus: false };
      this.states.set(entry, state);
    }
    return state;
  }
  owns(contents: WebContents): boolean {
    return this.lastFocused === contents;
  }
  deselect(entry: HostedPreview): void {
    if (this.owns(entry.view.webContents)) this.lastFocused = this.board;
  }
  preserve(contents: WebContents): void {
    this.lastFocused = contents;
  }
  bind(entry: HostedPreview, restoreFocus: boolean): void {
    const contents = entry.view.webContents;
    this.state(entry).restoreFocus = restoreFocus;
    if (restoreFocus) {
      this.lastFocused = contents;
      this.pendingFocus = contents;
    }
    const mouseDown = (event: Electron.Event, mouse: Electron.MouseInputEvent) => {
      if (this.covered()) {
        event.preventDefault();
        return;
      }
      this.activity(entry);
      if (mouse.type !== "mouseDown" || !entry.attached) return;
      // Native input only: page script cannot raise this event.
      this.manualFocus = undefined;
      this.clearHandoff();
      this.lastFocused = contents;
      this.state(entry).clicked = true;
      if (!contents.isFocused()) contents.focus();
    };
    const blur = () => {
      this.state(entry).clicked = false;
    };
    const focused = () => {
      if (entry.attached && this.state(entry).clicked) {
        this.lastFocused = contents;
        if (this.pendingFocus === contents) this.clearHandoff();
      }
      // Attached or not: macOS can hand focus to a detached view that is still loading.
      else if (this.lastFocused !== contents) {
        const target = this.lastFocused.isDestroyed() ? this.board : this.lastFocused;
        if (!target.isDestroyed()) target.focus();
      }
    };
    contents.on("before-mouse-event", mouseDown);
    contents.on("blur", blur);
    contents.on("focus", focused);
    this.listeners.set(entry, () => {
      contents.removeListener("before-mouse-event", mouseDown);
      contents.removeListener("blur", blur);
      contents.removeListener("focus", focused);
    });
  }
  loadFailed(entry: HostedPreview): void {
    const contents = entry.view.webContents;
    if (this.pendingFocus !== contents) return;
    this.cancelHandoff(contents);
    this.state(entry).restoreFocus = false;
    this.lastFocused = this.board;
  }
  detach(entry: HostedPreview): void {
    this.state(entry).clicked = false;
  }
  hidden(entry: HostedPreview): void {
    this.detach(entry);
    if (this.owns(entry.view.webContents)) this.lastFocused = this.board;
    this.cancelHandoff(entry.view.webContents);
    this.state(entry).restoreFocus = false;
  }
  attached(entry: HostedPreview): void {
    const contents = entry.view.webContents;
    const state = this.state(entry);
    if (state.restoreFocus && this.owns(contents)) {
      state.clicked = true;
      contents.focus();
      if (contents.isFocused()) this.clearHandoff();
    }
    state.restoreFocus = false;
  }
  requestManual(id: string): void {
    this.manualFocus = id;
  }
  visible(entry: HostedPreview): void {
    if (!entry.loaded || !entry.attached || this.manualFocus !== entry.id) return;
    this.manualFocus = undefined;
    this.clearHandoff();
    this.state(entry).clicked = true;
    this.lastFocused = entry.view.webContents;
    entry.view.webContents.focus();
  }
  release(entry: HostedPreview): void {
    if (this.manualFocus === entry.id) this.manualFocus = undefined;
    this.hidden(entry);
  }
  forgetManual(id: string): void {
    if (this.manualFocus === id) this.manualFocus = undefined;
  }
  unbind(entry: HostedPreview): void {
    this.listeners.get(entry)?.();
    this.listeners.delete(entry);
  }
  dispose(): void {
    for (const entry of this.listeners.keys()) this.unbind(entry);
    this.clearHandoff();
    this.window.removeListener("blur", this.releaseHandoff);
    this.board.removeListener("focus", this.boardFocused);
    this.board.removeListener("before-input-event", this.boardInput);
    this.board.removeListener("before-mouse-event", this.boardMouse);
  }
  private readonly boardFocused = () => {
    // Native fallback after detaching/closing is not a deliberate board selection.
    if (!this.pendingFocus) this.lastFocused = this.board;
  };
  private readonly boardInput = (event: Electron.Event, input?: Electron.Input) => {
    // Block synchronously in main, before Chromium can deliver a key to xterm
    // or an accelerator. Consume Escape while cancellation is pending.
    if (!this.pendingFocus) return;
    event.preventDefault();
    if (input?.key === "Escape") this.releaseHandoff();
  };
  clearHandoff() {
    clearTimeout(this.handoffTimer);
    this.handoffTimer = undefined;
    this.pendingFocus = undefined;
    this.handoffVersion++;
  }
  private readonly boardMouse = (_event: Electron.Event, mouse: Electron.MouseInputEvent) => {
    if (mouse.type !== "mouseDown") return;
    this.manualFocus = undefined;
    this.clearHandoff();
    this.lastFocused = this.board;
  };
  beginHandoff(contents: WebContents) {
    if (this.lastFocused !== contents || this.pendingFocus) return;
    this.pendingFocus = contents;
    this.handoffTimer = setTimeout(this.releaseHandoff, HANDOFF_DEADLINE_MS);
  }
  cancelHandoff(contents: WebContents) {
    if (this.pendingFocus === contents) this.releaseHandoff();
  }
  private readonly releaseHandoff = () => {
    this.manualFocus = undefined;
    if (!this.pendingFocus) return;
    // Revoke focus intent immediately, including during a recreation delay.
    this.lastFocused = this.board;
    for (const entry of this.entries()) {
      this.state(entry).restoreFocus = false;
      if (entry.view.webContents === this.pendingFocus) this.state(entry).clicked = false;
    }
    const version = ++this.handoffVersion;
    clearTimeout(this.handoffTimer);
    this.handoffTimer = undefined;
    // Native fallback may have left xterm's textarea focused in the board DOM.
    // Keep the main-process gate closed until the trusted board has blurred it.
    // No preview-controlled data is evaluated here.
    void this.board
      .executeJavaScript(
        'if (document.activeElement?.closest(".xterm")) document.activeElement.blur()',
      )
      .then(() => {
        if (this.handoffVersion !== version) return;
        this.clearHandoff();
        // Some platforms leave no native responder after detaching the preview.
        // Focus the board only after DOM blur, and never activate another window.
        if (this.window.isFocused()) this.board.focus();
      })
      .catch(() => {
        // A destroyed board cannot receive input; otherwise Escape can try again.
        if (this.board.isDestroyed() && this.handoffVersion === version) this.clearHandoff();
      });
  };
}
