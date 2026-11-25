import type { GithubSignInState } from "../../shared/registered-hosts.d";
import { viewChanges } from "../data/view-changes";
import type { WorkspaceTerminal } from "../../shared/workspace";
import { hostsAction } from "../../shared/registered-hosts";
import type { RemoteTarget } from "../../shared/remote-host";
import type { DialogContent, DialogOutcome, PlainDialogContent } from "../../shared/confirmation";
import type { RepositoryRequirementsStore } from "./repository-requirements";
import type { Hosts } from "./hosts";
import type { UpdateState } from "../../shared/updates";
import type { ReadinessReport } from "../../shared/readiness";
import { ApplicationError } from "../../shared/application-errors";
import { isUserThemeId } from "../../shared/theme-validation";
import type { ThemeCatalog } from "../../shared/theme-file";
import { checkPermissionConflicts } from "../../shared/agent-permission-arguments";
import { agentProviders } from "../agents/providers/registry";
import { bypassConsentIdentity, hasBypassArgument } from "../agents/default-arguments";
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

export { repositoryRequirementsForProfile } from "./repository-requirements";

export interface SetupDependencies {
  githubSignIn?: (id: unknown, action: unknown) => Promise<GithubSignInState>;
  hosts?: Hosts;
  repositoryRequirements?: RepositoryRequirementsStore;
  hostsChanged?: () => void;
  hostSessions?: () => readonly WorkspaceTerminal[];
  localAgentInstall?: (
    id: unknown,
  ) => Promise<{ available: readonly string[]; recipeSession?: string }>;
  launchHostRecipe?: (target: RemoteTarget, finished?: () => void) => Promise<unknown>;
  launchHostSetupAgent?: Parameters<Hosts["startSetupAgent"]>[1];
  placeHostSetupAgent?: (id: string, background: boolean) => void;
  copyText?: (value: string) => void | Promise<void>;
  confirmHostKey?: (content: PlainDialogContent, signal: AbortSignal) => Promise<DialogOutcome>;
  confirmRemoteSessions?: (content: DialogContent, signal?: AbortSignal) => Promise<boolean>;
  updates?: () => UpdateState;
  restartToUpdate?: () => Promise<void>;
  gitReadiness?: () => Promise<ReadinessReport>;
  readiness?: () => Promise<ReadinessReport>;
  themes?: () => ThemeCatalog;
  /** IDs from the validated main-owned catalog, never manifest host declarations. */
  forgeIds?: () => readonly string[];
  store: Pick<SettingsStore, "get" | "update">;
  worktreeRoot: string;
  /** Pushes hook and agent settings into the running services. */
  apply(settings: Settings): void;
  confirmBypass?: (
    agent: AgentId,
    args: readonly string[],
    permissionScope?: string,
  ) => Promise<boolean>;
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

interface ReadinessCache {
  revision: number;
  repositoriesRevision: number;
  report: Promise<ReadinessReport>;
}
interface ReadinessOwner {
  cache: ReadinessCache | undefined;
}
// All windows using one profile store share the same probe and published result.
const readinessOwners = new WeakMap<SetupDependencies["store"], ReadinessOwner>();

export class Setup {
  private saving: Promise<unknown> = Promise.resolve();
  private suggested: readonly string[] = [];
  /** Paths from the latest scan: the only ones the renderer may add or remove. */
  private scanned = new Set<string>();

  private readonly readinessOwner: ReadinessOwner;
  constructor(private readonly deps: SetupDependencies) {
    this.readinessOwner = readinessOwners.get(deps.store) ?? { cache: undefined };
    readinessOwners.set(deps.store, this.readinessOwner);
    deps.apply(deps.store.get());
  }

  /** Re-applies stored settings, for example after a validated config file change. */
  refresh(): void {
    this.deps.apply(this.deps.store.get());
  }

