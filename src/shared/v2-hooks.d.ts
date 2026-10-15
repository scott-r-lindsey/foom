import type { AgentManifestV2, ManifestChannel } from "./agent-manifest-v2";
import type { HookSignal } from "./hooks";
import type { HookHealthState } from "./agents";
export interface V2HookState {
  launchFacts?: Readonly<Record<string, unknown>>;
  conversation?: string;
  channels?: Map<string, { sequence?: number; completed?: Set<string> }>;
}
export interface V2HookRuntime {
  readonly model: AgentManifestV2;
  readonly health: { get(): HookHealthState; flush(): Promise<void> };
  required(): boolean;
  accept(signal: HookSignal, turn: number): boolean;
  idle(turn: number): void;
  review(tail: readonly string[]): void;
}
export interface V2Binding {
  values: Record<string, string | string[] | number>;
  channels: Map<string, ManifestChannel>;
  state: V2HookState;
  runtime?: V2HookRuntime;
}
