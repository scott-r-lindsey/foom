import type { Handoff } from "../../shared/handoff";
import type { ReviewState } from "../../shared/review";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { PullRequest } from "./forge.d";

export interface ReviewSnapshot {
  head: string;
  digest: string;
}
export interface ReviewLoopHost {
  row: (id: string) => WorkspaceTerminal | undefined;
  report: (id: string) => Handoff | undefined;
  checks: (id: string) => PullRequest | undefined;
  snapshot: (id: string) => Promise<ReviewSnapshot>;
  /** Reserves capacity and rechecks ownership immediately before spawning. Undefined means wait. */
  step: (authorId: string, reviewer: boolean, prompt: string) => Promise<string | undefined>;
  /** Normal session stop, with ownership checked immediately before signaling. */
  stop: (id: string) => Promise<void>;
  changed: () => void;
  save: () => Promise<void>;
}
export interface ReviewLoop {
  state: ReviewState;
  currentId: string;
  afterSeq: number;
  stoppingId?: string;
  snapshot?: ReviewSnapshot;
  number?: number;
  prompt?: string;
  busy: boolean;
  again?: boolean;
  unreadAt?: number;
  parentTimer?: ReturnType<typeof setTimeout>;
  authorPhase?: "building" | "fixing";
}
