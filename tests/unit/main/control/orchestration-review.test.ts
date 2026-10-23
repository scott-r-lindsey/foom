import { describe, expect, it, vi } from "vitest";
import { AUTHOR_REVIEW_BRIEF } from "../../../../src/main/control/review-loops";
import { harness, other, repo } from "./orchestration-helpers";
import type { Handoff } from "../../../../src/shared/handoff";

function fixture() {
  const snapshot = vi.fn(() => Promise.resolve({ head: "head", digest: "initial" }));
  const h = harness({ reviewSnapshot: snapshot });
  h.host.forge.read.mockReturnValue({
    number: 7,
    headSha: "head",
    state: "OPEN",
    requiredChecks: "success",
  });
  const sync = async () => {
    h.orchestration.childEvents.publish();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const launch = async () => {
    const tree = await h.mutate("create_worktree", { branch: "feature" });
    const launched = await h.mutate("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      prompt: "Build the feature",
      review: {},
    });
    return launched.resultId ?? "";
  };
  const report = (id: string, review?: Handoff["review"], status: Handoff["status"] = "done") => {
    h.orchestration.handoffs.restore(id, [
      ...h.orchestration.handoffs.entries(id),
      {
        seq: (h.orchestration.handoffs.latest(id)?.seq ?? 0) + 1,
        status,
        summary: "Result",
        links: [],
        timestamp: new Date(0).toISOString(),
        ...(review ? { review } : {}),
      },
    ]);
  };
  return { ...h, snapshot, sync, launch, report };
}

