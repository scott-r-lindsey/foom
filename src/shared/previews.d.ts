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
export interface PreviewApi {
  open(worktree: string, relativePath: string): Promise<string>;
  close(id: string): Promise<void>;
  bounds(id: string, bounds: PreviewBounds): Promise<void>;
}
