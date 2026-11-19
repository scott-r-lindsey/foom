import type { ParentIdentity } from "../control/orchestration.d";
import type { AgentInstallation, AgentLaunch } from "../../shared/agents";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { Orchestration } from "../control/orchestration";
import { homeDirectory } from "./home-shell";
import { restoreAuthority, restorePlan, runRestore } from "./session-restore";
import type { StoredSession, RemoteSavedPlacement } from "./session-restore.d";
import type { SessionStore } from "./session-store";
import { ApplicationError } from "../../shared/application-errors";

export interface SessionOwnerDependencies {
  registeredHost?: (host: string) => boolean;
  removeRow?: (id: string) => void;
  discover?: () => Promise<readonly StoredSession[]>;
  rememberRemote?: (entry: StoredSession) => void;
  store?: Pick<SessionStore, "load" | "save" | "flush">;
  configRoot?: string;
  orchestration: Pick<
    Orchestration,
    | "identity"
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
  sharedReview?: (id: string) => StoredSession["sharedReview"];
  restoreSharedReview?: (entry: StoredSession) => void;
  terminals: () => readonly WorkspaceTerminal[];
  terminal: (id: string) => WorkspaceTerminal | undefined;
  restoreRow: (row: WorkspaceTerminal) => void;
  failed: (id: string, error?: unknown) => void;
  closed: () => boolean;
  identity: (repository: string) => Promise<string>;
  agents: () => Promise<readonly AgentInstallation[]>;
  launch: (
    entry: StoredSession,
    control?: AgentLaunch["control"],
    identity?: ParentIdentity,
  ) => Promise<string | undefined>;
  onChange?: (localOnly?: boolean) => void;
}

/** Main-owned session metadata, restoration lifecycle and pre-shutdown persistence. */
export class SessionOwner {
  private readonly startupReservation = Symbol();
  private readonly reservations = new Map<string, symbol>();
  private restoreEnabled = true;
  private readonly saved = new Map<string, StoredSession>();
  private readonly remotePlacements = new Map<string, RemoteSavedPlacement>();
  private readonly restoring = new Set<string>();
  private readonly launching = new Set<string>();
  private queuedRestoresReleased = false;
  private readonly unrestoredRoles = new Set<string>();
  private restoreWork: Promise<void> | undefined;
  private discovery: Promise<readonly StoredSession[]> | undefined;
  private quitting = false;
  private pruning = false;
  private readonly forgottenSessions = new Set<string>();
  private readonly forgettingSessions = new Set<string>();

  constructor(private readonly deps: SessionOwnerDependencies) {}

