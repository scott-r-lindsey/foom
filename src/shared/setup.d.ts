import type { AgentId } from "./agents";
import type {
  ApiProvider,
  InferenceConfig,
  ModelList,
  ProbeResult,
  ProbeUpdate,
} from "./inference";

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
  /** How long a model gets per classification, 1–30 seconds. */
  inferenceTimeoutMs: number;
  /**
   * Which variant applies: the system's, or always light or dark. Themes will add a
   * palette per variant (for example `lightTheme`, `darkTheme`); Eclipse is the default.
   */
  colorMode: "system" | "light" | "dark";
  /** Interface zoom in percent, 80–150 in steps of 10. Terminal font size is separate. */
  interfaceScale: number;
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
  /**
   * Runs the sample check against a source, reporting each step to `onUpdate` as it
   * happens. Success lets main save that source. `id` names the check for cancelling.
   */
  checkInference(
    id: string,
    config: InferenceConfig,
    timeoutMs: number,
    onUpdate: (update: ProbeUpdate) => void,
  ): Promise<ProbeResult>;
  cancelInferenceCheck(id: string): Promise<void>;
  /** Models a local endpoint offers. */
  localModels(endpoint: string): Promise<ModelList>;
  /** Settings changed outside the renderer, for example by a zoom shortcut. */
  onSetupChange(callback: (state: SetupState) => void): () => void;
}
