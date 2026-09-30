import type { AgentId } from "./agents";
import type { ApiProvider, InferenceConfig, ModelCheck } from "./inference";

/** Everything first-run setup decides. Stored in main; the renderer holds only a copy. */
export interface Settings {
  setupComplete: boolean;
  /** Attach Foom's hooks per launch. Off means every agent uses the evaluator. */
  hooks: boolean;
  agents: Readonly<Record<AgentId, boolean>>;
  /** Default for new worktrees: Foom's folder, or next to the repository. */
  worktreeLocation: "root" | "adjacent";
  /** Only rules or a source that passed Run check is ever saved. */
  inference: InferenceConfig;
}

export type SettingsPatch = Partial<Settings>;

export interface SetupState {
  settings: Settings;
  /** Which providers have a stored key. Keys themselves never leave main. */
  keys: Readonly<Record<ApiProvider, boolean>>;
  /** False when the OS can't encrypt keys; API sources are then unavailable. */
  secureStorage: boolean;
  worktreeRoot: string;
}

export interface SetupApi {
  setupState(): Promise<SetupState>;
  saveSetup(patch: SettingsPatch): Promise<SetupState>;
  setInferenceKey(provider: ApiProvider, key: string): Promise<SetupState>;
  removeInferenceKey(provider: ApiProvider): Promise<SetupState>;
  /** Runs the sample check against a source. Success lets main save that source. */
  checkInference(config: InferenceConfig): Promise<ModelCheck>;
}
