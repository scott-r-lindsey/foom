import type { ApiProvider } from "../../shared/inference";

export interface ProbeDependencies {
  readKey(provider: ApiProvider): Promise<string>;
  request?: typeof fetch;
  /** Opens and closes a TCP connection, so "refused" shows up before any request. */
  connect?: (host: string, port: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface StreamDelta {
  text?: string;
  thinking?: boolean;
  finish?: "stop" | "length" | "refusal";
  error?: boolean;
}
