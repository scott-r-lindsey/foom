/** Fixed diagnostics only: never carry host output or provider text. */
export const launchReasons = {
  agent_disabled: "This agent is turned off in preflight.",
  agent_unavailable: "The local agent is not installed or discoverable.",
  remote_agent_unavailable: "The remote agent is unavailable (not installed or discoverable).",
  remote_host_unreachable: "The remote host is unreachable or SSH authentication failed.",
  remote_artifact_mismatch: "The remote host platform or artifact does not match.",
  remote_worktree_unavailable: "The remote worktree is missing or not a repository member.",
  remote_prepare_refused: "The remote host refused launch preparation.",
  remote_start_refused: "The remote host refused to start the agent.",
  launch_failed: "The agent launch failed.",
} as const;
export type LaunchReason = keyof typeof launchReasons;
export function isLaunchReason(value: unknown): value is LaunchReason {
  return typeof value === "string" && Object.hasOwn(launchReasons, value);
}
export class LaunchFailure extends Error {
  constructor(readonly reason: LaunchReason) {
    super(launchReasons[reason]);
  }
}
