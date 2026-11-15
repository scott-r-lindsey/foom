/** Suggestions contain data only. Approval and execution remain main-owned capabilities. */
export type SetupDistro = "debian" | "rhel" | "arch" | "darwin";
export interface SetupRequirement {
  id: string;
  purpose: string;
  sources: readonly string[];
}
export interface SetupPackage extends SetupRequirement {
  kind: "package";
  packages: Readonly<Record<SetupDistro, readonly string[] | "unsupported">>;
}
export interface SetupToolchain extends SetupRequirement {
  kind: "toolchain";
  tool: "node" | "pnpm";
  version: string;
}
export interface RepositorySetupList {
  requirements: readonly (SetupPackage | SetupToolchain)[];
  evidence: readonly string[];
}
export interface SetupSources {
  fingerprint: string;
  files: readonly { path: string; digest: string }[];
}
export interface SetupApproval {
  repository: string;
  identity: string;
  revision: number;
  digest: string;
  catalog: string;
  sources: SetupSources;
  checkout: string;
  head: string;
  approvedAt: number;
  list: RepositorySetupList;
}
export interface SetupPlatform {
  distro: SetupDistro | "unsupported";
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64" | "unsupported";
  nodeAbi: boolean;
}
export interface SetupCheck {
  platform: SetupPlatform;
  items: readonly { id: string; state: "met" | "missing" | "unable" | "manual" }[];
}
export interface SetupPlan {
  platform: SetupPlatform;
  packages: readonly string[];
  toolchains: readonly { tool: "node" | "pnpm"; version: string }[];
  steps: readonly (readonly string[])[];
}
export type SetupState =
  | "no-list"
  | "not-checked"
  | "met"
  | "needs-setup"
  | "review-needed"
  | "unable"
  | "manual";
export interface SetupRow {
  repository: string;
  host: string | null;
  state: SetupState;
  revision: number;
  checkedAt?: number;
  noRequirements?: boolean;
  location?: SetupRun["location"];
  missing: readonly string[];
  changed: readonly string[];
  sourcesAtLaunch: boolean;
  plan?: SetupPlan | undefined;
  token?: string | undefined;
  running?: string | undefined;
  failure?: "save-failed" | "check-failed" | "superseded";
}
export interface SetupReview {
  token: string;
  repository: string;
  revision: number;
  list: RepositorySetupList;
  previous?: RepositorySetupList;
  catalog: string;
  sources: SetupSources;
  changed: readonly string[];
  unresolved?: readonly SetupUnresolved[];
  removed?: readonly string[];
}
export interface RepositorySetupState {
  rows: readonly SetupRow[];
  review?: SetupReview;
  recipeSession?: string;
}
export type RepositorySetupAction =
  | { action: "list" }
  | { action: "copy-brief" }
  | { action: "cancel-review"; keepDraft: boolean }
  | { action: "review"; repository: string; draft?: string }
  | { action: "approve"; token: string }
  | { action: "remove"; repository: string }
  | { action: "check"; repository: string; host: string | null }
  | { action: "run"; token: string };
/** Serialized main-selected execution plan; host reconstructs it before any process. */
export interface SetupRun {
  location: { root: string; path: string; present: boolean };
  list: RepositorySetupList;
  catalog: string;
  revision: number;
  repository: string;
  registration: string;
  host: string;
  sources: string;
  check: SetupCheck;
  digest: string;
}
export interface SetupAdmission {
  codeRoot: string;
  list: RepositorySetupList;
  catalog: string;
  revision: number;
  sources: string;
}
export interface SetupArtifact {
  url: string;
  algorithm: "sha256" | "sha512";
  digest: string;
  encoding: "hex" | "base64";
}
export interface SetupRefusal {
  repository: string;
  host: string | null;
  missing: readonly { id: string; version?: string }[];
}
/** Known data fields with an unsupported tool; never an active requirement. */
export interface SetupUnresolved extends SetupRequirement {
  kind: "toolchain";
  tool: string;
  version: string;
}
export interface SetupDraft {
  list: RepositorySetupList;
  unresolved: readonly SetupUnresolved[];
}