  localAgentInstall(id: unknown) {
    if (!this.deps.localAgentInstall) throw new Error("Installer unavailable");
    return this.deps.localAgentInstall(id);
  }
  repositoryRequirements(input: unknown) {
    if (!this.deps.repositoryRequirements) throw new Error("Host requirements unavailable");
    return this.deps.repositoryRequirements.settings(input);
  }
  async copyHost(input: unknown): Promise<void> {
    if (!this.deps.hosts || !this.deps.copyText) throw new Error("Copy unavailable");
    await this.deps.copyText(this.deps.hosts.copyValue(input));
  }
  githubSignIn(id: unknown, action: unknown) {
    if (!this.deps.githubSignIn) throw new Error("Sign-in unavailable");
    return this.deps.githubSignIn(id, action);
  }
  private hostTrust = new AbortController();
  cancelHostTrust(): void {
    this.hostTrust.abort();
    this.hostTrust = new AbortController();
  }
  async hosts(input: unknown) {
    if (!hostsAction(input)) throw new Error("Invalid host action");
    if (input.action === "cancel-trust") this.cancelHostTrust();
    if (!this.deps.hosts) throw new Error("Hosts unavailable");
    if (input.action === "setup-agent") {
      if (!this.deps.launchHostSetupAgent) throw new Error("Setup agent unavailable");
      const id = await this.deps.hosts.startSetupAgent(
        input,
        this.deps.launchHostSetupAgent,
        this.hostTrust.signal,
      );
      this.deps.placeHostSetupAgent?.(id, true);
      return this.deps.hosts.state();
    }
    if (input.action === "show-setup-agent") {
      const id = this.deps.hosts.setupAgentId(input.host);
      if (id === input.id) this.deps.placeHostSetupAgent?.(id, false);
      return this.deps.hosts.state();
    }
    if (input.action === "remove") {
      const sessions = () =>
        (this.deps.hostSessions?.() ?? []).filter(
          (row) =>
            row.placement?.kind === "remote" &&
            row.placement.host === input.host &&
            (row.exited || row.dormant) &&
            !row.closeState,
        );
      const rows = sessions();
      if (rows.length) {
        if (
          !(await this.deps.confirmRemoteSessions?.({
            title: "Remove host and forget sessions?",
            accept: "Remove and forget",
            subject: input.host,
            detail:
              "Forgets these saved sessions on this computer. No request is sent to the host; remote processes may still be running. Worktrees and files are kept.",
            sessions: rows.map((row) => ({
              id: row.id,
              name: row.agent,
              location: row.worktree,
              state: "dormant",
            })),
          }))
        )
          return this.deps.hosts.state();
        const current = sessions();
        if (
          current.length !== rows.length ||
          current.some(
            (row) =>
              !rows.some(
                (approved) =>
                  approved.id === row.id && approved.launchVersion === row.launchVersion,
              ),
          )
        )
          throw new Error("Host sessions changed");
      }
    }
    return this.deps.hosts
      .action(
        input,
        this.deps.confirmRemoteSessions,
        this.deps.launchHostRecipe,
        this.hostTrust.signal,
        this.deps.confirmHostKey,
      )
      .then((state) => {
        if (state.preflightSaveFailed) return state;
        if (input.action === "rename") this.refresh();
        if (!["progress", "cancel-trust", "list", "reload"].includes(input.action))
          this.deps.hostsChanged?.();
        return state;
      });
  }

  readinessView(): Promise<ReadinessReport> {
    const cache = this.readinessOwner.cache;
    return cache?.revision === viewChanges.current("readiness") &&
      cache.repositoriesRevision === viewChanges.current("repositories")
      ? cache.report
      : this.readiness();
  }
  readiness() {
    if (!this.deps.readiness) throw new Error("Readiness unavailable");
    const owner = this.readinessOwner;
    const cache: ReadinessCache = {
      revision: viewChanges.current("readiness"),
      repositoriesRevision: viewChanges.current("repositories"),
      report: this.deps
        .readiness()
        .then((report) => {
          if (
            owner.cache === cache &&
            (cache.revision !== viewChanges.current("readiness") ||
              cache.repositoriesRevision !== viewChanges.current("repositories"))
          )
            owner.cache = undefined;
          if (owner.cache === cache) {
            viewChanges.publish("readiness");
            cache.revision = viewChanges.current("readiness");
          }
          return report;
        })
        .catch((error: unknown) => {
          if (owner.cache === cache) owner.cache = undefined;
          throw error;
        }),
    };
    owner.cache = cache;
    return cache.report;
  }

  restartToUpdate(): Promise<void> {
    return this.deps.restartToUpdate?.() ?? Promise.resolve();
  }

  state(): Promise<SetupState> {
    return Promise.resolve({
      ...(this.deps.themes ? { themes: this.deps.themes() } : {}),
      ...(this.deps.updates ? { updates: this.deps.updates() } : {}),
      settings: this.deps.store.get(),
      worktreeRoot: this.deps.worktreeRoot,
    });
  }

