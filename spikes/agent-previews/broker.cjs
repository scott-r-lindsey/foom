"use strict";
// Policy core for agent-opened previews (#222). Pure apart from the file check,
// which reuses the #221 containment rules. Not Foom code.

const crypto = require("node:crypto");
const path = require("node:path");
const { canonicalRoot, openInside } = require("../previews/containment.cjs");

const KINDS = new Map([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".html", "html"],
  [".htm", "html"],
]);

const LIMITS = Object.freeze({
  perAgent: 4, // live previews one principal may own, visible or not
  total: 12, // every agent-opened preview in this Foom instance
  burst: 6, // open_preview calls allowed back to back
  refillMs: 10_000, // one more call every 10 s (6 a minute sustained)
  pathBytes: 1024,
});

class BrokerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function exact(input, allowed) {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new BrokerError("invalid_request");
  for (const key of Object.keys(input))
    if (!allowed.includes(key)) throw new BrokerError("invalid_request");
  return input;
}

/**
 * Board stand-in: the renderer's real layout decides placement in Foom. This
 * keeps only what the policy needs: a landing spot, empty spaces in tree order,
 * the focused tile, and which tile holds which preview.
 */
class Board {
  constructor({ landing = null, empty = [], focused = "t1" } = {}) {
    this.landing = landing;
    this.empty = [...empty];
    this.focused = focused;
    this.tiles = new Map(); // tile id -> preview id
  }
  place(previewId) {
    const tile = this.landing ?? this.empty[0] ?? null;
    if (tile === null) return { placement: "sidebar", tile: null };
    const placement = tile === this.landing ? "landing" : "empty";
    this.empty = this.empty.filter((id) => id !== tile);
    if (tile === this.landing) this.landing = null;
    this.tiles.set(tile, previewId);
    return { placement, tile };
  }
  release(tile) {
    if (tile === null) return;
    this.tiles.delete(tile);
    // Closing a preview tile leaves empty space that becomes the landing spot,
    // like Hide or Close on a terminal.
    this.empty.push(tile);
    this.landing = tile;
  }
}

class PreviewBroker {
  constructor({ board = new Board(), now = () => Date.now(), limits = LIMITS, events } = {}) {
    this.board = board;
    this.now = now;
    this.limits = limits;
    this.previews = new Map(); // preview id -> record
    this.buckets = new Map(); // principal generation -> { tokens, at }
    this.dismissed = new Set(); // `${generation}\0${real}` the human closed
    this.events = events ?? [];
  }

  /** One token per call, including reuse: a reused open still flares its tile. */
  take(actor) {
    const at = this.now();
    const bucket = this.buckets.get(actor.generation) ?? { tokens: this.limits.burst, at };
    const refill = Math.floor((at - bucket.at) / this.limits.refillMs);
    if (refill > 0) {
      bucket.tokens = Math.min(this.limits.burst, bucket.tokens + refill);
      bucket.at += refill * this.limits.refillMs;
    }
    if (bucket.tokens === 0) {
      this.buckets.set(actor.generation, bucket);
      throw new BrokerError("rate_limited");
    }
    bucket.tokens--;
    this.buckets.set(actor.generation, bucket);
  }

