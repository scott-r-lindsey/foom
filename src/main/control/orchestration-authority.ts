import { reviewLabel } from "../../shared/review-state";
import { randomUUID } from "node:crypto";
import { ReviewLoops } from "./review-loops";
import type { ReviewOptions } from "../../shared/review";
import { UnreadChildEvents } from "./unread-child-events";
import { ChildEvents } from "./child-events";
import { Handoffs } from "./handoffs";
import type { OwnedWorktree } from "../workspace/session-restore.d";
import type {
  OrchestrationEntry,
  OrchestrationView,
  WorkspaceTerminal,
} from "../../shared/workspace";
import { locationId, metadataName, SessionMetadata } from "./metadata";
import type { Operations } from "./operations";
import type { Operation, Principal } from "./types";
import { ControlError } from "../../node-common/control-validation";
import type { Child, Parent, OrchestrationHost } from "./orchestration.d";

/** Orchestrator-created worktrees that no child has used yet. */
export const WORKTREE_LIMIT = 4;
const HISTORY = 20;

/**
 * Repository orchestrators and their children. Slots are reserved synchronously
 * before async work; authority ends with the parent's exit, children stay for the human.
 */
export class OrchestrationAuthority {
  readonly reviews: ReviewLoops;
  private readonly reviewRuns = new Map<string, { actor: Principal; operations: Operations }>();
  readonly handoffs = new Handoffs();
  readonly unreadChildren: UnreadChildEvents;
  readonly childEvents = new ChildEvents();
  private readonly slots = new Map<string, Parent>();
  private readonly parents = new Map<string, Parent>();
  protected readonly early = new Set<string>();
  protected readonly metadata: SessionMetadata;
  private readonly offUnread: () => void;

  constructor(
    protected readonly host: OrchestrationHost,
    protected readonly now: () => number = Date.now,
    readonly childLimit: () => number = () => 4,
  ) {
    this.reviews = new ReviewLoops(
      {
        row: (id) => host.terminals().find((row) => row.id === id),
        report: (id) => this.handoffs.latest(id),
        checks: (id) => {
          const row = host.terminals().find((row) => row.id === id);
          return row ? this.pullRequest(row) : undefined;
        },
        snapshot: async (id) => {
          const run = this.reviewRuns.get(id);
          if (!run) throw new ControlError("forbidden");
          const parent = this.parent(run.actor);
          const child = this.own(parent, id);
          const tree = child && parent.worktrees.get(child.worktreeId);
          if (!tree || !host.reviewSnapshot) throw new ControlError("unavailable");
          return host.reviewSnapshot(parent.repository, tree.path, tree.identity);
        },
        stop: (id) => this.reviewStop(id),
        step: (id, reviewer, prompt) => this.reviewStep(id, reviewer, prompt),
        changed: () => {
          this.changed();
        },
        save: async () => {
          await host.saveHandoffs?.();
        },
      },
      now,
    );
    this.unreadChildren = new UnreadChildEvents(() => {
      this.changed();
    }, now);
    this.offUnread = this.childEvents.subscribe(() => {
      this.syncUnreadChildEvents();
      this.reviews.sync();
    });
    this.metadata = new SessionMetadata(
      () => host.terminals(),
      (row) => this.pullRequest(row),
      (row) => this.handoffMetadata(row),
      (row) => this.reviewMetadata(row),
    );
  }

  disposeUnreadChildren(): void {
    this.offUnread();
    for (const id of this.reviewRuns.keys()) this.reviews.stop(id);
    this.unreadChildren.dispose();
  }

  syncUnreadChildEvents(): void {
    const rows = this.host.terminals();
    this.unreadChildren.sync(
      [...this.parents].flatMap(([parentId, parent]) =>
        parent.active
          ? [...parent.children].flatMap(([id, child]) => {
              const row = rows.find((entry) => entry.id === id);
              return child.takenOver || !row
                ? []
                : [
                    {
                      id,
                      parentId,
                      execution: row.execution,
                      exited: child.exited,
                      handoff: this.handoffMetadata(row),
                      pullRequest: this.pullRequest(row),
                    },
                  ];
            })
          : [],
      ),
    );
  }

