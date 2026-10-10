import type { ThemeKind } from "../../shared/theme-file";
import type { EnvironmentApi } from "../../shared/environment";
import type { AgyPluginAction } from "../../shared/agy-plugin";
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
  openThemesFolder(kind: ThemeKind): Promise<void>;
  state(): Promise<SetupState>;
  save(patch: SettingsPatch): Promise<SetupState>;
  scanAgents(refresh: boolean): Promise<AgentReport>;
  changeAgyPlugin(action: AgyPluginAction): Promise<AgentReport>;
  repositories(): Promise<readonly Repository[]>;
  suggestions(): Promise<readonly CodeSuggestion[]>;
  /** Null picks a folder with the native picker; resolves null if cancelled. */
  scan(
    id: string,
    folder: string | null,
    onProgress: (progress: ScanProgress) => void,
  ): Promise<CodeScan | null>;
  apply(selected: readonly string[]): Promise<RepositoryUpdate>;
  /** Settings → Environment; absent where main offers none, such as sample boards. */
  environment?: EnvironmentApi;
  /** Settings changed in main, for example by a zoom shortcut. */
  subscribe(listener: (state: SetupState) => void): () => void;
}
