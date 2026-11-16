import { viewChanges } from "./view-changes";

/** Projected host caches publish at their mutation site, including background reads. */
export class HostObservations<K, V> extends Map<K, V> {
  override set(key: K, value: V): this {
    const changed = !this.has(key) || this.get(key) !== value;
    super.set(key, value);
    if (changed) viewChanges.publish("hosts", "agents");
    return this;
  }
  override delete(key: K): boolean {
    const removed = super.delete(key);
    if (removed) viewChanges.publish("hosts", "agents");
    return removed;
  }
  override clear(): void {
    const changed = this.size > 0;
    super.clear();
    if (changed) viewChanges.publish("hosts", "agents");
  }
}
