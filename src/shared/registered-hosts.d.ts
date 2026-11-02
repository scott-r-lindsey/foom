import type { RemoteReviewSnapshot } from "./remote-agent";
export interface RegisteredHost {
  host: string;
  codeFolder: string;
}
export type HostFailure =
  | "unreachable"
  | "version-mismatch"
  | "provider-invalid"
  | "configuration-changed"
  | "invalid-reply"
  | "cancelled"
  | "facts-unavailable"
  | "libc-too-old"
  | "libc-unsupported"
  | "unsupported"
  | "artifact-unavailable"
  | "folder-refused"
  | "unsafe-folder"
  | "origin-unavailable"
  | "clone-failed"
  | "checkout-refused";
export type HostAgentState = "ready" | "missing" | "unable";
export type HostSignIn = "signed-in" | "signed-out" | "unknown";
export interface HostRequirements {
  distro: "debian" | "rhel" | "arch" | "darwin" | "unknown";
  libc: "supported" | "too-old" | "unsupported";
  packageManager: "apt" | "dnf" | "pacman" | "brew" | "none";
  mac?: { commandLineTools: boolean; staysAwake: boolean; protectedFolder: boolean };
}
export interface HostFacts {
  requirements?: HostRequirements;
  tools?: readonly { id: string; state: HostAgentState; signIn: HostSignIn }[];
  codeFolder: string;
  version: string;
  sessions: number;
  cores: number;
  load: readonly number[];
  memoryTotal: number;
  memoryAvailable: number;
  agents: readonly { id: string; state: HostAgentState; signIn?: HostSignIn }[];
}
export type HostManagement = {
  type: "manage";
  codeFolder: string;
  agents?: readonly { id: string; executables: readonly string[] }[];
} & (
  | { operation: "inspect"; readOnly?: true }
  | { operation: "list-worktrees"; profile: string }
  | { operation: "repository" | "clone"; directory: string; origin: string }
  | {
      operation: "create-worktree";
      profile: string;
      directory: string;
      origin: string;
      branch: string;
      fromOrigin?: boolean;
    }
  | {
      operation: "inspect-worktree" | "snapshot-worktree" | "remove-worktree";
      profile: string;
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
      inventory?: { own: readonly RemoteWorktree[]; other: number };
      worktree?: {
        path: string;
        branch: string;
        identity: string;
        changes: string;
        snapshot?: RemoteReviewSnapshot;
        head?: string;
        origin?: string;
      };
    };
export interface HostRow extends RegisteredHost {
  recipes?: readonly {
    tool: string;
    install: boolean;
    signIn: boolean;
    installReason?: "recipe-unavailable";
  }[];
  foreignSessions?: number;
  foreignWorktrees?: number;
  result?: HostResult | undefined;
}
export interface RepositoryLocation {
  repository: string;
  host: string;
  result: HostResult;
}
export interface HostsState {
  recipeFailure?: "recipe-unavailable";
  hosts: readonly HostRow[];
  locations: readonly RepositoryLocation[];
  result?: HostResult | undefined;
}
export type HostsAction =
  | { action: "recipe"; host: string; tool: string; operation: "install" | "sign-in" }
  | { action: "list" }
  | { action: "add"; host: string; codeFolder: string }
  | { action: "test"; host: string; codeFolder: string }
  | { action: "refresh"; host: string }
  | { action: "remove"; host: string }
  | { action: "end"; host: string }
  | { action: "locations" }
  | { action: "clone"; host: string; repository: string };
export interface HostsApi {
  copyHost(command: HostCopyCommand): Promise<void>;
  hosts(action: HostsAction): Promise<HostsState>;
}

/** Copy requests identify registered objects, never clipboard text. */
export type HostCopyCommand =
  | { kind: "copy-host-alias"; host: string }
  | { kind: "copy-host-code-folder"; host: string }
  | { kind: "copy-checkout-path"; host: string | null; repository: string };

/** Private management inventory; never projected into Settings. */
export interface RemoteWorktree {
  repository: string;
  path: string;
  branch: string;
  identity: string;
  origin: string;
}

export interface HostRecipeRequest {
  tool: string;
  action: "install" | "sign-in";
  distro: "debian" | "rhel" | "arch" | "darwin";
}
export interface HostRecipe extends HostRecipeRequest {
  steps: readonly (readonly string[])[];
}

export interface HostRecipeLaunch extends HostRecipeRequest {
  digest: string;
}
