import type { Session, WebContents } from "electron";
import type { PreviewBounds, PreviewRecord } from "../../shared/previews";
import type { HostedPreview } from "./hosted-preview";
import type { CanonicalRoot } from "./contained-files";
import type { PreviewFocus } from "./preview-focus";
import type { PreviewSnapshots } from "./preview-snapshots";
import { createPartition, createPreviewView, navigationAllowed } from "./partition";
import { PreviewWatcher, scrollPosition } from "./watcher";

const RECREATION_INTERVAL_MS = 250;
const EMPTY_BOUNDS: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
/** Native generation creation, loading, replacement, scroll and watch lifetime. */
interface LifecycleState {
  cleanup: () => void;
  navigated: boolean;
  previouslyLoaded: boolean;
  replacementTimer?: ReturnType<typeof setTimeout>;
  nextReplacementAt: number;
  scroll: [number, number] | undefined;
  readingScroll?: boolean;
}
export class PreviewViewLifecycle {
  private readonly retired = new WeakSet<HostedPreview>();
  private readonly states = new WeakMap<HostedPreview, LifecycleState>();
  private state(entry: HostedPreview): LifecycleState {
    const state = this.states.get(entry);
    if (!state) throw new Error("Unknown preview generation");
    return state;
  }
  constructor(
    private readonly board: WebContents,
    private readonly hosted: ReadonlyMap<string, HostedPreview>,
    private readonly install: (entry: HostedPreview) => void,
    private readonly remove: (entry: HostedPreview) => void,
    private readonly closed: () => boolean,
    private readonly detach: (entry: HostedPreview) => void,
    private readonly apply: (entry: HostedPreview) => void,
    private readonly external: (record: PreviewRecord, url: string) => Promise<void>,
    private readonly focus: PreviewFocus,
    private readonly snapshots: PreviewSnapshots,
  ) {}
  current(entry: HostedPreview): boolean {
    return this.hosted.get(entry.id) === entry && !this.retired.has(entry);
  }
  cancel(id: string): void {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const entry = this.hosted.get(id);
    if (!entry) return;
    this.retired.add(entry);
    clearTimeout(this.state(entry).replacementTimer);
    this.snapshots.cancel(entry);
    this.focus.unbind(entry);
    this.state(entry).cleanup();
  }
  async release(id: string): Promise<void> {
    this.cancel(id);
    const entry = this.hosted.get(id);
    if (!entry) return;
    this.detach(entry);
    const contents = entry.view.webContents;
    const partition = entry.partition;
    this.focus.release(entry);
    if (!contents.isDestroyed()) contents.close();
    this.remove(entry);
    this.snapshots.publish();
    partition.protocol.unhandle("foom-preview");
    partition.webRequest.onBeforeRequest(null);
    await partition.closeAllConnections();
    await partition.clearStorageData();
    await partition.clearCache();
    partition.removeAllListeners("will-download");
  }
  private readonly watchers = new Map<string, PreviewWatcher>();
  get watcherCount(): number {
    return [...this.watchers.values()].reduce((count, watcher) => count + watcher.count, 0);
  }
  async reload(id: string): Promise<void> {
    const entry = this.hosted.get(id);
    if (!entry || this.state(entry).readingScroll || entry.view.webContents.isDestroyed()) return;
    const contents = entry.view.webContents;
    this.state(entry).readingScroll = true;
    try {
      const value: unknown = await contents.executeJavaScriptInIsolatedWorld(999, [
        { code: "[window.scrollX, window.scrollY]" },
      ]);
      this.state(entry).scroll = scrollPosition(value);
    } catch {
      this.state(entry).scroll = undefined;
    } finally {
      this.state(entry).readingScroll = false;
    }
    if (this.current(entry) && !this.closed() && !contents.isDestroyed()) contents.reload();
  }
  create(record: PreviewRecord, root: CanonicalRoot): HostedPreview {
    const origin = `foom-preview://${record.id}`;
    const watcher = new PreviewWatcher(root.path, () => {
      void this.reload(record.id);
    });
    this.watchers.set(record.id, watcher);
    const partition = createPartition(record, root, watcher);
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
    const view = createPreviewView(partition);
    const entry: HostedPreview = {
      id: record.id,
      view,
      partition,
      bounds,
      loaded: false,
      attached: false,
    };
    const listeners: (() => void)[] = [];
    this.states.set(entry, {
      cleanup: () => {
        for (const remove of listeners.splice(0)) remove();
      },
      navigated: false,
      previouslyLoaded: false,
      nextReplacementAt,
      scroll,
    });
    this.install(entry);
    const contents = view.webContents;
    // The board's own guard (prepended in the constructor) runs first, so a pending
    // focus handoff blocks and Escape cancels it here too.
    const beforeInput = (event: Electron.Event, input: Electron.Input) => {
      if (this.snapshots.covered) {
        event.preventDefault();
        return;
      }
      this.snapshots.schedule(entry);
      // Use the owning board's dispatcher and synchronous input guards, including
      // the trusted confirmation guard. Forwarding never changes native focus.
      this.board.emit("before-input-event", event, input);
    };
    contents.on("before-input-event", beforeInput);
    listeners.push(() => {
      contents.removeListener("before-input-event", beforeInput);
    });
    const activity = () => {
      this.snapshots.schedule(entry);
    };
    contents.on("input-event", activity);
    listeners.push(() => {
      contents.removeListener("input-event", activity);
    });
    contents.setWindowOpenHandler(({ url }) => {
      void this.external(record, url);
      return { action: "deny" };
    });
    const attachWebview = (event: Electron.Event) => {
      event.preventDefault();
    };
    contents.on("will-attach-webview", attachWebview);
    listeners.push(() => {
      contents.removeListener("will-attach-webview", attachWebview);
    });
    const frameNavigate = (
      event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
    ) => {
      if (!navigationAllowed(event.url, origin)) {
        event.preventDefault();
        void this.external(record, event.url);
        entry.loaded ||= this.state(entry).previouslyLoaded;
        this.apply(entry);
      } else if (event.isMainFrame) {
        this.focus.beginHandoff(contents);
        this.detach(entry);
      }
    };
    contents.on("will-frame-navigate", frameNavigate);
    listeners.push(() => {
      contents.removeListener("will-frame-navigate", frameNavigate);
    });
    const redirect = (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
      event.preventDefault();
      void this.external(record, event.url);
    };
    contents.on("will-redirect", redirect);
    listeners.push(() => {
      contents.removeListener("will-redirect", redirect);
    });
    const navigate = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (!this.current(entry) || this.state(entry).replacementTimer || contents.isDestroyed())
        return;
      if (!event.isMainFrame || event.isSameDocument) return;
      if (!this.state(entry).navigated) {
        this.state(entry).navigated = true;
        return;
      }
      if (event.url !== contents.getURL() && !navigationAllowed(event.url, origin)) return;
      // A previously clicked RenderWidgetHost can regain native focus on reload
      // even while detached. A fresh contents has never held that focus grant.
      const heldFocus = this.focus.owns(contents);
      this.focus.beginHandoff(contents);
      this.detach(entry);
      this.retired.add(entry);
      this.snapshots.cancel(entry);
      this.focus.unbind(entry);
      this.state(entry).cleanup();
      contents.close();
      // Preserve the intent across native fallback; a deliberate click cancels it.
      if (heldFocus) this.focus.preserve(contents);
      const replace = () => {
        if (this.closed() || this.hosted.get(entry.id) !== entry) return;
        this.createView(
          record,
          partition,
          event.url,
          entry.bounds,
          heldFocus && this.focus.owns(contents),
          Date.now() + RECREATION_INTERVAL_MS,
          this.state(entry).scroll,
        );
      };
      const delay = Math.max(0, this.state(entry).nextReplacementAt - Date.now());
      // Close immediately so untrusted script stops running. At most one
      // replacement is pending, with at most four recreations per second.
      if (delay > 0) this.state(entry).replacementTimer = setTimeout(replace, delay);
      else replace();
    };
    contents.on("did-start-navigation", navigate);
    listeners.push(() => {
      contents.removeListener("did-start-navigation", navigate);
    });
    const loading = () => {
      if (!this.current(entry) || this.closed() || contents.isDestroyed()) return;
      this.state(entry).previouslyLoaded = entry.loaded;
      entry.loaded = false;
      this.detach(entry);
    };
    contents.on("did-start-loading", loading);
    listeners.push(() => {
      contents.removeListener("did-start-loading", loading);
    });
    const loaded = () => {
      if (!this.current(entry) || this.closed() || contents.isDestroyed()) return;
      const attach = () => {
        if (!this.current(entry) || this.closed() || contents.isDestroyed()) return;
        entry.loaded = true;
        this.apply(entry);
        void this.snapshots.capture(entry);
      };
      const scroll = this.state(entry).scroll;
      if (scroll) {
        const [x, y] = scroll;
        this.state(entry).scroll = undefined;
        void contents
          .executeJavaScriptInIsolatedWorld(999, [
            { code: `window.scrollTo(${String(x)}, ${String(y)})` },
          ])
          .then(attach, attach);
      } else attach();
    };
    contents.on("did-finish-load", loaded);
    listeners.push(() => {
      contents.removeListener("did-finish-load", loaded);
    });
    this.focus.bind(entry, restoreFocus);
    void contents.loadURL(url).catch(() => {
      if (this.current(entry)) this.focus.loadFailed(entry);
    });
    return entry;
  }
}
