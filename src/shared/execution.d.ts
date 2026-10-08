/** Execution evidence is metadata only, scoped to one launch and one turn. */
export type ExecutionPhase = "starting" | "idle" | "working" | "blocked" | "exited";
export type ExecutionSource = "launch" | "hook" | "title" | "screen" | "exit";
export interface ExecutionSnapshot {
  terminalId: string;
  launch: number;
  revision: number;
  turn: number;
  phase: ExecutionPhase;
}
export interface ExecutionTransition extends ExecutionSnapshot {
  from: ExecutionPhase;
  to: ExecutionPhase;
  source: ExecutionSource;
  at: number;
}
