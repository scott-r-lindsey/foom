import { createHash } from "node:crypto";
import type { Handoff, HandoffMetadata } from "../../shared/handoff";
import { handoffRequest } from "../../node-common/handoff";
import { ControlError } from "./validation";
import type { Principal } from "./types";

/** Pull-only child reports, independent of execution and terminal input. */
export class Handoffs {
  private readonly records = new Map<string, readonly Handoff[]>();
  private readonly replays = new Map<
    string,
    { fingerprint: string; result: HandoffMetadata & { timestamp: string } }
  >();
  private writes: Promise<unknown> = Promise.resolve();

  entries(id: string): readonly Handoff[] {
    return this.records.get(id) ?? [];
  }
  latest(id: string): Handoff | undefined {
    return this.entries(id).at(-1);
  }
  restore(id: string, entries: readonly Handoff[]): void {
    this.records.set(id, entries);
  }
  remove(id: string): void {
    this.records.delete(id);
  }

  async record(
    actor: Principal,
    params: unknown,
    authorize: () => void,
    audit: (report: Handoff) => Promise<void>,
    persist: () => Promise<void>,
    now: () => number,
  ): Promise<HandoffMetadata & { timestamp: string }> {
    authorize();
    const { idempotencyKey, ...content } = handoffRequest(params);
    const key = `${actor.generation}:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    const work = this.writes.then(async () => {
      authorize();
      const prior = this.replays.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ControlError("conflict");
        await persist();
        authorize();
        return { ...prior.result };
      }
      if (this.replays.size >= 4096) throw new ControlError("capacity");
      const latest = this.latest(actor.terminalId);
      const time = now();
      if (latest && time - Date.parse(latest.timestamp) < 10000) throw new ControlError("capacity");
      const seq = (latest?.seq ?? 0) + 1;
      if (!Number.isSafeInteger(seq)) throw new ControlError("capacity");
      const report: Handoff = { ...content, seq, timestamp: new Date(time).toISOString() };
      await audit(report);
      authorize();
      this.records.set(actor.terminalId, [...this.entries(actor.terminalId).slice(-19), report]);
      const result = { seq, status: report.status, timestamp: report.timestamp };
      // Keep the accepted result even when persistence acknowledgement is lost. A replay
      // flushes storage again, without creating another report or audit entry.
      this.replays.set(key, { fingerprint, result });
      await persist();
      authorize();
      return { ...result };
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
}
