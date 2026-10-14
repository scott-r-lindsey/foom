import { app, session, shell, WebContentsView } from "electron";
import type { BrowserWindow, Session, WebContents } from "electron";
import type { PreviewBounds, PreviewRecord } from "../../shared/previews";
import { canonicalRoot, readInside, readPreview } from "./contained-files";
import type { DialogContent } from "../../shared/confirmation";
import { externalLink, pathnameFor } from "./policy";
import type { PreviewRegistry } from "./registry";
import { previewPath } from "./registry";

interface HostedPreview {
  view: WebContentsView;
  partition: Session;
  bounds: PreviewBounds;
  loaded: boolean;
  navigated: boolean;
  previouslyLoaded: boolean;
  attached: boolean;
  clicked: boolean;
  restoreFocus: boolean;
  replacementTimer?: ReturnType<typeof setTimeout>;
  nextReplacementAt: number;
}
const RECREATION_INTERVAL_MS = 250;
const EMPTY_BOUNDS: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
export function requestAllowed(url: string, origin: string, network = false): boolean {
  return (
    (network && /^(https|wss):/.test(url)) ||
    /^(data|blob):/.test(url) ||
    "pathname" in pathnameFor(url, origin)
  );
}
export function navigationAllowed(url: string, origin: string): boolean {
  const parsed = pathnameFor(url, origin);
  return "pathname" in parsed && /\.(md|markdown)$/i.test(parsed.pathname);
}

