import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalRoot, openInside } from "../previews/contained-files";
import type { Principal } from "./types";
import { ControlError, exact, object } from "./validation";

export const PREVIEW_METHODS = ["open_preview", "list_previews", "close_preview"];
export const PREVIEW_LIMITS = { perAgent: 4, total: 12, burst: 6, refillMs: 10000 };
export type Placement = "landing" | "empty" | "sidebar";
export interface AgentPreview {
  previewId: string;
  owner: string | null;
  session: string;
  worktree: string;
  real: string;
  path: string;
  kind: "markdown" | "html";
}
export interface PreviewAudit {
  session: string;
  action: string;
  preview: string;
  path: string;
  outcome: string;
}
export interface PreviewBackend {
  open(actor: Principal, preview: AgentPreview, sidebar: boolean): Promise<Placement>;
  close(id: string): Promise<void>;
  visible(id: string): boolean;
  has(id: string): boolean;
}

/** Instance-wide policy; no transport or renderer can supply a worktree or owner. */
export class PreviewBroker {
  private readonly previews = new Map<string, AgentPreview>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly dismissed = new Set<string>();
  private pending = Promise.resolve();
  constructor(
    private readonly backend: PreviewBackend,
    private readonly audit: (event: PreviewAudit) => Promise<void>,
    private readonly active: (actor: Principal) => void,
    private readonly now: () => number = Date.now,
    private readonly limits = PREVIEW_LIMITS,
  ) {}
  call(actor: Principal, method: string, input: unknown): Promise<unknown> {
    const next = this.pending.then(() => this.dispatch(actor, method, input));
    this.pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private owned(actor: Principal): AgentPreview[] {
    for (const [id] of this.previews) if (!this.backend.has(id)) this.previews.delete(id);
    return [...this.previews.values()].filter((preview) => preview.owner === actor.generation);
  }
  private take(actor: Principal): void {
    const at = this.now();
    const bucket = this.buckets.get(actor.generation) ?? { tokens: this.limits.burst, at };
    const refill = Math.floor((at - bucket.at) / this.limits.refillMs);
    if (refill > 0) {
      bucket.tokens = Math.min(this.limits.burst, bucket.tokens + refill);
      bucket.at += refill * this.limits.refillMs;
    }
    this.buckets.set(actor.generation, bucket);
    if (bucket.tokens === 0) throw new ControlError("capacity");
    bucket.tokens--;
  }
  private resolve(actor: Principal, raw: unknown) {
    if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 1024 || /\p{Cc}/u.test(raw))
      throw new ControlError("invalid_request");
    let root: string;
    try {
      root = canonicalRoot(actor.worktree);
    } catch {
      throw new ControlError("unavailable");
    }
    const relative = path.isAbsolute(raw)
      ? path.relative(actor.worktree, raw)
      : path.normalize(raw);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new ControlError("forbidden");
    if (!/\.(md|markdown|html|htm)$/i.test(relative)) throw new ControlError("invalid_request");
    const opened = openInside(
      root,
      `/${relative.split(path.sep).map(encodeURIComponent).join("/")}`,
    );
    if (opened.status !== 200)
      throw new ControlError(
        opened.status === 404
          ? "not_found"
          : opened.status === 413
            ? "invalid_request"
            : "forbidden",
      );
    fs.closeSync(opened.fd);
    // A document-looking directory and a symlink onto an unsupported type are not documents.
    try {
      if (!fs.statSync(path.resolve(root, relative)).isFile()) throw new ControlError("forbidden");
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError("not_found");
    }
    if (!/\.(md|markdown|html|htm)$/i.test(opened.real)) throw new ControlError("invalid_request");
    return {
      real: opened.real,
      path: opened.relative.split(path.sep).join("/"),
      kind: /\.(md|markdown)$/i.test(opened.real) ? ("markdown" as const) : ("html" as const),
    };
  }
  private async record(
    actor: Principal,
    action: string,
    preview: AgentPreview,
    outcome: string,
  ): Promise<void> {
    try {
      await this.audit({
        session: actor.sessionId,
        action,
        preview: preview.previewId,
        path: preview.path,
        outcome,
      });
    } catch {
      throw new ControlError("unavailable");
    }
    this.active(actor);
  }
  private async dispatch(actor: Principal, method: string, input: unknown): Promise<unknown> {
    this.active(actor);
    if (actor.role === "cli") throw new ControlError("forbidden");
    const params = object(input);
    const owned = this.owned(actor);
    if (method === "list_previews") {
      exact(params, []);
      return {
        previews: owned.map((p) => ({
          previewId: p.previewId,
          path: p.path,
          kind: p.kind,
          visible: this.backend.visible(p.previewId),
        })),
      };
    }
    if (method === "close_preview") {
      exact(params, ["previewId"]);
      const preview = owned.find((p) => p.previewId === params["previewId"]);
      if (!preview) throw new ControlError("not_found");
      await this.record(actor, method, preview, "closing");
      this.assertOwned(actor, preview);
      try {
        await this.backend.close(preview.previewId);
      } catch {
        throw new ControlError("unavailable");
      }
      this.previews.delete(preview.previewId);
      await this.record(actor, method, preview, "closed");
      return { previewId: preview.previewId, closed: true };
    }
    if (method !== "open_preview") throw new ControlError("forbidden");
    exact(params, ["path"]);
    this.take(actor);
    const target = this.resolve(actor, params["path"]);
    const existing = owned.find((p) => p.real === target.real);
    if (existing) {
      await this.record(actor, method, existing, "existing");
      this.assertOwned(actor, existing);
      return this.view(existing, "existing", true);
    }
    if (owned.length >= this.limits.perAgent || this.previews.size >= this.limits.total)
      throw new ControlError("capacity");
    const preview: AgentPreview = {
      previewId: randomBytes(16).toString("hex"),
      owner: actor.generation,
      session: actor.sessionId,
      worktree: actor.worktree,
      ...target,
    };
    await this.record(actor, method, preview, "opening");
    this.previews.set(preview.previewId, preview);
    try {
      const placement = await this.backend.open(
        actor,
        preview,
        this.dismissed.has(`${actor.generation}\0${preview.real}`),
      );
      // Revocation during placement transfers ownership rather than undoing the human's view.
      this.active(actor);
      this.assertOwned(actor, preview);
      await this.record(actor, method, preview, placement);
      this.assertOwned(actor, preview);
      return this.view(preview, placement, false);
    } catch (error) {
      // Undo a refused new view only while the caller still owns it. A takeover keeps it.
      if (
        preview.owner === actor.generation &&
        this.previews.get(preview.previewId) === preview &&
        this.backend.has(preview.previewId)
      ) {
        try {
          await this.backend.close(preview.previewId);
        } catch {
          throw new ControlError("unavailable");
        }
      }
      if (!this.backend.has(preview.previewId)) this.previews.delete(preview.previewId);
      if (error instanceof ControlError) throw error;
      throw new ControlError("unavailable");
    }
  }
  private assertOwned(actor: Principal, preview: AgentPreview): void {
    if (
      preview.owner !== actor.generation ||
      this.previews.get(preview.previewId) !== preview ||
      !this.backend.has(preview.previewId)
    )
      throw new ControlError("not_found");
  }
  private view(preview: AgentPreview, placement: Placement | "existing", reused: boolean) {
    return {
      previewId: preview.previewId,
      path: preview.path,
      kind: preview.kind,
      placement,
      reused,
    };
  }
  humanClose(id: string): void {
    const preview = this.previews.get(id);
    if (preview?.owner) this.dismissed.add(`${preview.owner}\0${preview.real}`);
    this.previews.delete(id);
  }
  revoke(actor: Principal): void {
    for (const preview of this.previews.values())
      if (preview.owner === actor.generation) preview.owner = null;
    this.buckets.delete(actor.generation);
  }
  takeOver(terminalId: string, actors: readonly Principal[]): void {
    for (const actor of actors) if (actor.terminalId === terminalId) this.revoke(actor);
  }
}
