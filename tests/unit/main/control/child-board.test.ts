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
