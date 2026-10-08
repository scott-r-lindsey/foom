export interface WindowAudioState {
  enabled: boolean;
  focusedId: string | null;
}
export interface WindowView {
  id: string;
  window: number;
}
export interface WindowsApi {
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