  configure(enabled: boolean): void {
    this.restoreEnabled = enabled;
  }
  isRestoring(id: string): boolean {
    return this.reservations.get(id) === this.startupReservation;
  }
  isBusy(id: string): boolean {
    return this.reservations.has(id);
  }
  reserveManual(id: string): () => void {
    if (this.isBusy(id)) throw new ApplicationError("session-busy");
    const owner = Symbol();
    this.reservations.set(id, owner);
    this.restoring.delete(id);
    this.saved.delete(id);
    return () => {
      this.releaseReservation(id, owner);
    };
  }
  private releaseReservation(id: string, owner: symbol): void {
    if (this.reservations.get(id) === owner) this.reservations.delete(id);
  }
  roleNotRestored(id: string): boolean {
    return !this.restoring.has(id) && this.unrestoredRoles.has(id);
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
  get isQuitting(): boolean {
    return this.quitting;
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
    const loaded = (await this.deps.store?.load()) ?? [];
    const retained = this.retained(loaded);
    // Repair stale profiles before importing rows or granting saved authority.
    if (retained.length !== loaded.length) await this.deps.store?.save(retained);
    this.importEntries(retained);
  }

  private forgotten(entry: WorkspaceTerminal): boolean {
    return (
      this.forgottenSessions.has(entry.id) ||
      (entry.placement?.kind === "remote" &&
        this.deps.registeredHost?.(entry.placement.host) === false)
    );
  }

  private retained(entries: readonly StoredSession[]): StoredSession[] {
    const retained = entries.filter((entry) => !this.forgotten(entry) || entry.closeState);
    const ids = new Set(retained.map((entry) => entry.id));
    return retained.map((entry) => {
      if (!entry.parentId || ids.has(entry.parentId)) return entry;
      const row = { ...entry };
      delete row.parentId;
      return row;
    });
  }

  /** Forget metadata only; live connections and cleanup recovery stay intact. */
  async pruneHosts(host: string): Promise<void> {
    for (const entry of this.deps.terminals()) {
      if (entry.placement?.kind === "remote" && entry.placement.host === host)
        this.forgottenSessions.add(entry.id);
    }
    this.pruneRows();
    await this.save();
    this.deps.onChange?.();
  }

  /** Caller has validated human intent; no terminal or host capability is used. */
  async forget(id: string, revalidate?: () => Promise<void>): Promise<void> {
    const entry = this.deps.terminal(id);
    const validate = () => {
      const current = this.deps.terminals().find((row) => row.id === id);
      if (
        !entry ||
        this.deps.terminal(id) !== entry ||
        (!current?.dormant && !current?.exited) ||
        this.isRestoring(id)
      )
        throw new ApplicationError("session-busy");
    };
    validate();
    if (this.forgettingSessions.has(id)) throw new ApplicationError("session-busy");
    // Concurrent background saves must not reintroduce this row while the
    // removal write is pending. Keep the visible row until persistence succeeds.
    this.forgettingSessions.add(id);
    try {
      await this.save();
      try {
        await revalidate?.();
        validate();
      } catch (error) {
        // The deletion reached disk, but the row is no longer safe to forget.
        // Lift suppression before repairing persistence with the current row.
        this.forgettingSessions.delete(id);
        await this.save();
        throw error;
      }
      this.forgottenSessions.add(id);
      this.saved.delete(id);
      this.restoring.delete(id);
      this.unrestoredRoles.delete(id);
      this.remotePlacements.delete(id);
      this.deps.removeRow?.(id);
      this.deps.onChange?.(true);
    } finally {
      this.forgettingSessions.delete(id);
    }
  }

  private pruneRows(): void {
    if (this.pruning) return;
    this.pruning = true;
    try {
      const retained = this.retained([...this.saved.values()]);
      this.saved.clear();
      for (const entry of retained) this.saved.set(entry.id, entry);
      for (const entry of this.deps.terminals()) {
        if (
          this.forgottenSessions.has(entry.id) &&
          !entry.closeState &&
          (entry.exited || entry.dormant)
        ) {
          this.restoring.delete(entry.id);
          this.releaseReservation(entry.id, this.startupReservation);
          this.unrestoredRoles.delete(entry.id);
          this.remotePlacements.delete(entry.id);
          this.deps.removeRow?.(entry.id);
        }
      }
    } finally {
      this.pruning = false;
    }
  }

  private importEntries(entries: readonly StoredSession[], discovered = false): void {
    for (const entry of this.retained(entries)) {
      if (this.forgettingSessions.has(entry.id)) continue;
      if (this.isBusy(entry.id) && !this.isRestoring(entry.id)) continue;
      if (discovered) {
        if (this.forgottenSessions.has(entry.id)) continue;
        const previous = this.saved.get(entry.id);
        const reconcile =
          previous?.remote &&
          previous.closeState === undefined &&
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
            ? (entry.kind !== "shell" && !entry.machine) ||
              (!(entry.machine && entry.remote && entry.placement?.kind === "remote") &&
                (entry.worktree !== homeDirectory || entry.repository !== homeDirectory))
            : false
      )
        continue;
      this.deps.orchestration.handoffs.restore(entry.id, entry.handoffs ?? []);
      this.saved.set(entry.id, entry);
      this.deps.restoreSharedReview?.(entry);
      if (entry.remoteCheckout) {
        this.remotePlacements.set(entry.id, entry.remoteCheckout);
        this.deps.rememberRemote?.(entry);
      }
      const row = { ...entry, dormant: true };
      if (row.closeState) row.closeState = "failed";
      delete row.sharedReview;
      delete row.running;
      delete row.recovered;
      delete row.remoteCheckout;
      delete row.orchestrator;
      delete row.parentId;
      delete row.handoffs;
      this.deps.restoreRow(row);
      // Reserve eligible saved tiles before the first window requests inventory.
      if (restorePlan([entry], this.restoreEnabled).length) {
        this.restoring.add(entry.id);
        if (!this.queuedRestoresReleased) this.reservations.set(entry.id, this.startupReservation);
      }
    }
  }

  private records(): StoredSession[] {
    const entries = this.deps.terminals();
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of this.remotePlacements.keys())
      if (!ids.has(id)) this.remotePlacements.delete(id);
    return this.retained(
      entries
        .filter((entry) => !entry.probe && !this.forgettingSessions.has(entry.id))
        .map((entry) => {
          const remoteCheckout = entry.remote ? this.remotePlacements.get(entry.id) : undefined;
          const sharedReview = this.deps.sharedReview?.(entry.id);
          const role = this.deps.orchestration.view(entry.id);
          const identity = this.deps.orchestration.identity(entry.id);
          const saved = this.restoring.has(entry.id) ? this.saved.get(entry.id) : undefined;
          return {
            ...entry,
            ...(sharedReview ? { sharedReview } : {}),
            ...(remoteCheckout ? { remoteCheckout } : {}),
            handoffs: this.deps.orchestration.handoffs.entries(entry.id),
            ...(saved?.orchestrator ? { orchestrator: saved.orchestrator } : {}),
            ...(saved?.parentId ? { parentId: saved.parentId } : {}),
            running: this.restoring.has(entry.id) || !entry.exited,
            ...(role?.role === "orchestrator" && role.active && identity !== undefined
              ? {
                  orchestrator: {
                    identity: identity.repository,
                    worktreeIdentity: identity.worktree,
                    history: role.history,
                    worktrees: this.deps.orchestration.ownedWorktrees(entry.id),
                    uncertain: this.deps.orchestration.uncertainWorktrees(entry.id),
                  },
                }
              : {}),
            ...(role?.role === "child" && !role.takenOver ? { parentId: role.parentId } : {}),
          };
        }),
    );
  }

