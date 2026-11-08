export interface HostSnapshot {
  liveTerminals: number;
  hostMemoryKB: number | null;
  lastMessageAgeMs: number;
  mainLagMs: number;
}
export interface HostNearMiss {
  kind: "late-reply" | "late-drain" | "late-turn";
  replyLatencyMs: number | null;
  probeElapsedMs: number;
  lateCycles: number;
  mainLagMs: number;
}
export interface HostExitDiagnostic {
  cause?: "watchdog-kill" | "foom-kill" | "host-exit";
  snapshot?: HostSnapshot;
  reason: string;
  serviceName: string;
  pid?: number | undefined;
  exitCode?: number;
  gone?: { type: string; reason: string; exitCode: number };
}
