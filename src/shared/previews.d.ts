export interface PreviewRecord {
  id: string;
  worktree: string;
  relativePath: string;
  network: false;
  agentOpened?: true;
}
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
export type PreviewPlacement = "landing" | "empty" | "sidebar";
export interface PreviewApi {
  onPlace?(callback: (id: string, expiresAt: number) => Promise<PreviewPlacement>): () => void;
  open(worktree: string, relativePath: string): Promise<string>;
  close(id: string): Promise<void>;
  bounds(id: string, bounds: PreviewBounds): Promise<void>;
}
