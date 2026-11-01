import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../../../src/main/control/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBoard } from "../../../../src/main/control/message-board";
import { locationId } from "../../../../src/main/control/metadata";
import { harness, repo } from "./orchestration-helpers";
import { command } from "../../../../src/cli/commands";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const save = vi.fn(async (_data: unknown) => {});
  const board = new MessageBoard(save, () => [{ id: locationId(repo), name: "Repo" }]);
  const h = harness(
    { reviewSnapshot: () => Promise.resolve({ head: "head", digest: "digest" }) },
    board,
  );
  h.advance(Date.now() - 1_000_000);
  cleanups.push(() => {
    h.orchestration.disposeUnreadChildren();
  });
  const report = async (id: string, params: Record<string, unknown>) => {
    const row = h.rows.get(id);
    if (!row) throw new Error("missing row");
    const grant = h.service.prepare(repo, row.worktree, "agent", "parent");
    grant.bind(id);
    const actor = h.service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
    return h.service.call(actor, {
      version: 1,
      instanceId: h.service.instanceId,
      method: "handoff",
      params: { status: "done", summary: "Result", idempotencyKey: "report", ...params },
    });
  };
  const text = async (id: string) => {
    await board.flushChildren();
    const thread = board.childThreads().find((row) => row.child?.id === id);
    if (!thread) throw new Error("missing thread");
    let page = board.read({ thread: thread.id });
    const posts = [...page.posts];
    while (page.next) {
      page = board.read({ thread: thread.id, after: page.next });
      posts.push(...page.posts);
    }
    return posts.map((row) => row.text + " " + row.links.join(" ")).join("\n");
  };
  return { ...h, board, save, report, text };
}

