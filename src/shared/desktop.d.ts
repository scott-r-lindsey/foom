import type { AppMenuApi } from "./app-menu";
import type { AgentEvidence } from "./agent-detection";
import type { BoardCommand } from "./board-command";
export interface TerminalActivity {
  id: string;
  rate: number;
}
export type ShellState = { phase: "running" } | { phase: "prompt"; exitCode: number };
export interface TerminalTelemetry {
  onEvidence?(id: string, evidence: AgentEvidence): void;
  onShellState?(id: string, state: ShellState): void;
  onOutput?(id: string): void;
  onActivity?(batch: TerminalActivity[]): void;
  onQuiet?(id: string): void;
}
export interface TerminalSpec {
  /** Main-selected ID when replacing an exited session. Never accepted from renderer launch data. */
  id?: string;
  /** Main opts interactive shells into invocation-scoped lifecycle integration. */
  shellIntegration?: boolean;
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
  readonly isDevelopment: boolean;
  readonly appMenu: AppMenuApi;
  create(cols: number, rows: number): Promise<{ id: string; title: string }>;
  attach(id: string): Promise<void>;
  detach(id: string): Promise<void>;
  kill(id: string): Promise<void>;
  input(id: string, data: string, origin?: "wheel"): void;
  resize(id: string, cols: number, rows: number): void;
  acknowledge(id: string, token: string, count: number): void;
  tail(id: string, lines: number): Promise<string[]>;
  onBoardCommand(callback: (command: BoardCommand) => void): () => void;
  onActivity(callback: (batch: TerminalActivity[]) => void): () => void;
  onData(callback: (id: string, token: string, data: string) => void): () => void;
  onTerminalAvailability(
    callback: (id: string, available: boolean, reset?: boolean) => void,
  ): () => void;
  onExit(callback: (id: string, code: number) => void): () => void;
}
