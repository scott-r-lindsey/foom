import { describe, expect, it, vi } from "vitest";
import { harness, repo } from "./orchestration-helpers";
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
  it("launches ordinary owned reviewers and resumes the same author without using the PTY input capability", async () => {
    const h = fixture();
    const id = await h.launch();
    const row = h.rows.get(id);
    if (!row) throw new Error("missing author");
    row.conversationId = "author-conversation";
    h.report(id);
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
