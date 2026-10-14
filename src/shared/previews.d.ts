export interface PreviewRecord {
  id: string;
  worktree: string;
  relativePath: string;
  network: boolean;
  agentOpened?: true;
  openedBy?: { terminalId: string; agent: string };
}
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
export type PreviewPlacement = "landing" | "empty" | "column" | "replace" | "existing" | "sidebar";
export interface PreviewSnapshot {
  id: string;
  bounds: PreviewBounds;
  image: string;
}
export interface PreviewApi {
  onPlace?(callback: (id: string, expiresAt: number) => Promise<PreviewPlacement>): () => void;
  pick(worktree: string): Promise<string | null>;
  network(id: string, enabled: boolean): Promise<void>;
  close(id: string): Promise<void>;
  bounds(id: string, bounds: PreviewBounds): Promise<void>;
  cover(covered: boolean): Promise<void>;
  onSnapshots(callback: (snapshots: readonly PreviewSnapshot[]) => void): () => void;
}

export interface PreviewOpenAction {
  id: string;
  terminalId: string;
  path: string;
  at: number;
}
