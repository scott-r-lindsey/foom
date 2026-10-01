import { sampleRows } from "./sample-rows";
import type { BoardRow } from "./board.d";
import type { TerminalActivity } from "../../shared/desktop";
import type { BoardSource } from "./board-source.d";

export function createSampleSource(initial: readonly BoardRow[] = sampleRows(Date.now())) {
  let rows = initial;
  const listeners = new Set<() => void>();
  const activityListeners = new Set<(batch: readonly TerminalActivity[]) => void>();
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
    tail: (id) => Promise.resolve(rows.find((row) => row.id === id)?.tail ?? []),
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
    update,
    setActivity: (id: string, rate: number) => {
      for (const listener of activityListeners) listener([{ id, rate }]);
    },
  };
}
