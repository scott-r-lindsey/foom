import type { AgentId } from "./agents";

export interface DispatcherRepository {
  path: string;
  name: string;
  running: boolean;
}
export interface DispatcherView {
  orchestrators: number;
  repositories: number;
}
export interface DispatcherLaunch {
  repo: string;
  agent: AgentId;
  host?: string;
  prompt: string;
  reason?: string;
  idempotencyKey: string;
}

/** Main-only boundaries for a dispatcher launch. */
export interface DispatcherLaunchLifecycle {
  readonly terminalId: string;
  spawning(): void;
  binding(id: string): void;
}