describe("orchestration review authority and reservations", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "advances an authenticated done handoff without further author activity (blocked: %s, natural exit: %s)",
    async (blocked, naturalExit) => {
      const h = fixture();
      try {
        const id = await h.launch();
        const row = h.rows.get(id);
        if (!row) throw new Error("missing author");
        const grant = h.service.prepare(repo, row.worktree, "agent", "parent");
        grant.bind(id);
        const actor = h.service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
        const report = (status: "blocked" | "done") =>
          h.service.call(actor, {
            version: 1,
            instanceId: h.service.instanceId,
            method: "handoff",
            params: { status, summary: "Result", idempotencyKey: status },
          });
        const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
        if (blocked) {
          await report("blocked");
          await settle();
          expect(h.orchestration.reviews.view(id)).toMatchObject({
            phase: "waiting-on-parent",
            round: 0,
          });
          await h.mutate("prompt", { id, text: "Proceed" });
          h.advance(10_000);
        }
        row.state = {
          id,
          verdictId: null,
          state: "done",
          reason: "Turn finished",
          signal: "hook:stop",
          confidence: 1,
          timestamp: 1,
        };
        let release: (() => void) | undefined;
        if (naturalExit)
          h.snapshot.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                release = () => {
                  resolve({ head: "head", digest: "initial" });
                };
              }),
          );
        await report("done");
        // The accepted handoff must wake automation itself, without a manual sync
        // or any later output, hook, PR update, or prompt from the author.
        await settle();
        if (naturalExit) {
          h.exit(id);
          release?.();
          await settle();
        }
        if (!naturalExit) {
          expect(h.host.stop).toHaveBeenCalledExactlyOnceWith(id);
          expect(h.host.launch).toHaveBeenCalledTimes(1);
          await settle();
          expect(h.host.stop).toHaveBeenCalledTimes(1);
          h.exit(id);
          await settle();
        } else expect(h.host.stop).not.toHaveBeenCalled();
        expect(h.orchestration.reviews.view(id)).toMatchObject({ phase: "reviewing", round: 1 });
        expect(h.host.launch).toHaveBeenCalledTimes(2);
      } finally {
        h.orchestration.disposeUnreadChildren();
      }
    },
  );
  it("launches ordinary owned reviewers and resumes the same author without using the PTY input capability", async () => {
    const h = fixture();
    const id = await h.launch();
    const row = h.rows.get(id);
    if (!row) throw new Error("missing author");
    row.conversationId = "author-conversation";
    h.report(id);
    await h.sync();
    expect(h.host.stop).toHaveBeenLastCalledWith(id);
    expect(h.host.launch).toHaveBeenCalledTimes(1);
    h.exit(id);
    await h.sync();
    expect(h.orchestration.reviews.view(id)).toMatchObject({ phase: "reviewing" });
    expect(h.host.place).toHaveBeenLastCalledWith("child-2", "parent");
    expect(h.orchestration.view("child-2")).toEqual({
      role: "child",
      parentId: "parent",
      takenOver: false,
    });
    expect(h.host.launch.mock.calls.at(-1)?.slice(0, 5)).toEqual([
      "parent",
      repo,
      row.worktree,
      "id-feature",
      "claude",
    ]);
    expect(h.host.launch.mock.calls.at(-1)?.[5]).toContain("Review PR #7");
    expect(typeof h.host.launch.mock.calls.at(-1)?.[6]?.validate).toBe("function");
    h.report("child-2", {
      verdict: "findings",
      findings: [{ file: "a.ts", line: 1, summary: "Wrong result", scenario: "Input zero" }],
    });
    await h.sync();
    expect(h.host.stop).toHaveBeenLastCalledWith("child-2");
    expect(h.host.launch).toHaveBeenCalledTimes(2);
    h.exit("child-2");
    await h.sync();
    expect(h.orchestration.reviews.view(id)).toMatchObject({ phase: "fixing" });
    expect(h.host.launch).toHaveBeenLastCalledWith(
      "parent",
      repo,
      row.worktree,
      "id-feature",
      "claude",
      expect.stringContaining("Quoted review notes"),
      expect.objectContaining({ resume: { id, conversationId: "author-conversation" } }),
    );
    expect(h.host.reply).not.toHaveBeenCalled();
    h.report(id);
    h.exit(id);
    await h.sync();
    h.report("child-3", { verdict: "clean" });
    h.exit("child-3");
    await h.sync();
    expect(h.orchestration.reviews.view(id)).toMatchObject({ phase: "clean" });
    expect(h.orchestration.reviewUnreadAt("parent")).toBeDefined();
    h.orchestration.readReviews("parent");
    expect(h.orchestration.reviewUnreadAt("parent")).toBeUndefined();
    expect(h.orchestration.reviewUnreadAt("unknown")).toBeUndefined();
    expect(await h.call("session_state", { id })).toMatchObject({ review: { phase: "clean" } });
    expect(await h.call("sessions")).toMatchObject({
      sessions: [
        {},
        { review: { phase: "clean" } },
        { review: { phase: "clean" } },
        { review: { phase: "clean" } },
      ],
    });
    expect(await h.call("wait_for", { ids: [id], timeoutMs: 0 })).toMatchObject({
      sessions: [{ review: { phase: "clean" } }],
    });
    expect(await h.call("read_handoff", { id: "child-2" })).toMatchObject({
      review: { verdict: "findings" },
      untrusted: true,
    });
    h.orchestration.disposeUnreadChildren();
  });
  it("waits when the configured limit is lowered, counts the reviewer and wakes when capacity is freed", async () => {
    const h = fixture();
    const id = await h.launch();
    const other = await h.child("other");
    h.setLimit(1);
    h.report(id);
    h.exit(id);
    await h.sync();
    expect(h.orchestration.reviews.view(id)).toMatchObject({ phase: "reviewing", waiting: true });
    expect(h.host.launch).toHaveBeenCalledTimes(2);
    h.exit(other.id);
    await h.sync();
    expect(h.host.launch).toHaveBeenCalledTimes(3);
    const tree = await h.mutate("create_worktree", { branch: "no-room" });
    await expect(
      h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" }),
    ).rejects.toThrow("capacity");
    h.orchestration.disposeUnreadChildren();
  });
  it.each(["stop", "takeover", "revoke", "remove", "relaunch"])(
    "cancels automation on %s",
    async (event) => {
      const h = fixture();
      const id = await h.launch();
      h.report(id, undefined, "blocked");
      await h.sync();
      expect(h.orchestration.reviews.view(id)?.phase).toBe("waiting-on-parent");
      if (event === "stop") await h.mutate("stop", { id });
      if (event === "takeover") h.orchestration.takeOver(id);
      if (event === "revoke") h.orchestration.revoke("parent");
      if (event === "remove") h.orchestration.removed(id);
      if (event === "relaunch") h.orchestration.relaunched(id);
      h.report(id);
      h.exit(id);
      await h.sync();
      expect(h.host.launch).toHaveBeenCalledTimes(1);
      if (event === "remove") expect(h.orchestration.reviews.view(id)).toBeUndefined();
      else expect(h.orchestration.reviews.view(id)).toMatchObject({ reason: "stopped" });
      h.orchestration.disposeUnreadChildren();
    },
  );
  it("rechecks cancellation after durable intent and before spawning, refusing stale automation", async () => {
    const h = fixture();
    const id = await h.launch();
    h.persist.mockImplementationOnce(() => {
      h.orchestration.takeOver(id);
      return Promise.resolve();
    });
    h.report(id);
    h.exit(id);
    await h.sync();
    expect(h.host.launch).toHaveBeenCalledTimes(1);
    expect(h.orchestration.reviews.view(id)).toMatchObject({ reason: "stopped" });
    h.orchestration.disposeUnreadChildren();
  });
  it("keeps review opt-in and rejects unsupported reviewers before launching", async () => {
    const h = fixture();
    const normal = await h.child("normal");
    expect(h.orchestration.reviews.view(normal.id)).toBeUndefined();
    const tree = await h.mutate("create_worktree", { branch: "bad" });
    await expect(
      h.mutate("launch", {
        worktreeId: tree.resultId,
        agent: "claude",
        review: { agent: "unknown" },
      }),
    ).rejects.toThrow("invalid_request");
    h.orchestration.stopReviews("parent");
    h.orchestration.stopReviews("unknown");
    h.orchestration.disposeUnreadChildren();
  });
});

