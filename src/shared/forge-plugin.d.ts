export type ForgePath = readonly (string | number)[];
export type ForgeState = "OPEN" | "CLOSED" | "MERGED";
export type CheckConclusion = "pending" | "success" | "failure" | "none" | "unknown";
export type ForgeSlot =
  | "branch"
  | "number"
  | "project"
  | "host"
  | "nodeId"
  | "query"
  | "projectOwner"
  | "projectName";
export type ForgeArgument =
  | string
  | { parts: readonly (string | { slot: ForgeSlot; encoding: "literal" | "percent-component" })[] };
export interface ForgeCommand {
  argv: readonly ForgeArgument[];
  jsonExitCodes: readonly number[];
  bindNodeId: ForgePath | undefined;
  emptyDiagnostics: readonly { exitCode: number; prefix: string; suffix: string }[];
}
export interface ForgeGuard {
  path: ForgePath;
  absent: boolean;
  binding: "headSha" | "number" | undefined;
  length: number | undefined;
}
export interface ForgeVariant {
  when: { path: ForgePath; equals: string } | undefined;
  status: ForgePath | undefined;
  completed: string | undefined;
  unfinished: readonly string[];
  value: ForgePath;
  table: Readonly<Record<string, CheckConclusion>>;
}
export interface ForgeCheckResult {
  guards: readonly ForgeGuard[];
  nullAt: ForgePath | undefined;
  rows: ForgePath;
  shape: "array" | "object";
  limit: number;
  pageComplete: ForgePath | undefined;
  required: ForgePath | undefined;
  rowGuards: readonly ForgeGuard[];
  variants: readonly ForgeVariant[];
}
export interface ForgePlan {
  commands: readonly ForgeCommand[];
  query: string | undefined;
  result: ForgeCheckResult;
}
export type ForgeProjects =
  | {
      mode: "owner-and-cross-flag";
      owner: ForgePath;
      crossProject: ForgePath;
      sourceName: ForgePath;
    }
  | { mode: "numeric-project-ids"; source: ForgePath; target: ForgePath; context: ForgePath };
export interface ForgeBatchPlan {
  mapping?: ForgeManifest["mapping"];
  numberEncoding?: "decimal-string";
  projectIdEncoding?: "global-project-id";
  projectContext?: ForgePath;
  command: ForgeCommand;
  /** Query with one ...FoomBatch insertion point; item queries each select one field. */
  query: string;
  discovery: string;
  bound: string;
  repository: ForgePath;
  defaultBranch: ForgePath;
  nodes: ForgePath;
  pageComplete: ForgePath;
  webUrl: ForgeArgument;
  sourceProject: ForgePath;
  crossProject: ForgePath;
  checks: ForgeCheckResult;
}
export interface ForgeManifest {
  kind: "forge";
  version: 1;
  id: string;
  name: string;
  badge: string;
  executables: readonly string[];
  requestLabel?: "Merge request";
  numberPrefix?: "!";
  remote: {
    hosts: readonly string[];
    namespace: "pair" | "nested";
    case: "ascii-insensitive" | "exact";
  };
  auth: {
    argv: readonly ForgeArgument[];
    successExitCodes: readonly number[];
    failureContains: readonly string[];
  };
  environment: Readonly<Record<string, string>>;
  minimumIntervalSeconds: number;
  operations: {
    lookupByBranch: { open: ForgeCommand; all: ForgeCommand };
    resolveNumber: ForgeCommand;
    refresh: ForgeCommand;
    display: ForgeCommand | undefined;
    batchStatus: ForgeBatchPlan | undefined;
  };
  mapping: {
    number: ForgePath;
    branch: ForgePath;
    headSha: ForgePath;
    mergeCommit: ForgePath | undefined;
    squashCommit?: ForgePath;
    state: ForgePath;
    states: Readonly<Record<string, ForgeState>>;
    title: ForgePath | undefined;
    webUrl: ForgePath | undefined;
    projects: ForgeProjects;
  };
  checks: {
    meaning: "required" | "head-pipeline" | "commit-status";
    primary: ForgePlan;
    fallback: ForgePlan | undefined;
  };
}
