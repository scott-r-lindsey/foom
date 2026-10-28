import type { HookSignal } from "./hooks";
/** Main-only mapping; paths authorize nothing without the selected local checkout. */
export interface RemoteAgentSpec {
  agent: string;
  repository: string;
  worktree: string;
  defaults: string[];
  prompt?: string;
  conversationId?: string;
  hooks: boolean;
  checkoutIdentity?: string;
}
export type RemoteControlResult =
  | { type: "identity"; alias: string; role: "child"; capabilities: string[] }
  | { type: "handoff"; seq: number; status: "done" | "blocked" | "failed"; timestamp: string }
  | {
      type: "manual";
      value:
        | { sections: { id: string; title: string; summary: string }[] }
        | { id: string; title: string; text: string; page: number; nextPage?: number };
    }
  | {
      type: "error";
      error:
        | "phase_2_restricted"
        | "invalid_request"
        | "unavailable"
        | "no_parent"
        | "unauthorized";
    };
export interface RemoteAgentReady {
  channels?: string[];
  hooks: boolean;
  mcp: boolean;
  conversationId?: string;
}
/** Main-only callbacks. Never serialized to a host or accepted through IPC. */
export interface RemoteAgentBinding {
  /** Installed by the main transport; opens the remote relay after grant binding. */
  activate?(): void;
  spec: RemoteAgentSpec;
  authorize(): Promise<void>;
  /** Recheck captured parent/operation authority synchronously before agent-start. */
  start(): void;
  call(method: string, params: unknown): Promise<RemoteControlResult>;
  hook(signal: HookSignal): void | Promise<void>;
  ready(value: RemoteAgentReady): void;
}
