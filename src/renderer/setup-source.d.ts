import type {
  ApiProvider,
  InferenceConfig,
  ModelList,
  ProbeResult,
  ProbeUpdate,
} from "../shared/inference";
import type { SettingsPatch, SetupState } from "../shared/setup";
import type { AgentReport } from "../shared/workspace";
import type { Repository } from "../shared/worktrees";

/** What preflight needs from main. Components use this, never the bridge directly. */
export interface SetupSource {
  state(): Promise<SetupState>;
  save(patch: SettingsPatch): Promise<SetupState>;
  setKey(provider: ApiProvider, key: string): Promise<SetupState>;
  removeKey(provider: ApiProvider): Promise<SetupState>;
  check(
    id: string,
    config: InferenceConfig,
    timeoutMs: number,
    onUpdate: (update: ProbeUpdate) => void,
  ): Promise<ProbeResult>;
  cancel(id: string): Promise<void>;
  models(endpoint: string): Promise<ModelList>;
  scanAgents(refresh: boolean): Promise<AgentReport>;
  repositories(): Promise<readonly Repository[]>;
  /** Main shows the folder picker; null when the user cancels. */
  addRepository(): Promise<Repository | null>;
}
