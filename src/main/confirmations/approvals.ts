import { randomUUID } from "node:crypto";
import type {
  ApprovalFeed,
  ApprovalRow,
  DialogContent,
  DialogOutcome,
} from "../../shared/confirmation";
import type { InterfaceTheme } from "../../shared/interface-theme";

type Caller = { resolve(outcome: DialogOutcome): void; cleanup(): void };
interface Entry {
  key: string;
  content: DialogContent;
  row: ApprovalRow;
  readyAt: number;
  timer?: NodeJS.Timeout;
  expires?: NodeJS.Timeout;
  unsubscribe?: () => void;
  callers: Set<Caller>;
}
/** App-owned consent queue. Presentation, identities and each caller's lifetime stay in main. */
export class Approvals {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private visible = false;
  private run: { controller: AbortController } | undefined;
  constructor(
    private readonly present: (content: DialogContent, signal: AbortSignal) => Promise<boolean>,
    private readonly theme: () => InterfaceTheme,
    private readonly now = () => performance.now(),
  ) {}
  readonly feed: ApprovalFeed = {
    current: () => [...this.entries.values()].map((entry) => entry.row),
    subscribe: (listener) => {
      this.listeners.add(listener);
      listener();
      return () => this.listeners.delete(listener);
    },
    presented: (visible) => {
      this.visible = visible;
      if (visible) for (const entry of this.entries.values()) this.arm(entry);
    },
    answer: (id, accepted) => {
      if (Array.isArray(accepted)) {
        // Validate the whole snapshot against main-owned removal status before resolving any caller.
        if (!accepted.length || new Set(accepted).size !== accepted.length) return;
        const entries = accepted.map((id: unknown) =>
          typeof id === "string" ? this.entries.get(id) : undefined,
        );
        if (
          entries.some(
            (entry) =>
              !entry ||
              entry.row.kind !== "Worktree removal" ||
              entry.content.removal?.item.changes !== "" ||
              entry.content.pluginFeed !== undefined ||
              entry.content.pairing !== undefined ||
              !this.ready(entry),
          )
        )
          return;
        for (const entry of entries) if (entry) this.finish(entry, "accepted");
      } else if (typeof accepted === "boolean") {
        const entry = this.entries.get(id);
        if (!entry || !this.ready(entry)) return;
        const plugin = entry.content.pluginFeed;
        const progress = plugin?.current();
        if (progress?.phase === "running") return;
        if (plugin && !progress && accepted) {
          plugin.accept();
          return;
        }
        this.finish(entry, accepted ? "accepted" : "declined");
      }
    },
  };
  private ready(entry: Entry): boolean {
    return (
      this.visible &&
      entry.row.request.presented &&
      this.now() >= entry.readyAt &&
      (entry.row.request.pairing === undefined || Date.now() < entry.row.request.pairing.expiresAt)
    );
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private arm(entry: Entry): void {
    if (Number.isFinite(entry.readyAt)) return;
    entry.readyAt = this.now() + 900;
    entry.timer = setTimeout(() => {
      entry.row = { ...entry.row, request: { ...entry.row.request, presented: true } };
      this.changed();
    }, 900);
    entry.timer.unref();
  }
  private finish(entry: Entry, outcome: DialogOutcome): void {
    if (!this.entries.delete(entry.row.request.id)) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.expires);
    entry.unsubscribe?.();
    for (const caller of entry.callers) {
      caller.cleanup();
      caller.resolve(outcome);
    }
    if (!this.entries.size) {
      this.run?.controller.abort();
      this.run = undefined;
      this.visible = false;
    }
    this.changed();
  }
  request(content: DialogContent, signal?: AbortSignal): Promise<boolean> {
    return this.requestOutcome(content, signal).then((outcome) => outcome === "accepted");
  }
  requestOutcome(content: DialogContent, signal?: AbortSignal): Promise<DialogOutcome> {
    if (signal?.aborted) return Promise.resolve("cancelled");
    const { approval, removal, pluginFeed, ...plain } = content;
    delete plain.userAction;
    delete plain.feed;
    delete plain.removalFeed;
    delete plain.approvalFeed;
    delete plain.approvals;
    const kind = approval?.kind ?? (removal ? "Worktree removal" : "Background");
    const item =
      kind === "Worktree removal" && !pluginFeed && !plain.pairing ? removal?.item : undefined;
    if (
      item?.changes &&
      !(item.fileCount && Number.isSafeInteger(item.fileCount) && item.fileCount > 0)
    )
      return Promise.resolve("unavailable");
    // Callers supply canonical target/generation keys where an operation has live state.
    const key = JSON.stringify([
      approval?.kind,
      approval?.key ?? removal?.group,
      removal ? { ...removal.item, id: undefined } : undefined,
      approval?.origin,
      plain,
    ]);
    let entry = [...this.entries.values()].find((entry) => entry.key === key);
    if (entry) entry.row = { ...entry.row, repeats: entry.row.repeats + 1 };
    else {
      const request = {
        ...plain,
        ...(item
          ? {
              worktreePath: item.path,
              changes: item.changes,
              ...(item.fileCount === undefined ? {} : { discardCount: item.fileCount }),
              accept: item.changes ? "Discard changes and remove" : "Remove worktree",
              ...(item.pullRequest
                ? {
                    facts: [
                      ...(plain.facts ?? []),
                      {
                        label: "PR",
                        value: `#${String(item.pullRequest.number)} · ${item.pullRequest.state}`,
                      },
                    ],
                  }
                : {}),
            }
          : {}),
        id: randomUUID(),
        presented: false,
        theme: this.theme(),
      };
      entry = {
        key,
        content,
        row: {
          request,
          kind,
          origin: (
            approval?.origin ?? (item ? "Background cleanup" : "Foom · background · no tile")
          )
            .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f]/gu, " ")
            .slice(0, 8192),
          repeats: 1,
        },
        callers: new Set(),
        readyAt: Infinity,
      };
      this.entries.set(request.id, entry);
      const current = entry;
      if (pluginFeed)
        current.unsubscribe = pluginFeed.subscribe(() => {
          const pluginSetup = pluginFeed.current();
          if (!pluginSetup) return;
          current.row = { ...current.row, request: { ...current.row.request, pluginSetup } };
          this.changed();
        });
      if (request.pairing) {
        current.expires = setTimeout(
          () => {
            this.finish(current, "cancelled");
          },
          Math.max(0, request.pairing.expiresAt - Date.now()),
        );
        current.expires.unref();
      }
      if (this.visible) this.arm(current);
    }
    const current = entry;
    const result = new Promise<DialogOutcome>((resolve) => {
      const cancel = () => {
        caller.cleanup();
        current.callers.delete(caller);
        resolve("cancelled");
        if (!current.callers.size) this.finish(current, "cancelled");
      };
      const caller: Caller = {
        resolve,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      };
      current.callers.add(caller);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    this.changed();
    if (!this.run && this.entries.size) {
      const run = { controller: new AbortController() };
      this.run = run;
      void this.present(
        { title: "Approvals waiting", accept: "Approve", approvalFeed: this.feed },
        run.controller.signal,
      )
        .catch(() => false)
        .finally(() => {
          if (this.run !== run) return;
          for (const entry of [...this.entries.values()]) this.finish(entry, "unavailable");
        });
    }
    return result;
  }
}
