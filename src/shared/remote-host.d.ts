import type { HostRequest, HostResponse } from "./terminal-host";
export type RemoteTarget = { host: string; artifact: string };
export type RemoteRequest =
  | { type: "hello"; build: string }
  | { type: "open"; request: number; id: string; cols: number; rows: number }
  | Exclude<HostRequest, { type: "create" | "shutdown" | "child-input" }>;
export type RemoteResponse = { type: "hello"; build: string } | HostResponse;
export type RemoteEnvelope = { version: 1; message: RemoteRequest | RemoteResponse };
