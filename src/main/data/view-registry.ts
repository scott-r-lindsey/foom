import { hostAlias } from "../../shared/registered-hosts";
import type {
  DataView,
  DataViews,
  ViewParams,
  ViewRequest,
  ViewSnapshot,
} from "../../shared/data-views";
import type { ViewChanges } from "./view-changes";

export const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const LISTS = new Set<DataView>(["repositories", "worktrees", "sessions"]);
const VIEWS = new Set([
  "settings",
  "hosts",
  "agents",
  "repositories",
  "worktrees",
  "sessions",
  "environment",
  "config",
  "fonts",
  "sounds",
  "readiness",
]);
export function viewRequest(value: unknown): value is ViewRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value));
  } catch {
    return false;
  }
  if (size > 32768) return false;
  const fields = Object.entries(value);
  const id: unknown = Reflect.get(value, "id");
  const view: unknown = Reflect.get(value, "view");
  const params: unknown = Reflect.get(value, "params");
  if (
    fields.length !== 3 ||
    !fields.every(([key]) => ["id", "view", "params"].includes(key)) ||
    typeof id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
    typeof view !== "string" ||
    !VIEWS.has(view) ||
    typeof params !== "object" ||
    params === null ||
    Array.isArray(params) ||
    (Object.getPrototypeOf(params) !== Object.prototype && Object.getPrototypeOf(params) !== null)
  )
    return false;
  return (
    Object.entries(params).every(([key, entry]) => {
      if (key === "machine" && view === "agents")
        return (
          entry === "local" ||
          (typeof entry === "string" && entry.startsWith("host:") && hostAlias(entry.slice(5)))
        );
      if (key === "repository" && view === "worktrees")
        return (
          typeof entry === "string" &&
          entry.length > 0 &&
          entry.length <= 4096 &&
          !entry.includes("\0")
        );
      if (
        (key === "offset" || key === "limit") &&
        (view === "repositories" || view === "worktrees" || view === "sessions")
      )
        return (
          typeof entry === "number" &&
          Number.isSafeInteger(entry) &&
          entry >= (key === "limit" ? 1 : 0) &&
          entry <= (key === "limit" ? 100 : 1000000)
        );
      return false;
    }) &&
    (view !== "worktrees" || Object.hasOwn(params, "repository"))
  );
}
export type ViewReader = (
  view: DataView,
  params: ViewParams,
) => DataViews[DataView] | Promise<DataViews[DataView]>;

/** Register before reading; invalidation during an awaited read discards and repeats it. */
export class ViewRegistry {
  private generation = 0;
  private readonly subscriptions = new Map<
    string,
    {
      request: ViewRequest;
      generation: number;
      dirty: boolean;
      reading: boolean;
      awaiting: number | undefined;
      send: (value: ViewSnapshot) => void;
    }
  >();
  private readonly off: () => void;
  constructor(
    private readonly changes: ViewChanges,
    private readonly read: ViewReader,
  ) {
    this.off = changes.subscribe((views) => {
      for (const entry of this.subscriptions.values())
        if (views.has(entry.request.view)) {
          entry.dirty = true;
          this.schedule(entry.request.id);
        }
    });
  }
  subscribe(input: unknown, send: (value: ViewSnapshot) => void): void {
    if (!viewRequest(input) || this.subscriptions.has(input.id) || this.subscriptions.size >= 32)
      throw new Error("Invalid view subscription");
    const request = structuredClone(input);
    this.subscriptions.set(request.id, {
      request,
      generation: ++this.generation,
      dirty: true,
      reading: false,
      awaiting: undefined,
      send,
    });
    this.schedule(request.id);
  }
  unsubscribe(id: unknown): void {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
      throw new Error("Invalid view subscription");
    this.subscriptions.delete(id);
  }
  acknowledge(id: unknown, generation: unknown, revision: unknown): void {
    if (
      typeof id !== "string" ||
      !Number.isSafeInteger(generation) ||
      !Number.isSafeInteger(revision)
    )
      throw new Error("Invalid view acknowledgement");
    const entry = this.subscriptions.get(id);
    if (!entry || entry.generation !== generation || entry.awaiting !== revision) return;
    entry.awaiting = undefined;
    if (entry.dirty) this.schedule(id);
  }
  clear(): void {
    this.subscriptions.clear();
  }
  dispose(): void {
    this.clear();
    this.off();
  }
  private isDirty(id: string): boolean {
    return this.subscriptions.get(id)?.dirty === true;
  }
  private schedule(id: string): void {
    const entry = this.subscriptions.get(id);
    if (!entry || entry.reading || entry.awaiting !== undefined) return;
    entry.reading = true;
    queueMicrotask(() => {
      void this.deliver(id, entry);
    });
  }
  private async deliver(
    id: string,
    entry: NonNullable<ReturnType<typeof this.subscriptions.get>>,
  ): Promise<void> {
    while (this.subscriptions.get(id) === entry && entry.dirty) {
      entry.dirty = false;
      const revision = this.changes.revision;
      const base = {
        ...entry.request,
        generation: entry.generation,
        revision,
        viewRevision: this.changes.current(entry.request.view),
      };
      let snapshot: ViewSnapshot;
      try {
        let data = await this.read(entry.request.view, entry.request.params);
        let nextOffset: number | undefined;
        if (LISTS.has(entry.request.view)) {
          if (!Array.isArray(data)) throw new Error("Invalid list view");
          const { offset = 0, limit = 100 } = entry.request.params;
          if (data.length > offset + limit) nextOffset = offset + limit;
          data = data.slice(offset, offset + limit);
        }
        snapshot =
          Buffer.byteLength(JSON.stringify({ ...base, data, nextOffset })) > MAX_VIEW_BYTES
            ? { ...base, error: "too-large" }
            : { ...base, data, ...(nextOffset === undefined ? {} : { nextOffset }) };
      } catch {
        snapshot = { ...base, error: "unavailable" };
      }
      if (this.subscriptions.get(id) !== entry) return;
      if (!this.isDirty(id)) {
        entry.awaiting = snapshot.revision;
        entry.send(snapshot);
        break;
      }
    }
    entry.reading = false;
    if (entry.awaiting === undefined && entry.dirty) this.schedule(id);
  }
}
