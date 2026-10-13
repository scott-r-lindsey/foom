import { describe, expect, it, vi } from "vitest";
import { ReviewedReplies } from "../../../../src/main/control/replies";
import { Operations } from "../../../../src/main/control/operations";
import { SessionMetadata } from "../../../../src/main/control/metadata";
import type { Principal, StoredOperation } from "../../../../src/main/control/types";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";
import type { DialogContent } from "../../../../src/shared/confirmation";

function harness(forge: () => unknown = () => undefined) {
  let now = 100_000;
  const actor: Principal = {
    generation: "g",
    sessionId: "s",
    repository: "/repo",
    worktree: "/repo",
    terminalId: "parent",
    parentId: null,
    role: "orchestrator",
  };
  let active = actor;
  let owned = true;
  const row: WorkspaceTerminal = {
    id: "child",
    kind: "agent",
    agent: "claude",
    repository: "/repo",
    worktree: "/repo/child",
    branch: "child",
    attention: "evaluator",
    state: {
      id: "child",
      verdictId: "v1",
      state: "needs_input",
      attentionKind: "question",
      signal: "pattern:question",
      reason: "Question",
      timestamp: 1,
      confidence: 0.01,
    },
  };
  const host = {
    terminals: () => [row],
    tail: vi.fn(() => Promise.resolve(["Which file should I change?"])),
    dialog: vi.fn((_content: DialogContent, _signal: AbortSignal) => Promise.resolve(true)),
    reply: vi.fn((_id: string, _text: string) => Promise.resolve()),
    reveal: vi.fn(),
  };
  const persist = vi.fn((_record: StoredOperation) => Promise.resolve());
  const operations = new Operations(persist, (a) => {
    if (a !== active) throw new Error("revoked");
  });
  const replies = new ReviewedReplies(host, () => now, forge);
  const note = vi.fn();
  const aborts = new Set<AbortController>();
  const params = (key = "k1", text = "src/app.ts") => {
    const state = new SessionMetadata(host.terminals, forge).read(actor, "session_state", {
      id: "child",
    }) as { revision: string; verdictId: string };
    return {
      id: "child",
      revision: state.revision,
      verdictId: state.verdictId,
      idempotencyKey: key,
      text,
    };
  };
  const propose = (p: Record<string, unknown> = params()) =>
    replies.propose(
      actor,
      p,
      operations,
      () => {
        if (!owned || actor !== active) throw new Error("revoked");
      },
      note,
      aborts,
    );
  const done = async (key = "k1") => {
    await vi.waitFor(() => {
      expect(operations.lookup(actor, { idempotencyKey: key }).status).not.toMatch(
        /pending_confirmation|running/u,
      );
    });
    return operations.lookup(actor, { idempotencyKey: key });
  };
  const fresh = (n: number) => {
    if (!row.state) throw new Error("state missing");
    row.state.verdictId = `v${String(n)}`;
    row.state.timestamp++;
    now += 10_000;
    host.tail.mockResolvedValue([`Which file should I change for task ${String(n)}?`]);
  };
  return {
    actor,
    row,
    host,
    persist,
    operations,
    replies,
    note,
    aborts,
    params,
    propose,
    done,
    fresh,
    revoke: () => {
      active = { ...actor, role: "agent" };
      operations.revoke(actor);
      for (const abort of aborts) abort.abort();
    },
    takeover: () => {
      owned = false;
      replies.invalidate("child");
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("human-reviewed question reply gate", () => {
  it("persists a redacted single-use proposal, reviews exact text and context, writes once and deduplicates", async () => {
    const h = harness();
    const p = h.params("k1", "api_key=supersecret");
    expect(await h.propose(p)).toMatchObject({ status: "pending_confirmation", action: "reply" });
    expect(await h.done()).toMatchObject({ status: "succeeded" });
    expect(h.host.dialog.mock.calls[0]?.[0].reply?.text).toBe("api_key=supersecret");
    expect(h.host.reply).toHaveBeenCalledExactlyOnceWith("child", "api_key=supersecret\r");
    expect(JSON.stringify(h.persist.mock.calls)).not.toContain("supersecret");
    expect(await h.propose(p)).toMatchObject({ status: "succeeded" });
    expect(h.host.reply).toHaveBeenCalledTimes(1);
    await h.propose(h.params("k2"));
    expect(await h.done("k2")).toMatchObject({ status: "cancelled" });
  });
  it.each(["permission", "credential", "provider", "unknown"] as const)(
    "rejects %s even with maximal confidence or forged needs_input",
    async (kind) => {
      const h = harness();
      if (!h.row.state) throw new Error("state missing");
      h.row.state.attentionKind = kind;
      h.row.state.confidence = 1;
      await expect(h.propose()).rejects.toThrow("conflict");
      expect(h.persist).not.toHaveBeenCalled();
      expect(h.host.dialog).not.toHaveBeenCalled();
      expect(h.host.reply).not.toHaveBeenCalled();
    },
  );
  it.each([
    "",
    " ",
    "\n",
    "yes\rno",
    "\t",
    "\x1b[A",
    "\x00",
    "\x7f",
    "\u202e",
    "a\u2028b",
    "/approve",
    "  /exit",
    "é".repeat(2049),
  ])("rejects unsafe text %j", async (text) => {
    const h = harness();
    await expect(h.propose(h.params("k1", text))).rejects.toThrow("invalid_request");
    expect(h.persist).not.toHaveBeenCalled();
  });
  it("accepts 4096 UTF-8 bytes and rejects extra fields, stale IDs and cross-child access", async () => {
    const h = harness();
    await h.propose(h.params("k1", "é".repeat(2048)));
    await h.done();
    await expect(h.propose({ ...h.params("k2"), unattended: true })).rejects.toThrow(
      "invalid_request",
    );
    await expect(h.propose({ ...h.params("k3"), id: "" })).rejects.toThrow("invalid_request");
    await expect(h.propose({ ...h.params("k4"), revision: "stale" })).rejects.toThrow("conflict");
    h.takeover();
    await expect(h.propose(h.params("k5"))).rejects.toThrow("revoked");
  });
  it.each(["output", "input", "permission", "dismissal", "exit", "takeover"])(
    "invalidates on %s while review is open, including PTY mode switches",
    async (event) => {
      const h = harness();
      let accept: (value: boolean) => void = () => {};
      h.host.dialog.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            accept = resolve;
          }),
      );
      await h.propose();
      await vi.waitFor(() => {
        expect(h.host.dialog).toHaveBeenCalled();
      });
      if (event === "takeover") h.takeover();
      else h.replies.invalidate("child");
      if (event === "permission" && h.row.state) h.row.state.attentionKind = "permission";
      if (event === "exit") h.row.exited = true;
      accept(true);
      await h.done();
      expect(h.host.reply).not.toHaveBeenCalled();
      expect(h.host.dialog.mock.calls[0]?.[1].aborted).toBe(true);
    },
  );
  it("binds to principal identity on role changes even when generation stays the same", async () => {
    const h = harness();
    let accept: (v: boolean) => void = () => {};
    h.host.dialog.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    await h.propose();
    await vi.waitFor(() => {
      expect(h.host.dialog).toHaveBeenCalled();
    });
    h.revoke();
    accept(true);
    await h.operations.drain();
    expect(h.host.reply).not.toHaveBeenCalled();
    expect(h.host.dialog.mock.calls[0]?.[1].aborted).toBe(true);
  });
  it("rejects activity during context retrieval, delayed hooks and new proposals from stale screen state", async () => {
    const h = harness();
    h.host.tail.mockImplementation(() => {
      h.replies.invalidate("child");
      return Promise.resolve(["Allow execution? (y/n)"]);
    });
    await h.propose();
    await h.done();
    expect(h.host.dialog).not.toHaveBeenCalled();
    h.row.outputRevision = 1;
    await expect(h.propose(h.params("k2"))).rejects.toThrow("invalid_request");
    expect(h.host.reply).not.toHaveBeenCalled();
  });
  it("declines without delivery and refuses missing adapters", async () => {
    const h = harness();
    h.host.dialog.mockResolvedValue(false);
    await h.propose();
    expect(await h.done()).toMatchObject({ status: "declined" });
    const host = { terminals: h.host.terminals, tail: h.host.tail, dialog: h.host.dialog };
    const noAdapter = new ReviewedReplies(host, Date.now);
    await noAdapter.propose(h.actor, h.params("k2"), h.operations, () => {}, h.note, h.aborts);
    expect(await h.done("k2")).toMatchObject({ status: "cancelled" });
  });
  it("enforces ten seconds and three sends before explicit human reset without replaying a verdict", async () => {
    const h = harness();
    await h.propose();
    await h.done();
    h.fresh(2);
    h.advance(-9999);
    await h.propose(h.params("k2"));
    await h.done("k2");
    expect(h.host.reply).toHaveBeenCalledTimes(1);
    h.advance(9999);
    await h.propose(h.params("k3"));
    await h.done("k3");
    h.fresh(3);
    await h.propose(h.params("k4"));
    await h.done("k4");
    h.fresh(4);
    await h.propose(h.params("k5"));
    await h.done("k5");
    expect(h.host.reply).toHaveBeenCalledTimes(3);
    h.replies.reset("child");
    await h.propose(h.params("k6"));
    await h.done("k6");
    expect(h.host.reply).toHaveBeenCalledTimes(4);
    h.replies.reset("child");
    await h.propose(h.params("k7"));
    await h.done("k7");
    expect(h.host.reply).toHaveBeenCalledTimes(4);
    h.replies.reset("nonexistent");
  });
  it("never replays ambiguous delivery, refuses intent log failure and pre-write audit failure", async () => {
    const h = harness();
    h.host.reply.mockRejectedValue(new Error("possibly sent"));
    const p = h.params();
    await h.propose(p);
    expect(await h.done()).toMatchObject({ status: "indeterminate" });
    await h.propose(p);
    expect(h.host.reply).toHaveBeenCalledTimes(1);
    const failed = harness();
    failed.persist.mockRejectedValue(new Error("disk full"));
    await expect(failed.propose()).rejects.toThrow("unavailable");
    expect(failed.host.reply).not.toHaveBeenCalled();
    const later = harness();
    later.host.dialog.mockImplementation(() => {
      later.persist.mockRejectedValue(new Error("disk full"));
      return Promise.resolve(true);
    });
    await later.propose();
    await later.done();
    expect(later.host.reply).not.toHaveBeenCalled();
  });
});

it("suspends repeated questions until human reset, including new verdict IDs", async () => {
  const h = harness();
  await h.propose();
  await h.done();
  h.fresh(2);
  h.host.tail.mockResolvedValue(["Which file should I change?"]);
  await h.propose(h.params("k2"));
  await h.done("k2");
  h.fresh(3);
  await h.propose(h.params("k3"));
  await h.done("k3");
  expect(h.host.reply).toHaveBeenCalledTimes(1);
  h.replies.reset("child");
  h.fresh(4);
  await h.propose(h.params("k4"));
  await h.done("k4");
  expect(h.host.reply).toHaveBeenCalledTimes(2);
});

it("accepts the same validated PR-aware revision exposed by session metadata", async () => {
  const h = harness(() => ({
    number: 340,
    headSha: "a".repeat(40),
    state: "OPEN",
    requiredChecks: "pending",
  }));
  await h.propose();
  expect((await h.done()).status).toBe("succeeded");
  expect(h.host.reply).toHaveBeenCalledWith("child", "src/app.ts\r");
});
