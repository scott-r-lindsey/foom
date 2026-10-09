/** Local, bounded facts; null means unavailable rather than a guessed value. */
export interface GitPanelFacts {
  changes: number | null;
  upstream: { ahead: number; behind: number } | null;
  commit: { hash: string; subject: string; timestamp: number } | null;
  remote: string | null;
  defaultBranch: string | null;
  lastFetch: number | null;
  fetchFailed: boolean;
  merged: boolean | null;
}
export interface HomeShellFacts {
  directory: string;
  path: string;
  version: string | null;
}
