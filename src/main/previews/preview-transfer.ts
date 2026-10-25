import type { PreviewBounds, PreviewRecord } from "../../shared/previews";
import type { PreviewRegistry } from "./registry";

interface TransferPort {
  registry: PreviewRegistry;
  disposed: () => boolean;
  closed: () => boolean;
  boardDestroyed: () => boolean;
  bounds: (id: string) => PreviewBounds | undefined;
  validateRecord: (record: PreviewRecord) => Promise<void>;
  release: (id: string) => Promise<void>;
  changed: () => void;
  close: (id: string) => Promise<void>;
  updateBounds: (record: PreviewRecord, bounds: PreviewBounds) => void;
  landing: (id: string) => void;
  placeMoved: (id: string) => void;
}
/** Two-owner transaction. Only this owner can mutate transfer bookkeeping. */
export class PreviewTransfer {
  constructor(private readonly port: TransferPort) {}
  isMoving(id: string): boolean {
    return this.moving.has(id);
  }
  isIncoming(id: string): boolean {
    return this.incoming.has(id);
  }
  followClose(id: string): Promise<boolean> | undefined {
    const moving = this.moving.get(id);
    if (!moving) return undefined;
    return moving.done
      .catch(() => {})
      .then(async () => {
        if (!moving.target.port.registry.records.has(id)) return false;
        await moving.target.port.close(id);
        return true;
      });
  }
  async recover(replacement?: () => Promise<PreviewTransfer | undefined>): Promise<void> {
    for (const [id, incoming] of [...this.incoming]) {
      await incoming.source.moving.get(id)?.done.catch(() => {});
      if (!this.incoming.has(id) || !this.port.registry.records.has(id)) continue;
      let source = incoming.source;
      const unavailable = () =>
        source.port.closed() ||
        source.port.boardDestroyed() ||
        source.port.registry.records.size >= 256;
      if (unavailable()) source = (await replacement?.()) ?? source;
      if (unavailable()) continue;
      // A removed checkout must not be resurrected. A persistence error can
      // happen after ownership changed, so still restore any returned record.
      await this.moveTo(id, source, true).catch(() => {});
      // Availability may change during checkout validation or native cleanup.
      // Keep ownership here until a replacement can accept the same record.
      if (this.port.registry.records.has(id) && unavailable()) {
        source = (await replacement?.()) ?? source;
        if (!unavailable()) await this.moveTo(id, source, true).catch(() => {});
      }
      const record = source.port.registry.records.get(id);
      if (record) {
        if (source === incoming.source && incoming.bounds?.visible)
          source.port.updateBounds(record, incoming.bounds);
        else source.port.landing(id);
        source.port.placeMoved(id);
      }
    }
  }
  private readonly moving = new Map<string, { target: PreviewTransfer; done: Promise<void> }>();
  private readonly incoming = new Map<
    string,
    {
      source: PreviewTransfer;
      bounds: PreviewBounds | undefined;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  forgetIncoming(id: string): void {
    const incoming = this.incoming.get(id);
    if (incoming) clearTimeout(incoming.timer);
    this.incoming.delete(id);
  }
  moveTo(id: string, target: PreviewTransfer, recovering = false): Promise<void> {
    const record = this.port.registry.records.get(id);
    const available = () =>
      !this.port.disposed() &&
      !target.port.closed() &&
      !target.port.boardDestroyed() &&
      target !== this &&
      !target.port.registry.records.has(id) &&
      target.port.registry.records.size < 256;
    if (!record || this.moving.has(id) || !available())
      return Promise.reject(new Error("Unable to move preview"));
    const bounds = this.port.bounds(id);
    const done = (async () => {
      await target.port.validateRecord(record);
      await this.port.release(id);
      await target.port.validateRecord(record);
      if (this.port.registry.records.get(id) !== record || !available())
        throw new Error("Unable to move preview");
      // No await between owners: agent inventory never loses the preview ID.
      this.forgetIncoming(id);
      this.port.registry.records.delete(id);
      target.port.registry.records.set(id, { ...record, network: false });
      if (!recovering)
        target.incoming.set(id, {
          source: this,
          bounds,
          timer: setTimeout(() => {
            // Geometry can arrive before a slow page finishes loading. Keep it.
            const incoming = target.incoming.get(id);
            const pending = () => {
              const current = target.port.bounds(id);
              return (
                incoming !== undefined &&
                target.incoming.get(id) === incoming &&
                !target.port.closed() &&
                !target.moving.has(id) &&
                !(current?.visible && current.width > 0 && current.height > 0)
              );
            };
            if (!pending()) return;
            void target.port
              .validateRecord(record)
              .then(() => {
                if (pending()) target.port.landing(id);
              })
              .catch(() => {
                /* A removed checkout cannot regain a view. */
              });
          }, 5000),
        });
      this.port.changed();
      target.port.changed();
      // Persist removal first; a failed source write must not also write the target.
      await this.port.registry.save();
      await target.port.registry.save();
    })()
      .catch(async (error: unknown) => {
        if (
          !this.port.disposed() &&
          this.port.registry.records.get(id) === record &&
          bounds &&
          !this.port.bounds(id)
        ) {
          try {
            await this.port.validateRecord(record);
            if (!this.port.closed() && this.port.registry.records.get(id) === record)
              this.port.updateBounds(record, bounds);
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
}
