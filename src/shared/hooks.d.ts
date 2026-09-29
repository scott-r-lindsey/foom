export type HookAgent = "claude" | "codex";

/** Reduced evidence only: no agent text, paths, prompts, or credentials. */
export interface HookSignal {
  terminalId: string;
  action: "classify" | "needs_input";
  signal:
    | "claude:Stop"
    | "claude:PermissionRequest"
    | "claude:permission_prompt"
    | "claude:idle_prompt"
    | "codex:agent-turn-complete";
}

export interface HookLaunch {
  env: { FOOM_SESSION: string; FOOM_TOKEN: string; FOOM_HOOK_URL: string };
  /** Revoke on launch failure, terminal exit, or removal. Safe to call repeatedly. */
  revoke(): void;
}
