export type HookAgent = "claude" | "codex" | "agy";

/** Reduced evidence only: no agent text, paths, prompts, or credentials. */
export interface HookSignal {
  terminalId: string;
  conversationId?: string;
  action: "classify" | "needs_input" | "working" | "ready" | "failed";
  terminationReason?: "model_stop" | "max_steps_exceeded" | "error";
  fullyIdle?: boolean;
  signal:
    | "agy:PreInvocation"
    | "agy:PostToolUse"
    | "agy:Stop"
    | "claude:UserPromptSubmit"
    | "claude:PreToolUse"
    | "claude:Stop"
    | "claude:PermissionRequest"
    | "claude:permission_prompt"
    | "claude:idle_prompt"
    | "codex:SessionStart"
    | "codex:UserPromptSubmit"
    | "codex:PreToolUse"
    | "codex:PermissionRequest"
    | "codex:PostToolUse"
    | "codex:Stop"
    | "codex:agent-turn-complete";
}

export interface HookLaunch {
  env: { FOOM_SESSION: string; FOOM_TOKEN: string; FOOM_HOOK_URL: string };
  /** Revoke on launch failure, terminal exit, or removal. Safe to call repeatedly. */
  revoke(): void;
}
