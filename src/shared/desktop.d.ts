export interface DesktopApi {
  start(cols: number, rows: number): Promise<string>;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  acknowledge(count: number): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (code: number) => void): () => void;
}