it("rechecks the live grant at the final spawn boundary even if ownership metadata remains", async () => {
  const h = fixture();
  const id = await h.launch();
  let spawned = false;
  h.host.launch.mockImplementationOnce((...args) => {
    // Stand in for asynchronous provider preparation, after the durable intent.
    h.grant.dispose();
    args[6]?.validate();
    spawned = true;
    return Promise.resolve("unexpected");
  });
  h.report(id);
  h.exit(id);
  await h.sync();
  expect(spawned).toBe(false);
  expect(h.orchestration.reviews.view(id)).toMatchObject({ reason: "launch failed" });
  h.orchestration.disposeUnreadChildren();
});

it("refuses a reviewer if known checks turn red during provider preparation", async () => {
  const h = fixture();
  const id = await h.launch();
  let spawned = false;
  h.host.launch.mockImplementationOnce((...args) => {
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      state: "OPEN",
      requiredChecks: "failure",
    });
    args[6]?.validate();
    spawned = true;
    return Promise.resolve("unexpected");
  });
  h.report(id);
  h.exit(id);
  await h.sync();
  expect(spawned).toBe(false);
  expect(h.orchestration.reviews.view(id)).toMatchObject({ reason: "checks not green" });
  h.orchestration.disposeUnreadChildren();
});

it("reserves the review brief before accepting a UTF-8 task prompt at the launch boundary", async () => {
  const h = fixture();
  const tree = await h.mutate("create_worktree", { branch: "boundary" });
  const bytes = 16384 - Buffer.byteLength(`${AUTHOR_REVIEW_BRIEF}\n\n`);
  const prompt = "é".repeat(Math.floor(bytes / 2)) + "a".repeat(bytes % 2);
  for (const oversized of [prompt + "a", "a".repeat(16384)]) {
    await expect(
      h.mutate("launch", {
        worktreeId: tree.resultId,
        agent: "claude",
        prompt: oversized,
        review: {},
      }),
    ).rejects.toThrow("invalid_request");
  }
  expect(h.host.launch).not.toHaveBeenCalled();
  const launched = await h.mutate("launch", {
    worktreeId: tree.resultId,
    agent: "claude",
    prompt,
    review: {},
  });
  expect(launched.status).toBe("succeeded");
  expect(Buffer.byteLength(h.host.launch.mock.calls[0]?.[5] ?? "")).toBe(16384);
  const normal = await h.mutate("create_worktree", { branch: "normal-boundary" });
  expect(
    (
      await h.mutate("launch", {
        worktreeId: normal.resultId,
        agent: "claude",
        prompt: "a".repeat(16384),
      })
    ).status,
  ).toBe("succeeded");
  h.orchestration.disposeUnreadChildren();
});

