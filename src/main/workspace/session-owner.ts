import { setTimeout as delay } from "node:timers/promises";
import type { ParentIdentity } from "../control/orchestration.d";
import type { AgentInstallation, AgentLaunch } from "../../shared/agents";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { Orchestration } from "../control/orchestration";
import { homeDirectory } from "./home-shell";
import { restoreAuthority, restorePlan, runRestore } from "./session-restore";
import type { StoredSession, RemoteSavedPlacement } from "./session-restore.d";
import type { SessionStore } from "./session-store";
import { ApplicationError } from "../../shared/application-errors";

const RESTORE_PAUSED = new Error("Startup restore paused");

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
    | "relaunched"
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
    control: AgentLaunch["control"],
    identity: ParentIdentity | undefined,
    validateLaunch: (dispatch?: true) => void,
  ) => Promise<string | undefined>;
  onChange?: (localOnly?: boolean) => void;
}

/** Main-owned session metadata, restoration lifecycle and pre-shutdown persistence. */
export class SessionOwner {
  private restoreEnabled = true;
  private readonly saved = new Map<string, StoredSession>();
  private readonly remotePlacements = new Map<string, RemoteSavedPlacement>();
  // The identity of a claim is its generation. Settled claims remain visible to
  // discovery that started before them, even if their row has since been deleted.
  private readonly claims = new Map<
    string,
    { generation: number; owner: "startup" | "operation" | "settled"; active: boolean }
  >();
  private generation = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private resume: (() => void) | undefined;
  private paused: Promise<void> | undefined;
  private discoveryGeneration = 0;
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
    return this.claims.get(id)?.owner === "startup";
  }
  roleNotRestored(id: string): boolean {
    return !this.isRestoring(id) && this.unrestoredRoles.has(id);
  }
  operationInProgress(id: string): boolean {
    const claim = this.claims.get(id);
    return claim?.owner === "operation" || claim?.active === true;
  }

  childCount(parentId: string): number {
    return this.deps.terminals().filter((row) => {
      const role = this.deps.orchestration.view(row.id);
      return (role?.role === "child" ? role.parentId : this.savedParent(row.id)) === parentId;
    }).length;
  }

  private savedParent(id: string): string | undefined {
    return this.saved.get(id)?.parentId;
  }

  private assign(id: string, owner: "startup" | "operation" | "settled") {
    const claim = { generation: ++this.generation, owner, active: false };
    if (owner === "settled" && !this.discovery) this.claims.delete(id);
    else this.claims.set(id, claim);
    return claim;
  }

  claim(id: string): () => void {
    if (this.quitting || this.operationInProgress(id)) throw new ApplicationError("session-busy");
    const queued = this.isRestoring(id);
    const operation = this.assign(id, "operation");
    this.saved.delete(id);
    this.unrestoredRoles.delete(id);
    return () => {
      if (this.claims.get(id) !== operation) return;
      this.assign(id, "settled");
      if (queued && this.deps.terminal(id)?.dormant) {
        this.persist();
        this.deps.onChange?.();
      }
    };
  }

  removed(id: string): void {
    if (this.claims.get(id)?.owner !== "operation") this.assign(id, "settled");
    this.saved.delete(id);
    this.unrestoredRoles.delete(id);
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
  releaseRestorePause(): void {
    this.resume?.();
    this.resume = undefined;
    this.paused = undefined;
  }
  async flush(): Promise<void> {
    await this.deps.store?.flush();
  }

  async restore(): Promise<void> {
    // Network discovery must not delay creating the board windows.
    const loaded = (await this.deps.store?.load()) ?? [];
    const retained = this.retained(loaded);
    // Repair stale profiles before importing rows or granting saved authority.
    if (retained.length !== loaded.length) await this.deps.store?.save(retained);
    this.importEntries(retained);
    this.discoveryGeneration = this.generation;
    this.discovery = this.deps.discover?.().catch(() => []);
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
      this.removed(id);
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
      for (const entry of this.saved.values()) {
        if (this.forgotten(entry) && !entry.closeState) this.saved.delete(entry.id);
      }
      for (const entry of this.deps.terminals()) {
        if (
          this.forgottenSessions.has(entry.id) &&
          !this.operationInProgress(entry.id) &&
          !entry.closeState &&
          (entry.exited || entry.dormant)
        ) {
          this.removed(entry.id);
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
      if (this.forgettingSessions.has(entry.id) || this.operationInProgress(entry.id)) continue;
      if (discovered) {
        if (
          this.forgottenSessions.has(entry.id) ||
          (this.claims.get(entry.id)?.generation ?? 0) > this.discoveryGeneration
        )
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
      if (restorePlan([entry], this.restoreEnabled).length) this.assign(entry.id, "startup");
    }
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
          const saved = this.isRestoring(entry.id) ? this.saved.get(entry.id) : undefined;
          const parentId =
            role?.role === "child"
              ? role.takenOver
                ? undefined
                : role.parentId
              : this.savedParent(entry.id);
          const orchestrator =
            role?.role === "orchestrator"
              ? role.active && identity !== undefined
                ? {
                    identity: identity.repository,
                    worktreeIdentity: identity.worktree,
                    history: role.history,
                    // Startup owns the saved list until validation of the whole list settles.
                    worktrees:
                      saved?.orchestrator?.worktrees ??
                      this.deps.orchestration.ownedWorktrees(entry.id),
                    uncertain:
                      saved?.orchestrator?.uncertain ??
                      this.deps.orchestration.uncertainWorktrees(entry.id),
                  }
                : undefined
              : saved?.orchestrator;
          return {
            ...entry,
            ...(sharedReview ? { sharedReview } : {}),
            ...(remoteCheckout ? { remoteCheckout } : {}),
            handoffs: this.deps.orchestration.handoffs.entries(entry.id),
            ...(orchestrator ? { orchestrator } : {}),
            ...(parentId ? { parentId } : {}),
            running: entry.dormant ? saved?.running === true : !entry.exited,
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

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    return work.finally(() => this.pending.delete(work));
  }

  /** Stop dispatching new restores and give in-flight work a bounded window to settle. */
  pauseRestore(): Promise<boolean> | undefined {
    this.paused ??= new Promise<void>((resolve) => {
      this.resume = resolve;
    });
    if (!this.pending.size) return undefined;
    const timeout = new AbortController();
    return Promise.race([
      Promise.allSettled(this.pending).then(() => false),
      delay(750, true, { signal: timeout.signal }),
    ]).finally(() => {
      timeout.abort();
    });
  }

  /** Freeze the pre-shutdown state, before stopping PTYs reports their exits. */
  async prepareQuit(): Promise<void> {
    this.quitting = true;
    try {
      await this.save();
      await this.flush();
    } catch (error) {
      this.cancelQuit();
      throw error;
    }
  }

  cancelQuit(): void {
    if (!this.quitting && !this.paused) return;
    this.quitting = false;
    this.releaseRestorePause();
    this.persist();
  }

  private async waitForResume(): Promise<void> {
    while (this.paused && !this.quitting) await this.paused;
  }

  /** Called only after all saved windows have been shown. */
  restartSaved(settings?: Promise<void>): Promise<void> {
    this.restoreWork ??= this.restartEntries(settings);
    return this.restoreWork;
  }

  private async restartEntries(settings?: Promise<void>): Promise<void> {
    const [, discovered] = await this.track(Promise.all([settings, this.discovery]));
    await this.waitForResume();
    if (this.quitting || this.deps.closed()) return;
    if (discovered) this.importEntries(discovered, true);
    this.discovery = undefined;
    for (const [id, claim] of this.claims) {
      if (claim.owner === "settled") this.claims.delete(id);
    }
    const plan = restorePlan([...this.saved.values()], this.restoreEnabled);
    const planned = new Set(plan.map(({ id }) => id));
    for (const [id, claim] of this.claims) {
      if (claim.owner === "startup" && !planned.has(id)) this.assign(id, "settled");
    }
    for (const entry of plan) {
      if (!this.claims.has(entry.id)) this.assign(entry.id, "startup");
    }
    this.deps.onChange?.();
    await runRestore(plan, (entry) => this.runEntry(entry));
  }

  private async runEntry(entry: StoredSession): Promise<void> {
    const id = entry.id;
    const claim = this.claims.get(id);
    if (claim?.owner !== "startup") return;
    const current = () => !this.quitting && !this.deps.closed() && this.claims.get(id) === claim;
    let dispatched = false;
    const validate = (dispatch?: true) => {
      if (!current()) throw new ApplicationError("session-busy");
      if (dispatch && !dispatched) {
        if (this.paused || !this.restoreEnabled) throw RESTORE_PAUSED;
        dispatched = true;
      }
    };
    while (current()) {
      await this.waitForResume();
      if (!current()) break;
      claim.active = true;
      try {
        if (this.restoreEnabled && this.deps.terminal(id)?.dormant)
          await this.track(this.restartSavedEntry(entry, current, validate));
        break;
      } catch (error) {
        if (error === RESTORE_PAUSED) continue;
        if (current()) this.deps.failed(id, error);
        break;
      } finally {
        claim.active = false;
      }
    }
    if (this.quitting || this.claims.get(id) !== claim) return;
    if (this.deps.terminal(id)?.dormant) this.deps.orchestration.exited(id);
    this.assign(id, "settled");
    this.saved.delete(id);
    this.persist();
    this.deps.onChange?.();
  }

  private async restartSavedEntry(
    entry: StoredSession,
    current: () => boolean,
    validateLaunch: (dispatch?: true) => void,
  ): Promise<void> {
    if (entry.home || entry.config) {
      await this.deps.launch(entry, undefined, undefined, validateLaunch);
      return;
    }
    let control: AgentLaunch["control"];
    let authorityIdentity: ParentIdentity | undefined;
    let slot: ReturnType<Orchestration["reserve"]> | undefined;
    if (entry.orchestrator) {
      this.unrestoredRoles.add(entry.id);
      const identity = await this.deps.identity(entry.repository).catch(() => undefined);
      const agents = await this.deps.agents();
      validateLaunch();
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
      (await this.deps.orchestration.restoreChild(
        entry.parentId,
        { ...entry, exited: true },
        current,
      ))
    ) {
      control = { parentId: entry.parentId };
    }
    try {
      const childParent = control && "parentId" in control ? control.parentId : undefined;
      let proceeding = false;
      validateLaunch();
      const id = await this.deps.launch(entry, control, authorityIdentity, (dispatch) => {
        validateLaunch(dispatch);
        if (dispatch && !proceeding) {
          if (childParent) this.deps.orchestration.relaunched(entry.id, childParent);
          proceeding = true;
        }
      });
      if (current() && id && slot && !("existing" in slot)) {
        slot.bind(id);
        this.deps.orchestration.restoreHistory(id, entry.orchestrator?.history ?? []);
        await this.deps.orchestration.restoreWorktrees(
          id,
          entry.orchestrator?.worktrees ?? [],
          entry.orchestrator?.uncertain ?? 0,
          current,
        );
        if (!current()) return;
        // Transfer persistence to live authority without dropping pending child metadata.
        const hydrated = { ...entry };
        delete hydrated.orchestrator;
        this.saved.set(id, hydrated);
        this.unrestoredRoles.delete(id);
        for (const child of this.saved.values()) {
          if (child.parentId !== id) continue;
          const childClaim = this.claims.get(child.id);
          const childCurrent = () =>
            current() &&
            this.claims.get(child.id) === childClaim &&
            this.saved.get(child.id) === child &&
            this.deps.terminal(child.id)?.dormant === true;
          const restored = await this.deps.orchestration.restoreChild(
            id,
            { ...child, exited: true },
            childCurrent,
          );
          if (!restored && childCurrent()) delete child.parentId;
        }
      }
    } finally {
      if (slot && !("existing" in slot)) slot.release();
    }
  }
}
