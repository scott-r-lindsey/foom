import type { ThemeCatalog } from "../../shared/theme-file";
import { hasBypassArgument } from "../agents/default-arguments";
import type { AgentId } from "../../shared/agents";
import { isRecent, scanCodeFolder, suggestCodeFolders } from "./code-scan";
import { parseSettingsPatch } from "./settings";
import type { SettingsStore } from "./settings";
import type {
  CodeScan,
  CodeSuggestion,
  RepositoryUpdate,
  ScanProgress,
  Settings,
  SettingsPatch,
  SetupState,
} from "../../shared/setup";
import type { WorktreeService } from "../workspace/worktrees";

export interface SetupDependencies {
  themes?: () => ThemeCatalog;
  store: Pick<SettingsStore, "get" | "update">;
  worktreeRoot: string;
  /** Pushes hook and agent settings into the running services. */
  apply(settings: Settings): void;
  confirmBypass?: (agent: AgentId) => Promise<boolean>;
  code: {
    worktrees: Pick<WorktreeService, "listRepositories" | "addRepository" | "removeRepository">;
    /** The native folder picker; null when cancelled. */
    pickFolder(): Promise<string | null>;
    home: string;
    scan?: typeof scanCodeFolder;
    now?: () => number;
  };
}

/** How far the quick scan behind a suggestion's count looks. */
const QUICK_SCAN_FOLDERS = 5000;

export class Setup {
  private saving: Promise<unknown> = Promise.resolve();
  private suggested: readonly string[] = [];
  /** Paths from the latest scan: the only ones the renderer may add or remove. */
  private scanned = new Set<string>();

  constructor(private readonly deps: SetupDependencies) {
    deps.apply(deps.store.get());
  }

  state(): Promise<SetupState> {
    return Promise.resolve({
      ...(this.deps.themes ? { themes: this.deps.themes() } : {}),
      settings: this.deps.store.get(),
      worktreeRoot: this.deps.worktreeRoot,
    });
  }

  async save(value: unknown): Promise<SetupState> {
    const patch = parseSettingsPatch(value);
    if (patch.agentBypassAcknowledged !== undefined)
      throw new Error("Bypass acknowledgement belongs to Foom's confirmation dialog.");
    const saving = this.saving.catch(() => undefined).then(() => this.savePatch(patch));
    this.saving = saving;
    return saving;
  }

  private async savePatch(patch: SettingsPatch): Promise<SetupState> {
    // Choosing System/Light/Dark explicitly returns to Eclipse. Size-only edits keep the theme.
    if (patch.colorMode !== undefined && patch.interfaceTheme === undefined)
      patch.interfaceTheme = "follow";
    const before = this.deps.store.get();
    if (patch.agentArguments) {
      const acknowledged = { ...before.agentBypassAcknowledged };
      for (const agent of ["claude", "codex", "agy"] as const) {
        if (hasBypassArgument(agent, patch.agentArguments[agent]) && !acknowledged[agent]) {
          if (!(await this.deps.confirmBypass?.(agent)))
            throw new Error("Default arguments were not saved. Bypass disclosure was cancelled.");
          acknowledged[agent] = true;
        }
      }
      patch.agentBypassAcknowledged = acknowledged;
    }
    const settings = await this.deps.store.update(patch);
    this.deps.apply(settings);
    return this.state();
  }

  /**
   * Common code folders that hold repositories, each with a count from a quick scan
   * (the same scan, stopped sooner). Folders without any aren't suggested.
   */
  async codeSuggestions(): Promise<readonly CodeSuggestion[]> {
    const folders = await suggestCodeFolders(this.deps.code.home);
    const scan = this.deps.code.scan ?? scanCodeFolder;
    const found = await Promise.all(
      folders.map((path) =>
        scan(path, { exclude: [this.deps.worktreeRoot], maxFolders: QUICK_SCAN_FOLDERS }).then(
          (result) => ({
            path,
            repositories: result.repositories.length,
            more: result.truncated,
          }),
          () => ({ path, repositories: 0, more: false }),
        ),
      ),
    );
    const suggestions = found.filter((suggestion) => suggestion.repositories > 0);
    this.suggested = suggestions.map((suggestion) => suggestion.path);
    return suggestions;
  }

  /**
   * Scans a suggested folder, the saved one, or (for null) one the user picks. The
   * folder is saved, and its repositories become the only paths `applyRepositories`
   * accepts.
   */
  async scanCode(
    folder: unknown,
    onProgress: (progress: ScanProgress) => void,
  ): Promise<CodeScan | null> {
    let target: string;
    if (folder === null) {
      const picked = await this.deps.code.pickFolder();
      if (picked === null) return null;
      target = picked;
    } else if (
      typeof folder === "string" &&
      (this.suggested.includes(folder) || folder === this.deps.store.get().codeFolder)
    )
      target = folder;
    else throw new Error("Unknown code folder");
    const scan = await (this.deps.code.scan ?? scanCodeFolder)(target, {
      exclude: [this.deps.worktreeRoot],
      onProgress,
    });
    await this.save({ codeFolder: scan.folder });
    this.scanned = new Set(scan.repositories.map((repository) => repository.path));
    const added = new Set(this.deps.code.worktrees.listRepositories().map((entry) => entry.path));
    const now = (this.deps.code.now ?? Date.now)();
    return {
      folder: scan.folder,
      folders: scan.folders,
      truncated: scan.truncated,
      repositories: scan.repositories.map((repository) => ({
        ...repository,
        recent: isRecent(repository.lastActive, now),
        added: added.has(repository.path),
      })),
    };
  }

  /** Adds and removes scanned repositories so that exactly `selected` are added. */
  async applyRepositories(selected: unknown): Promise<RepositoryUpdate> {
    if (
      !Array.isArray(selected) ||
      !selected.every((path): path is string => typeof path === "string" && this.scanned.has(path))
    )
      throw new Error("Choose repositories from the latest scan");
    const wanted = new Set<string>(selected);
    const { worktrees } = this.deps.code;
    const added = new Set(worktrees.listRepositories().map((entry) => entry.path));
    const failures: { path: string; message: string }[] = [];
    for (const path of this.scanned) {
      try {
        if (wanted.has(path) && !added.has(path)) await worktrees.addRepository(path);
        else if (!wanted.has(path) && added.has(path)) await worktrees.removeRepository(path);
      } catch (error) {
        failures.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { repositories: worktrees.listRepositories(), failures };
  }
}