/** One host per board window. No page or IPC capability can focus a preview. */
export class PreviewHost {
  private readonly hosted = new Map<string, HostedPreview>();
  private readonly confirmations = new Map<string, AbortController>();
  private lastFocused: WebContents;
  private disposed = false;
  private pendingFocus: WebContents | undefined;
  constructor(
    private readonly window: BrowserWindow,
    readonly registry: PreviewRegistry,
    private readonly validateWorktree: (worktree: string) => Promise<void>,
    private readonly changed: () => void,
    private readonly confirm: (
      content: DialogContent,
      signal: AbortSignal,
    ) => Promise<boolean> = () => Promise.resolve(false),
  ) {
    this.lastFocused = window.webContents;
    window.webContents.on("focus", this.boardFocused);
    window.webContents.prependListener("before-input-event", this.boardInput);
    window.webContents.on("before-mouse-event", this.boardMouse);
    window.on("resize", this.refresh);
  }
  private readonly boardFocused = () => {
    // Native fallback after detaching/closing is not a deliberate board selection.
    if (!this.pendingFocus) this.lastFocused = this.window.webContents;
  };
  private readonly boardInput = (event: Electron.Event) => {
    // Block synchronously in main, before Chromium can deliver a key to xterm
    // or an accelerator. No renderer round trip can protect the first key.
    if (this.pendingFocus) event.preventDefault();
  };
  private readonly boardMouse = (_event: Electron.Event, mouse: Electron.MouseInputEvent) => {
    if (mouse.type !== "mouseDown") return;
    this.pendingFocus = undefined;
    this.lastFocused = this.window.webContents;
  };
  private beginHandoff(contents: WebContents) {
    if (this.lastFocused === contents) this.pendingFocus = contents;
  }
  private cancelHandoff(contents: WebContents) {
    if (this.pendingFocus === contents) this.pendingFocus = undefined;
  }
  readonly refresh = () => {
    for (const entry of this.hosted.values()) this.applyBounds(entry);
  };
  private closed(): boolean {
    return this.disposed;
  }
  async restore(): Promise<void> {
    await this.registry.load();
    for (const record of [...this.registry.records.values()]) {
      try {
        await this.validateWorktree(record.worktree);
      } catch {
        this.registry.records.delete(record.id);
      }
    }
    await this.registry.save();
  }
  async open(worktree: string, relativePath: string): Promise<string> {
    if (!previewPath(relativePath)) throw new Error("Invalid preview path");
    await this.validateWorktree(worktree);
    if (this.disposed) throw new Error("Preview host closed");
    const root = canonicalRoot(worktree);
    const pathname = `/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
    const file = readInside(root, pathname);
    if (file.status !== 200) throw new Error("Preview file unavailable");
    const record = this.registry.add(worktree, relativePath);
    try {
      await this.registry.save();
      if (this.closed() || !this.registry.records.has(record.id))
        throw new Error("Preview host closed");
      this.create(record, root);
    } catch (error) {
      this.registry.records.delete(record.id);
      await this.registry.save();
      throw error;
    }
    this.changed();
    return record.id;
  }
  private create(record: PreviewRecord, root: string): HostedPreview {
    const origin = `foom-preview://${record.id}`;
    const partition = session.fromPartition(`preview-${record.id}`, { cache: false });
    partition.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    partition.setPermissionCheckHandler(() => false);
    partition.setDevicePermissionHandler(() => false);
    partition.on("will-download", (event) => {
      event.preventDefault();
    });
    partition.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !requestAllowed(details.url, origin, record.network) });
    });
    partition.protocol.handle("foom-preview", (request) => {
      const result = readPreview(root, request.url, origin, record.network);
      return new Response(
        result.status === 200 ? new Uint8Array(result.body) : "Preview file unavailable",
        {
          status: result.status,
          headers: result.headers,
        },
      );
    });
    const pathname = record.relativePath.split("/").map(encodeURIComponent).join("/");
    return this.createView(record, partition, `${origin}/${pathname}`, { ...EMPTY_BOUNDS });
  }
  private createView(
    record: PreviewRecord,
    partition: Session,
    url: string,
    bounds: PreviewBounds,
    restoreFocus = false,
    nextReplacementAt = 0,
  ): HostedPreview {
    const origin = `foom-preview://${record.id}`;
    const view = new WebContentsView({
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
        webviewTag: false,
        devTools: !app.isPackaged,
        spellcheck: false,
      },
    });
    const entry: HostedPreview = {
      view,
      partition,
      bounds,
      loaded: false,
      navigated: false,
      previouslyLoaded: false,
      attached: false,
      clicked: false,
      restoreFocus,
      nextReplacementAt,
    };
    this.hosted.set(record.id, entry);
    const contents = view.webContents;
    if (restoreFocus) {
      this.lastFocused = contents;
      this.pendingFocus = contents;
    }
    contents.setWindowOpenHandler(({ url }) => {
      void this.openExternal(record, url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    contents.on("will-frame-navigate", (event) => {
      if (!navigationAllowed(event.url, origin)) {
        event.preventDefault();
        void this.openExternal(record, event.url);
        entry.loaded ||= entry.previouslyLoaded;
        this.applyBounds(entry);
      } else if (event.isMainFrame) {
        this.beginHandoff(contents);
        this.detach(entry);
      }
    });
    contents.on("will-redirect", (event) => {
      event.preventDefault();
      void this.openExternal(record, event.url);
    });
    contents.on("did-start-navigation", (event) => {
      if (entry.replacementTimer || contents.isDestroyed()) return;
      if (!event.isMainFrame || event.isSameDocument) return;
      if (!entry.navigated) {
        entry.navigated = true;
        return;
      }
      if (event.url !== contents.getURL() && !navigationAllowed(event.url, origin)) return;
      // A previously clicked RenderWidgetHost can regain native focus on reload
      // even while detached. A fresh contents has never held that focus grant.
      const heldFocus = this.lastFocused === contents;
      this.beginHandoff(contents);
      this.detach(entry);
      contents.close();
      // Preserve the intent across native fallback; a deliberate click cancels it.
      if (heldFocus) this.lastFocused = contents;
      const replace = () => {
        this.createView(
          record,
          partition,
          event.url,
          entry.bounds,
          heldFocus && this.lastFocused === contents,
          Date.now() + RECREATION_INTERVAL_MS,
        );
      };
      const delay = Math.max(0, entry.nextReplacementAt - Date.now());
      // Close immediately so untrusted script stops running. At most one
      // replacement is pending, with at most four recreations per second.
      if (delay > 0) entry.replacementTimer = setTimeout(replace, delay);
      else replace();
    });
    contents.on("did-start-loading", () => {
      if (contents.isDestroyed()) return;
      entry.previouslyLoaded = entry.loaded;
      entry.loaded = false;
      this.detach(entry);
    });
    contents.on("did-finish-load", () => {
      if (contents.isDestroyed()) return;
      entry.loaded = true;
      this.applyBounds(entry);
    });
    contents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type !== "mouseDown" || !entry.attached) return;
      // Native input only: page script cannot raise this event.
      this.pendingFocus = undefined;
      this.lastFocused = contents;
      entry.clicked = true;
      if (!contents.isFocused()) contents.focus();
    });
    contents.on("blur", () => {
      entry.clicked = false;
    });
    contents.on("focus", () => {
      if (entry.attached && entry.clicked) {
        this.lastFocused = contents;
        this.cancelHandoff(contents);
      }
      // Attached or not: macOS can hand focus to a detached view that is still loading.
      else if (this.lastFocused !== contents) {
        const target = this.lastFocused.isDestroyed() ? this.window.webContents : this.lastFocused;
        if (!target.isDestroyed()) target.focus();
      }
    });
    void contents.loadURL(url).catch(() => {
      if (this.pendingFocus !== contents) return;
      this.cancelHandoff(contents);
      entry.restoreFocus = false;
      this.lastFocused = this.window.webContents;
    });
    return entry;
  }
  private detach(entry: HostedPreview) {
    if (entry.attached) this.window.contentView.removeChildView(entry.view);
    entry.attached = false;
    entry.clicked = false;
  }
  private applyBounds(entry: HostedPreview) {
    if (entry.view.webContents.isDestroyed()) return;
    const zoom = this.window.webContents.getZoomFactor();
    const { width, height } = this.window.getContentBounds();
    const x = Math.min(width, Math.max(0, Math.round(entry.bounds.x * zoom)));
    const y = Math.min(height, Math.max(0, Math.round(entry.bounds.y * zoom)));
    const bounds = {
      x,
      y,
      width: Math.min(width - x, Math.max(0, Math.round(entry.bounds.width * zoom))),
      height: Math.min(height - y, Math.max(0, Math.round(entry.bounds.height * zoom))),
    };
    entry.view.setBounds(bounds);
    entry.view.webContents.setZoomFactor(zoom);
    const visible = entry.bounds.visible && bounds.width > 0 && bounds.height > 0;
    entry.view.setVisible(visible);
    if (!visible) {
      if (entry.restoreFocus && this.lastFocused === entry.view.webContents)
        this.lastFocused = this.window.webContents;
      this.cancelHandoff(entry.view.webContents);
      entry.restoreFocus = false;
      this.detach(entry);
    } else if (entry.loaded && !entry.attached) {
      this.window.contentView.addChildView(entry.view);
      entry.attached = true;
      if (entry.restoreFocus && this.lastFocused === entry.view.webContents) {
        entry.clicked = true;
        entry.view.webContents.focus();
        if (entry.view.webContents.isFocused()) this.cancelHandoff(entry.view.webContents);
      }
      entry.restoreFocus = false;
    }
  }
  bounds(id: string, bounds: PreviewBounds): void {
    const record = this.registry.records.get(id);
    if (!record || this.disposed) throw new Error("Unknown preview ID");
    const entry = this.hosted.get(id) ?? this.create(record, canonicalRoot(record.worktree));
    entry.bounds = bounds;
    if (!bounds.visible && this.lastFocused === entry.view.webContents)
      this.lastFocused = this.window.webContents;
    this.applyBounds(entry);
  }
  private async review(record: PreviewRecord, content: DialogContent): Promise<boolean> {
    if (this.disposed || !this.registry.records.has(record.id) || this.confirmations.has(record.id))
      return false;
    const controller = new AbortController();
    this.confirmations.set(record.id, controller);
    try {
      return (
        (await this.confirm(content, controller.signal)) &&
        !controller.signal.aborted &&
        !this.closed() &&
        this.registry.records.get(record.id) === record
      );
    } catch {
      return false;
    } finally {
      if (this.confirmations.get(record.id) === controller) this.confirmations.delete(record.id);
    }
  }
  private async openExternal(record: PreviewRecord, url: string): Promise<void> {
    if (!externalLink(url)) return;
    if (
      (await this.review(record, {
        title: "Open this link?",
        accept: "Open in browser",
        glyph: "link",
        subject: record.relativePath,
        facts: [{ label: "URL", value: url, mono: true }],
      })) &&
      this.registry.records.get(record.id) === record &&
      !this.closed()
    ) {
      await shell.openExternal(url).catch(() => {});
    }
  }
  async network(id: string, enabled: boolean): Promise<void> {
    const record = this.registry.records.get(id);
    if (!record || this.disposed) throw new Error("Unknown preview ID");
    if (record.network === enabled) return;
    if (
      enabled &&
      !(await this.review(record, {
        title: "Allow network for this preview?",
        accept: "Allow network",
        glyph: "shield",
        subject: record.relativePath,
        detail: "This page can send files from this worktree to the internet",
      }))
    )
      return;
    if (this.registry.records.get(id) !== record || this.closed()) return;
    record.network = enabled;
    this.changed();
    const entry = this.hosted.get(id);
    if (entry) {
      await entry.partition.closeAllConnections();
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.reload();
    }
  }
  async close(id: string): Promise<void> {
    if (!this.registry.records.delete(id)) throw new Error("Unknown preview ID");
    this.confirmations.get(id)?.abort();
    const entry = this.hosted.get(id);
    if (entry) {
      clearTimeout(entry.replacementTimer);
      this.detach(entry);
      const contents = entry.view.webContents;
      const partition = entry.partition;
      this.cancelHandoff(contents);
      if (this.lastFocused === contents) this.lastFocused = this.window.webContents;
      if (!contents.isDestroyed()) contents.close();
      this.hosted.delete(id);
      partition.protocol.unhandle("foom-preview");
      partition.webRequest.onBeforeRequest(null);
      await partition.clearStorageData();
      await partition.clearCache();
      partition.removeAllListeners("will-download");
    }
    await this.registry.save();
    this.changed();
  }
  async reconcile(): Promise<void> {
    for (const record of [...this.registry.records.values()]) {
      try {
        await this.validateWorktree(record.worktree);
      } catch {
        if (this.registry.records.has(record.id)) await this.close(record.id);
      }
    }
  }
  async dispose(persist: boolean): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.window.removeListener("resize", this.refresh);
    this.window.webContents.removeListener("focus", this.boardFocused);
    this.window.webContents.removeListener("before-input-event", this.boardInput);
    this.window.webContents.removeListener("before-mouse-event", this.boardMouse);
    const saved = [...this.registry.records.values()];
    for (const id of [...this.registry.records.keys()]) await this.close(id);
    if (persist) {
      for (const record of saved) this.registry.records.set(record.id, record);
      await this.registry.save();
    }
  }
}
