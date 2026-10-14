export interface PreviewRecord {
  id: string;
  worktree: string;
  relativePath: string;
  network: false;
}
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
export interface PreviewSnapshot {
  id: string;
  bounds: PreviewBounds;
  image: string;
}
export interface PreviewApi {
  open(worktree: string, relativePath: string): Promise<string>;
  close(id: string): Promise<void>;
  bounds(id: string, bounds: PreviewBounds): Promise<void>;
  cover(covered: boolean): Promise<void>;
  onSnapshots(callback: (snapshots: readonly PreviewSnapshot[]) => void): () => void;
}
