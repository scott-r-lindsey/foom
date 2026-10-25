import type { WebContents } from "electron";
import type { HostedPreview } from "./hosted-preview";
import type { PreviewSnapshot } from "../../shared/previews";

interface SnapshotState {
  snapshot?: string;
  snapshotVersion?: number;
  painted?: boolean;
  capturePending?: boolean;
  captureAgain?: boolean;
  refreshTimer?: ReturnType<typeof setTimeout>;
  coverTimer?: ReturnType<typeof setTimeout>;
  coverExpired?: boolean;
}
/** Capture and paint state belongs to an exact native-view generation. */
export class PreviewSnapshots {
  private readonly cancelled = new WeakSet<HostedPreview>();
  private readonly states = new WeakMap<HostedPreview, SnapshotState>();
  private snapshotVersion = 0;
  private disposed = false;
  private isCovered = false;
  get covered(): boolean {
    return this.isCovered;
  }
  constructor(
    private readonly board: WebContents,
    private readonly hosted: ReadonlyMap<string, HostedPreview>,
    private readonly closed: () => boolean,
    private readonly apply: (entry: HostedPreview) => void,
  ) {
    board.on("did-start-loading", this.reset);
  }
  private inactive(): boolean {
    return this.disposed || this.closed();
  }
  private current(entry: HostedPreview): boolean {
    return this.hosted.get(entry.id) === entry && !this.cancelled.has(entry);
  }
  private state(entry: HostedPreview): SnapshotState {
    let state = this.states.get(entry);
    if (!state) {
      state = {};
      this.states.set(entry, state);
    }
    return state;
  }
  invalidate(entry: HostedPreview): void {
    this.state(entry).painted = false;
  }
  obscured(entry: HostedPreview): boolean {
    const state = this.state(entry);
    if (this.covered && !state.painted && !state.coverExpired && !state.coverTimer) {
      state.coverTimer = setTimeout(() => {
        if (!this.current(entry) || this.inactive()) return;
        state.coverExpired = true;
        this.apply(entry);
      }, 250);
    }
    return this.covered && !!(state.painted || state.coverExpired);
  }
  cancel(entry: HostedPreview): void {
    this.cancelled.add(entry);
    const state = this.state(entry);
    clearTimeout(state.refreshTimer);
    clearTimeout(state.coverTimer);
  }
  dispose(): void {
    this.disposed = true;
    this.board.removeListener("did-start-loading", this.reset);
    for (const entry of this.hosted.values()) this.cancel(entry);
  }
  private readonly reset = () => {
    for (const entry of this.hosted.values()) {
      this.state(entry).painted = false;
      // A replacement board must paint its own canvases. In-flight replies from
      // the previous renderer cannot acknowledge these fresh versions.
      if (this.state(entry).snapshot) this.state(entry).snapshotVersion = ++this.snapshotVersion;
    }
  };
  publish() {
    if (this.board.isDestroyed()) return;
    const snapshots: PreviewSnapshot[] = [];
    for (const [id, entry] of this.hosted) {
      const { snapshot, snapshotVersion } = this.state(entry);
      if (snapshot && snapshotVersion && entry.bounds.visible)
        snapshots.push({
          id,
          bounds: entry.bounds,
          image: snapshot,
          version: snapshotVersion,
        });
    }
    this.board.send("preview:snapshots", snapshots);
  }
  painted(id: string, version: number): void {
    const entry = this.hosted.get(id);
    if (!entry || !entry.bounds.visible || this.state(entry).snapshotVersion !== version) return;
    this.state(entry).painted = true;
    clearTimeout(this.state(entry).coverTimer);
    this.apply(entry);
  }
  cover(covered: boolean): Promise<void> {
    if (this.inactive()) return Promise.resolve();
    this.isCovered = covered;
    for (const entry of this.hosted.values()) {
      clearTimeout(this.state(entry).coverTimer);
      this.state(entry).coverExpired = false;
      delete this.state(entry).coverTimer;
      if (covered && !this.state(entry).painted) void this.capture(entry);
      this.apply(entry);
    }
    this.publish();
    return Promise.resolve();
  }
  schedule(entry: HostedPreview) {
    clearTimeout(this.state(entry).refreshTimer);
    if (this.inactive() || !this.current(entry) || !entry.bounds.visible || this.covered) return;
    // Trailing debounce of actual resize/input activity, never periodic polling.
    this.state(entry).refreshTimer = setTimeout(() => void this.capture(entry), 120);
  }
  async capture(entry: HostedPreview) {
    const contents = entry.view.webContents;
    if (
      this.inactive() ||
      !this.current(entry) ||
      this.board.isDestroyed() ||
      !entry.loaded ||
      !entry.bounds.visible ||
      contents.isDestroyed()
    )
      return;
    if (this.state(entry).capturePending) {
      this.state(entry).captureAgain = true;
      return;
    }
    clearTimeout(this.state(entry).refreshTimer);
    this.state(entry).capturePending = true;
    try {
      const image = await contents.capturePage(undefined, { stayHidden: true });
      if (this.inactive() || !this.current(entry) || contents.isDestroyed() || image.isEmpty())
        return;
      this.state(entry).snapshot = image.toDataURL();
      this.state(entry).snapshotVersion = ++this.snapshotVersion;
      this.publish();
    } catch {
      // Retain the last painted image if capture fails.
    } finally {
      this.state(entry).capturePending = false;
      if (this.state(entry).captureAgain) {
        this.state(entry).captureAgain = false;
        this.schedule(entry);
      }
    }
  }
}
