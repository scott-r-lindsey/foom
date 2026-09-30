import type { Verdict } from "./evaluator";

export type ApiProvider = "anthropic" | "openai" | "google";
export type InferenceConfig =
  | { kind: "rules" }
  | { kind: ApiProvider; model: string }
  | { kind: "local"; model: string; endpoint: string };
/** Main-only capability. Receives only a prepared prompt, never terminal metadata. */
export interface InferenceSource {
  complete(prompt: string, signal: AbortSignal): Promise<string>;
}
export interface ModelCheck {
  verdict: Verdict;
  status: "model" | "rules" | "busy" | "timeout" | "failed";
  elapsedMs: number;
}

/** One stage of Run check. Labels are written by Foom, never copied from a provider. */
export type ProbeStep =
  | "key"
  | "connect"
  | "server"
  | "model"
  | "load"
  | "request"
  | "reply"
  | "parse";
export interface ProbeEvent {
  step: ProbeStep;
  status: "running" | "ok" | "failed" | "skipped";
  label: string;
  /** Since the check started. */
  atMs: number;
  durationMs?: number;
}
export type ProbeUpdate =
  | { kind: "step"; event: ProbeEvent }
  /** The streamed reply so far and how many thinking chunks arrived. */
  | { kind: "stream"; thinking: number; reply: string };

export type ProbeFailure =
  | "refused"
  | "unreachable"
  | "dns"
  | "tls"
  | "connect-timeout"
  | "no-key"
  | "auth"
  | "model-missing"
  | "rate-limited"
  | "server-error"
  | "http"
  | "timeout"
  | "bad-reply"
  | "truncated"
  | "refusal"
  | "cancelled"
  | "failed";

export interface ProbeResult {
  ok: boolean;
  failure?: ProbeFailure;
  /** Foom's own one-line summary. */
  message: string;
  verdict?: Verdict;
  timings: { connectMs?: number; firstTokenMs?: number; totalMs: number };
  /** Exactly what was sent, minus credentials. The prompt holds only the fixed sample. */
  request: { url: string; model: string; parameters: Record<string, unknown>; prompt: string };
  /** The model's raw reply to the sample, shown as text, bounded. */
  reply: string;
  thinking: number;
}

export type ModelList =
  | { ok: true; models: readonly string[]; server: string | null }
  | { ok: false; failure: ProbeFailure; message: string };
