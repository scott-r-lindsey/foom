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
import type { SetupApi } from "./setup";
import type { WorkspaceApi } from "./workspace";

export interface DesktopApi extends WorkspaceApi, SetupApi {
  create(cols: number, rows: number): Promise<{ id: string; title: string }>;
  attach(id: string): Promise<void>;
  detach(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  input(id: string, data: string, origin?: "wheel"): void;
  resize(id: string, cols: number, rows: number): void;
  acknowledge(id: string, token: string, count: number): void;
  tail(id: string, lines: number): Promise<string[]>;
  onBoardCommand(callback: (command: "sidebar" | "next-waiting" | "settings") => void): () => void;
  onActivity(callback: (batch: TerminalActivity[]) => void): () => void;
  onData(callback: (id: string, token: string, data: string) => void): () => void;
  onExit(callback: (id: string, code: number) => void): () => void;
}
