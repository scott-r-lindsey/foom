import type { HostRequest, HostResponse } from "./terminal-host";
export type RemoteTarget = { host: string; artifact: string };
export type RemoteRequest =
  | { type: "hello"; build: string }
  | { type: "open"; request: number; id: string; cols: number; rows: number; reattach: boolean }
  | Exclude<HostRequest, { type: "create" | "shutdown" | "child-input" }>;
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
  | { type: "hello"; build: string }
  | HostResponse
  | RemoteFragment
  | RemoteOpenResult;
export type RemoteEnvelope = { version: 1; message: RemoteRequest | RemoteResponse };