  /** Resolve a caller path inside the caller's own worktree, bound at launch. */
  resolve(actor, input) {
    const raw = input.path;
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      Buffer.byteLength(raw) > this.limits.pathBytes ||
      /[\u0000-\u001f\u007f]/.test(raw)
    )
      throw new BrokerError("invalid_request");
    let root;
    try {
      root = canonicalRoot(actor.worktree);
    } catch {
      throw new BrokerError("unavailable");
    }
    // Absolute paths are accepted only when they name something under the
    // worktree; relative paths are taken from the worktree, never the agent's cwd.
    const relative = path.isAbsolute(raw)
      ? path.relative(actor.worktree, raw)
      : path.normalize(raw);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
      throw new BrokerError("forbidden");
    const kind = KINDS.get(path.extname(relative).toLowerCase());
    if (!kind) throw new BrokerError("unsupported_type");
    const url = `/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
    const opened = openInside(root, url);
    if (opened.status === 200) {
      require("node:fs").closeSync(opened.fd);
      return { root, real: opened.real, relative: opened.relative, kind };
    }
    if (opened.status === 404) throw new BrokerError("not_found");
    if (opened.status === 413) throw new BrokerError("too_large");
    throw new BrokerError("forbidden");
  }

  owned(actor) {
    return [...this.previews.values()].filter((p) => p.owner === actor.generation);
  }

  open(actor, input) {
    exact(input, ["path"]);
    this.take(actor);
    const target = this.resolve(actor, input);
    const existing = this.owned(actor).find((p) => p.real === target.real);
    const focused = this.board.focused;
    if (existing) {
      this.record(actor, "open_preview", existing, "existing");
      return this.view(existing, "existing", true);
    }
    if (this.owned(actor).length >= this.limits.perAgent) throw new BrokerError("capacity");
    if (this.previews.size >= this.limits.total) throw new BrokerError("capacity");
    const preview = {
      previewId: `pv_${crypto.randomBytes(16).toString("hex")}`,
      owner: actor.generation,
      opener: { sessionId: actor.sessionId, agent: actor.agent, name: actor.name },
      worktree: actor.worktree,
      real: target.real,
      path: target.relative.split(path.sep).join("/"),
      kind: target.kind,
      openedAt: new Date(this.now()).toISOString(),
      tile: null,
    };
    this.previews.set(preview.previewId, preview);
    // A path the human already closed never refills a tile for the same agent.
    const dismissed = this.dismissed.has(`${actor.generation}\0${target.real}`);
    const placed = dismissed ? { placement: "sidebar", tile: null } : this.board.place(preview.previewId);
    preview.tile = placed.tile;
    if (this.board.focused !== focused) throw new Error("placement moved focus");
    this.record(actor, "open_preview", preview, placed.placement);
    return this.view(preview, placed.placement, false);
  }

  close(actor, input) {
    exact(input, ["previewId"]);
    const preview = this.previews.get(input.previewId);
    // Unknown and foreign IDs are indistinguishable.
    if (typeof input.previewId !== "string" || !preview || preview.owner !== actor.generation)
      throw new BrokerError("not_found");
    this.drop(preview);
    this.record(actor, "close_preview", preview, "closed");
    return { previewId: preview.previewId, closed: true };
  }

  list(actor, input) {
    exact(input ?? {}, []);
    return {
      previews: this.owned(actor).map((p) => ({
        previewId: p.previewId,
        path: p.path,
        kind: p.kind,
        visible: p.tile !== null,
      })),
    };
  }

  /** The human closed the tile or sidebar row. */
  humanClose(previewId) {
    const preview = this.previews.get(previewId);
    if (!preview) return;
    if (preview.owner) this.dismissed.add(`${preview.owner}\0${preview.real}`);
    this.drop(preview);
  }

  /** The human showed a sidebar-only preview: only now would Foom create its view. */
  humanShow(previewId) {
    const preview = this.previews.get(previewId);
    if (!preview || preview.tile !== null) return null;
    const placed = this.board.place(previewId);
    preview.tile = placed.tile;
    return placed.placement;
  }

  /** Session exit, takeover or grant revocation: previews stay, owned by nobody. */
  revoke(actor) {
    for (const preview of this.owned(actor)) preview.owner = null;
    this.buckets.delete(actor.generation);
  }

  /** A worktree left the inventory: its previews close, as in #221. */
  worktreeRemoved(worktree) {
    for (const preview of [...this.previews.values()])
      if (preview.worktree === worktree) this.drop(preview);
  }

  drop(preview) {
    this.previews.delete(preview.previewId);
    this.board.release(preview.tile);
  }

  view(preview, placement, reused) {
    return { previewId: preview.previewId, path: preview.path, kind: preview.kind, placement, reused };
  }

  record(actor, action, preview, outcome) {
    // Fixed fields only: never file contents, never the raw argument.
    this.events.push({ at: this.now(), session: actor.sessionId, action, preview: preview.previewId, path: preview.path, outcome });
  }
}

module.exports = { Board, BrokerError, LIMITS, PreviewBroker };