  async save(value: unknown, themeDigest?: unknown): Promise<SetupState> {
    const patch = parseSettingsPatch(value);
    if (
      patch.registeredHosts !== undefined ||
      patch.agentBypassAcknowledged !== undefined ||
      patch.agentBypassIdentities !== undefined
    )
      throw new Error("Bypass acknowledgement belongs to Foom's confirmation dialog.");
    if (patch.agentPermissions) {
      const edits = Object.values(patch.agentPermissions);
      if (
        Object.keys(patch).length !== 1 ||
        edits.length !== 1 ||
        Object.values(edits[0] ?? {}).length !== 1 ||
        Object.values(edits[0] ?? {}).some((choice) => choice?.identity !== undefined)
      )
        throw new Error("Choose one agent permission level in Settings.");
    }
    const saving = this.saving
      .catch(() => undefined)
      .then(() => this.savePatch(patch, themeDigest));
    this.saving = saving;
    return saving;
  }

  private async savePatch(patch: SettingsPatch, themeDigest: unknown): Promise<SetupState> {
    const before = this.deps.store.get();
    if (isUserThemeId(patch.interfaceTheme) && patch.interfaceTheme !== before.interfaceTheme) {
      const offered = this.deps.themes?.().interface.find(({ id }) => id === patch.interfaceTheme);
      if (typeof themeDigest !== "string" || offered?.digest !== themeDigest)
        throw new ApplicationError("theme-selection-changed");
    }
    if (
      patch.setupComplete === true &&
      this.deps.gitReadiness &&
      (await this.deps.gitReadiness()).git !== "ready"
    )
      throw new Error("Git is unavailable. Install Git and recheck on Go / no-go.");
    if (patch.forgeHosts) {
      const enabled = patch.forges ?? before.forges;
      const ids = this.deps.forgeIds?.() ?? ["github"];
      for (const [host, id] of Object.entries(patch.forgeHosts)) {
        if (before.forgeHosts[host] === id) continue;
        if (!ids.includes(id) || enabled[id] !== true)
          throw new Error("Choose an enabled forge for each host.");
      }
    }
    let machineCurrent: (() => boolean) | undefined;
    for (const [scope, choices] of Object.entries(patch.agentPermissions ?? {})) {
      const registration = before.registeredHosts?.find(({ host }) => scope === `host:${host}`);
      if (scope.startsWith("host:") && !registration)
        throw new Error("Machine is no longer registered.");
      if (registration)
        machineCurrent = () =>
          this.deps.store.get().registeredHosts?.includes(registration) === true;
      for (const [agent, choice] of Object.entries(choices)) {
        if (!choice) continue;
        const provider = agentProviders().find(({ id }) => id === agent);
        if (
          !provider?.model.permissionLevels?.[choice.level] ||
          (registration && provider.origin !== "bundled")
        )
          throw new Error("This agent does not declare permission levels for this machine.");
        checkPermissionConflicts(provider.model, before.agentArguments[agent] ?? []);
        if (choice.level !== "full") continue;
        const identity = bypassConsentIdentity(provider, true);
        if (
          !identity ||
          !(await this.deps.confirmBypass?.(agent, provider.model.permissionLevels.full, scope))
        )
          throw new Error("Full access was not saved.");
        if (bypassConsentIdentity(agent, true) !== identity)
          throw new Error("Agent plugin changed. Review it again.");
        choice.identity = identity;
      }
    }
    if (patch.agentArguments) {
      const acknowledged = { ...before.agentBypassAcknowledged };
      const identities = { ...before.agentBypassIdentities };
      for (const [agent, args] of Object.entries(patch.agentArguments)) {
        const identity = bypassConsentIdentity(agent);
        if (identity && hasBypassArgument(agent, args) && identities[agent] !== identity) {
          if (!(await this.deps.confirmBypass?.(agent, args)))
            throw new Error("Default arguments were not saved. Bypass disclosure was cancelled.");
          acknowledged[agent] = true;
          identities[agent] = identity;
        }
      }
      patch.agentBypassAcknowledged = acknowledged;
      patch.agentBypassIdentities = identities;
    }
    const settings =
      machineCurrent && patch.agentPermissions
        ? await this.deps.store.update({ agentPermissions: patch.agentPermissions }, machineCurrent)
        : await this.deps.store.update(
            patch,
            ...(typeof themeDigest === "string" ? [themeDigest] : []),
          );
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
        recent: isRecent(repository.lastActive, now, this.deps.store.get().recentRepositoryDays),
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
    if (selected.length && this.deps.gitReadiness) {
      const report = await this.deps.gitReadiness();
      if (report.git !== "ready")
        return {
          repositories: this.deps.code.worktrees.listRepositories(),
          failures: selected.map((path: string) => ({
            path,
            message: "Git is unavailable. Install Git and recheck on Go / no-go.",
          })),
        };
    }
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
