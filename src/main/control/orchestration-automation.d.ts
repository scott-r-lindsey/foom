import type { Operation, Principal } from "./types";

/** Captured authority with exact parent/child identity revalidation, never mutable stores. */
export interface AuthorizedChild {
  repository: string;
  tree: { path: string; identity: string } | undefined;
  valid(): boolean;
  closeScope(): { signal: AbortSignal; release(): void };
  exited(): boolean;
  active(): boolean;
  validate(): void;
  note(record: Operation): void;
}
export interface ReviewReservation {
  release(): void;
  exited(exited: boolean): void;
  attach(id: string, reviewer: boolean): void;
}
export interface ReviewAuthority {
  authorize(actor: Principal, id: string): AuthorizedChild;
  capacity(actor: Principal): boolean;
  reserve(actor: Principal, id: string): ReviewReservation | undefined;
  changed(): void;
  released(): void;
  resumed(id: string): void;
}
export interface FinishedChildAuthority {
  children(): { parentId: string | null; id: string }[];
  authorize(actor: Principal, id: string): AuthorizedChild;
}
