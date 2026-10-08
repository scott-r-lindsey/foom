import type {
  ExecutionPhase,
  ExecutionSnapshot,
  ExecutionSource,
  ExecutionTransition,
} from "../../shared/execution";

/** One machine per invocation. Output, keyboard input and focus are not evidence. */
export class AgentExecution {
  private current: ExecutionSnapshot;
  private openTurn = false;
  private blocker: ExecutionSource | undefined;
  constructor(
    terminalId: string,
    launch: number,
    private readonly emit: (event: ExecutionTransition) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.current = { terminalId, launch, revision: 0, turn: 0, phase: "starting" };
  }
  snapshot(): ExecutionSnapshot {
    return { ...this.current };
  }
  transition(
    to: ExecutionPhase,
    source: ExecutionSource,
    permissionReply = false,
  ): ExecutionTransition | undefined {
    const from = this.current.phase;
    if (from === "exited") return;
    // A title alone cannot answer an explicit permission request. The caller
    // verifies a reply followed by fresh title evidence and a cleared screen.
    // Working hooks prove progress without a reply.
    if (
      from === "blocked" &&
      to === "working" &&
      this.blocker === "hook" &&
      source !== "hook" &&
      !permissionReply
    )
      return;
    if (to === "blocked") this.blocker = source;
    if (to === from) return;
    let turn = this.current.turn;
    if (to === "working" && !this.openTurn) {
      turn++;
      this.openTurn = true;
    }
    if (to === "idle" || to === "exited") this.openTurn = false;
    if (to !== "blocked") this.blocker = undefined;
    this.current = { ...this.current, phase: to, revision: this.current.revision + 1, turn };
    const event = { ...this.current, from, to, source, at: this.now() };
    this.emit(event);
    return event;
  }
}
