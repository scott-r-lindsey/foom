import type { ChildInput } from "./child-input";
import type { AgentEvidence } from "./agent-detection";
import type { TerminalTheme } from "./terminal-theme";
import type { TerminalActivity, TerminalSpec, ShellState } from "./desktop";

type RequestBase = { request: number; id: string };
export type HostRequest = RequestBase &
  (
    | { type: "create"; spec: TerminalSpec; dark?: boolean; theme?: TerminalTheme }
    | { type: "theme"; dark: boolean; theme?: TerminalTheme }
    | { type: "attach"; view: string }
    | { type: "detach" | "kill" | "stop" | "shutdown" | "screen" }
    | { type: "write"; data: string }
    | { type: "child-input"; input: ChildInput }
    | { type: "resize"; cols: number; rows: number }
    | { type: "acknowledge"; token: string; count: number }
    | { type: "tail"; lines: number }
  );
export type HostResponse =
  | { type: "foreground"; id: string; name: string }
  | { type: "evidence"; id: string; evidence: AgentEvidence }
  | { type: "shell-state"; id: string; state: ShellState }
  | { type: "activity"; entries: TerminalActivity[] }
  | { type: "quiet"; id: string }
  | { type: "output"; id: string }
  | { type: "result"; request: number; id: string; lines: string[]; title?: string }
  | { type: "error"; request: number; id: string }
  | { type: "data"; id: string; view: string; token: string; data: string }
  | { type: "exit"; id: string; code: number };
