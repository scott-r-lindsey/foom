import { app, session, shell, WebContentsView } from "electron";
import type { BrowserWindow, Session, WebContents } from "electron";
import type { PreviewBounds, PreviewRecord, PreviewSnapshot } from "../../shared/previews";
import { canonicalRoot, readInside, readPreview } from "./contained-files";
import type { DialogContent } from "../../shared/confirmation";
import { externalLink, pathnameFor, previewCsp, responseHeaders } from "./policy";
import { markdownAsset, markdownPage } from "./markdown";
import type { PreviewRegistry } from "./registry";
import { previewPath } from "./registry";
import { PreviewWatcher, scrollPosition } from "./watcher";

interface HostedPreview {
  id: string;
  view: WebContentsView;
  partition: Session;
  bounds: PreviewBounds;
  snapshot?: string;
  snapshotVersion?: number;
  painted?: boolean;
  capturePending?: boolean;
  captureAgain?: boolean;
  refreshTimer?: ReturnType<typeof setTimeout>;
  coverTimer?: ReturnType<typeof setTimeout>;
  coverExpired?: boolean;
  loaded: boolean;
  navigated: boolean;
  previouslyLoaded: boolean;
  attached: boolean;
  clicked: boolean;
  restoreFocus: boolean;
  replacementTimer?: ReturnType<typeof setTimeout>;
  nextReplacementAt: number;
  scroll: [number, number] | undefined;
  readingScroll?: boolean;
}
const RECREATION_INTERVAL_MS = 250;
const HANDOFF_DEADLINE_MS = 1500;
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
  private readonly moving = new Map<string, { target: PreviewHost; done: Promise<void> }>();
  private readonly tiled = new Set<string>();
  private readonly hosted = new Map<string, HostedPreview>();
  private readonly confirmations = new Map<string, AbortController>();
  private readonly watchers = new Map<string, PreviewWatcher>();
  get watcherCount(): number {
    return [...this.watchers.values()].reduce((count, watcher) => count + watcher.count, 0);
  }
  private async reload(id: string): Promise<void> {
    const entry = this.hosted.get(id);
    if (!entry || entry.readingScroll || entry.view.webContents.isDestroyed()) return;
    const contents = entry.view.webContents;
    entry.readingScroll = true;
    try {
      const value: unknown = await contents.executeJavaScriptInIsolatedWorld(999, [
        { code: "[window.scrollX, window.scrollY]" },
      ]);
      entry.scroll = scrollPosition(value);
    } catch {
      entry.scroll = undefined;
    } finally {
      entry.readingScroll = false;
    }
    if (this.hosted.get(id) === entry && !contents.isDestroyed()) contents.reload();
  }
  private lastFocused: WebContents;
  private disposed = false;
  private covered = false;
  private snapshotVersion = 0;
  private pendingFocus: WebContents | undefined;
  private handoffTimer: ReturnType<typeof setTimeout> | undefined;
  private handoffVersion = 0;
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
    window.webContents.on("did-start-loading", this.resetSnapshots);
    window.webContents.prependListener("before-input-event", this.boardInput);
    window.webContents.on("before-mouse-event", this.boardMouse);
    window.on("resize", this.refresh);
    window.on("blur", this.releaseHandoff);
  }
  private readonly resetSnapshots = () => {
    for (const entry of this.hosted.values()) {
      entry.painted = false;
      // A replacement board must paint its own canvases. In-flight replies from
      // the previous renderer cannot acknowledge these fresh versions.
      if (entry.snapshot) entry.snapshotVersion = ++this.snapshotVersion;
    }
  };
  private readonly boardFocused = () => {
    // Native fallback after detaching/closing is not a deliberate board selection.
    if (!this.pendingFocus) this.lastFocused = this.window.webContents;
  };
  private readonly boardInput = (event: Electron.Event, input?: Electron.Input) => {
    // Block synchronously in main, before Chromium can deliver a key to xterm
    // or an accelerator. Consume Escape while cancellation is pending.
    if (!this.pendingFocus) return;
    event.preventDefault();
    if (input?.key === "Escape") this.releaseHandoff();
  };
  private clearHandoff() {
    clearTimeout(this.handoffTimer);
    this.handoffTimer = undefined;
    this.pendingFocus = undefined;
    this.handoffVersion++;
  }
  private readonly boardMouse = (_event: Electron.Event, mouse: Electron.MouseInputEvent) => {
    if (mouse.type !== "mouseDown") return;
    this.clearHandoff();
    this.lastFocused = this.window.webContents;
  };
  private beginHandoff(contents: WebContents) {
    if (this.lastFocused !== contents || this.pendingFocus) return;
    this.pendingFocus = contents;
    this.handoffTimer = setTimeout(this.releaseHandoff, HANDOFF_DEADLINE_MS);
  }
  private cancelHandoff(contents: WebContents) {
    if (this.pendingFocus === contents) this.releaseHandoff();
  }
  private readonly releaseHandoff = () => {
    if (!this.pendingFocus) return;
    // Revoke focus intent immediately, including during a recreation delay.
    this.lastFocused = this.window.webContents;
    for (const entry of this.hosted.values()) {
      entry.restoreFocus = false;
      if (entry.view.webContents === this.pendingFocus) entry.clicked = false;
    }
    const version = ++this.handoffVersion;
    clearTimeout(this.handoffTimer);
    this.handoffTimer = undefined;
    // Native fallback may have left xterm's textarea focused in the board DOM.
    // Keep the main-process gate closed until the trusted board has blurred it.
    // No preview-controlled data is evaluated here.
    void this.window.webContents
      .executeJavaScript(
        'if (document.activeElement?.closest(".xterm")) document.activeElement.blur()',
      )
      .then(() => {
        if (this.handoffVersion !== version) return;
        this.clearHandoff();
        // Some platforms leave no native responder after detaching the preview.
        // Focus the board only after DOM blur, and never activate another window.
        if (this.window.isFocused()) this.window.webContents.focus();
      })
      .catch(() => {
        // A destroyed board cannot receive input; otherwise Escape can try again.
        if (this.window.webContents.isDestroyed() && this.handoffVersion === version)
          this.clearHandoff();
      });
  };
  readonly refresh = () => {
    for (const entry of this.hosted.values()) {
      this.applyBounds(entry);
      this.scheduleCapture(entry);
    }
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
  async open(
    worktree: string,
    relativePath: string,
    agent?: { id: string; openedBy?: PreviewRecord["openedBy"] },
  ): Promise<string> {
    if (!previewPath(relativePath)) throw new Error("Invalid preview path");
    await this.validateWorktree(worktree);
    if (this.disposed) throw new Error("Preview host closed");
    const root = canonicalRoot(worktree);
    const pathname = `/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
    const file = readInside(root, pathname);
    if (file.status !== 200) throw new Error("Preview file unavailable");
    const record = this.registry.add(worktree, relativePath, agent?.id);
    if (agent) {
      record.agentOpened = true;
      if (agent.openedBy) record.openedBy = agent.openedBy;
    }
    try {
      await this.registry.save();
      await this.validateWorktree(worktree);
      if (this.closed() || !this.registry.records.has(record.id))
        throw new Error("Preview host closed");
      if (!agent) this.create(record, root);
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
    const watcher = new PreviewWatcher(root, () => {
      void this.reload(record.id);
    });
    this.watchers.set(record.id, watcher);
    partition.protocol.handle("foom-preview", (request) => {
      const asset = markdownAsset(request.url, origin);
      if (asset)
        return new Response(new Uint8Array(asset.body), { headers: responseHeaders(asset.type) });
      const result = readPreview(
        root,
        request.url,
        origin,
        (file) => {
          watcher.record(file);
        },
        record.network,
      );
      if (result.status === 200 && result.type.startsWith("text/markdown")) {
        return new Response(markdownPage(result.body.toString("utf8")), {
          headers: {
            ...result.headers,
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": previewCsp(result.type, record.network),
          },
        });
      }
      return new Response(
        result.status === 200
          ? new Uint8Array(result.body)
          : result.status === 404
            ? "File not found. Waiting for it to appear."
            : "Preview file unavailable",
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
    scroll?: [number, number],
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
      id: record.id,
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
      scroll,
    };
    this.hosted.set(record.id, entry);
    const contents = view.webContents;
    if (restoreFocus) {
      this.lastFocused = contents;
      this.pendingFocus = contents;
    }
    // The board's own guard (prepended in the constructor) runs first, so a pending
    // focus handoff blocks and Escape cancels it here too.
    contents.on("before-input-event", (event, input) => {
      if (this.covered) {
        event.preventDefault();
        return;
      }
      this.scheduleCapture(entry);
      // Use the owning board's dispatcher and synchronous input guards, including
      // the trusted confirmation guard. Forwarding never changes native focus.
      this.window.webContents.emit("before-input-event", event, input);
    });
    contents.on("input-event", () => {
      this.scheduleCapture(entry);
    });
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
      clearTimeout(entry.refreshTimer);
      clearTimeout(entry.coverTimer);
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
          entry.scroll,
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
      const attach = () => {
        if (contents.isDestroyed()) return;
        entry.loaded = true;
        this.applyBounds(entry);
        void this.capture(entry);
      };
      if (entry.scroll) {
        const [x, y] = entry.scroll;
        entry.scroll = undefined;
        void contents
          .executeJavaScriptInIsolatedWorld(999, [
            { code: `window.scrollTo(${String(x)}, ${String(y)})` },
          ])
          .then(attach, attach);
      } else attach();
    });
    contents.on("before-mouse-event", (event, mouse) => {
      if (this.covered) {
        event.preventDefault();
        return;
      }
      this.scheduleCapture(entry);
      if (mouse.type !== "mouseDown" || !entry.attached) return;
      // Native input only: page script cannot raise this event.
      this.clearHandoff();
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
        if (this.pendingFocus === contents) this.clearHandoff();
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
    // Native destruction can lag close; released/replaced views must never reattach.
    if (
      this.disposed ||
      this.hosted.get(entry.id) !== entry ||
      this.window.webContents.isDestroyed() ||
      entry.view.webContents.isDestroyed()
    )
      return;
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
    if (this.covered && !entry.painted && !entry.coverExpired && !entry.coverTimer) {
      // Also covers views first loaded or recreated underneath an open overlay.
      entry.coverTimer = setTimeout(() => {
        entry.coverExpired = true;
        this.applyBounds(entry);
      }, 250);
    }
    const obscured = this.covered && (entry.painted || entry.coverExpired);
    const visible = !obscured && entry.bounds.visible && bounds.width > 0 && bounds.height > 0;
    entry.view.setVisible(visible);
    if (!visible) {
      entry.clicked = false;
      if (this.lastFocused === entry.view.webContents) this.lastFocused = this.window.webContents;
      this.cancelHandoff(entry.view.webContents);
      entry.restoreFocus = false;
      // Overlay covers only hide: keep the native child attached on X11.
      if (!entry.bounds.visible) this.detach(entry);
    } else if (entry.loaded && !entry.attached) {
      this.window.contentView.addChildView(entry.view);
      entry.attached = true;
      if (entry.restoreFocus && this.lastFocused === entry.view.webContents) {
        entry.clicked = true;
        entry.view.webContents.focus();
        if (entry.view.webContents.isFocused()) this.clearHandoff();
      }
      entry.restoreFocus = false;
    }
  }
  placed(id: string, visible: boolean): void {
    if (visible && this.registry.records.has(id)) this.tiled.add(id);
  }
  visible(id: string): boolean {
    return this.tiled.has(id);
  }
  bounds(id: string, bounds: PreviewBounds): void {
    const record = this.registry.records.get(id);
    if (!record || this.disposed) throw new Error("Unknown preview ID");
    if (this.moving.has(id)) return;
    this.updateBounds(record, bounds);
  }
  private updateBounds(record: PreviewRecord, bounds: PreviewBounds): void {
    const { id } = record;
    if (bounds.visible) this.tiled.add(id);
    if (!bounds.visible && !this.hosted.has(id)) return;
    const entry = this.hosted.get(id) ?? this.create(record, canonicalRoot(record.worktree));
    const resized = entry.bounds.width !== bounds.width || entry.bounds.height !== bounds.height;
    entry.bounds = bounds;
    if (!bounds.visible) entry.painted = false;
    if (resized) this.scheduleCapture(entry);
    if (!bounds.visible && this.lastFocused === entry.view.webContents)
      this.lastFocused = this.window.webContents;
    this.applyBounds(entry);
    this.publishSnapshots();
  }
  private publishSnapshots() {
    if (this.window.webContents.isDestroyed()) return;
    const snapshots: PreviewSnapshot[] = [];
    for (const [id, entry] of this.hosted) {
      if (entry.snapshot && entry.snapshotVersion && entry.bounds.visible)
        snapshots.push({
          id,
          bounds: entry.bounds,
          image: entry.snapshot,
          version: entry.snapshotVersion,
        });
    }
    this.window.webContents.send("preview:snapshots", snapshots);
  }
  painted(id: string, version: number): void {
    const entry = this.hosted.get(id);
    if (!entry || !entry.bounds.visible || entry.snapshotVersion !== version) return;
    entry.painted = true;
    clearTimeout(entry.coverTimer);
    this.applyBounds(entry);
  }
  cover(covered: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.covered = covered;
    for (const entry of this.hosted.values()) {
      clearTimeout(entry.coverTimer);
      entry.coverExpired = false;
      delete entry.coverTimer;
      if (covered && !entry.painted) void this.capture(entry);
      this.applyBounds(entry);
    }
    this.publishSnapshots();
    return Promise.resolve();
  }
  private scheduleCapture(entry: HostedPreview) {
    clearTimeout(entry.refreshTimer);
    if (
      this.disposed ||
      this.hosted.get(entry.id) !== entry ||
      !entry.bounds.visible ||
      this.covered
    )
      return;
    // Trailing debounce of actual resize/input activity, never periodic polling.
    entry.refreshTimer = setTimeout(() => void this.capture(entry), 120);
  }
  private async capture(entry: HostedPreview) {
    const contents = entry.view.webContents;
    if (!entry.loaded || !entry.bounds.visible || contents.isDestroyed()) return;
    if (entry.capturePending) {
      entry.captureAgain = true;
      return;
    }
    clearTimeout(entry.refreshTimer);
    entry.capturePending = true;
    try {
      const image = await contents.capturePage(undefined, { stayHidden: true });
      if (
        this.disposed ||
        this.hosted.get(entry.id) !== entry ||
        contents.isDestroyed() ||
        image.isEmpty()
      )
        return;
      entry.snapshot = image.toDataURL();
      entry.snapshotVersion = ++this.snapshotVersion;
      this.publishSnapshots();
    } catch {
      // Retain the last painted image if capture fails.
    } finally {
      entry.capturePending = false;
      if (entry.captureAgain) {
        entry.captureAgain = false;
        this.scheduleCapture(entry);
      }
    }
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
  /** Keep the ID discoverable until native cleanup finishes, then transfer it atomically.
   * The target creates a fresh view only when its board reports bounds. */
  moveTo(id: string, target: PreviewHost): Promise<void> {
    const record = this.registry.records.get(id);
    const available = () =>
      !this.disposed &&
      !target.disposed &&
      target !== this &&
      !target.registry.records.has(id) &&
      target.registry.records.size < 256;
    if (!record || this.moving.has(id) || !available())
      return Promise.reject(new Error("Unable to move preview"));
    const bounds = this.hosted.get(id)?.bounds;
    const done = (async () => {
      await target.validateWorktree(record.worktree);
      await this.release(id);
      await target.validateWorktree(record.worktree);
      if (this.registry.records.get(id) !== record || !available())
        throw new Error("Unable to move preview");
      // No await between owners: agent inventory never loses the preview ID.
      this.registry.records.delete(id);
      target.registry.records.set(id, { ...record, network: false });
      this.changed();
      target.changed();
      // Persist removal first; a failed source write must not also write the target.
      await this.registry.save();
      await target.registry.save();
    })()
      .catch(async (error: unknown) => {
        if (
          !this.disposed &&
          this.registry.records.get(id) === record &&
          bounds &&
          !this.hosted.has(id)
        ) {
          try {
            await this.validateWorktree(record.worktree);
            if (!this.closed() && this.registry.records.get(id) === record)
              this.updateBounds(record, bounds);
          } catch {
            /* Removed worktrees cannot regain a native view. */
          }
        }
        throw error;
      })
      .finally(() => this.moving.delete(id));
    this.moving.set(id, { target, done });
    return done;
  }
  async close(id: string): Promise<void> {
    const moving = this.moving.get(id);
    if (moving) {
      await moving.done.catch(() => {});
      if (moving.target.registry.records.has(id)) return moving.target.close(id);
    }
    if (!this.registry.records.delete(id)) throw new Error("Unknown preview ID");
    await this.release(id);
    await this.registry.save();
    // Shutdown frees views without publishing a transient empty inventory to the board.
    if (!this.disposed) this.changed();
  }
  private async release(id: string): Promise<void> {
    this.tiled.delete(id);
    this.confirmations.get(id)?.abort();
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const entry = this.hosted.get(id);
    if (entry) {
      clearTimeout(entry.replacementTimer);
      clearTimeout(entry.refreshTimer);
      clearTimeout(entry.coverTimer);
      this.detach(entry);
      const contents = entry.view.webContents;
      const partition = entry.partition;
      this.cancelHandoff(contents);
      if (this.lastFocused === contents) this.lastFocused = this.window.webContents;
      if (!contents.isDestroyed()) contents.close();
      this.hosted.delete(id);
      this.publishSnapshots();
      partition.protocol.unhandle("foom-preview");
      partition.webRequest.onBeforeRequest(null);
      await partition.closeAllConnections();
      await partition.clearStorageData();
      await partition.clearCache();
      partition.removeAllListeners("will-download");
    }
  }
  async closeWorktree(worktree: string): Promise<void> {
    for (const record of [...this.registry.records.values()]) {
      if (record.worktree === worktree && this.registry.records.has(record.id))
        await this.close(record.id);
    }
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
    this.clearHandoff();
    this.window.removeListener("blur", this.releaseHandoff);
    this.window.removeListener("resize", this.refresh);
    this.window.webContents.removeListener("focus", this.boardFocused);
    this.window.webContents.removeListener("did-start-loading", this.resetSnapshots);
    this.window.webContents.removeListener("before-input-event", this.boardInput);
    this.window.webContents.removeListener("before-mouse-event", this.boardMouse);
    const saved = [...this.registry.records.values()]
      .filter((record) => !record.agentOpened || this.visible(record.id))
      .map(({ agentOpened: _agentOpened, openedBy: _openedBy, ...record }) => record);
    for (const id of [...this.registry.records.keys()]) await this.close(id);
    if (persist) {
      for (const record of saved) this.registry.records.set(record.id, record);
      await this.registry.save();
    }
  }
}
