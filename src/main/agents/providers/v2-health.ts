import { readOwnedFile } from "./v2-files";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import type { HookSignal } from "../../../shared/hooks";
import type { CodexHookState } from "../../../shared/agents";
import { atomicPrivate } from "../../control/private-files";

const owners = new Map<string, { latest: number; writes: Promise<void> }>();

/** Profile-local observations, never an agent trust store. */
export class V2Health {
  private state: CodexHookState = "not-reviewed";
  private readonly owner;
  constructor(
    private readonly directory: string,
    private readonly id: string,
    private readonly fingerprint: string,
  ) {
    const key = join(directory, `${id}-health.json`);
    let owner = owners.get(key);
    if (!owner) {
      owner = { latest: 0, writes: Promise.resolve() };
      owners.set(key, owner);
    }
    this.owner = owner;
  }
  async load(): Promise<void> {
    try {
      const file = join(this.directory, `${this.id}-health.json`);
      const data: unknown = JSON.parse(await readOwnedFile(file, 4096));
      if (
        typeof data !== "object" ||
        data === null ||
        !("fingerprint" in data) ||
        !("state" in data)
      )
        return;
      if (
        typeof data.fingerprint === "string" &&
        (data.state === "trusted" ||
          data.state === "declined" ||
          data.state === "outdated" ||
          data.state === "not-reviewed")
      )
        this.state = data.fingerprint !== this.fingerprint ? "outdated" : data.state;
    } catch {
      /* Absent/corrupt observations do not grant trust. */
    }
  }
  get(): CodexHookState {
    return this.state;
  }
  begin(): number {
    return ++this.owner.latest;
  }
  set(state: CodexHookState, launch: number): void {
    if (launch !== this.owner.latest || this.state === state) return;
    this.state = state;
    const data = { fingerprint: this.fingerprint, state };
    this.owner.writes = this.owner.writes
      .then(() => atomicPrivate(this.directory, `${this.id}-health.json`, data))
      .catch(() => undefined);
  }
  flush(): Promise<void> {
    return this.owner.writes;
  }
}
/** Include health writes from terminals removed before application shutdown. */
export async function flushV2Health(): Promise<void> {
  await Promise.all([...owners.values()].map((owner) => owner.writes));
}
const stores = new Map<string, { fingerprint: string; store: Promise<V2Health> }>();
export function healthStore(
  directory: string,
  model: AgentManifestV2,
  definitions: unknown,
): Promise<V2Health> {
  const fingerprint = createHash("sha256").update(JSON.stringify(definitions)).digest("hex");
  const key = JSON.stringify([directory, model.id]);
  const cached = stores.get(key);
  if (cached?.fingerprint === fingerprint) return cached.store;
  const store = (async () => {
    const result = new V2Health(directory, model.id, fingerprint);
    await result.flush();
    await result.load();
    return result;
  })();
  stores.set(key, { fingerprint, store });
  return store;
}
export class V2ExecutionHooks {
  private observed = false;
  private readonly seen = new Set<string>();
  private promptTurn: number | undefined;
  private stoppedTurn: number | undefined;
  constructor(
    readonly model: AgentManifestV2,
    readonly channels: ReadonlyMap<string, unknown>,
    readonly health: V2Health,
    private readonly launch = health.begin(),
  ) {}
  required(): boolean {
    return (
      this.model.execution.completionChannels.some((id) => this.channels.has(id)) &&
      (this.model.execution.completion === "attached" || this.observed)
    );
  }
  /** Returns false for metadata or duplicate completion in this execution turn. */
  accept(signal: HookSignal, turn: number): boolean {
    const spec = this.model.health;
    const healthChannel = spec && signal.channel === spec.channel;
    if (healthChannel && signal.caseId) {
      this.seen.add(signal.caseId);
      if (signal.caseId === spec.promptEvent) this.promptTurn = turn;
      if (signal.action === "ready") return false;
      this.observed = true;
    }
    const completion =
      signal.endsTurn === true &&
      signal.channel !== undefined &&
      this.model.execution.completionChannels.includes(signal.channel);
    if (completion) {
      if (healthChannel && signal.caseId === spec.completionEvent) {
        if (
          turn > 0 &&
          this.promptTurn === turn &&
          spec.requiredEvents.every((id) => this.seen.has(id))
        )
          this.health.set("trusted", this.launch);
        else if (this.promptTurn !== turn) this.health.set("declined", this.launch);
      } else if (spec && this.promptTurn !== turn) this.health.set("declined", this.launch);
      // Ordered streams already discard stale/duplicate reports in the reducer.
      // A newer Stop can belong to a turn whose working report was lost.
      const ordered = this.model.hooks?.channels.some(
        (channel) => channel.id === signal.channel && channel.mapping.sequence !== undefined,
      );
      if (turn > 0 && this.stoppedTurn === turn && !ordered) return false;
      if (turn > 0) this.stoppedTurn = turn;
    }
    if (!spec && signal.channel && this.model.execution.completionChannels.includes(signal.channel))
      this.observed = true;
    return true;
  }
  idle(turn: number): void {
    if (this.model.health && this.promptTurn !== turn && this.health.get() === "trusted")
      this.health.set("declined", this.launch);
  }
  review(tail: readonly string[]): void {
    const review = this.model.health?.review;
    if (!review) return;
    const text = tail.slice(-review.lines).join("\n");
    const normalize = (value: string) => (review.caseSensitive ? value : value.toLowerCase());
    if (review.contains.every((part) => normalize(text).includes(normalize(part))))
      this.health.set(
        ["trusted", "outdated"].includes(this.health.get()) ? "outdated" : "not-reviewed",
        this.launch,
      );
  }
}
