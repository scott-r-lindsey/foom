import type { AgentInstallation, AgentLaunch } from "../../shared/agents";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { Orchestration } from "../control/orchestration";
import { homeDirectory } from "./home-shell";
import { restoreAuthority, restorePlan, runRestore } from "./session-restore";
import type { StoredSession, RemoteSavedPlacement } from "./session-restore.d";
import type { SessionStore } from "./session-store";

export interface SessionOwnerDependencies {
  discover?: () => Promise<readonly StoredSession[]>;
  rememberRemote?: (entry: StoredSession) => void;
  store?: Pick<SessionStore, "load" | "save" | "flush">;
  configRoot?: string;
  orchestration: Pick<
    Orchestration,
    | "handoffs"
    | "view"
    | "ownedWorktrees"
    | "uncertainWorktrees"
    | "exited"
    | "reserve"
    | "restoreChild"
    | "restoreHistory"
    | "restoreWorktrees"
  >;
  terminals: () => readonly WorkspaceTerminal[];
  terminal: (id: string) => WorkspaceTerminal | undefined;
  restoreRow: (row: WorkspaceTerminal) => void;
  failed: (id: string, error?: unknown) => void;
  busy: (id: string, value: boolean) => void;
  closed: () => boolean;
  identity: (repository: string) => Promise<string>;
  agents: () => Promise<readonly AgentInstallation[]>;
  launch: (
    entry: StoredSession,
    control?: AgentLaunch["control"],
    identity?: string,
  ) => Promise<string | undefined>;
  onChange?: () => void;
}

/** Main-owned session metadata, restoration lifecycle and pre-shutdown persistence. */
export class SessionOwner {
  private restoreEnabled = true;
  private readonly saved = new Map<string, StoredSession>();
  private readonly remotePlacements = new Map<string, RemoteSavedPlacement>();
  private readonly repositoryIdentities = new Map<string, string>();
  private readonly restoring = new Set<string>();
  private readonly unrestoredRoles = new Set<string>();
  private restoreWork: Promise<void> | undefined;
  private discovery: Promise<readonly StoredSession[]> | undefined;
  private quitting = false;

  constructor(private readonly deps: SessionOwnerDependencies) {}

  configure(enabled: boolean): void {
    this.restoreEnabled = enabled;
  }
  isRestoring(id: string): boolean {
    return this.restoring.has(id);
  }
  roleNotRestored(id: string): boolean {
    return !this.restoring.has(id) && this.unrestoredRoles.has(id);
  }
  rememberIdentity(repository: string, identity: string): void {
    this.repositoryIdentities.set(repository, identity);
  }
  rememberRemote(id: string, value: RemoteSavedPlacement): void {
    const placement = {
      repository: value.repository,
      path: value.path,
      identity: value.identity,
      branch: value.branch,
    };
    this.remotePlacements.set(id, placement);
    const entry = this.deps.terminal(id);
    if (entry) this.deps.rememberRemote?.({ ...entry, remoteCheckout: placement });
  }
  /** Explicit handoff writes propagate failures even during the quit freeze. */
  async save(): Promise<void> {
    await this.deps.store?.save(this.records());
  }
  async flush(): Promise<void> {
    await this.deps.store?.flush();
  }

  async restore(): Promise<void> {
    // Network discovery must not delay creating the board windows.
    this.discovery = this.deps.discover?.().catch(() => []);
    this.importEntries((await this.deps.store?.load()) ?? []);
  }

  private importEntries(entries: readonly StoredSession[], discovered = false): void {
    for (const entry of entries) {
      if (discovered) {
        const previous = this.saved.get(entry.id);
        const reconcile =
          previous?.remote &&
          previous.running !== true &&
          entry.running === true &&
          previous.placement?.kind === "remote" &&
          entry.placement?.kind === "remote" &&
          previous.placement.host === entry.placement.host;
        // A live invocation saved as exited has no proven running grant. The
        // daemon observation recovers human access, never old parent authority.
        if (!reconcile && (previous || this.deps.terminal(entry.id) || this.saved.size >= 1000))
          continue;
      }
      if (
        entry.config
          ? entry.worktree !== this.deps.configRoot || entry.repository !== entry.worktree
          : entry.home
            ? entry.kind !== "shell" ||
              entry.worktree !== homeDirectory ||
              entry.repository !== homeDirectory
            : false
      )
        continue;
      this.deps.orchestration.handoffs.restore(entry.id, entry.handoffs ?? []);
      this.saved.set(entry.id, entry);
      if (entry.remoteCheckout) {
        this.remotePlacements.set(entry.id, entry.remoteCheckout);
        this.deps.rememberRemote?.(entry);
      }
      const row = { ...entry };
      delete row.running;
      delete row.recovered;
      delete row.remoteCheckout;
      delete row.orchestrator;
      delete row.parentId;
      delete row.handoffs;
      this.deps.restoreRow(row);
      // Reserve eligible saved tiles before the first window requests inventory.
      if (restorePlan([entry], this.restoreEnabled).length) this.restoring.add(entry.id);
    }
  }