  persist(): void {
    if (this.quitting) return;
    this.pruneRows();
    void this.deps.store?.save(this.records()).catch((error: unknown) => {
      console.error("Unable to save sessions:", error);
    });
  }

  /** Freeze the pre-shutdown state, before stopping PTYs reports their exits. */
  async prepareQuit(waitForRestore = true): Promise<void> {
    if (waitForRestore) await this.restoreWork;
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

  releaseQueuedRestores(): void {
    if (this.queuedRestoresReleased) return;
    this.queuedRestoresReleased = true;
    for (const id of this.restoring)
      if (!this.launching.has(id)) this.releaseReservation(id, this.startupReservation);
    this.deps.onChange?.();
  }

  /** Called only after all saved windows have been shown. */
  restartSaved(pause?: () => Promise<boolean> | undefined): Promise<void> {
    if (this.restoreWork) return this.restoreWork;
    this.restoreWork = this.discovery
      ? this.discovery.then((entries) => {
          this.importEntries(entries, true);
          return this.restartEntries(pause);
        })
      : this.restartEntries(pause);
    return this.restoreWork;
  }

  private restartEntries(pause?: () => Promise<boolean> | undefined): Promise<void> {
    const plan = restorePlan(
      [...this.saved.values()].filter(
        (entry) => !this.forgettingSessions.has(entry.id) && !this.forgottenSessions.has(entry.id),
      ),
      this.restoreEnabled,
    );
    for (const id of this.restoring) this.releaseReservation(id, this.startupReservation);
    this.restoring.clear();
    for (const entry of plan) {
      this.restoring.add(entry.id);
      if (!this.queuedRestoresReleased) this.reservations.set(entry.id, this.startupReservation);
    }
    this.deps.onChange?.();
    return runRestore(plan, async (entry) => {
      for (let pending = pause?.(); pending; pending = pause?.()) {
        if (!(await pending)) return;
      }
      if (!this.restoring.has(entry.id) || (this.isBusy(entry.id) && !this.isRestoring(entry.id)))
        return;
      try {
        const row = this.deps.terminal(entry.id);
        if (
          this.quitting ||
          this.deps.closed() ||
          !this.restoreEnabled ||
          this.forgettingSessions.has(entry.id) ||
          this.forgottenSessions.has(entry.id) ||
          row?.dormant !== true ||
          row.closeState !== undefined
        )
          return;
        this.launching.add(entry.id);
        this.reservations.set(entry.id, this.startupReservation);
        if (this.queuedRestoresReleased) this.deps.onChange?.();
        await this.restartSavedEntry(entry);
      } catch (error) {
        this.deps.failed(entry.id, error);
        this.deps.orchestration.exited(entry.id);
      } finally {
        if (this.launching.delete(entry.id) && this.deps.terminal(entry.id)?.dormant)
          this.deps.orchestration.exited(entry.id);
        this.restoring.delete(entry.id);
        this.releaseReservation(entry.id, this.startupReservation);
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
    let authorityIdentity: ParentIdentity | undefined;
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
        const worktree =
          entry.orchestrator.worktreeIdentity ??
          (entry.worktree === entry.repository ? entry.orchestrator.identity : undefined);
        if (identity !== undefined && worktree !== undefined) {
          const proof = { repository: identity, worktree };
          slot = this.deps.orchestration.reserve(entry.repository, undefined, false, proof);
          if (!("existing" in slot)) {
            control = { role: "orchestrator" };
            authorityIdentity = proof;
          }
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
