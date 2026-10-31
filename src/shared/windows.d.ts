export type MoveContent = { kind: "terminal" | "preview"; id: string };
export type MovePlacement = {
  tile: string;
  zone: "center" | "left" | "right" | "up" | "down";
} | null;
export interface WindowDestination {
  id: number;
  label: string;
}
export interface WindowMovesApi {
  list(): Promise<WindowDestination[]>;
  beginDrag(content: MoveContent): Promise<string>;
  endDrag(token: string): Promise<void>;
  drop(token: string, placement: MovePlacement): Promise<void>;
  move(content: MoveContent, target: number): Promise<void>;
  ready(request: string, accepted: boolean): Promise<void>;
  onDrag(callback: (token: string | null) => void): () => void;
  onPrepare(callback: (request: string, placement: MovePlacement) => void): () => void;
  onFinish(callback: (request: string, content: MoveContent | null) => void): () => void;
}
export interface WindowAudioState {
  enabled: boolean;
  focusedId: string | null;
}
export interface WindowView {
  id: string;
  window: number;
}
export interface WindowsApi {
  moves?: WindowMovesApi;
  audio?: {
    state(): Promise<WindowAudioState>;
    focus(id: string | null): Promise<void>;
    refuse(): Promise<void>;
    onChanged(callback: (state: WindowAudioState) => void): () => void;
    onRefuse(callback: () => void): () => void;
  };
  readonly id: string;
  readonly number: number;
  readonly initialSession: string | undefined;
  sync(ids: string[]): Promise<string[]>;
  select(id: string): Promise<boolean>;
  popout(id: string): Promise<void>;
  snapshot(): Promise<WindowView[]>;
  onChanged(callback: (views: WindowView[]) => void): () => void;
  onRemoved(callback: (id: string) => void): () => void;
}
