export interface RegisteredHost {
  host: string;
  codeFolder: string;
}
export type HostFailure =
  | "unreachable"
  | "unsupported"
  | "artifact-unavailable"
  | "folder-refused"
  | "unsafe-folder"
  | "origin-unavailable"
  | "clone-failed"
  | "checkout-refused";
export type HostAgentState = "ready" | "missing" | "unable";
export interface HostFacts {
  codeFolder: string;
  version: string;
  sessions: number;
  cores: number;
  load: readonly number[];
  memoryTotal: number;
  memoryAvailable: number;
  agents: readonly { id: string; state: HostAgentState }[];
}
export type HostManagement = {
  type: "manage";
  codeFolder: string;
  agents?: readonly { id: string; executables: readonly string[] }[];
} & (
  | { operation: "inspect" }
  | { operation: "repository" | "clone"; directory: string; origin: string }
  | {
      operation: "create-worktree";
      directory: string;
      origin: string;
      branch: string;
      fromOrigin?: boolean;
    }
  | {
      operation: "inspect-worktree" | "remove-worktree";
      directory: string;
      origin: string;
      path: string;
      identity: string;
      changes?: string;
    }
);
export type HostResult =
  | { ok: false; reason: HostFailure }
  | {
      ok: true;
      facts: HostFacts;
      checkout?: { path: string; state: "clean" | "changed" | "absent" };
      worktree?: {
        path: string;
        branch: string;
        identity: string;
        changes: string;
        head?: string;
        origin?: string;
      };
    };
export interface HostRow extends RegisteredHost {
  foreignSessions?: number;
  result?: HostResult | undefined;
}
export interface RepositoryLocation {
  repository: string;
  host: string;
  result: HostResult;
}
export interface HostsState {
  hosts: readonly HostRow[];
  locations: readonly RepositoryLocation[];
  result?: HostResult | undefined;
}
export type HostsAction =
  | { action: "list" }
  | { action: "add"; host: string; codeFolder: string }
  | { action: "test"; host: string; codeFolder: string }
  | { action: "refresh"; host: string }
  | { action: "remove"; host: string }
  | { action: "end"; host: string }
  | { action: "locations" }
  | { action: "clone"; host: string; repository: string };
export interface HostsApi {
  hosts(action: HostsAction): Promise<HostsState>;
}
