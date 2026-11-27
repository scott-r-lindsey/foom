import {
  HOST_HANDSHAKE_TIMEOUT_MS,
  HOST_MANAGEMENT_TIMEOUT_MS,
  HOST_PREPARATION_TIMEOUT_MS,
} from "./registered-hosts";
import { record } from "./remote-agent-protocol";

const DEFAULT_DEADLINE_MS = 10_000;
const RELAY_MARGIN_MS = 5_000;
const MANAGEMENT_ROUND_TRIP_MS = HOST_HANDSHAKE_TIMEOUT_MS + HOST_MANAGEMENT_TIMEOUT_MS;
const LAUNCH_ROUND_TRIP_MS = HOST_HANDSHAKE_TIMEOUT_MS + HOST_PREPARATION_TIMEOUT_MS;

/** Budget for the bounded host checkout and launch phases, plus relay overhead. */
export function remoteControlDeadline(method: string, params: unknown): number {
  // Creation can inspect the repository, clone it, create the checkout and reconcile a lost reply.
  if (method === "create_worktree") return 4 * MANAGEMENT_ROUND_TRIP_MS + RELAY_MARGIN_MS;
  // Launch and review can check provider readiness, inspect the checkout and verify review state.
  if (method === "review" || method === "launch")
    return 4 * MANAGEMENT_ROUND_TRIP_MS + LAUNCH_ROUND_TRIP_MS + RELAY_MARGIN_MS;
  if (method === "wait_for" && record(params)) {
    const timeout = params["timeoutMs"];
    if (
      typeof timeout === "number" &&
      Number.isInteger(timeout) &&
      timeout >= 0 &&
      timeout <= 30_000
    )
      return Math.max(DEFAULT_DEADLINE_MS, timeout + RELAY_MARGIN_MS);
  }
  return DEFAULT_DEADLINE_MS;
}