  childRead(actor: Principal, id: string): void {
    if (actor.role !== "orchestrator") return;
    const parent = this.parent(actor);
    if (!this.own(parent, id)) return;
    this.reviews.read(id);
    this.syncUnreadChildEvents();
    if (this.unreadChildren.read(actor.terminalId, id)) this.changed();
  }

  protected changed(): void {
    this.childEvents.publish();
    this.host.changed();
  }

  pullRequest(row: WorkspaceTerminal) {
    return this.host.forge?.read(row.repository, row.worktree);
  }

  reviewMetadata(row: WorkspaceTerminal) {
    return this.reviews.view(row.id) ?? row.review;
  }

  handoffMetadata(row: WorkspaceTerminal) {
    const latest = this.handoffs.latest(row.id);
    return latest ? { seq: latest.seq, status: latest.status } : undefined;
  }

  canHandoff(actor: Principal): boolean {
    const parent = actor.parentId === null ? undefined : this.parents.get(actor.parentId);
    const child = parent?.children.get(actor.terminalId);
    return (
      actor.role === "agent" &&
      parent?.active === true &&
      parent.repository === actor.repository &&
      child !== undefined &&
      !child.takenOver &&
      !child.exited &&
      parent.worktrees.get(child.worktreeId)?.path === actor.worktree
    );
  }

  /** One parent per canonical repository; a live duplicate returns the existing parent's ID. */
  reserve(
    repository: string,
  ): { existing: string } | { bind(terminalId: string): void; release(): void } {
    const current = this.slots.get(repository);
    if (current) {
      if (current.terminalId !== null) return { existing: current.terminalId };
      throw new Error("An orchestrator is already starting in this repository");
    }
    const parent: Parent = {
      repository,
      terminalId: null,
      generation: null,
      active: true,
      starting: 0,
      creating: 0,
      uncertain: 0,
      refusedWorktrees: new Set(),
      children: new Map(),
      worktrees: new Map(),
      history: [],
      aborts: new Set(),
    };
    this.slots.set(repository, parent);
    return {
      bind: (terminalId) => {
        if (this.slots.get(repository) !== parent || parent.terminalId !== null) return;
        parent.terminalId = terminalId;
        // A session made orchestrator again keeps its earlier, retired action history.
        const previous = this.parents.get(terminalId);
        if (previous && previous !== parent) {
          parent.history.push(...previous.history.slice(-HISTORY));
          this.retire(previous);
        }
        this.parents.set(terminalId, parent);
        if (this.early.delete(terminalId)) this.retire(parent);
        this.changed();
      },
      release: () => {
        if (this.slots.get(repository) === parent && parent.terminalId === null)
          this.slots.delete(repository);
      },
    };
  }

  /** Restore main-owned history without carrying an old principal or pending work. */
  restoreHistory(id: string, history: readonly OrchestrationEntry[]): void {
    const parent = this.parents.get(id);
    if (parent) parent.history.push(...history.slice(-HISTORY));
  }

  ownedWorktrees(id: string): OwnedWorktree[] {
    return [...(this.parents.get(id)?.worktrees.values() ?? [])].map((tree) => ({
      path: tree.path,
      identity: tree.identity,
      state: tree.state === "unused" ? "unused" : "used",
    }));
  }

  uncertainWorktrees(id: string): number {
    return this.parents.get(id)?.uncertain ?? 0;
  }

  /** Saved identity must still match; invalid entries never grant capabilities. */
  async restoreWorktrees(
    id: string,
    trees: readonly OwnedWorktree[],
    uncertain = 0,
  ): Promise<void> {
    const parent = this.parents.get(id);
    if (!parent?.active) return;
    parent.uncertain = uncertain;
    for (const saved of trees) {
      const tree = await this.host
        .restoreWorktree(parent.repository, saved.path)
        .catch(() => undefined);
      if (this.active(parent.repository) !== id) return;
      const key = locationId(saved.path);
      if (!tree || tree.identity !== saved.identity) {
        parent.refusedWorktrees.add(key);
        continue;
      }
      if (parent.worktrees.has(key)) continue;
      if (saved.state === "unused" && this.unused(parent) >= WORKTREE_LIMIT) continue;
      parent.worktrees.set(key, { ...tree, path: saved.path, state: saved.state });
      this.host.forge?.track({ repository: parent.repository, path: saved.path, ...tree });
    }
    this.changed();
  }

