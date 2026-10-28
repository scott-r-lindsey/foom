import type { HostManagement, HostResult } from "./registered-hosts.d";
import type { LaunchReason } from "./launch-failure";
import type {
  RemoteAgentBinding,
  RemoteAgentSpec,
  RemoteAgentReady,
  RemoteControlResult,
} from "./remote-agent";
import type { HookSignal } from "./hooks";
import type { HostRequest, HostResponse } from "./terminal-host";
export type RemoteTarget = {
  host: string;
  artifact?: string;
  agent?: RemoteAgentBinding;
  cleanup?: true;
};
export type RemoteRequest =
  | HostManagement
  | { type: "hello"; build: string }
  | { type: "open"; request: number; id: string; cols: number; rows: number; reattach: boolean }
  | {
      type: "agent-open";
      request: number;
      id: string;
      cols: number;
      rows: number;
      spec: RemoteAgentSpec;
    }
  | { type: "agent-close"; id: string; request: number }
  | { type: "agent-start"; id: string }
  | { type: "agent-activate"; id: string }
  | { type: "agent-reply"; id: string; call: number; result: RemoteControlResult }
  | Exclude<HostRequest, { type: "create" | "shutdown" }>;
export type RemoteFragment = {
  type: "fragment";
  id: string;
  offset: number;
  total: number;
  data: string;
};
export type RemoteOpenResult = { type: "open-result"; request: number; id: string } & (
  | { state: "live" | "gone" }
  | { state: "exited"; code: number }
);
export type RemoteResponse =
  | { type: "managed"; result: HostResult }
  | { type: "agent-failed"; id: string; reason: LaunchReason }
  | { type: "hello"; build: string }
  | HostResponse
  | RemoteFragment
  | RemoteOpenResult
  | { type: "agent-prepared"; id: string }
  | { type: "agent-ready"; id: string; ready: RemoteAgentReady }
  | { type: "agent-hook"; id: string; signal: HookSignal }
  | {
      type: "agent-call";
      id: string;
      call: number;
      method: string;
      params: Record<string, unknown>;
    };
export type RemoteEnvelope = { version: 2; message: RemoteRequest | RemoteResponse };
