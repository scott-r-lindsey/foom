import type { AgentEvidence } from "./agent-detection";
import type { AgentId } from "./agents";
import type { HookSignal } from "./hooks";

export type VerdictState = "needs_input" | "done" | "failed" | "quiet_ok" | "working";
export interface Verdict {
  state: VerdictState;
  reason: string;
  signal: string;
  confidence: number;
}
/** Main-process evidence. Prompt return must be observed, never guessed from tail text. */
export interface EvaluationInput {
  agent?: AgentId;
  evidence?: AgentEvidence;
  terminalId: string;
  tail: readonly string[];
  hook?: HookSignal;
  exitCode?: number;
  promptReturned?: boolean;
}
export type VerdictAction = "replied" | "dismissed" | "ignored";
export interface VerdictRecord {
  id: string;
  terminalId: string;
  timestamp: string;
  verdict: Verdict;
}
