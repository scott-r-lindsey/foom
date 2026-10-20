import type { LoadedForgeManifest } from "../config/plugins";
import type { ForgeRemote } from "./forge.d";

export type ForgeExecutionState =
  | "ready"
  | "unavailable"
  | "unauthenticated"
  | "cancelled"
  | "timeout";
export interface ForgeSampleContext {
  /** Main-owned canonical worktree identity, including branch/remote generation. */
  identity: string;
  /** Reinspect registration, remote, worktree identity and branch. Never supplied by IPC. */
  validate(branches?: readonly string[]): Promise<void>;
}
export interface ForgeLifecycleOptions {
  /** Already discovered login PATH; relative/empty components are ignored. */
  path: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cacheMs?: number;
}
export interface ForgeSelection {
  plugin: LoadedForgeManifest;
  remote: ForgeRemote;
  context: ForgeSampleContext;
  defaultBranch?: string;
  signal?: AbortSignal;
}
