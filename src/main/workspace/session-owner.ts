import { setTimeout as delay } from "node:timers/promises";
import type { ParentIdentity } from "../control/orchestration.d";
import type { AgentInstallation, AgentLaunch } from "../../shared/agents";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { Orchestration } from "../control/orchestration";
import { homeDirectory } from "./home-shell";
import { restoreAuthority, restorePlan, runRestore } from "./session-restore";
import type { OwnedWorktree, StoredSession, RemoteSavedPlacement } from "./session-restore.d";
import type { SessionStore } from "./session-store";
import { ApplicationError } from "../../shared/application-errors";

const RESTORE_PAUSED = new Error("Startup restore paused");

type RowClaim = {
  generation: number;
  owner: "startup" | "operation" | "settled";
  active: boolean;
  completion: Promise<void> | undefined;
};

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
  private readonly claims = new Map<string, RowClaim>();
  private generation = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private resume: (() => void) | undefined;
  private paused: Promise<void> | undefined;
  private pauseGeneration = 0;
  private discoveryGeneration = 0;
  private readonly unrestoredRoles = new Set<string>();
  private restoreWork: Promise<void> | undefined;
  private discovery: Promise<readonly StoredSession[]> | undefined;
  private quitting = false;
  private pruning = false;
  private readonly forgottenSessions = new Set<string>();
  private removalWrite: Promise<void> | undefined;

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
      return (role?.role === "child" ? role.parentId : this.savedParent(row)) === parentId;
    }).length;
  }

  private savedParent(row: WorkspaceTerminal): string | undefined {
    return row.dormant ? this.saved.get(row.id)?.parentId : undefined;
  }

  private assign(id: string, owner: RowClaim["owner"], completion?: Promise<void>): RowClaim {
    const claim = { generation: ++this.generation, owner, active: false, completion };
    if (owner === "settled" && !this.discovery && !this.saved.has(id)) this.claims.delete(id);
    else this.claims.set(id, claim);
    return claim;
  }

  claim(id: string): () => void {
    if (this.quitting || this.operationInProgress(id)) throw new ApplicationError("session-busy");
    const queued = this.isRestoring(id);
    const previous = this.deps.terminal(id);
    let finish: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation = this.assign(id, "operation", completion);
    return () => {
      finish?.();
      if (this.claims.get(id) !== operation) return;
      const row = this.deps.terminal(id);
      // A failed manual claim leaves the previous saved record and its links intact.
      if (row !== previous) this.removed(id);
      const retry = queued && row?.dormant && !row.closeState && this.saved.has(id);
      this.assign(id, retry ? "startup" : "settled");
      if (queued && row?.dormant) {
        this.persist();
        this.deps.onChange?.();
      }
    };
  }

  removed(id: string): void {
    this.saved.delete(id);
    this.unrestoredRoles.delete(id);
    if (this.claims.get(id)?.owner !== "operation") this.assign(id, "settled");
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
  async save(explicit = true): Promise<void> {
    while (this.removalWrite) await this.removalWrite.catch(() => {});
    if (explicit || !this.quitting) await this.deps.store?.save(this.records());
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
    const validate = (preparing = true) => {
      const current = this.deps.terminals().find((row) => row.id === id);
      if (
        (preparing && this.quitting) ||
        !entry ||
        this.deps.terminal(id) !== entry ||
        (!current?.dormant && !current?.exited) ||
        this.isRestoring(id)
      )
        throw new ApplicationError("session-busy");
    };
    validate();
    const release = this.claim(id);
    try {
      const commit = async () => {
        await this.deps.store?.save(this.records(id));
        try {
          validate(false);
        } catch (error) {
          await this.deps.store?.save(this.records());
          throw error;
        }
        this.forgottenSessions.add(id);
        this.removed(id);
        this.remotePlacements.delete(id);
        this.deps.removeRow?.(id);
        this.deps.onChange?.(true);
      };
      // Host checks are preparation. Only an admitted local write serializes snapshots.
      for (;;) {
        validate();
        const precedingWrite = this.removalWrite;
        if (precedingWrite) await precedingWrite.catch(() => {});
        if (revalidate) await revalidate();
        validate();
        if (this.removalWrite) continue;
        const write = commit().finally(() => {
          this.removalWrite = undefined;
        });
        this.removalWrite = write;
        await write;
        return;
      }
    } finally {
      release();
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
      if (this.operationInProgress(entry.id)) continue;
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

  private savedAndLiveWorktrees(
    id: string,
    pending: readonly OwnedWorktree[] = [],
  ): OwnedWorktree[] {
    const owned = new Map(pending.map((tree) => [tree.path, tree]));
    for (const live of this.deps.orchestration.ownedWorktrees(id)) owned.set(live.path, live);
    return [...owned.values()];
  }

  private records(removed?: string): StoredSession[] {
    const entries = this.deps.terminals();
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of this.remotePlacements.keys())
      if (!ids.has(id)) this.remotePlacements.delete(id);
    return this.retained(
      entries
        .filter((entry) => !entry.probe && !entry.recipe && entry.id !== removed)
        .map((entry) => {
          const remoteCheckout = entry.remote ? this.remotePlacements.get(entry.id) : undefined;
          const sharedReview = this.deps.sharedReview?.(entry.id);
          const role = this.deps.orchestration.view(entry.id);
          const identity = this.deps.orchestration.identity(entry.id);
          const saved =
            this.isRestoring(entry.id) || (entry.dormant && this.claims.has(entry.id))
              ? this.saved.get(entry.id)
              : undefined;
          const parentId =
            role?.role === "child"
              ? role.takenOver
                ? undefined
                : role.parentId
              : this.savedParent(entry);
          const orchestrator =
            role?.role === "orchestrator"
              ? role.active && identity !== undefined
                ? {
                    identity: identity.repository,
                    worktreeIdentity: identity.worktree,
                    history: role.history,
                    worktrees: this.savedAndLiveWorktrees(entry.id, saved?.orchestrator?.worktrees),
                    uncertain: Math.max(
                      saved?.orchestrator?.uncertain ?? 0,
                      this.deps.orchestration.uncertainWorktrees(entry.id),
                    ),
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
    void this.save(false).catch((error: unknown) => {
      console.error("Unable to save sessions:", error);
    });
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    return work.finally(() => this.pending.delete(work));
  }

  /** Stop dispatching new restores and give in-flight work a bounded window to settle. */
  pauseRestore(): Promise<boolean> | undefined {
    if (!this.paused) {
      this.pauseGeneration++;
      this.paused = new Promise<void>((resolve) => {
        this.resume = resolve;
      });
    }
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
    if (this.isQuitting || this.deps.closed()) return;
    if (discovered) this.importEntries(discovered, true);
    this.discovery = undefined;
    for (const [id, claim] of this.claims) {
      if (claim.owner === "settled" && !this.saved.has(id)) this.claims.delete(id);
    }
    const plan = restorePlan([...this.saved.values()], this.restoreEnabled).filter(({ id }) => {
      const claim = this.claims.get(id);
      return claim?.owner !== "settled";
    });
    const planned = new Set(plan.map(({ id }) => id));
    for (const [id, claim] of this.claims) {
      if (claim.owner === "startup" && !planned.has(id)) {
        const entry = this.saved.get(id);
        if (entry) {
          const skipped = { ...entry };
          delete skipped.running;
          delete skipped.orchestrator;
          this.saved.set(id, skipped);
        }
        this.assign(id, "settled");
      }
    }
    for (const entry of plan) {
      if (!this.claims.has(entry.id)) this.assign(entry.id, "startup");
    }
    this.deps.onChange?.();
    let ready = plan;
    while (ready.length) {
      const deferred = new Map<string, Promise<void>>();
      await runRestore(ready, ({ id }) => this.runEntry(id, deferred));
      if (!deferred.size || this.quitting) return;
      // A queued launch leaves its worker and checkout lane free during a manual claim.
      await Promise.race(deferred.values());
      ready = ready.filter(({ id }) => deferred.has(id));
    }
  }

  private async runEntry(id: string, deferred: Map<string, Promise<void>>): Promise<void> {
    for (;;) {
      await this.waitForResume();
      if (this.isQuitting) return;
      if (this.paused) continue;
      const entry = this.saved.get(id);
      const claim = this.claims.get(id);
      const completion =
        claim?.completion ?? (entry?.parentId ? deferred.get(entry.parentId) : undefined);
      if (completion) {
        deferred.set(id, completion);
        return;
      }
      if (!entry || claim?.owner !== "startup") return;
      const current = () => !this.quitting && !this.deps.closed() && this.claims.get(id) === claim;
      const pauseGeneration = this.pauseGeneration;
      let dispatched = false;
      const interrupted = () => !dispatched && pauseGeneration !== this.pauseGeneration;
      const validate = (dispatch?: true) => {
        if (!current()) throw new ApplicationError("session-busy");
        if (dispatch && !dispatched) {
          if (this.paused || !this.restoreEnabled) throw RESTORE_PAUSED;
          dispatched = true;
        }
      };
      claim.active = true;
      try {
        if (current() && this.restoreEnabled && this.deps.terminal(id)?.dormant)
          await this.track(this.restartSavedEntry(entry, current, validate));
        if (interrupted()) continue;
      } catch (error) {
        if (error === RESTORE_PAUSED || interrupted()) continue;
        if (current()) this.deps.failed(id, error);
      } finally {
        claim.active = false;
      }
      if (this.quitting || this.claims.get(id) !== claim) return;
      if (this.deps.terminal(id)?.dormant) this.deps.orchestration.exited(id);
      this.saved.delete(id);
      this.assign(id, "settled");
      this.persist();
      this.deps.onChange?.();
      return;
    }
  }

  private async restartSavedEntry(
    entry: StoredSession,
    current: () => boolean,
    validateLaunch: (dispatch?: true) => void,
  ): Promise<void> {
    validateLaunch();
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
      validateLaunch();
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
          (settled) => {
            const saved = this.saved.get(id);
            const orchestrator = saved?.orchestrator;
            if (current() && saved && orchestrator?.worktrees)
              this.saved.set(id, {
                ...saved,
                orchestrator: {
                  ...orchestrator,
                  worktrees: orchestrator.worktrees.filter(({ path }) => path !== settled),
                },
              });
          },
        );
        if (!current()) return;
        // Transfer persistence to live authority without dropping pending child metadata.
        const hydrated = { ...entry };
        delete hydrated.orchestrator;
        this.saved.set(id, hydrated);
        this.unrestoredRoles.delete(id);
        for (const childId of [...this.saved.keys()]) {
          if (!current()) return;
          if (this.saved.get(childId)?.parentId === id)
            await this.hydrateChild(id, childId, current);
        }
      }
    } finally {
      if (slot && !("existing" in slot)) slot.release();
    }
  }

  private async hydrateChild(parentId: string, id: string, parentCurrent: () => boolean) {
    while (parentCurrent()) {
      const child = this.saved.get(id);
      const claim = this.claims.get(id);
      if (!child || child.parentId !== parentId) return;
      if (claim?.completion) {
        await claim.completion;
        continue;
      }
      const current = () =>
        parentCurrent() &&
        this.claims.get(id) === claim &&
        this.saved.get(id) === child &&
        this.deps.terminal(id)?.dormant === true;
      if (!current()) return;
      const restored = await this.deps.orchestration.restoreChild(
        parentId,
        { ...child, exited: true },
        current,
      );
      if (!current()) continue;
      if (!restored) delete child.parentId;
      return;
    }
  }
}
