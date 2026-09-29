export interface TerminalActivity {
  id: string;
  rate: number;
}
export interface TerminalTelemetry {
  onActivity?(batch: TerminalActivity[]): void;
  onQuiet?(id: string): void;
}
export interface TerminalSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Readonly<Record<string, string>>;
}
export interface DesktopApi {
  create(cols: number, rows: number): Promise<{ id: string; title: string }>;
  attach(id: string): Promise<void>;
  detach(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  acknowledge(id: string, token: string, count: number): void;
  tail(id: string, lines: number): Promise<string[]>;
  onActivity(callback: (batch: TerminalActivity[]) => void): () => void;
  onData(callback: (id: string, token: string, data: string) => void): () => void;
  onExit(callback: (id: string, code: number) => void): () => void;
}