describe("child event board integration", () => {
  it.each([false, true])(
    "keeps the spawned child when board recording fails (continuation: %s)",
    async (continuation) => {
      const h = fixture();
      const tree = await h.mutate("create_worktree", { branch: "feature" });
      if (continuation) {
        const first = await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
        const id = first.resultId;
        if (!id) throw new Error("missing child");
        h.exit(id);
        await h.mutate("close", { id });
        h.orchestration.removed(id);
        h.rows.delete(id);
        await h.board.flushChildren();
      }
      h.save.mockRejectedValueOnce(new Error("recording unavailable"));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
        expect(result.status).toBe("indeterminate");
        expect(result.resultId).toBeDefined();
        expect(h.rows.has(result.resultId ?? "")).toBe(true);
        expect(h.orchestration.ownedWorktrees("parent")[0]?.state).toBe("used");
        await expect(h.board.flushChildren()).rejects.toThrow("unavailable");
      } finally {
        log.mockRestore();
      }
    },
  );
  it("records standalone reviews as automatic generated launches", async () => {
    const h = fixture();
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "success",
      state: "OPEN",
    });
    const result = await h.mutate("review", { pullRequest: 7 });
    expect(result.status).toBe("succeeded");
    const text = await h.text(result.resultId ?? "");
    expect(text).toContain('"automatic":true');
    expect(text).toContain("Review PR #7");
    expect(h.orchestration.reviews.view(result.resultId ?? "")).toBeUndefined();
  });
  it.each(["explicit", "credential", "provider", "state-credential"])(
    "never persists sensitive prompt text: %s",
    async (mode) => {
      const h = fixture();
      const { id } = await h.child("feature");
      const row = h.rows.get(id);
      if (!row) throw new Error("missing row");
      if (mode !== "explicit") {
        row.state = {
          id,
          verdictId: null,
          state: "needs_input",
          reason: "Credential needed",
          signal: "fixture",
          confidence: 1,
          timestamp: 1,
          ...(mode === "state-credential" ? { attentionKind: "credential" } : {}),
        };
        if (mode === "credential" || mode === "provider") row.attentionKind = mode;
      }
      await h.mutate("prompt", {
        id,
        text: "super-private-answer",
        ...(mode === "explicit" ? { sensitive: true } : {}),
      });
      expect(h.host.reply).toHaveBeenCalledWith(id, {
        kind: "prompt",
        text: "super-private-answer",
      });
      expect(await h.text(id)).toContain("⟨redacted⟩ reply sent · delivered");
      expect(JSON.stringify(h.save.mock.calls)).not.toContain("super-private-answer");
      expect(JSON.stringify(h.persist.mock.calls)).not.toContain("super-private-answer");
    },
  );
  it("omits sensitive replies and keys from actual board, audit and operation files through failures and retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "foom-child-board-private-"));
    const board = await MessageBoard.open(
      directory,
      () => [{ id: locationId(repo), name: "Repo" }],
      () => {},
    );
    const store = new ControlStore(directory);
    const h = harness({}, board);
    cleanups.push(() => {
      h.orchestration.disposeUnreadChildren();
    });
    h.persist.mockImplementation((record) => store.persist(record));
    try {
      const { id } = await h.child("feature");
      const row = h.rows.get(id);
      if (!row) throw new Error("missing child");
      const cases = [
        { text: "FIXTURE_SECRET_EXPLICIT", sensitive: true },
        { text: "FIXTURE_SECRET_CREDENTIAL", kind: "credential" as const, failure: true },
        { text: "FIXTURE_SECRET_PROVIDER", kind: "provider" as const },
      ];
      for (const [index, item] of cases.entries()) {
        row.state = item.kind
          ? {
              id,
              state: "needs_input",
              attentionKind: item.kind,
              verdictId: null,
              reason: "fixture",
              signal: "fixture",
              timestamp: Date.now(),
              confidence: 1,
            }
          : null;
        if (item.failure) h.host.reply.mockRejectedValueOnce(new Error(item.text));
        const params = {
          id,
          text: item.text,
          ...(item.sensitive ? { sensitive: true } : {}),
          idempotencyKey: `secret-${String(index)}`,
        };
        const op = await h.mutate("prompt", params);
        const calls = h.host.reply.mock.calls.length;
        await h.mutate("prompt", params);
        expect(h.host.reply.mock.calls).toHaveLength(calls);
        expect(
          await h.call("operation_status", { idempotencyKey: params.idempotencyKey }),
        ).toMatchObject({ status: op.status });
      }
      await h.mutate("send_keys", { id, keys: ["ctrl+c", "enter"] });
      await board.flushChildren();
      for (const name of await readdir(directory)) {
        const bytes = await readFile(join(directory, name), "utf8");
        expect(bytes).not.toContain("FIXTURE_SECRET_");
        expect(bytes).not.toContain("ctrl+c");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("records normal and automatic prompts, key count, handoff/verdict, stop, close and removal outcome", async () => {
    const h = fixture();
    const tree = await h.mutate("create_worktree", { branch: "feature" });
    const launch = await h.mutate("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      prompt: "Build the feature",
    });
    const id = launch.resultId ?? "";
    await h.mutate("prompt", { id, text: "Continue", automatic: true });
    await h.mutate("send_keys", { id, keys: ["ctrl+c", "enter"] });
    await h.report(id, {
      summary: "Result",
      review: {
        verdict: "findings",
        findings: [{ file: "a.ts", line: 1, summary: "Bug", scenario: "Zero input" }],
      },
    });
    await h.mutate("stop", { id });
    h.exit(id);
    await h.mutate("close", { id });
    h.orchestration.removed(id);
    h.rows.delete(id);
    await h.mutate("remove_worktree", { worktreeId: tree.resultId });
    await vi.waitFor(() => {
      expect(h.board.childThreads()[0]?.child?.removedAt).toBeDefined();
    });
    const text = await h.text(id);
    for (const event of [
      "launch",
      "Build the feature",
      "Continue",
      '"automatic":true',
      "keys sent (2)",
      "handoff",
      "review verdict",
      "Zero input",
      "stop",
      "close",
      "worktree removal",
    ])
      expect(text).toContain(event);
    expect(text).not.toContain("ctrl+c");
    expect(h.host.tail).not.toHaveBeenCalled();
    expect(h.board.childThreads()).toHaveLength(1);
    await expect(
      h.call("board_post", {
        thread: h.board.childThreads()[0]?.id,
        kind: "fyi",
        text: "Spoof",
        idempotencyKey: "spoof",
      }),
    ).resolves.toMatchObject({ status: "failed" });
  });
  it("records failed and ambiguous delivery without retrying or exposing tagged text", async () => {
    const h = fixture();
    const { id } = await h.child("feature");
    h.host.reply.mockRejectedValueOnce(new Error("lost"));
    expect(await h.mutate("prompt", { id, text: "private", sensitive: true })).toMatchObject({
      status: "indeterminate",
    });
    expect(await h.text(id)).toContain('"delivery":"indeterminate"');
    expect(JSON.stringify(h.save.mock.calls)).not.toContain('"private"');
    for (const change of [{ sensitive: "true" }, { automatic: "yes" }, { secret: true }])
      await expect(h.mutate("prompt", { id, text: "hello", ...change })).rejects.toThrow(
        "invalid_request",
      );
  });
  it("keeps escalated findings readable after the reviewer and author close", async () => {
    const h = fixture();
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "success",
      state: "OPEN",
    });
    const tree = await h.mutate("create_worktree", { branch: "feature" });
    const launch = await h.mutate("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      prompt: "Build",
      review: { rounds: 1 },
    });
    const id = launch.resultId ?? "";
    const row = h.rows.get(id);
    if (!row) throw new Error("missing author");
    row.conversationId = "author";
    await h.report(id, {});
    h.exit(id);
    await vi.waitFor(() => {
      expect(h.host.launch).toHaveBeenCalledTimes(2);
    });
    await h.report("child-2", {
      review: {
        verdict: "findings",
        findings: [{ file: "a.ts", line: 2, summary: "Incorrect zero", scenario: "Zero input" }],
      },
    });
    h.exit("child-2");
    await vi.waitFor(() => {
      expect(h.orchestration.reviews.view(id)?.phase).toBe("escalated");
    });
    h.orchestration.removed("child-2");
    h.rows.delete("child-2");
    h.orchestration.removed(id);
    h.rows.delete(id);
    expect(await h.text("child-2")).toContain("Incorrect zero");
    expect(await h.text(id)).toContain("round cap");
    expect(await h.text(id)).toContain("#7");
  });
  it("starts expiry for human/automatic cleanup even after sessions close", async () => {
    const h = fixture();
    const { id } = await h.child("feature");
    const row = h.rows.get(id);
    if (!row) throw new Error("missing child");
    const path = row.worktree;
    h.orchestration.removed(id);
    h.rows.delete(id);
    await h.orchestration.worktreeRemoved(path);
    await h.orchestration.worktreeRemoved(path);
    expect(h.board.childThreads()[0]?.child?.removedAt).toBeDefined();
    expect(await h.text(id)).toContain("worktree removal");
  });
  it("starts retention at the receipt cap and recovers child writes after pruning", async () => {
    const board = new MessageBoard(
      async () => {},
      () => [{ id: locationId(repo), name: "Repo" }],
      () => {},
      { bytes: 32768, receipts: 1 },
    );
    const h = harness({}, board);
    h.advance(Date.now() - 1_000_000);
    cleanups.push(() => {
      h.orchestration.disposeUnreadChildren();
    });
    const { id } = await h.child("feature");
    const row = h.rows.get(id);
    if (!row) throw new Error("missing child");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        board.childEvent(
          locationId(repo),
          { id, worktreeId: locationId(row.worktree) },
          "feature",
          "prompt",
          {},
          "full",
        ),
      ).rejects.toThrow("capacity");
      await h.orchestration.worktreeRemoved(row.worktree);
      await board.flushChildren();
      expect(board.childThreads()[0]?.child?.removedAt).toBeDefined();
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 86400000);
      try {
        await board.prune();
        expect(board.childThreads()).toHaveLength(0);
        await board.childEvent(
          locationId(repo),
          { id: "next", worktreeId: "next-tree" },
          "next",
          "launch",
          {},
          "next",
        );
        await board.flushChildren();
        expect(board.childThreads()).toHaveLength(1);
      } finally {
        now.mockRestore();
      }
    } finally {
      log.mockRestore();
    }
  });
  it("keeps distinct handoffs when a fresh launch restores an older report sequence", async () => {
    const h = fixture();
    const { id } = await h.child("feature");
    await h.report(id, { summary: "Before interrupted session save" });
    h.orchestration.handoffs.remove(id);
    h.advance(10_000);
    await h.report(id, { summary: "New launch generation" });
    const text = await h.text(id);
    expect(text).toContain("Before interrupted session save");
    expect(text).toContain("New launch generation");
  });
  it("uses the worktree name for detached child thread titles", async () => {
    const h = fixture();
    const launch = h.host.launch.getMockImplementation();
    if (!launch) throw new Error("missing launch");
    h.host.launch.mockImplementationOnce(async (...args) => {
      const id = await launch(...args);
      const row = h.rows.get(id);
      if (row) row.branch = null;
      return id;
    });
    await h.child("detached-review");
    expect(h.board.childThreads()[0]?.title).toBe("detached-review");
  });
  it("records declined and failed removals without starting expiry", async () => {
    const h = fixture();
    const { id, worktreeId } = await h.child("feature");
    h.exit(id);
    h.host.dialog.mockResolvedValueOnce(false);
    await h.mutate("remove_worktree", { worktreeId });
    await vi.waitFor(async () => {
      expect(await h.text(id)).toContain('"status":"declined"');
    });
    expect(h.board.childThreads()[0]?.child?.removedAt).toBeUndefined();
    h.host.remove.mockRejectedValueOnce(new Error("fixture failure"));
    await h.mutate("remove_worktree", { worktreeId });
    await vi.waitFor(async () => {
      expect(await h.text(id)).toContain('"status":"failed"');
    });
    expect(h.board.childThreads()[0]?.child?.removedAt).toBeUndefined();
  });
  it("records the parent resume and restored escalation transitions", async () => {
    const h = fixture();
    const tree = await h.mutate("create_worktree", { branch: "waiting" });
    const launch = await h.mutate("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      review: {},
    });
    const id = launch.resultId ?? "";
    await h.report(id, { status: "blocked", summary: "Need a scope decision" });
    await vi.waitFor(() => {
      expect(h.orchestration.reviews.view(id)?.phase).toBe("waiting-on-parent");
    });
    await h.mutate("prompt", { id, text: "Proceed" });
    expect(await h.text(id)).toContain("review resumed by parent");
    const other = await h.child("restored");
    const saved = {
      authorId: other.id,
      round: 1,
      phase: "reviewing" as const,
      rounds: 3,
      agent: "claude",
      postFindings: false,
    };
    h.orchestration.reviews.restore(other.id, saved);
    h.orchestration.reviews.restore(other.id, saved);
    const text = await h.text(other.id);
    expect(text).toContain("review restored");
    expect(text).toContain('"reason":"restored"');
    expect(text.match(/review restored/gu)).toHaveLength(1);
  });
  it("keeps PR links within board bounds without breaking later records", async () => {
    const h = fixture();
    h.host.forge.read.mockReturnValue({
      number: 8,
      headSha: "head",
      requiredChecks: "success",
      state: "OPEN",
      url: "https://example.org/" + "x".repeat(3000),
    });
    const { id } = await h.child("feature");
    expect(await h.text(id)).toContain("#8");
    await h.mutate("prompt", { id, text: "Continue" });
    expect(await h.text(id)).toContain("Continue");
  });
  it("parses explicit sensitive and automatic console flags, refusing duplicates", () => {
    expect(
      command([
        "prompt",
        "child",
        "--text",
        "secret",
        "--sensitive",
        "--automatic",
        "--idempotency-key",
        "key",
      ]),
    ).toMatchObject({ params: { sensitive: true, automatic: true, text: "secret" } });
    expect(() =>
      command([
        "prompt",
        "child",
        "--sensitive",
        "--sensitive",
        "--text",
        "secret",
        "--idempotency-key",
        "key",
      ]),
    ).toThrow("invalid_request");
  });
});
