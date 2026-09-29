import type { BoardRow } from "./board.d";

/** View contract. Sample commands never reach the terminal bridge. */
export interface BoardSource {
  getSnapshot: () => readonly BoardRow[];
  subscribe: (listener: () => void) => () => void;
  subscribeActivity(listener: (id: string, rate: number) => void): () => void;
  markSeen(id: string): void;
  resolve(id: string, reason: string): void;
}
