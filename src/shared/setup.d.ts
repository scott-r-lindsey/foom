import type { ThemeCatalog, ThemeKind } from "./theme-file";
import type { InterfaceThemeChoice } from "./interface-theme";
import type { SoundSettings } from "./sound";
import type { TerminalThemeChoice } from "./terminal-theme";
import type { AgentId } from "./agents";
import type { Repository } from "./worktrees";
/** Everything first-run setup decides. Stored in main; the renderer holds only a copy. */
export interface Settings {
  setupComplete: boolean;
  codexNotifierAcknowledged: boolean;
  /** Attach Foom's hooks per launch. Off means every agent uses the evaluator. */
  hooks: boolean;
  agents: Readonly<Record<AgentId, boolean>>;
  agentArguments: Readonly<Record<AgentId, readonly string[]>>;
  /** Main-owned acknowledgement; renderer save requests may not set this. */
  agentBypassAcknowledged: Readonly<Record<AgentId, boolean>>;
  /** Default for new worktrees: Foom's folder, or next to the repository. */
  worktreeLocation: "root" | "adjacent";
  /** Eclipse variant when interfaceTheme is Follow; fixed themes supply their own base. */
  panelColor: "vivid" | "subtle" | "plain";
  colorMode: "system" | "light" | "dark";
  /** A built-in or complete validated color palette; Follow preserves the legacy mode. */
  interfaceTheme: InterfaceThemeChoice;
  /** Interface zoom in percent, 80–150 in steps of 10. Terminal font size is separate. */
  interfaceScale: number;
  /** Terminal text size in CSS pixels, 10–32 in whole pixels. */
  terminalFontSize: number;
  terminalTheme: TerminalThemeChoice;
  sound: SoundSettings;
  /** Where the user keeps their code; preflight scans it for repositories. */
  codeFolder: string | null;
}

/** A repository found in the code folder. */
export interface FoundRepository {
  path: string;
  name: string;
  /** Path relative to the code folder, for display. */
  relative: string;
  branch: string | null;
  /** Latest git activity (ms since epoch), from reflog, index and HEAD file times. */
  lastActive: number | null;
  /** Active within the last 30 days. */
  recent: boolean;
  /** Already added to Foom. */
  added: boolean;
}

export interface CodeScan {
  folder: string;
  repositories: readonly FoundRepository[];
  /** Folders looked at. */
  folders: number;
  /** The scan stopped at its folder limit before finishing. */
  truncated: boolean;
}

/** A common code folder that exists, with how many repositories a quick look found. */
export interface CodeSuggestion {
  path: string;
  repositories: number;
  /** The quick look stopped at its limit; there may be more. */
  more: boolean;
}

export interface ScanProgress {
  folders: number;
  repositories: number;
}

/** After applying a selection: what's added now, and anything refused. */
export interface RepositoryUpdate {
  repositories: readonly Repository[];
  failures: readonly { path: string; message: string }[];
}

export type SettingsPatch = Partial<Settings>;

export interface SetupState {
  themes?: ThemeCatalog;
  settings: Settings;
  worktreeRoot: string;
}

export interface SetupApi {
  listThemes(): Promise<ThemeCatalog>;
  openThemesFolder(kind: ThemeKind): Promise<void>;
  setupState(): Promise<SetupState>;
  saveSetup(patch: SettingsPatch): Promise<SetupState>;
  /** Persisted settings after a save or a main-process zoom shortcut. */
  onSetupChange(callback: (state: SetupState) => void): () => void;
  /** Common code folders under the home folder, such as ~/code, that hold repositories. */
  codeSuggestions(): Promise<readonly CodeSuggestion[]>;
  /**
   * Scans a code folder. `folder` must be a suggestion or the saved code folder; null
   * shows the folder picker. Resolves null if the picker is cancelled.
   */
  scanCode(
    id: string,
    folder: string | null,
    onProgress: (progress: ScanProgress) => void,
  ): Promise<CodeScan | null>;
  /**
   * Makes the added repositories among the last scan's results exactly `selected`.
   * Paths must come from that scan.
   */
  applyRepositories(selected: readonly string[]): Promise<RepositoryUpdate>;
}
