/** Fixed local update facts; release notes and server errors never reach the renderer. */
export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloaded" | "error";
  runningAgents: number;
}