  /** Reserve restored children before launches, so they count against the live limit. */
  async restoreChild(parentId: string, entry: WorkspaceTerminal): Promise<boolean> {
    const parent = this.parents.get(parentId);
    const existing = parent?.children.get(entry.id);
    if (existing) return parent?.active === true && !existing.takenOver;
    if (
      !parent?.active ||
      parent.repository !== entry.repository ||
      parent.refusedWorktrees.has(locationId(entry.worktree)) ||
      (!entry.exited && this.running(parent) >= this.childLimit())
    )
      return false;
    const tree = await this.host
      .restoreWorktree(parent.repository, entry.worktree)
      .catch(() => undefined);
    if (
      !tree ||
      this.active(parent.repository) !== parentId ||
      (!entry.exited && this.running(parent) >= this.childLimit())
    )
      return false;
    const worktreeId = locationId(entry.worktree);
    const owned = parent.worktrees.get(worktreeId);
    if (owned && owned.identity !== tree.identity) return false;
    parent.worktrees.set(worktreeId, { ...tree, path: entry.worktree, state: "used" });
    this.host.forge?.track({ repository: parent.repository, path: entry.worktree, ...tree });
    parent.children.set(entry.id, {
      worktreeId,
      exited: entry.exited === true,
      takenOver: false,
      tailAt: 0,
    });
    if (entry.review) this.reviews.restore(entry.id, entry.review);
    this.changed();
    return true;
  }

  /** The live orchestrator's session in a repository, if any. */
  active(repository: string): string | undefined {
    const parent = this.slots.get(repository);
    return parent?.active && parent.terminalId !== null ? parent.terminalId : undefined;
  }

  /** The human revoked the role: authority ends as on exit, and the session keeps running. */
  revoke(id: string): void {
    const parent = this.parents.get(id);
    if (parent) this.retire(parent);
  }

  /** Exit revokes the parent's authority; children keep running under human control. */
  exited(id: string): void {
    this.childEvents.publish();
    const parent = this.parents.get(id);
    if (parent) {
      this.retire(parent);
      return;
    }
    const child = this.child(id);
    if (child) {
      child.exited = true;
      this.changed();
    } else if (this.launching()) this.early.add(id);
  }

  /** The session left the board. A parent's history goes with its row. */
  removed(id: string): void {
    this.childEvents.publish();
    this.reviews.stop(id);
    this.reviews.forget(id);
    this.handoffs.remove(id);
    const parent = this.parents.get(id);
    if (parent) {
      this.retire(parent);
      this.parents.delete(id);
    }
    this.reviewRuns.delete(id);
    for (const entry of this.parents.values()) entry.children.delete(id);
  }

  /** A human relaunch under the same ID (resume, new conversation) is never the orchestrator's. */
  relaunched(id: string): void {
    this.reviews.stop(id);
    this.childEvents.publish();
    for (const parent of this.parents.values()) parent.children.delete(id);
  }

  takeOver(id: string): void {
    this.reviews.stop(id);
    this.childEvents.publish();
    for (const parent of this.parents.values()) {
      const child = parent.children.get(id);
      if (!child) continue;
      if (child.takenOver) return;
      child.takenOver = true;
      this.note(parent, {
        id: `takeover-${id}`,
        action: "take_over",
        label: this.label(id),
        status: "succeeded",
        at: this.now(),
      });
      this.changed();
      return;
    }
    throw new Error("This session has no orchestrator");
  }

  /** Owned children still running without a read handoff, or with a newer unread report. */
  waitingOn(id: string): number {
    const parent = this.parents.get(id);
    if (!parent?.active) return 0;
    let count = 0;
    for (const [childId, child] of parent.children) {
      if (child.takenOver) continue;
      const latest = this.handoffs.latest(childId);
      if (latest ? latest.seq > (child.readHandoff ?? 0) : !child.exited) count++;
    }
    return count;
  }

  view(id: string): OrchestrationView | undefined {
    const parent = this.parents.get(id);
    if (parent)
      return {
        role: "orchestrator",
        active: parent.active,
        children: this.running(parent),
        history: [...parent.history],
      };
    for (const [parentId, entry] of this.parents) {
      const child = entry.children.get(id);
      if (child) return { role: "child", parentId, takenOver: child.takenOver };
    }
    return undefined;
  }
  protected startReview(
    id: string,
    options: ReviewOptions,
    actor: Principal,
    operations: Operations,
  ): void {
    this.reviewRuns.set(id, { actor, operations });
    this.reviews.start(id, options);
  }

