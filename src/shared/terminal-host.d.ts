import type { TerminalActivity, TerminalSpec } from "./desktop";

type RequestBase = { request: number; id: string };
export type HostRequest = RequestBase &
  (
    | { type: "create"; spec: TerminalSpec; dark?: boolean }
    | { type: "theme"; dark: boolean }
    | { type: "attach"; view: string }
    | { type: "detach" | "kill" | "stop" | "shutdown" }
    | { type: "write"; data: string }
    | { type: "resize"; cols: number; rows: number }
    | { type: "acknowledge"; token: string; count: number }
    | { type: "tail"; lines: number }
  );
export type HostResponse =
  | { type: "activity"; entries: TerminalActivity[] }
  | { type: "quiet"; id: string }
  | { type: "output"; id: string }
  | { type: "result"; request: number; id: string; lines: string[] }
  | { type: "error"; request: number; id: string }
  | { type: "data"; id: string; view: string; token: string; data: string }
  | { type: "exit"; id: string; code: number };
