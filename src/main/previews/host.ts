import { app, session, WebContentsView } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import type { PreviewBounds, PreviewRecord } from "../../shared/previews";
import { canonicalRoot, readInside, readPreview } from "./contained-files";
import { pathnameFor } from "./policy";
import type { PreviewRegistry } from "./registry";
import { previewPath } from "./registry";

interface HostedPreview {
  view: WebContentsView;
  bounds: PreviewBounds;
  loaded: boolean;
  previouslyLoaded: boolean;
  attached: boolean;
  clicked: boolean;
}
const EMPTY_BOUNDS: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
export function requestAllowed(url: string, origin: string): boolean {
  return /^(data|blob):/.test(url) || "pathname" in pathnameFor(url, origin);
}
export function navigationAllowed(url: string, origin: string): boolean {
  const parsed = pathnameFor(url, origin);
  return "pathname" in parsed && /\.(md|markdown)$/i.test(parsed.pathname);
}

/** One host per board window. No page or IPC capability can focus a preview. */
export class PreviewHost {
  private readonly hosted = new Map<string, HostedPreview>();
  private lastFocused: WebContents;
  private disposed = false;
  constructor(
    private readonly window: BrowserWindow,
    readonly registry: PreviewRegistry,
    private readonly validateWorktree: (worktree: string) => Promise<void>,
    private readonly changed: () => void,
  ) {
    this.lastFocused = window.webContents;
    window.webContents.on("focus", this.boardFocused);
    window.on("resize", this.refresh);
  }
  private readonly boardFocused = () => {
    this.lastFocused = this.window.webContents;
  };
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
      callback({ cancel: !requestAllowed(details.url, origin) });
    });
    partition.protocol.handle("foom-preview", (request) => {
      const result = readPreview(root, request.url, origin);
      return new Response(
        result.status === 200 ? new Uint8Array(result.body) : "Preview file unavailable",
        {
          status: result.status,
          headers: result.headers,
        },
      );
    });
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
      bounds: { ...EMPTY_BOUNDS },
      loaded: false,
      previouslyLoaded: false,
      attached: false,
      clicked: false,
    };
    this.hosted.set(record.id, entry);
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    contents.on("will-frame-navigate", (event) => {
      if (!navigationAllowed(event.url, origin)) {
        event.preventDefault();
        entry.loaded ||= entry.previouslyLoaded;
        this.applyBounds(entry);
      } else if (event.isMainFrame) this.detach(entry);
    });
    contents.on("will-redirect", (event) => {
      event.preventDefault();
    });
    contents.on("did-start-loading", () => {
      entry.previouslyLoaded = entry.loaded;
      entry.loaded = false;
      this.detach(entry);
    });
    contents.on("did-finish-load", () => {
      entry.loaded = true;
      this.applyBounds(entry);
    });
    contents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type !== "mouseDown" || !entry.attached) return;
      // Native input only: page script cannot raise this event.
      entry.clicked = true;
      if (!contents.isFocused()) contents.focus();
    });
    contents.on("blur", () => {
      entry.clicked = false;
    });
    contents.on("focus", () => {
      if (entry.attached && entry.clicked) this.lastFocused = contents;
      else if (entry.attached && !this.lastFocused.isDestroyed()) this.lastFocused.focus();
    });
    const pathname = record.relativePath.split("/").map(encodeURIComponent).join("/");
    void contents.loadURL(`${origin}/${pathname}`).catch(() => {});
    return entry;
  }
  private detach(entry: HostedPreview) {
    if (entry.attached) this.window.contentView.removeChildView(entry.view);
    entry.attached = false;
    entry.clicked = false;
  }
  private applyBounds(entry: HostedPreview) {
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
    if (!visible) this.detach(entry);
    else if (entry.loaded && !entry.attached) {
      this.window.contentView.addChildView(entry.view);
      entry.attached = true;
    }
  }
  bounds(id: string, bounds: PreviewBounds): void {
    const record = this.registry.records.get(id);
    if (!record || this.disposed) throw new Error("Unknown preview ID");
    const entry = this.hosted.get(id) ?? this.create(record, canonicalRoot(record.worktree));
    entry.bounds = bounds;
    this.applyBounds(entry);
  }
  async close(id: string): Promise<void> {
    if (!this.registry.records.delete(id)) throw new Error("Unknown preview ID");
    const entry = this.hosted.get(id);
    if (entry) {
      this.detach(entry);
      const contents = entry.view.webContents;
      const partition = contents.session;
      if (this.lastFocused === contents) this.lastFocused = this.window.webContents;
      contents.close();
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
    const saved = [...this.registry.records.values()];
    for (const id of [...this.registry.records.keys()]) await this.close(id);
    if (persist) {
      for (const record of saved) this.registry.records.set(record.id, record);
      await this.registry.save();
    }
  }
}
