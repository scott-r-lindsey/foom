export type CaptureState = "working" | "blocked" | "idle" | "other";
export interface ProbeCapture {
  version: 1;
  agentId: string;
  agentVersion: string;
  expected: CaptureState;
  lines: string[];
  title: string;
  cols: number;
  rows: number;
}
export interface CaptureResult {
  file: string;
  expected: CaptureState;
  actual: CaptureState;
  ruleId: string | null;
  passed: boolean;
}
export interface CaptureReport {
  agentId: string;
  captures: CaptureResult[];
  passed: boolean;
}