  readReviews(parentId: string): void {
    const parent = this.parents.get(parentId);
    if (parent) for (const id of parent.children.keys()) this.reviews.read(id);
  }

  stopReviews(id: string): void {
    this.reviews.stop(id);
    const parent = this.parents.get(id);
    if (parent) for (const childId of parent.children.keys()) this.reviews.stop(childId);
  }

  reviewAttentionReason(parentId: string): string | undefined {
    const parent = this.parents.get(parentId);
    if (!parent?.active) return undefined;
    for (const [id, child] of parent.children) {
      if (child.takenOver) continue;
      const state = this.reviews.view(id);
      if (state && this.reviews.unread(id) !== undefined) return reviewLabel(state);
    }
    return undefined;
  }

  reviewUnreadAt(parentId: string): number | undefined {
    const parent = this.parents.get(parentId);
    if (!parent?.active) return undefined;
    const times = [...parent.children].flatMap(([id, child]) => {
      if (child.takenOver) return [];
      const at = this.reviews.unread(id);
      return at === undefined ? [] : [at];
    });
    return times.length ? Math.min(...times) : undefined;
  }

  private async reviewStop(id: string): Promise<void> {
    const state = this.reviews.view(id);
    const run = state && this.reviewRuns.get(state.authorId);
    if (!run) throw new ControlError("forbidden");
    const { actor, operations } = run;
    const parent = this.parent(actor);
    const child = this.own(parent, id);
    if (!child) throw new ControlError("forbidden");
    const label = this.label(id);
    const operation = await operations.begin(
      actor,
      "stop",
      `review-stop-${randomUUID()}`,
      JSON.stringify([id]),
      id,
    );
    try {
      operations.lookup(actor, { operationId: operation.operationId });
      this.parent(actor);
      const current = this.reviews.view(id);
      if (
        this.own(parent, id) !== child ||
        current?.phase !== state.phase ||
        current.round !== state.round
      )
        throw new ControlError("conflict");
      // Unlike a human/parent stop, this validated completion preserves the loop.
      await this.host.stop(id);
      await this.finish(actor, parent, operations, operation, label, "succeeded", id);
    } catch (error) {
      await this.finish(actor, parent, operations, operation, label, "indeterminate").catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async reviewStep(
    authorId: string,
    reviewer: boolean,
    prompt: string,
  ): Promise<string | undefined> {
    const run = this.reviewRuns.get(authorId);
    if (!run) throw new ControlError("forbidden");
    const { actor, operations } = run;
    const parent = this.parent(actor);
    const child = this.own(parent, authorId);
    const tree = child && parent.worktrees.get(child.worktreeId);
    const state = this.reviews.view(authorId);
    const author = this.host.terminals().find((row) => row.id === authorId);
    if (!tree || !author || !state) throw new ControlError("not_found");
    if (this.running(parent) + parent.starting >= this.childLimit()) return undefined;
    const agent = reviewer ? state.agent : author.agent;
    let operation: Operation | undefined;
    const validate = () => {
      if (operation) operations.lookup(actor, { operationId: operation.operationId });
      this.parent(actor);
      if (reviewer && !this.reviews.reviewReady(authorId)) throw new ControlError("conflict");
      const current = this.reviews.view(authorId);
      if (
        this.own(parent, authorId) !== child ||
        current?.phase !== state.phase ||
        current.round !== state.round ||
        this.host.bypassDefaults?.(agent) ||
        this.host
          .terminals()
          .some(
            (row) =>
              row.worktree === tree.path &&
              !row.exited &&
              !(row.id === authorId && row.dormant && !reviewer),
          )
      )
        throw new ControlError("conflict");
    };
    validate();
    parent.starting++;
    const label = this.label(authorId);
    try {
      operation = await operations.begin(
        actor,
        "launch",
        `review-${randomUUID()}`,
        JSON.stringify([authorId, state.round, reviewer]),
        authorId,
      );
      await this.host.saveHandoffs?.();
      validate();
      const resume = reviewer
        ? undefined
        : { id: authorId, conversationId: author.conversationId ?? "" };
      if (!reviewer) child.exited = false;
      const id = await this.host.launch(
        actor.terminalId,
        parent.repository,
        tree.path,
        tree.identity,
        agent,
        prompt,
        { ...(resume ? { resume } : {}), loop: state, validate },
      );
      if (reviewer)
        parent.children.set(id, {
          worktreeId: child.worktreeId,
          exited: this.early.delete(id),
          takenOver: false,
          tailAt: 0,
        });
      else child.exited ||= this.early.delete(id);
      this.reviews.attach(id, authorId);
      const current = this.reviews.view(authorId);
      const cancelled =
        !parent.active || current?.phase !== state.phase || current.round !== state.round;
      if (cancelled) await this.host.stop(id);
      this.changed();
      if (reviewer && !cancelled) this.host.place?.(id, actor.terminalId);
      await this.finish(actor, parent, operations, operation, label, "succeeded", id);
      return id;
    } catch (error) {
      if (!reviewer) child.exited = true;
      if (operation)
        await this.finish(actor, parent, operations, operation, label, "indeterminate").catch(
          () => undefined,
        );
      throw error;
    } finally {
      parent.starting--;
      this.childEvents.publish();
      if (!this.launching()) this.early.clear();
    }
  }

  protected parent(actor: Principal): Parent {
    if (actor.role !== "orchestrator") throw new ControlError("forbidden");
    const parent = this.parents.get(actor.terminalId);
    if (!parent?.active || parent.repository !== actor.repository)
      throw new ControlError("forbidden");
    parent.generation ??= actor.generation;
    if (parent.generation !== actor.generation) throw new ControlError("forbidden");
    return parent;
  }

  protected own(parent: Parent, id: string): Child | undefined {
    const child = parent.children.get(id);
    return child && !child.takenOver ? child : undefined;
  }

  private child(id: string): Child | undefined {
    for (const parent of this.parents.values()) {
      const child = parent.children.get(id);
      if (child) return child;
    }
    return undefined;
  }

  protected running(parent: Parent): number {
    return [...parent.children.values()].filter((child) => !child.exited).length;
  }

  protected unused(parent: Parent): number {
    return (
      [...parent.worktrees.values()].filter((tree) => tree.state !== "used").length +
      parent.uncertain
    );
  }

  protected launching(): boolean {
    return [...this.parents.values(), ...this.slots.values()].some(
      (parent) => parent.starting > 0 || parent.terminalId === null,
    );
  }

  private retire(parent: Parent): void {
    if (!parent.active) return;
    parent.active = false;
    for (const id of parent.children.keys()) this.reviews.stop(id);
    if (this.slots.get(parent.repository) === parent) this.slots.delete(parent.repository);
    for (const abort of parent.aborts) abort.abort();
    this.changed();
  }

  protected label(id: string): string {
    const row = this.host.terminals().find((entry) => entry.id === id);
    return metadataName(row?.branch ?? id);
  }

  protected entry(operation: Operation, label: string): OrchestrationEntry {
    return {
      id: operation.operationId,
      action: operation.action,
      label,
      status: operation.status,
      at: this.now(),
    };
  }

  protected note(parent: Parent, entry: OrchestrationEntry): void {
    const index = parent.history.findIndex((item) => item.id === entry.id);
    if (index >= 0) parent.history.splice(index, 1);
    parent.history.push(entry);
    if (parent.history.length > HISTORY) parent.history.splice(0, parent.history.length - HISTORY);
    this.changed();
  }

  protected async finish(
    actor: Principal,
    parent: Parent,
    operations: Operations,
    operation: Operation,
    label: string,
    status: "succeeded" | "failed" | "indeterminate",
    resultId: string | null = null,
  ): Promise<Operation> {
    const record = await operations.finish(
      actor,
      operation.operationId,
      status,
      status === "succeeded" ? "completed" : status === "failed" ? "error" : "uncertain",
      resultId,
    );
    this.note(parent, this.entry(record, label));
    return record;
  }

  /** Limits and foreign targets are recorded, then rejected; retries see the same record. */
  protected async refuse(
    actor: Principal,
    parent: Parent,
    operations: Operations,
    operation: Operation,
    label: string,
    code: ControlError["code"],
  ): Promise<never> {
    const record = await operations.finish(actor, operation.operationId, "failed", "refused");
    this.note(parent, this.entry(record, label));
    throw new ControlError(code);
  }
}
