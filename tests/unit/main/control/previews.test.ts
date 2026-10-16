import fs from "node:fs";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewBroker, PREVIEW_LIMITS } from "../../../../src/main/control/previews";
import type {
  AgentPreview,
  Placement,
  PreviewAudit,
  PreviewBackend,
} from "../../../../src/main/control/previews";
import type { Principal } from "../../../../src/main/control/types";
import { ControlError, identifier, object } from "../../../../src/main/control/validation";

class Board implements PreviewBackend {
  landing: string | null = "t2";
  empty = ["t2", "t3"];
  focused = "t1";
  previews = new Map<string, { preview: AgentPreview; tile: string | null }>();
  open(_actor: Principal, preview: AgentPreview, sidebar: boolean): Promise<Placement> {
    if (this.visible(preview.previewId)) return Promise.resolve("existing");
    const tile = sidebar ? null : (this.landing ?? this.empty[0] ?? null);
    const placement = tile === null ? "sidebar" : tile === this.landing ? "landing" : "empty";
    if (tile) {
      this.empty = this.empty.filter((id) => id !== tile);
      if (tile === this.landing) this.landing = null;
    }
    this.previews.set(preview.previewId, { preview, tile });
    return Promise.resolve(placement);
  }
  close(id: string) {
    const tile = this.previews.get(id)?.tile;
    if (tile) {
      this.empty.push(tile);
      this.landing = tile;
    }
    this.previews.delete(id);
    return Promise.resolve();
  }
  visible(id: string) {
    return this.previews.get(id)?.tile != null;
  }
  has(id: string) {
    return this.previews.has(id);
  }
}
let root: string;
let tree: string;
let actor: Principal;
let board: Board;
let events: PreviewAudit[];
let now: number;
let active: ReturnType<typeof vi.fn<(actor: Principal) => void>>;
let audit: ReturnType<typeof vi.fn<(event: PreviewAudit) => Promise<void>>>;
let broker: PreviewBroker;
const open = (path: string, who = actor) => broker.call(who, "open_preview", { path });
const id = (result: unknown) => identifier(object(result)["previewId"]);
const list = (who = actor) => broker.call(who, "list_previews", {});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "foom-preview-broker-"));
  tree = join(root, "tree");
  mkdirSync(join(tree, "docs"), { recursive: true });
  mkdirSync(join(root, "other"));
  writeFileSync(join(tree, "docs", "plan.md"), "# plan");
  writeFileSync(join(tree, "mockup.html"), "<h1>mock</h1>");
  for (let i = 0; i < 8; i++) writeFileSync(join(tree, `p${String(i)}.md`), `# ${String(i)}`);
  writeFileSync(join(tree, "notes.txt"), "text");
  writeFileSync(join(tree, ".env.md"), "SECRET=1");
  writeFileSync(join(root, "other", "secret.md"), "outside");
  actor = {
    grantedAt: "2026-10-15T00:00:00.000Z",
    generation: "g1",
    sessionId: "s1",
    role: "agent",
    terminalId: "t1",
    parentId: null,
    repository: tree,
    worktree: tree,
  };
  board = new Board();
  events = [];
  now = 0;
  active = vi.fn();
  audit = vi.fn((event) => {
    events.push(event);
    return Promise.resolve();
  });
  broker = new PreviewBroker(board, audit, active, () => now);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
