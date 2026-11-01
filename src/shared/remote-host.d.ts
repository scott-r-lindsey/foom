import type { ImagePut, ImagePutResult } from "./image-paste.d";
import type { HostManagement, HostResult, HostRecipeLaunch } from "./registered-hosts.d";
import type { LaunchReason } from "./launch-failure";
import type {
  RemoteAgentBinding,
  RemoteAgentSpec,
  RemoteAgentReady,
  RemoteControlResult,
} from "./remote-agent";
import type { HookSignal } from "./hooks";
import type { HostRequest, HostResponse } from "./terminal-host";
/** Main/daemon metadata only; never supplied to the PTY or remote launch files. */
export interface RemoteSessionContext {
  repository: string;
  worktree: string;
  branch: string | null;
  agent: string;
}
export interface RemoteSessionInfo {
  id: string;
  context?: RemoteSessionContext;
  checkout?: { repository: string; path: string; identity: string };
}
export interface ForeignRemoteSession {
  /** Legacy daemon aggregate; ending it ends all its untagged sessions. */
  count?: number;
  id: string;
  generation: string;
}
export type RemoteInventory =
  | { type: "inventory"; profile: string; codeFolder?: string }
  | {
      type: "end-sessions";
      profile: string;
      ids: ForeignRemoteSession[];
    };
export interface RemoteInventoryResult {
  type: "inventory-result";
  own: RemoteSessionInfo[];
  foreign: ForeignRemoteSession[];
}
export type RemoteTarget = {
  recipe?: HostRecipeLaunch;
  host: string;
  artifact?: string;
  agent?: RemoteAgentBinding;
  cleanup?: true;
  profile?: string;
  context?: RemoteSessionContext;
  checkout?: { repository: string; path: string; identity: string };
  reattach?: true;
  human?: true;
  /** Main-only notification of a definitive reattach outcome. */
  unavailable?: (code: number) => void;
};
export type RemoteRequest =
  | RemoteInventory
  | ImagePut
  | HostManagement
  | { type: "hello"; build: string }
  | {
      type: "open";
      recipe?: HostRecipeLaunch;
      request: number;
      id: string;
      cols: number;
      rows: number;
      reattach: boolean;
      checkout?: { repository: string; path: string; identity: string };
      profile?: string;
      context?: RemoteSessionContext;
      human?: boolean;
    }
  | {
      type: "agent-open";
      request: number;
      id: string;
      cols: number;
      rows: number;
      spec: RemoteAgentSpec;
      profile?: string;
      context?: RemoteSessionContext;
    }
  | { type: "agent-close"; id: string; request: number }
  | { type: "session-close"; id: string; request: number; profile: string }
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
  | RemoteInventoryResult
  | { type: "upgrade"; build: string }
  | ImagePutResult
  | { type: "managed"; result: HostResult }
  | { type: "agent-failed"; id: string; reason: LaunchReason }
  | { type: "hello"; build: string; compatible?: 2 }
  | HostResponse
  | RemoteFragment
  | RemoteOpenResult
  | { type: "agent-prepared"; id: string }
  | { type: "agent-ready"; id: string; ready: RemoteAgentReady; imageOwner?: string }
  | { type: "agent-hook"; id: string; signal: HookSignal }
  | {
      type: "agent-call";
      id: string;
      call: number;
      method: string;
      params: Record<string, unknown>;
    };
export type RemoteEnvelope = { version: 3; message: RemoteRequest | RemoteResponse };
