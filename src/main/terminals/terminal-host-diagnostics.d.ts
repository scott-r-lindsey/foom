export interface HostExitDiagnostic {
  reason: string;
  serviceName: string;
  pid?: number | undefined;
  exitCode?: number;
  gone?: { type: string; reason: string; exitCode: number };
}
