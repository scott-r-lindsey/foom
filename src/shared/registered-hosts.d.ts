import type { RemoteReviewSnapshot } from "./remote-agent";
export interface RegisteredHost {
  host: string;
  /** Profile-only display label; never a transport target. */
  nickname?: string;
  codeFolder: string;
  /** Display-only last check; never used to authorize remote operations. */
  observation?: HostObservation;
}
export type HostGitFailureReason =
  | "origin-auth"
  | "origin-host-key"
  | "origin-unreachable"
  | "timed-out"
  | "checkout-invalid";
export type HostFailure =
  | HostGitFailureReason
  | "unreachable"
  | "host-key-unknown"
  | "host-key-changed"
  | "login-rejected"
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
  | "folder-missing"
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
export type HostCheck =
  | { state: "pass" }
  | { state: "not-checked" }
  | { state: "fail"; reason: HostFailure };
export interface HostConnectionChecks {
  ssh: HostCheck;
  platform: HostCheck;
  artifact: HostCheck;
}
export interface HostPreflight extends HostConnectionChecks {
  result: HostResult;
  repositories: readonly { repository: string; origin: HostCheck; checkout: HostResult }[];
}
export interface HostObservation {
  lastAgents?: { checkedAt: number; result: HostResult };
  checkedAt: number;
  preflight: HostPreflight;
  foreignSessions?: number;
  foreignWorktrees?: number;
}
export interface HostFacts {
  /** Present on partial inspection; failed folder checks never authorize a checkout. */
  folder?: HostCheck;
  requirements?: HostRequirements;
  tools?: readonly { id: string; state: HostAgentState; signIn: HostSignIn }[];
  codeFolder: string;
  version: string;
  sessions: number;
  cores: number;
  load: readonly number[];
  memoryTotal: number;
  memoryAvailable: number;
  agents: readonly {
    id: string;
    state: HostAgentState;
    signIn?: HostSignIn;
    details?: {
      path: string;
      version: string;
      capabilities: readonly string[];
      plugin?: "present" | "not-installed" | "unavailable";
    };
  }[];
}
export type HostCheckTarget =
  | { kind: "ssh" | "platform" | "artifact" | "folder" | "command-line-tools" | "power" }
  | { kind: "tool" | "sign-in"; tool: string }
  | { kind: "origin" | "checkout"; repository: string };
export type HostInspectionTarget =
  | Exclude<HostCheckTarget, { repository: string }>
  | { kind: "facts" };
export type HostManagement = {
  type: "manage";
  codeFolder: string;
  agents?: readonly { id: string; executables: readonly string[] }[];
} & (
  | {
      operation: "inspect";
      readOnly?: true;
      partial?: true;
      target?: HostInspectionTarget;
      agentDetails?: true;
    }
  | { operation: "create-folder" }
  | { operation: "list-worktrees"; profile: string }
  | { operation: "repository" | "clone" | "origin"; directory: string; origin: string }
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
export type HostResult = { connection?: HostConnectionChecks } & (
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
    }
);
export interface HostRow extends RegisteredHost {
  hostKeyTrust?: "askpass" | "manual";
  rowFailures?: readonly { target: HostCheckTarget; reason: "save-failed" | "check-failed" }[];
  recipes?: readonly {
    tool: string;
    install: boolean;
    signIn: boolean;
    pluginInstall?: boolean;
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
/** Local observation of the existing management steps; never sent to the host. */
export interface HostCheckProgress {
  host: string;
  phase: "inspect" | "origin" | "checkout";
  repository?: string;
  result?: HostResult;
  repositories: readonly {
    repository: string;
    origin?: HostCheck;
    checkout?: HostResult;
  }[];
}
export interface HostOutput {
  host: string;
  text: string;
  running: boolean;
  failed: boolean;
}
export interface HostsState {
  /** Sealed local build capability; independent of host connectivity. */
  remoteHostsAvailable?: boolean;
  output?: HostOutput;
  recipeSession?: string;
  progress?: HostCheckProgress;
  preflight?: HostPreflight;
  recipeFailure?: "recipe-unavailable";
  hosts: readonly HostRow[];
  locations: readonly RepositoryLocation[];
  result?: HostResult | undefined;
}
export type HostsAction =
  | { action: "trust-host-key"; host: string }
  | { action: "cancel-trust" }
  | { action: "reload"; host: string; target: HostCheckTarget }
  | { action: "rename"; host: string; nickname: string }
  | { action: "trust-origin"; host: string; repository: string }
  | {
      action: "recipe";
      host: string;
      tool: string;
      operation: "install" | "sign-in" | "install-plugin";
    }
  | { action: "preflight"; host: string; codeFolder: string }
  | { action: "draft-preflight"; host: string; codeFolder: string }
  | { action: "create-folder"; host: string }
  | { action: "change-folder"; host: string; codeFolder: string }
  | { action: "list" }
  | { action: "progress" }
  | { action: "dismiss-output" }
  | { action: "add"; host: string; codeFolder: string; nickname?: string }
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
  | { kind: "copy-host-ssh-command"; host: string }
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
  action: "install" | "sign-in" | "install-plugin";
  distro: "debian" | "rhel" | "arch" | "darwin";
}
export interface HostRecipe extends HostRecipeRequest {
  steps: readonly (readonly string[])[];
}

export interface HostRecipeLaunch extends HostRecipeRequest {
  digest: string;
}
