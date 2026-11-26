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
    | "savedWorktrees"
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
  busy: (id: string, value: boolean) => void;
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
  private restoreEnabled = true;
  private readonly saved = new Map<string, StoredSession>();
  private readonly remotePlacements = new Map<string, RemoteSavedPlacement>();
  private readonly restoring = new Set<string>();
  private readonly manualLaunches = new Map<string, { row: WorkspaceTerminal | undefined }>();
  private readonly restoreQueue = new Map<string, StoredSession>();
  private readonly deferredDiscovery = new Map<string, StoredSession>();
  private readonly deferredLinks = new Map<
    string,
    { entry: StoredSession; parentId: string; current: () => boolean }
  >();
  private readonly checkingDeferredLinks = new Set<string>();
  private readonly claimedDuringDiscovery = new Set<string>();
  private readonly restoredParents = new Map<string, () => boolean>();
  private readonly unverifiedParents = new Map<
    string,
    { id: string; stillActive: () => boolean }
  >();
  private readonly unrestoredRoles = new Set<string>();
  private restoreWork: Promise<void> | undefined;
  private activeRestore: Promise<void> | undefined;
  private discovery: Promise<readonly StoredSession[]> | undefined;
  private quitAttempt = 0;
  private preparingQuit = false;
  private quitting = false;
  private pruning = false;
  private readonly forgottenSessions = new Set<string>();
  private readonly forgettingSessions = new Set<string>();

  constructor(private readonly deps: SessionOwnerDependencies) {}

  configure(enabled: boolean): void {
    this.restoreEnabled = enabled;
  }
  isRestoring(id: string): boolean {
    return this.restoring.has(id) && !this.manualLaunchReplaced(id);
  }
  roleNotRestored(id: string): boolean {
    return !this.restoring.has(id) && this.unrestoredRoles.has(id);
  }

  /** Accepted manual actions take precedence over saved rows and in-flight discovery. */
  claim(id: string): void {
    if (this.discovery) this.claimedDuringDiscovery.add(id);
    this.restoring.delete(id);
    this.saved.delete(id);
    this.restoreQueue.delete(id);
    this.deferredDiscovery.delete(id);
    this.deferredLinks.delete(id);
    this.unverifiedParents.delete(id);
  }

  /** Hold the startup claim through confirmation and launch without discarding saved provenance. */
  reserveManualLaunch(id: string): (started: boolean) => void {
    const manual = { row: this.deps.terminal(id) };
    this.manualLaunches.set(id, manual);
    return (started) => {
      if (this.manualLaunches.get(id) !== manual) return;
      const claimed = started || this.manualLaunchReplaced(id);
      if (claimed) this.claim(id);
      this.manualLaunches.delete(id);
      if (claimed) this.persist();
      this.continueRestore();
    };
  }

  private manualLaunchReplaced(id: string): boolean {
    const manual = this.manualLaunches.get(id);
    return manual !== undefined && this.deps.terminal(id) !== manual.row;
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
        this.restoring.has(id)
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
      this.claim(id);
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
          this.unrestoredRoles.delete(entry.id);
          this.remotePlacements.delete(entry.id);
          this.deps.removeRow?.(entry.id);
        }
      }
    } finally {
      this.pruning = false;
    }
  }

  private importEntries(entries: readonly StoredSession[], discovered = false): Set<string> {
    const imported = new Set<string>();
    for (const entry of this.retained(entries)) {
      if (this.forgettingSessions.has(entry.id)) continue;
      if (discovered) {
        if (this.claimedDuringDiscovery.has(entry.id) || this.forgottenSessions.has(entry.id))
          continue;
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
        if (this.manualLaunches.has(entry.id)) {
          this.deferredDiscovery.set(entry.id, entry);
          continue;
        }
      }
      if (
        entry.config
          ? entry.worktree !== this.deps.configRoot || entry.repository !== entry.worktree
          : entry.home
            ? (entry.kind !== "shell" && !entry.machine) ||
              (!entry.sourceSession &&
                !(entry.machine && entry.remote && entry.placement?.kind === "remote") &&
                (entry.worktree !== homeDirectory || entry.repository !== homeDirectory))
            : false
      )
        continue;
      // A daemon-live row recovered from an exited record starts with human access.
      if (discovered) this.deferredLinks.delete(entry.id);
      this.deps.orchestration.handoffs.restore(entry.id, entry.handoffs ?? []);
      this.saved.set(entry.id, entry);
      imported.add(entry.id);
      this.deps.restoreSharedReview?.(entry);
      if (entry.remoteCheckout) {
        this.remotePlacements.set(entry.id, entry.remoteCheckout);
        this.deps.rememberRemote?.(entry);
      }
      const row = { ...entry };
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
      if (restorePlan([entry], this.restoreEnabled).length) this.restoring.add(entry.id);
    }
    return imported;
  }

  private records(): StoredSession[] {
    const entries = this.deps.terminals();
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of this.remotePlacements.keys())
      if (!ids.has(id)) this.remotePlacements.delete(id);
    return this.retained(
      entries
        .filter((entry) => !entry.probe && !entry.recipe && !this.forgettingSessions.has(entry.id))
        .map((entry) => {
          const remoteCheckout = entry.remote ? this.remotePlacements.get(entry.id) : undefined;
          const sharedReview = this.deps.sharedReview?.(entry.id);
          const role = this.deps.orchestration.view(entry.id);
          const identity = this.deps.orchestration.identity(entry.id);
          const restoring = this.isRestoring(entry.id);
          const replaced = this.manualLaunchReplaced(entry.id);
          const saved = replaced ? undefined : this.saved.get(entry.id);
          const deferred = this.deferredLinks.get(entry.id);
          const pendingParent = deferred?.parentId ?? saved?.parentId;
          const unverified = replaced ? undefined : this.unverifiedParents.get(entry.id);
          const parentId = role
            ? role.role === "child" && !role.takenOver
              ? role.parentId
              : undefined
            : unverified?.stillActive()
              ? unverified.id
              : !replaced &&
                  pendingParent &&
                  (deferred ? deferred.current() : this.isRestoring(pendingParent))
                ? pendingParent
                : undefined;
          return {
            ...entry,
            ...(sharedReview ? { sharedReview } : {}),
            ...(remoteCheckout ? { remoteCheckout } : {}),
            handoffs: this.deps.orchestration.handoffs.entries(entry.id),
            ...(restoring && saved?.orchestrator ? { orchestrator: saved.orchestrator } : {}),
            ...(parentId ? { parentId } : {}),
            running: restoring || !entry.exited,
            ...(role?.role === "orchestrator" && role.active && identity !== undefined
              ? {
                  orchestrator: {
                    identity: identity.repository,
                    worktreeIdentity: identity.worktree,
                    history: role.history,
                    worktrees: this.deps.orchestration.savedWorktrees(entry.id),
                    uncertain: this.deps.orchestration.uncertainWorktrees(entry.id),
                  },
                }
              : {}),
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
  async prepareQuit(): Promise<void> {
    this.quitAttempt++;
    this.preparingQuit = true;
    try {
      await this.restoreWork;
      await this.activeRestore;
      this.quitting = true;
      await this.deps.store?.save(this.records());
      await this.deps.store?.flush();
    } catch (error) {
      this.quitting = false;
      throw error;
    } finally {
      this.preparingQuit = false;
      if (!this.quitting) this.continueRestore();
    }
  }

  cancelQuit(): void {
    this.quitting = false;
    this.persist();
    this.continueRestore();
  }

  /** Called only after all saved windows have been shown. */
  restartSaved(): Promise<void> {
    if (this.restoreWork) return this.restoreWork;
    this.restoreWork = this.discovery
      ? this.discovery.then((entries) => this.finishDiscovery(entries))
      : this.finishDiscovery([]);
    return this.restoreWork;
  }

  private finishDiscovery(entries: readonly StoredSession[]): Promise<void> {
    this.importEntries(entries, true);
    this.discovery = undefined;
    this.claimedDuringDiscovery.clear();
    this.restoring.clear();
    this.enqueueRestarts();
    this.deps.onChange?.();
    return this.drainRestore();
  }

  private enqueueRestarts(imported?: ReadonlySet<string>): void {
    const plan = restorePlan(
      [...this.saved.values()].filter(
        (entry) => !this.forgettingSessions.has(entry.id) && !this.forgottenSessions.has(entry.id),
      ),
      this.restoreEnabled,
    );
    for (const entry of plan) {
      if (imported && !imported.has(entry.id)) continue;
      this.restoring.add(entry.id);
      this.restoreQueue.set(entry.id, entry);
    }
  }

  private continueRestore(): void {
    void this.drainRestore().catch(() => {
      console.error("Unable to continue saved session restore");
    });
  }

  /** Only runnable work enters the scheduler. Dialog lifetimes stay outside the quit barrier. */
  private async drainRestore(): Promise<void> {
    if (this.preparingQuit || this.quitting) return;
    const discovered = [...this.deferredDiscovery.values()].filter(
      (entry) => !this.manualLaunches.has(entry.id),
    );
    for (const entry of discovered) this.deferredDiscovery.delete(entry.id);
    if (discovered.length) {
      this.enqueueRestarts(this.importEntries(discovered, true));
      this.deps.onChange?.();
    }
    this.checkDeferredLinks();
    if (this.activeRestore) return this.activeRestore;

    const heldCheckouts = new Set<string>();
    for (const { row } of this.manualLaunches.values())
      if (row && !row.home && !row.config) heldCheckouts.add(row.worktree);
    const queued = [...this.restoreQueue.values()];
    const held = new Set(
      queued
        .filter((entry) => this.manualLaunches.has(entry.id) || heldCheckouts.has(entry.worktree))
        .map((entry) => entry.id),
    );
    const plan = queued.filter(
      (entry) =>
        !held.has(entry.id) &&
        !(
          entry.parentId &&
          held.has(entry.parentId) &&
          this.restoreQueue.get(entry.parentId)?.orchestrator
        ),
    );
    if (!plan.length) {
      if (!this.restoreQueue.size && !this.deferredLinks.size) this.restoredParents.clear();
      return;
    }
    for (const entry of plan) {
      this.restoreQueue.delete(entry.id);
      this.deps.busy(entry.id, true);
    }
    this.activeRestore = runRestore(plan, (entry) => this.restorePlannedEntry(entry))
      .finally(() => {
        this.activeRestore = undefined;
      })
      .then(() => this.drainRestore());
    return this.activeRestore;
  }

  /** A late check for an exited child can proceed without keeping launches or quit open. */
  private checkDeferredLinks(): void {
    for (const [id, link] of this.deferredLinks) {
      if (
        this.restoring.has(id) ||
        this.manualLaunches.has(id) ||
        this.checkingDeferredLinks.has(id)
      )
        continue;
      this.checkingDeferredLinks.add(id);
      const quitAttempt = this.quitAttempt;
      const canCheck = () => this.quitAttempt === quitAttempt;
      void this.restoreSavedChild(link.entry, link.parentId, true, canCheck)
        .catch(() => {
          console.error("Unable to restore a deferred child link");
        })
        .finally(() => {
          this.checkingDeferredLinks.delete(id);
          if (this.preparingQuit || this.quitting) return;
          if (canCheck()) {
            this.deferredLinks.delete(id);
            this.persist();
            this.deps.onChange?.();
          }
          this.continueRestore();
        });
    }
  }

  private async restorePlannedEntry(entry: StoredSession): Promise<void> {
    try {
      if (
        this.quitting ||
        this.deps.closed() ||
        !this.restoreEnabled ||
        this.forgettingSessions.has(entry.id) ||
        this.forgottenSessions.has(entry.id) ||
        !this.saved.has(entry.id) ||
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
      this.deferredLinks.delete(entry.id);
      this.persist();
      this.deps.onChange?.();
    }
  }

  private async restoreSavedChild(
    entry: StoredSession,
    parentId: string,
    exited: boolean,
    canCheck: () => boolean = () => true,
  ) {
    const parentCurrent = this.restoredParents.get(parentId);
    if (!parentCurrent || this.unverifiedParents.has(entry.id)) return false;
    const deferred = this.deferredLinks.get(entry.id);
    const eligible = () =>
      parentCurrent() &&
      (!deferred || (this.deferredLinks.get(entry.id) === deferred && deferred.current())) &&
      !this.quitting &&
      canCheck() &&
      !this.deps.closed() &&
      this.saved.has(entry.id) &&
      !this.forgettingSessions.has(entry.id) &&
      this.deps.terminal(entry.id) !== undefined;
    if (!eligible()) return false;
    const reserveDormant = !this.restoring.has(entry.id);
    if (reserveDormant) this.deps.busy(entry.id, true);
    try {
      const result = await this.deps.orchestration.restoreChild(
        parentId,
        { ...entry, exited },
        eligible,
      );
      if (typeof result === "boolean") return result && eligible();
      if (eligible())
        this.unverifiedParents.set(entry.id, {
          id: parentId,
          stillActive: result.parentStillActive,
        });
      return false;
    } finally {
      if (reserveDormant) this.deps.busy(entry.id, false);
    }
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
    } else if (entry.parentId && (await this.restoreSavedChild(entry, entry.parentId, false))) {
      control = { parentId: entry.parentId };
    }
    try {
      const id = await this.deps.launch(entry, control, authorityIdentity);
      if (id && slot && !("existing" in slot)) {
        slot.bind(id);
        this.restoredParents.set(id, slot.isCurrent);
        this.deps.orchestration.restoreHistory(id, entry.orchestrator?.history ?? []);
        await this.deps.orchestration.restoreWorktrees(
          id,
          entry.orchestrator?.worktrees ?? [],
          entry.orchestrator?.uncertain ?? 0,
        );
        this.unrestoredRoles.delete(id);
        for (const child of [...this.saved.values()]) {
          if (child.parentId !== id || !this.saved.has(child.id)) continue;
          if (this.manualLaunches.has(child.id) || this.restoreQueue.has(child.id)) {
            const currentIdentity = () =>
              this.deps.orchestration
                .savedWorktrees(id)
                .find((tree) => tree.path === child.worktree)?.identity;
            const identity =
              entry.orchestrator?.worktrees?.find((tree) => tree.path === child.worktree)
                ?.identity ?? currentIdentity();
            const parentCurrent = slot.isCurrent;
            this.deferredLinks.set(child.id, {
              entry: child,
              parentId: id,
              current: () =>
                parentCurrent() && (identity === undefined || currentIdentity() === identity),
            });
          } else {
            await this.restoreSavedChild(child, id, !this.restoring.has(child.id));
          }
        }
      }
    } finally {
      if (slot && !("existing" in slot)) slot.release();
    }
  }
}
