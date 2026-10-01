import type {
  ApiProvider,
  InferenceConfig,
  ModelList,
  ProbeResult,
  ProbeUpdate,
} from "../../shared/inference";
import type {
  CodeScan,
  CodeSuggestion,
  RepositoryUpdate,
  ScanProgress,
  SettingsPatch,
  SetupState,
} from "../../shared/setup";
import type { AgentReport } from "../../shared/workspace";
import type { Repository } from "../../shared/worktrees";

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
  suggestions(): Promise<readonly CodeSuggestion[]>;
  /** Null picks a folder with the native picker; resolves null if cancelled. */
  scan(
    id: string,
    folder: string | null,
    onProgress: (progress: ScanProgress) => void,
  ): Promise<CodeScan | null>;
  apply(selected: readonly string[]): Promise<RepositoryUpdate>;
  /** Settings changed in main, for example by a zoom shortcut. */
  subscribe(listener: (state: SetupState) => void): () => void;
}
