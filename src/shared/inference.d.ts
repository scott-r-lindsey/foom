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
