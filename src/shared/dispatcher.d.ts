import type { AgentId } from "./agents";

export interface DispatcherRepository {
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
