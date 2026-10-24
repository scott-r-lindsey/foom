/** Immutable exit observations; inventory readiness precedes final classification. */
export type SessionExit = Readonly<{
  phase: "host-observed" | "inventory-settled" | "evaluation-settled";
  code: number;
}>;

type Invocation = {
  released: boolean;
  removed: boolean;
  exit?: SessionExit;
  evaluation?: Promise<void>;
};

export interface SessionLifecycleDependencies {
  release(id: string): void;
  observed(id: string): void;
  evaluate(id: string, code: number): Promise<void>;
  inventorySettled(id: string): void;
}

/** Host exit, resource release and queued evaluation are separate invocation phases. */
export class SessionLifecycle {
  private readonly invocations = new Map<string, Invocation>();
  constructor(private readonly deps: SessionLifecycleDependencies) {}

  private invocation(id: string): Invocation {
    let current = this.invocations.get(id);
    if (!current) {
      current = { released: false, removed: false };
      this.invocations.set(id, current);
    }
    return current;
  }

  exit(id: string): SessionExit | undefined {
    return this.invocations.get(id)?.exit;
  }

  /** Safe before or after host exit, including removal of an already exited row. */
  release(id: string): void {
    const current = this.invocation(id);
    if (current.released) return;
    current.released = true;
    this.deps.release(id);
  }

  exited(id: string, code: number): Promise<void> {
    const current = this.invocation(id);
    if (current.removed || current.exit) return current.evaluation ?? Promise.resolve();
    current.exit = Object.freeze({ phase: "host-observed", code });
    this.release(id);
    // Authority must end synchronously, before execution transitions or queued work.
    this.deps.observed(id);
    current.evaluation = this.deps.evaluate(id, code).then(() => {
      if (this.invocations.get(id) !== current || current.removed) return;
      if (current.exit?.phase === "inventory-settled")
        current.exit = Object.freeze({ phase: "evaluation-settled", code });
    });
    return current.evaluation;
  }

  /** Called inside the terminal queue once exit metadata is ready for inventory. */
  inventorySettled(id: string): void {
    const current = this.invocations.get(id);
    if (!current || current.removed || current.exit?.phase !== "host-observed") return;
    current.exit = Object.freeze({ phase: "inventory-settled", code: current.exit.code });
    this.deps.inventorySettled(id);
  }

  removed(id: string): void {
    const current = this.invocation(id);
    if (current.removed) return;
    this.release(id);
    if (!current.exit) this.deps.observed(id);
    current.removed = true;
  }

  /** Resume creates a fresh invocation, even when its terminal ID is unchanged. */
  reset(id: string): void {
    this.invocations.delete(id);
  }
}
