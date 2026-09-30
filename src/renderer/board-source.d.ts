import type { BoardRow } from "./board.d";
import type { ShellView } from "./shell.d";
import type { TerminalActivity } from "../shared/desktop";

/** Samples and the future live source share rows, verdicts, activity batches and tails. */
export interface BoardSource {
  getSnapshot: () => readonly BoardRow[];
  subscribe: (listener: () => void) => () => void;
  subscribeActivity(listener: (batch: readonly TerminalActivity[]) => void): () => void;
  tail(id: string): Promise<readonly string[]>;
  markSeen(id: string): void;
  resolve(id: string, reason: string): void;
  shell?: {
    mount(element: HTMLElement, onHide: () => void): () => void;
    getSnapshot: () => ShellView;
    subscribe: (listener: () => void) => () => void;
    open(): Promise<void>;
    hide(): Promise<void>;
    toggle(): Promise<void>;
    restart(): Promise<void>;
  };
}
