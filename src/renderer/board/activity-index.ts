import type { TerminalActivity } from "../../shared/desktop";
import type { BoardSource } from "./board-source";
import type { BoardRow } from "./board.d";

const indexes = new WeakMap<readonly BoardRow[], ReadonlyMap<string, BoardRow>>();
/** Structural snapshots are immutable; all light owners reuse their one index. */
export function activityRows(source: BoardSource): ReadonlyMap<string, BoardRow> {
  const snapshot = source.getSnapshot();
  let index = indexes.get(snapshot);
  if (!index) {
    index = new Map(snapshot.map((row) => [row.id, row]));
    indexes.set(snapshot, index);
  }
  return index;
}

type Listener = (batch: readonly TerminalActivity[]) => void;
type Dispatch = {
  all: Set<Listener>;
  scoped: Map<string, Set<Listener>>;
  latest: Map<string, { rate: number; version: number }>;
  off?: () => void;
  offRows?: () => void;
};
const dispatchers = new WeakMap<BoardSource, Dispatch>();

/** One upstream activity subscription; tile listeners receive only their session. */
export function subscribeActivity(
  source: BoardSource,
  listener: Listener,
  id?: string,
): () => void {
  let dispatch = dispatchers.get(source);
  if (!dispatch) {
    dispatch = { all: new Set(), scoped: new Map(), latest: new Map() };
    dispatchers.set(source, dispatch);
  }
  const shared = dispatch;
  const listeners = id === undefined ? shared.all : (shared.scoped.get(id) ?? new Set<Listener>());
  if (id !== undefined) shared.scoped.set(id, listeners);
  listeners.add(listener);
  if (!shared.off) {
    shared.offRows = source.subscribe(() => {
      const rows = activityRows(source);
      for (const [key, value] of shared.latest) {
        const row = rows.get(key);
        if (!row || row.exited || value.version !== (row.launchVersion ?? 0))
          shared.latest.delete(key);
      }
    });
    shared.off = source.subscribeActivity((batch) => {
      const rows = activityRows(source);
      for (const entry of batch) {
        const row = rows.get(entry.id);
        if (!row || row.exited) continue;
        shared.latest.set(entry.id, { rate: entry.rate, version: row.launchVersion ?? 0 });
        for (const callback of shared.scoped.get(entry.id) ?? []) callback([entry]);
      }
      for (const callback of shared.all) callback(batch);
    });
  } else {
    const rate = id === undefined ? undefined : shared.latest.get(id);
    const cached =
      id === undefined
        ? [...shared.latest].map(([key, value]) => ({ id: key, rate: value.rate }))
        : rate
          ? [{ id, rate: rate.rate }]
          : [];
    if (cached.length) listener(cached);
  }
  return () => {
    listeners.delete(listener);
    if (id !== undefined && !listeners.size) shared.scoped.delete(id);
    if (shared.all.size || shared.scoped.size) return;
    shared.off?.();
    shared.offRows?.();
    dispatchers.delete(source);
  };
}
