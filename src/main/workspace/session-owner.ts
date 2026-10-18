import type { AgentInstallation, AgentLaunch } from "../../shared/agents";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { Orchestration } from "../control/orchestration";
import { homeDirectory } from "./home-shell";
import { restoreAuthority, restorePlan, runRestore } from "./session-restore";
import type { StoredSession } from "./session-restore.d";
import type { SessionStore } from "./session-store";

export interface SessionOwnerDependencies {
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
  failed: (id: string) => void;
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
  private readonly repositoryIdentities = new Map<string, string>();
  private readonly restoring = new Set<string>();
  private readonly unrestoredRoles = new Set<string>();
  private restoreWork: Promise<void> | undefined;
  private quitting = false;

  constructor(private readonly deps: SessionOwnerDependencies) {}

  configure(enabled: boolean): void {
    this.restoreEnabled = enabled;
  }
  isRestoring(id: string): boolean {
    return this.restoring.has(id);
  }
  roleNotRestored(id: string): boolean {
    return this.unrestoredRoles.has(id);
  }
  rememberIdentity(repository: string, identity: string): void {
    this.repositoryIdentities.set(repository, identity);
  }
  /** Explicit handoff writes propagate failures even during the quit freeze. */
  async save(): Promise<void> {
    await this.deps.store?.save(this.records());
  }
  async flush(): Promise<void> {
    await this.deps.store?.flush();
  }

  async restore(): Promise<void> {
    for (const entry of (await this.deps.store?.load()) ?? []) {
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
      const row = { ...entry };
      delete row.running;
      delete row.orchestrator;
      delete row.parentId;
      delete row.handoffs;
      this.deps.restoreRow(row);
    }
  }

  private records(): StoredSession[] {
    return this.deps.terminals().map((entry) => {
      const role = this.deps.orchestration.view(entry.id);
      const identity = this.repositoryIdentities.get(entry.repository);
      const saved = this.restoring.has(entry.id) ? this.saved.get(entry.id) : undefined;
      return {
        ...entry,
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
    const plan = restorePlan([...this.saved.values()], this.restoreEnabled);
    for (const entry of plan) {
      this.restoring.add(entry.id);
      this.deps.busy(entry.id, true);
    }
    this.deps.onChange?.();
    this.restoreWork = runRestore(plan, async (entry) => {
      try {
        if (
          this.quitting ||
          this.deps.closed() ||
          !this.restoreEnabled ||
          this.deps.terminal(entry.id) === undefined
        )
          return;
        await this.restartSavedEntry(entry);
      } catch {
        this.deps.failed(entry.id);
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
    return this.restoreWork;
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