it("resumes blocked authors only after a successful owning-parent prompt, never keys or human input", async () => {
  const h = fixture();
  const id = await h.launch();
  h.report(id, undefined, "blocked");
  await h.sync();
  const foreign = h.launchParent("foreign-parent", other);
  await expect(foreign.mutate("prompt", { id, text: "Foreign answer" })).rejects.toThrow(
    "not_found",
  );
  // Workspace/human input invalidations carry no parent-prompt capability.
  await h.sync();
  expect(h.orchestration.reviews.view(id)?.phase).toBe("waiting-on-parent");
  await h.mutate("send_keys", { id, keys: ["enter"] });
  await h.sync();
  expect(h.orchestration.reviews.view(id)?.phase).toBe("waiting-on-parent");
  h.host.reply.mockRejectedValueOnce(new Error("delivery failed"));
  await h.mutate("prompt", { id, text: "Answer" });
  await h.sync();
  expect(h.orchestration.reviews.view(id)?.phase).toBe("waiting-on-parent");
  await h.mutate("prompt", { id, text: "Proceed" });
  expect(h.orchestration.reviews.view(id)?.phase).toBe("building");
  h.report(id);
  h.exit(id);
  await h.sync();
  expect(h.orchestration.reviews.view(id)).toMatchObject({ phase: "reviewing", round: 1 });
  expect(h.host.reply).toHaveBeenCalledTimes(3);
  h.orchestration.disposeUnreadChildren();
});

it.each(["takeover", "revoke", "grant", "exit"])(
  "rechecks ownership after %s during prompt delivery",
  async (event) => {
    const h = fixture();
    const id = await h.launch();
    h.report(id, undefined, "blocked");
    await h.sync();
    h.host.reply.mockImplementationOnce(() => {
      if (event === "takeover") h.orchestration.takeOver(id);
      if (event === "revoke") h.orchestration.revoke("parent");
      if (event === "grant") h.grant.dispose();
      if (event === "exit") {
        h.report(id);
        h.exit(id);
      }
      return Promise.resolve();
    });
    const delivery = h.mutate("prompt", { id, text: "Proceed" });
    if (event === "grant") await expect(delivery).rejects.toThrow("unauthorized");
    else await delivery;
    await h.sync();
    if (event === "exit") expect(h.orchestration.reviews.view(id)?.phase).toBe("reviewing");
    else expect(h.orchestration.reviews.view(id)?.phase).not.toBe("building");
    h.orchestration.disposeUnreadChildren();
  },
);

it("rechecks the live grant before stopping a participant after its asynchronous snapshot", async () => {
  const h = fixture();
  const id = await h.launch();
  h.snapshot.mockImplementationOnce(() => {
    h.grant.dispose();
    return Promise.resolve({ head: "head", digest: "initial" });
  });
  h.report(id);
  await h.sync();
  expect(h.host.stop).not.toHaveBeenCalled();
  expect(h.orchestration.reviews.view(id)).toMatchObject({
    phase: "escalated",
    reason: "launch failed",
  });
  h.orchestration.disposeUnreadChildren();
});

it("cancels a completion stop when takeover races durable intent, and audits host stop failures", async () => {
  const h = fixture();
  const id = await h.launch();
  h.persist.mockImplementationOnce(() => {
    h.orchestration.takeOver(id);
    return Promise.resolve();
  });
  h.report(id);
  await h.sync();
  expect(h.host.stop).not.toHaveBeenCalled();
  expect(h.orchestration.reviews.view(id)?.reason).toBe("stopped");
  h.orchestration.disposeUnreadChildren();
  const f = fixture();
  const author = await f.launch();
  f.host.stop.mockRejectedValueOnce(new Error("host unavailable"));
  f.report(author);
  await f.sync();
  expect(f.orchestration.reviews.view(author)?.reason).toBe("launch failed");
  expect(f.persist.mock.calls.at(-1)?.[0].operation).toMatchObject({
    action: "stop",
    status: "indeterminate",
    targetId: author,
  });
  f.orchestration.disposeUnreadChildren();
});