it("fills landing then empty then sidebar without changing focus or adding tiles", async () => {
  expect(await open("mockup.html")).toMatchObject({
    placement: "landing",
    kind: "html",
    reused: false,
  });
  expect(await open("docs/plan.md")).toMatchObject({ placement: "empty", kind: "markdown" });
  expect(await open("p0.md")).toMatchObject({ placement: "sidebar" });
  expect(board.focused).toBe("t1");
  expect(board.empty).toEqual([]);
  expect(await list()).toMatchObject({
    previews: [{ visible: true }, { visible: true }, { visible: false }],
  });
});
it("reuses canonical file identity without moving any tile", async () => {
  const first = id(await open("docs/plan.md"));
  for (const spelling of ["./docs/plan.md", "docs//plan.md", join(tree, "docs", "plan.md")])
    expect(await open(spelling)).toEqual({
      previewId: first,
      path: "docs/plan.md",
      kind: "markdown",
      placement: "existing",
      reused: true,
    });
  expect(board.previews.size).toBe(1);
  expect(board.empty).toEqual(["t3"]);
});
it("places a reused sidebar preview without creating a new identity", async () => {
  board.landing = null;
  board.empty = [];
  const first = id(await open("docs/plan.md"));
  board.empty = ["available"];
  expect(await open("docs/plan.md")).toMatchObject({
    previewId: first,
    placement: "empty",
    reused: true,
  });
  expect(board.previews.size).toBe(1);
  expect(board.visible(first)).toBe(true);
});
it("keeps human-dismissed sidebar previews hidden when reused", async () => {
  const first = id(await open("docs/plan.md"));
  broker.humanClose(first);
  await board.close(first);
  const second = id(await open("docs/plan.md"));
  expect(await open("docs/plan.md")).toMatchObject({
    previewId: second,
    placement: "existing",
    reused: true,
  });
  expect(board.visible(second)).toBe(false);
});
it("validates reuse after asynchronous placement and maps backend failures", async () => {
  board.landing = null;
  board.empty = [];
  await open("docs/plan.md");
  vi.spyOn(board, "open").mockRejectedValueOnce(new Error("failed"));
  await expect(open("docs/plan.md")).rejects.toMatchObject({ code: "unavailable" });
  vi.spyOn(board, "open").mockRejectedValueOnce(new ControlError("capacity"));
  await expect(open("docs/plan.md")).rejects.toMatchObject({ code: "capacity" });
  vi.spyOn(board, "open").mockImplementationOnce(async (who, preview, sidebar) => {
    await Board.prototype.open.call(board, who, preview, sidebar);
    broker.revoke(actor);
    return "empty";
  });
  await expect(open("docs/plan.md")).rejects.toMatchObject({ code: "not_found" });
});
it("refuses traversal, hidden names, unsupported types, missing files and malformed input", async () => {
  broker = new PreviewBroker(board, audit, active, () => now, { ...PREVIEW_LIMITS, burst: 100 });
  for (const path of [
    "../other/secret.md",
    join(root, "other", "secret.md"),
    ".env.md",
    "/etc/hostname.md",
  ])
    await expect(open(path)).rejects.toMatchObject({ code: "forbidden" });
  for (const input of [
    null,
    [],
    {},
    { path: "" },
    { path: "a\nb.md" },
    { path: 7 },
    { path: `${"a".repeat(1024)}.md` },
    { path: "p0.md", worktree: "/" },
    { path: "notes.txt" },
  ])
    await expect(broker.call(actor, "open_preview", input)).rejects.toMatchObject({
      code: "invalid_request",
    });
  await expect(open("missing.md")).rejects.toMatchObject({ code: "not_found" });
  mkdirSync(join(tree, "directory.md"));
  writeFileSync(join(tree, "directory.md", "index.html"), "directory");
  await expect(open("directory.md")).rejects.toMatchObject({ code: "forbidden" });
  const big = join(tree, "big.md");
  const fd = openSync(big, "w");
  closeSync(fd);
  truncateSync(big, 2 * 1024 * 1024 + 1);
  await expect(open("big.md")).rejects.toMatchObject({ code: "invalid_request" });
  rmSync(tree, { recursive: true });
  await expect(open("p0.md")).rejects.toMatchObject({ code: "unavailable" });
});
it.skipIf(process.platform === "win32")(
  "refuses symlink escapes, hidden targets and unsupported targets; reuses contained aliases",
  async () => {
    symlinkSync(join(root, "other", "secret.md"), join(tree, "escape.md"));
    symlinkSync(join(tree, ".env.md"), join(tree, "hidden-link.md"));
    symlinkSync(join(tree, "notes.txt"), join(tree, "text-link.md"));
    symlinkSync(join(tree, "docs", "plan.md"), join(tree, "link.md"));
    for (const path of ["escape.md", "hidden-link.md"])
      await expect(open(path)).rejects.toMatchObject({ code: "forbidden" });
    await expect(open("text-link.md")).rejects.toMatchObject({ code: "invalid_request" });
    const first = id(await open("link.md"));
    expect(await open("docs/plan.md")).toMatchObject({ previewId: first, reused: true });
  },
);
it("isolates owners by generation, with foreign IDs indistinguishable from unknown", async () => {
  const other = { ...actor, generation: "g2", sessionId: "s2", role: "orchestrator" as const };
  const mine = id(await open("p0.md"));
  const theirs = id(await open("p0.md", other));
  expect(mine).not.toBe(theirs);
  expect(await list()).toMatchObject({ previews: [{ previewId: mine }] });
  for (const previewId of [theirs, "unknown", 4])
    await expect(broker.call(actor, "close_preview", { previewId })).rejects.toMatchObject({
      code: "not_found",
    });
  await expect(
    broker.call(actor, "close_preview", { previewId: mine, extra: true }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(await broker.call(actor, "close_preview", { previewId: mine })).toEqual({
    previewId: mine,
    closed: true,
  });
  expect(await list(other)).toMatchObject({ previews: [{ previewId: theirs }] });
  await expect(broker.call(actor, "list_previews", { extra: true })).rejects.toMatchObject({
    code: "invalid_request",
  });
});
it("refuses count and rate limits, counting reuse and preserving every preview", async () => {
  for (let i = 0; i < PREVIEW_LIMITS.perAgent; i++) await open(`p${String(i)}.md`);
  await expect(open("p5.md")).rejects.toMatchObject({ code: "capacity" });
  await open("p0.md");
  await expect(open("p0.md")).rejects.toMatchObject({ code: "capacity" });
  expect(board.previews.size).toBe(4);
  now = 9999;
  await expect(open("p0.md")).rejects.toMatchObject({ code: "capacity" });
  now = 10000;
  expect(await open("p0.md")).toMatchObject({ reused: true });
  now += 1000000;
  for (let i = 0; i < 6; i++) await open("p0.md");
  await expect(open("p0.md")).rejects.toMatchObject({ code: "capacity" });
});
it("enforces an instance cap even after ownership transfers", async () => {
  for (let generation = 0; generation < 3; generation++) {
    const who = { ...actor, generation: String(generation) };
    for (let i = 0; i < 4; i++) await open(`p${String(i)}.md`, who);
    broker.revoke(who);
  }
  await expect(open("p0.md")).rejects.toMatchObject({ code: "capacity" });
  expect(board.previews.size).toBe(12);
});
it("makes human close sticky; agent close does not dismiss", async () => {
  const first = id(await open("mockup.html"));
  broker.humanClose(first);
  await board.close(first);
  expect(await open("mockup.html")).toMatchObject({ placement: "sidebar" });
  expect(board.landing).toBe("t2");
  const second = id(await open("p0.md"));
  await broker.call(actor, "close_preview", { previewId: second });
  expect(await open("p0.md")).toMatchObject({ placement: "landing" });
  broker.humanClose("missing");
});
it("releases ownership on exit or takeover, and drops removed worktree records", async () => {
  const first = id(await open("mockup.html"));
  broker.takeOver("other", [actor]);
  expect(await list()).toMatchObject({ previews: [{ previewId: first }] });
  broker.takeOver(actor.terminalId, [actor]);
  expect(await list()).toEqual({ previews: [] });
  await expect(broker.call(actor, "close_preview", { previewId: first })).rejects.toMatchObject({
    code: "not_found",
  });
  expect(board.previews.size).toBe(1);
  await board.close(first);
  expect(await list()).toEqual({ previews: [] });
});
it("audits fixed fields before presentation and refuses failed writes or inactive grants", async () => {
  audit.mockImplementationOnce((event) => {
    expect(board.previews.size).toBe(0);
    events.push(event);
    return Promise.resolve();
  });
  const first = id(await open("docs/plan.md"));
  expect(Object.keys(events[0] ?? {}).sort()).toEqual([
    "action",
    "outcome",
    "path",
    "preview",
    "session",
  ]);
  expect(JSON.stringify(events)).not.toContain("# plan");
  audit.mockRejectedValueOnce(new Error("disk"));
  await expect(open("p0.md")).rejects.toMatchObject({ code: "unavailable" });
  expect(board.previews.size).toBe(1);
  audit.mockRejectedValueOnce(new Error("disk"));
  await expect(broker.call(actor, "close_preview", { previewId: first })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(board.has(first)).toBe(true);
  vi.spyOn(board, "close").mockRejectedValueOnce(new Error("host close failed"));
  await expect(broker.call(actor, "close_preview", { previewId: first })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(board.has(first)).toBe(true);
  active.mockImplementationOnce(() => {
    throw new Error("revoked");
  });
  await expect(list()).rejects.toThrow("revoked");
});
it("refuses CLI callers, unknown methods, backend failure and authority lost during placement", async () => {
  await expect(
    broker.call({ ...actor, role: "cli" }, "open_preview", { path: "p0.md" }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(broker.call(actor, "other", {})).rejects.toMatchObject({ code: "forbidden" });
  vi.spyOn(board, "open").mockRejectedValueOnce(new Error("host"));
  await expect(open("p0.md")).rejects.toMatchObject({ code: "unavailable" });
  expect(await list()).toEqual({ previews: [] });
  vi.spyOn(board, "open").mockImplementationOnce(async (who, preview, sidebar) => {
    await Board.prototype.open.call(board, who, preview, sidebar);
    broker.revoke(who);
    active.mockImplementationOnce(() => {
      throw new Error("revoked");
    });
    return "landing";
  });
  await expect(open("p0.md")).rejects.toMatchObject({ code: "unavailable" });
  expect(await list()).toEqual({ previews: [] });
  expect(board.previews.size).toBe(1);
});

it("returns not_found if a document disappears between containment validation and registration", async () => {
  const close = fs.closeSync;
  vi.spyOn(fs, "closeSync").mockImplementationOnce((fd) => {
    close(fd);
    rmSync(join(tree, "docs", "plan.md"));
  });
  await expect(open("docs/plan.md")).rejects.toMatchObject({ code: "not_found" });
  expect(board.previews.size).toBe(0);
  expect(events).toEqual([]);
});

it("refuses an in-flight close after takeover while the grant remains live", async () => {
  const previewId = id(await open("mockup.html"));
  audit.mockImplementationOnce(() => {
    broker.revoke(actor);
    return Promise.resolve();
  });
  await expect(broker.call(actor, "close_preview", { previewId })).rejects.toMatchObject({
    code: "not_found",
  });
  expect(board.has(previewId)).toBe(true);
  expect(await list()).toEqual({ previews: [] });
});

it("refuses reuse after ownership release and a human close during the audit write", async () => {
  const previewId = id(await open("mockup.html"));
  audit.mockImplementationOnce(() => {
    broker.revoke(actor);
    return Promise.resolve();
  });
  await expect(open("mockup.html")).rejects.toMatchObject({ code: "not_found" });
  expect(board.has(previewId)).toBe(true);
  const next = id(await open("mockup.html"));
  audit.mockImplementationOnce(() => {
    broker.humanClose(next);
    return Promise.resolve();
  });
  await expect(broker.call(actor, "close_preview", { previewId: next })).rejects.toMatchObject({
    code: "not_found",
  });
});
it("refuses a result if its view disappears during placement", async () => {
  vi.spyOn(board, "open").mockImplementationOnce(async (who, preview, sidebar) => {
    await Board.prototype.open.call(board, who, preview, sidebar);
    await board.close(preview.previewId);
    return "landing";
  });
  await expect(open("mockup.html")).rejects.toMatchObject({ code: "not_found" });
  expect(await list()).toEqual({ previews: [] });
});

it("rolls back a new preview when completion auditing fails, while preserving a takeover", async () => {
  audit
    .mockImplementationOnce((event) => {
      events.push(event);
      return Promise.resolve();
    })
    .mockRejectedValueOnce(new Error("completion audit"));
  await expect(open("mockup.html")).rejects.toMatchObject({ code: "unavailable" });
  expect(board.previews.size).toBe(0);
  expect(await list()).toEqual({ previews: [] });
  audit
    .mockImplementationOnce((event) => {
      events.push(event);
      return Promise.resolve();
    })
    .mockImplementationOnce(() => {
      broker.revoke(actor);
      return Promise.reject(new Error("completion audit"));
    });
  await expect(open("mockup.html")).rejects.toMatchObject({ code: "unavailable" });
  expect(board.previews.size).toBe(1);
  expect(await list()).toEqual({ previews: [] });
});
it("refuses completion failures and preserves a live record when rollback itself fails", async () => {
  audit
    .mockImplementationOnce((event) => {
      events.push(event);
      return Promise.resolve();
    })
    .mockRejectedValueOnce(new Error("completion audit"));
  vi.spyOn(board, "close").mockRejectedValueOnce(new Error("rollback"));
  await expect(open("mockup.html")).rejects.toMatchObject({ code: "unavailable" });
  expect(board.previews.size).toBe(1);
  const previewId = id(await open("mockup.html"));
  audit
    .mockImplementationOnce((event) => {
      events.push(event);
      return Promise.resolve();
    })
    .mockRejectedValueOnce(new Error("closed audit"));
  await expect(broker.call(actor, "close_preview", { previewId })).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(board.previews.size).toBe(0);
});

it("keeps bounded successful open history after human dismissal, with terminal identity and no contents", async () => {
  const changed = vi.fn();
  broker = new PreviewBroker(
    board,
    audit,
    active,
    () => now,
    { ...PREVIEW_LIMITS, burst: 300 },
    changed,
  );
  const preview = id(await open("docs/plan.md"));
  broker.humanClose(preview);
  await board.close(preview);
  expect(broker.history).toEqual([
    { id: broker.history[0]?.id, terminalId: "t1", path: "docs/plan.md", at: 0 },
  ]);
  for (let index = 0; index < 256; index++) {
    now = index + 1;
    await open("docs/plan.md");
  }
  expect(broker.history).toHaveLength(256);
  expect(broker.history[0]?.at).toBe(1);
  expect(broker.history[255]?.at).toBe(256);
  expect(changed).toHaveBeenCalledTimes(257);
  audit.mockRejectedValueOnce(new Error("audit"));
  await expect(open("mockup.html")).rejects.toMatchObject({ code: "unavailable" });
  expect(broker.history).toHaveLength(256);
});
