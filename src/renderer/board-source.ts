import { sampleRows } from "./board";
import type { BoardRow } from "./board.d";
import type { BoardSource } from "./board-source.d";

export function createSampleSource(initial: readonly BoardRow[] = sampleRows(Date.now())) {
  let rows = initial;
  const listeners = new Set<() => void>();
  const activityListeners = new Set<(id: string, rate: number) => void>();
  const update = (id: string, change: Partial<BoardRow>) => {
    rows = rows.map((row) => (row.id === id ? { ...row, ...change } : row));
    for (const listener of listeners) listener();
  };
  const source: BoardSource = {
    getSnapshot: () => rows,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeActivity: (listener) => {
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
      };
    },
    markSeen: (id) => {
      update(id, { seen: true });
    },
    resolve: (id, reason) => {
      if (rows.some((row) => row.id === id && row.state === "needs_input"))
        update(id, { state: "working", reason });
    },
  };
  return {
    ...source,
    setActivity: (id: string, rate: number) => {
      for (const listener of activityListeners) listener(id, rate);
    },
  };
}