  private records(): StoredSession[] {
    const entries = this.deps.terminals();
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of this.remotePlacements.keys())
      if (!ids.has(id)) this.remotePlacements.delete(id);
    return entries
      .filter((entry) => !entry.probe)
      .map((entry) => {
        const remoteCheckout = entry.remote ? this.remotePlacements.get(entry.id) : undefined;
        const role = this.deps.orchestration.view(entry.id);
        const identity = this.repositoryIdentities.get(entry.repository);
        const saved = this.restoring.has(entry.id) ? this.saved.get(entry.id) : undefined;
        return {
          ...entry,
          ...(remoteCheckout ? { remoteCheckout } : {}),
          handoffs: this.deps.orchestration.handoffs.entries(entry.id),
          ...(saved?.orchestrator ? { orchestrator: saved.orchestrator } : {}),
          ...(saved?.parentId ? { parentId: saved.parentId } : {}),
          running: this.restoring.has(entry.id) || !entry.exited,
          ...(role?.role === "orchestrator" && role.active && identity !== undefined
            ? {
                orchestrator: {
                  identity,
                  history: role.history,
                  worktrees: this.deps.orchestration.ownedWorktrees(entry.id),
                  uncertain: this.deps.orchestration.uncertainWorktrees(entry.id),
                },
              }
            : {}),
          ...(role?.role === "child" && !role.takenOver ? { parentId: role.parentId } : {}),
        };
      });
  }

  persist(): void {
    if (this.quitting) return;
    void this.deps.store?.save(this.records()).catch((error: unknown) => {
      console.error("Unable to save sessions:", error);
    });
  }

  /** Freeze the pre-shutdown state, before stopping PTYs reports their exits. */
  async prepareQuit(): Promise<void> {
    await this.restoreWork;
    this.quitting = true;
    try {
      await this.deps.store?.save(this.records());
      await this.deps.store?.flush();
    } catch (error) {
      this.quitting = false;
      throw error;
    }
  }

  cancelQuit(): void {
    this.quitting = false;
    this.persist();
  }

  /** Called only after all saved windows have been shown. */
  restartSaved(): Promise<void> {
    if (this.restoreWork) return this.restoreWork;
    this.restoreWork = this.discovery
      ? this.discovery.then((entries) => {
          this.importEntries(entries, true);
          return this.restartEntries();
        })
      : this.restartEntries();
    return this.restoreWork;
  }

  private restartEntries(): Promise<void> {
    const plan = restorePlan([...this.saved.values()], this.restoreEnabled);
    this.restoring.clear();
    for (const entry of plan) {
      this.restoring.add(entry.id);
      this.deps.busy(entry.id, true);
    }
    this.deps.onChange?.();
    return runRestore(plan, async (entry) => {
      try {
        if (
          this.quitting ||
          this.deps.closed() ||
          !this.restoreEnabled ||
          this.deps.terminal(entry.id) === undefined
        )
          return;
        await this.restartSavedEntry(entry);
      } catch (error) {
        this.deps.failed(entry.id, error);
        this.deps.orchestration.exited(entry.id);
      } finally {
        if (this.deps.terminal(entry.id)?.dormant) this.deps.orchestration.exited(entry.id);
        this.restoring.delete(entry.id);
        this.deps.busy(entry.id, false);
        this.saved.delete(entry.id);
        this.persist();
        this.deps.onChange?.();
      }
    });
  }

  private async restartSavedEntry(entry: StoredSession): Promise<void> {
    if (entry.home || entry.config) {
      await this.deps.launch(entry);
      return;
    }
    let control: AgentLaunch["control"];
    let authorityIdentity: string | undefined;
    let slot: ReturnType<Orchestration["reserve"]> | undefined;
    if (entry.orchestrator) {
      this.unrestoredRoles.add(entry.id);
      const identity = await this.deps.identity(entry.repository).catch(() => undefined);
      const agents = await this.deps.agents();
      if (
        restoreAuthority(
          entry,
          identity,
          agents.find((agent) => agent.id === entry.agent),
          this.restoreEnabled,
        )
      ) {
        slot = this.deps.orchestration.reserve(entry.repository);
        if (!("existing" in slot)) {
          control = { role: "orchestrator" };
          authorityIdentity = identity;
          if (identity !== undefined) this.repositoryIdentities.set(entry.repository, identity);
        }
      }
    } else if (
      entry.parentId &&
      (await this.deps.orchestration.restoreChild(entry.parentId, { ...entry, exited: false }))
    ) {
      control = { parentId: entry.parentId };
    }
    try {
      const id = await this.deps.launch(entry, control, authorityIdentity);
      if (id && slot && !("existing" in slot)) {
        slot.bind(id);
        this.deps.orchestration.restoreHistory(id, entry.orchestrator?.history ?? []);
        await this.deps.orchestration.restoreWorktrees(
          id,
          entry.orchestrator?.worktrees ?? [],
          entry.orchestrator?.uncertain ?? 0,
        );
        this.unrestoredRoles.delete(id);
        for (const child of this.saved.values()) {
          if (child.parentId === id)
            await this.deps.orchestration.restoreChild(id, {
              ...child,
              exited: !this.restoring.has(child.id),
            });
        }
      }
    } finally {
      if (slot && !("existing" in slot)) slot.release();
    }
  }
}