it.each(["snapshot", "intent"])(
  "keeps a newly blocked author alive when done is superseded during %s",
  async (boundary) => {
    const h = fixture();
    const id = await h.launch();
    const replace = () => {
      h.report(id, undefined, "blocked");
    };
    if (boundary === "snapshot")
      h.snapshot.mockImplementationOnce(() => {
        replace();
        return Promise.resolve({ head: "head", digest: "initial" });
      });
    else
      h.persist.mockImplementationOnce(() => {
        replace();
        return Promise.resolve();
      });
    h.report(id);
    await h.sync();
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.orchestration.reviews.view(id)?.phase).toBe("waiting-on-parent");
    expect(h.rows.get(id)?.exited).not.toBe(true);
    await h.mutate("prompt", { id, text: "Proceed" });
    expect(h.orchestration.reviews.view(id)?.phase).toBe("building");
    h.orchestration.disposeUnreadChildren();
  },
);

it.each(["checks", "head"])(
  "does not signal when completion %s change during durable stop intent",
  async (change) => {
    const h = fixture();
    const id = await h.launch();
    h.persist.mockImplementationOnce(() => {
      if (change === "checks")
        h.host.forge.read.mockReturnValue({
          number: 7,
          headSha: "head",
          state: "OPEN",
          requiredChecks: "failure",
        });
      else h.snapshot.mockResolvedValue({ head: "new-head", digest: "new-digest" });
      return Promise.resolve();
    });
    h.report(id);
    await h.sync();
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.orchestration.reviews.view(id)?.reason).toBe("checks not green");
    h.orchestration.disposeUnreadChildren();
  },
);

it.each([
  ["author", "snapshot"],
  ["reviewer", "snapshot"],
  ["author", "intent"],
  ["reviewer", "intent"],
  ["author", "mutated"],
  ["reviewer", "mutated"],
] as const)(
  "preserves a natural nonzero %s exit during %s instead of exempting it",
  async (participant, boundary) => {
    const h = fixture();
    const author = await h.launch();
    let id = author;
    if (participant === "reviewer") {
      h.report(author);
      h.exit(author);
      await h.sync();
      id = "child-2";
    }
    const exit = () => {
      const row = h.rows.get(id);
      if (!row) throw new Error("missing participant");
      if (boundary === "mutated") {
        row.exited = true;
        row.exitCode = 1;
      } else h.rows.set(id, { ...row, exited: true, exitCode: 1 });
      h.orchestration.exited(id);
    };
    if (boundary === "intent")
      h.persist.mockImplementationOnce(() => {
        exit();
        return Promise.resolve();
      });
    else
      h.snapshot.mockImplementationOnce(() => {
        exit();
        return Promise.resolve({ head: "head", digest: "initial" });
      });
    h.report(id, participant === "reviewer" ? { verdict: "clean" } : undefined);
    await h.sync();
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.orchestration.reviews.view(author)?.reason).toBe(`${participant} failed`);
    h.orchestration.disposeUnreadChildren();
  },
);

it.each(["author", "reviewer"])(
  "waits without polling when the host observes a natural %s exit before main",
  async (participant) => {
    const h = fixture();
    const author = await h.launch();
    let id = author;
    if (participant === "reviewer") {
      h.report(author);
      h.exit(author);
      await h.sync();
      id = "child-2";
    }
    h.host.stop.mockResolvedValueOnce(false);
    h.report(id, participant === "reviewer" ? { verdict: "clean" } : undefined);
    await h.sync();
    // No self-sustaining retry loop while the host's exit notification is in flight.
    expect(h.host.stop).toHaveBeenCalledTimes(1);
    const row = h.rows.get(id);
    if (!row) throw new Error("missing participant");
    h.rows.set(id, { ...row, exited: true, exitCode: 1 });
    h.orchestration.exited(id);
    await h.sync();
    expect(h.orchestration.reviews.view(author)?.reason).toBe(`${participant} failed`);
    h.orchestration.disposeUnreadChildren();
  },
);
