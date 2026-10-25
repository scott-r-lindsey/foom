import { PreviewTransfer } from "./preview-transfer";
import { PreviewViewLifecycle } from "./preview-view-lifecycle";
import { PreviewFocus } from "./preview-focus";
import { PreviewSnapshots } from "./preview-snapshots";
import type { HostedPreview } from "./hosted-preview";
import { shell } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import type { PreviewBounds, PreviewRecord } from "../../shared/previews";
import { canonicalRoot, readInside, type CanonicalRoot } from "./contained-files";
import type { DialogContent } from "../../shared/confirmation";
import { externalLink } from "./policy";
import type { PreviewRegistry } from "./registry";
import { previewPath } from "./registry";

/** One host per board window. No page or IPC capability can focus a preview. */
export class PreviewHost {
  private readonly transfer: PreviewTransfer;
  private closing = false;
  private disposal: Promise<void> | undefined;
  private readonly tiled = new Set<string>();
  private readonly hosted = new Map<string, HostedPreview>();
  private readonly confirmations = new Map<string, AbortController>();
  get watcherCount(): number {
    return this.lifecycle.watcherCount;
  }
  private readonly lifecycle: PreviewViewLifecycle;
  private readonly focus: PreviewFocus;
  private readonly snapshots: PreviewSnapshots;
  private readonly board: WebContents;
  private disposed = false;
  constructor(
    private readonly window: BrowserWindow,
    readonly registry: PreviewRegistry,
    private readonly validateWorktree: (worktree: string) => Promise<void>,
    private readonly changed: () => void,
    private readonly confirm: (
      content: DialogContent,
      signal: AbortSignal,
    ) => Promise<boolean> = () => Promise.resolve(false),
    private readonly bundledRoot?: string,
    placeMoved: (id: string) => void = () => {},
  ) {
    this.board = window.webContents;
    this.snapshots = new PreviewSnapshots(
      this.board,
      this.hosted,
      () => this.closed(),
      (entry) => {
        this.applyBounds(entry);
      },
    );
    this.focus = new PreviewFocus(
      window,
      () => this.hosted.values(),
      () => this.snapshots.covered,
      (entry) => {
        this.snapshots.schedule(entry);
      },
    );
    this.lifecycle = new PreviewViewLifecycle(
      this.board,
      this.hosted,
      (entry) => this.hosted.set(entry.id, entry),
      (entry) => {
        if (this.hosted.get(entry.id) === entry) this.hosted.delete(entry.id);
      },
      () => this.closed(),
      (entry) => {
        this.detach(entry);
      },
      (entry) => {
        this.applyBounds(entry);
      },
      (record, url) => this.openExternal(record, url),
      this.focus,
      this.snapshots,
    );
    this.transfer = new PreviewTransfer({
      registry,
      disposed: () => this.disposed,
      closed: () => this.closed(),
      boardDestroyed: () => this.board.isDestroyed(),
      bounds: (id) => this.hosted.get(id)?.bounds,
      validateRecord: (record) => this.validateRecord(record),
      release: (id) => this.release(id),
      changed,
      close: (id) => this.close(id),
      updateBounds: (record, bounds) => {
        this.updateBounds(record, bounds);
      },
      landing: (id) => {
        this.landing(id);
      },
      placeMoved,
    });
    window.on("resize", this.refresh);
  }
  readonly refresh = () => {
    for (const entry of this.hosted.values()) {
      this.applyBounds(entry);
      this.snapshots.schedule(entry);
    }
  };
  private closed(): boolean {
    return this.disposed || this.closing;
  }
  async restore(): Promise<void> {
    await this.registry.load();
    for (const record of [...this.registry.records.values()]) {
      try {
        await this.validateRecord(record);
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
    if (this.closed()) throw new Error("Preview host closed");
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
      if (!agent) this.lifecycle.create(record, root);
    } catch (error) {
      this.registry.records.delete(record.id);
      await this.registry.save();
      throw error;
    }
    this.changed();
    return record.id;
  }
  /** Fixed bundled capability. It cannot be selected by a file-path IPC request. */
  openManual(): string {
    if (!this.bundledRoot || this.closed()) throw new Error("Manual unavailable");
    const existing = [...this.registry.records.values()].find(
      (record) => record.bundled === "manual",
    );
    if (existing) return existing.id;
    const root = canonicalRoot(this.bundledRoot);
    if (readInside(root, "/manual.html").status !== 200) throw new Error("Manual unavailable");
    const record = this.registry.add("foom:manual", "manual.html");
    record.bundled = "manual";
    this.lifecycle.create(record, root);
    this.changed();
    return record.id;
  }
  focusManual(id: string): void {
    const entry = this.hosted.get(id);
    if (!entry || this.registry.records.get(id)?.bundled !== "manual") return;
    this.focus.requestManual(id);
    this.applyBounds(entry);
  }
  private root(record: PreviewRecord): CanonicalRoot {
    if (record.bundled === "manual") {
      if (!this.bundledRoot) throw new Error("Manual unavailable");
      return canonicalRoot(this.bundledRoot);
    }
    return canonicalRoot(record.worktree);
  }
  private validateRecord(record: PreviewRecord): Promise<void> {
    return record.bundled === "manual" && this.bundledRoot
      ? Promise.resolve()
      : this.validateWorktree(record.worktree);
  }
  private detach(entry: HostedPreview) {
    if (entry.attached && !this.window.isDestroyed())
      this.window.contentView.removeChildView(entry.view);
    entry.attached = false;
    this.focus.detach(entry);
  }
  private applyBounds(entry: HostedPreview) {
    // Native destruction can lag close; released/replaced views must never reattach.
    if (
      this.closed() ||
      !this.lifecycle.current(entry) ||
      this.board.isDestroyed() ||
      entry.view.webContents.isDestroyed()
    )
      return;
    const zoom = this.board.getZoomFactor();
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
    const obscured = this.snapshots.obscured(entry);
    const visible = !obscured && entry.bounds.visible && bounds.width > 0 && bounds.height > 0;
    entry.view.setVisible(visible);
    if (!visible) {
      this.focus.hidden(entry);
      // Overlay covers only hide: keep the native child attached on X11.
      if (!entry.bounds.visible) this.detach(entry);
    } else if (entry.loaded && !entry.attached) {
      this.window.contentView.addChildView(entry.view);
      entry.attached = true;
      this.transfer.forgetIncoming(entry.id);
      this.focus.attached(entry);
    }
    if (visible) this.focus.visible(entry);
  }

  private landing(id: string): void {
    const record = this.registry.records.get(id);
    if (!record || this.closed() || this.transfer.isMoving(id) || this.board.isDestroyed()) return;
    // Keep the sidebar reachable even when the board has not supplied tile geometry.
    const zoom = this.board.getZoomFactor();
    const { width, height } = this.window.getContentBounds();
    const x = Math.min(300, width / zoom / 2);
    this.updateBounds(record, {
      x,
      y: 40,
      width: width / zoom - x,
      height: Math.max(1, height / zoom - 40),
      visible: true,
    });
  }
  placed(id: string, visible: boolean): void {
    if (visible && this.registry.records.has(id)) this.tiled.add(id);
  }
  visible(id: string): boolean {
    return this.tiled.has(id);
  }
  bounds(id: string, bounds: PreviewBounds): void {
    const record = this.registry.records.get(id);
    if (!record || this.closed()) throw new Error("Unknown preview ID");
    if (this.transfer.isMoving(id)) return;
    this.updateBounds(record, bounds);
  }
  private updateBounds(record: PreviewRecord, bounds: PreviewBounds): void {
    const { id } = record;
    if (bounds.visible) this.tiled.add(id);
    if (!bounds.visible && !this.hosted.has(id)) return;
    const entry = this.hosted.get(id) ?? this.lifecycle.create(record, this.root(record));
    const resized = entry.bounds.width !== bounds.width || entry.bounds.height !== bounds.height;
    entry.bounds = bounds;
    if (!bounds.visible) {
      this.snapshots.invalidate(entry);
      this.focus.deselect(entry);
    }
    if (resized) this.snapshots.schedule(entry);
    this.applyBounds(entry);
    this.snapshots.publish();
  }
  painted(id: string, version: number): void {
    this.snapshots.painted(id, version);
  }
  cover(covered: boolean): Promise<void> {
    return this.snapshots.cover(covered);
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
  reload(id: string): Promise<void> {
    if (this.closed() || !this.registry.records.has(id)) throw new Error("Unknown preview ID");
    return this.lifecycle.reload(id);
  }
  reloadFocused(): void {
    if (this.closed() || this.snapshots.covered || !this.window.isFocused()) return;
    const entry = [...this.hosted.values()].find(
      (entry) =>
        entry.attached &&
        this.focus.owns(entry.view.webContents) &&
        entry.view.webContents.isFocused(),
    );
    if (entry) void this.reload(entry.id);
  }
  async network(id: string, enabled: boolean): Promise<void> {
    const record = this.registry.records.get(id);
    if (!record || this.closed()) throw new Error("Unknown preview ID");
    if (record.bundled) throw new Error("Bundled previews have no network access");
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
   * A destination without board geometry receives a native landing view after five seconds. */
  moveTo(id: string, target: PreviewHost): Promise<void> {
    return this.transfer.moveTo(id, target.transfer);
  }
  async close(id: string): Promise<void> {
    const closingTransfer = this.transfer.followClose(id);
    if (closingTransfer && (await closingTransfer)) return;
    this.transfer.forgetIncoming(id);
    if (!this.registry.records.delete(id)) throw new Error("Unknown preview ID");
    await this.release(id);
    await this.registry.save();
    // Shutdown frees views without publishing a transient empty inventory to the board.
    if (!this.disposed) this.changed();
  }
  private async release(id: string): Promise<void> {
    this.focus.forgetManual(id);
    this.tiled.delete(id);
    this.confirmations.get(id)?.abort();
    await this.lifecycle.release(id);
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
        await this.validateRecord(record);
      } catch {
        if (this.registry.records.has(record.id)) await this.close(record.id);
      }
    }
  }
  dispose(persist: boolean, replacement?: () => Promise<PreviewHost | undefined>): Promise<void> {
    this.disposal ??= this.finishDispose(persist, replacement);
    return this.disposal;
  }
  private async finishDispose(
    persist: boolean,
    replacement?: () => Promise<PreviewHost | undefined>,
  ): Promise<void> {
    if (this.disposed) return;
    this.closing = true;
    if (!persist)
      await this.transfer.recover(
        replacement ? async () => (await replacement())?.transfer : undefined,
      );
    this.disposed = true;
    this.snapshots.dispose();
    this.focus.dispose();
    this.window.removeListener("resize", this.refresh);
    const saved = [...this.registry.records.values()]
      .filter(
        (record) =>
          !record.bundled &&
          (this.transfer.isIncoming(record.id) || !record.agentOpened || this.visible(record.id)),
      )
      .map(({ agentOpened: _agentOpened, openedBy: _openedBy, ...record }) => record);
    for (const id of [...this.registry.records.keys()]) await this.close(id);
    if (persist) {
      for (const record of saved) this.registry.records.set(record.id, record);
      await this.registry.save();
    }
  }
}
