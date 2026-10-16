import type { ExecutionSnapshot } from "../../shared/execution";
import type { TerminalState } from "../../shared/workspace";

/** Presentation never changes execution, evaluator history or control-plane metadata. */
export function waitingState(
  id: string,
  state: TerminalState | null,
  execution: ExecutionSnapshot | undefined,
  count: number,
): TerminalState | null {
  if (execution?.phase !== "idle" || count === 0) return state;
  const current =
    state?.execution?.launch === execution.launch &&
    state.execution.revision === execution.revision;
  const idle: TerminalState = current
    ? state
    : {
        id,
        execution,
        verdictId: null,
        state: "quiet_ok",
        reason: "Agent turn ended; checking result",
        signal: "execution:idle",
        confidence: 1,
        timestamp: state?.timestamp ?? 0,
      };
  if (idle.state === "failed" || (idle.state === "needs_input" && idle.attentionKind !== "unknown"))
    return idle;
  return { ...idle, waitingOn: count };
}
