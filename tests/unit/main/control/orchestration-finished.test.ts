import { describe, expect, it } from "vitest";
import { harness } from "./orchestration-helpers";
import type { Handoff } from "../../../../src/shared/handoff";

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const h = harness({ reviewSnapshot: () => Promise.resolve({ head: "head", digest: "same" }) });
  const sync = async () => {
    h.orchestration.childEvents.publish();
    await settled();
  };
  const report = (id: string, review?: Handoff["review"]) => {
    h.orchestration.handoffs.restore(id, [
      {
        seq: 1,
        status: "done",
        summary: "Finished",
        links: [],
        timestamp: new Date(0).toISOString(),
        ...(review ? { review } : {}),
      },
    ]);
  };
  const loop = async () => {
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      state: "OPEN",
      requiredChecks: "success",
    });
    const tree = await h.mutate("create_worktree", { branch: "feature" });
    const launched = await h.mutate("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      review: {},
    });
    const id = launched.resultId ?? "";
    const row = h.rows.get(id);
    if (!row) throw Error("missing author");
    row.conversationId = "conversation";
    report(id);
    h.exit(id);
    await sync();
    return id;
  };
  return { ...h, sync, report, loop };
}

describe("close finished agents", () => {
  it.each(["MERGED", "CLOSED"] as const)(
    "closes an exited ordinary child after its PR becomes %s, once",
    async (state) => {
      const h = fixture();
      const { id } = await h.child("feature");
      h.exit(id);
      await h.sync();
      expect(h.host.close).not.toHaveBeenCalled();
      h.host.forge.read.mockReturnValue({
        number: 7,
        headSha: "head",
        requiredChecks: "none",
        state,
      });
      await h.sync();
      expect(h.host.close).toHaveBeenCalledExactlyOnceWith(id);
      await h.sync();
      expect(h.host.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "running",
    "taken over",
    "needs user",
    "unread attention",
    "blocked",
    "no PR",
    "open PR",
    "disabled",
    "parent exited",
    "missing row",
    "shell",
    "starting",
  ])("keeps a session with %s", async (reason) => {
    const h = fixture();
    const { id } = await h.child("feature");
    const row = h.rows.get(id);
    if (!row) throw Error("missing child");
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "none",
      state: "MERGED",
    });
    // All protections are established before publishing the observed exit.
    if (reason === "taken over") h.orchestration.takeOver(id);
    if (reason === "needs user" || reason === "unread attention")
      row.state = {
        id,
        verdictId: null,
        state: "needs_input",
        reason,
        signal: reason === "unread attention" ? "orchestration:unread" : "hook:permission",
        confidence: 1,
        timestamp: 1,
      };
    if (reason === "blocked")
      row.execution = { terminalId: id, launch: 1, revision: 1, turn: 1, phase: "blocked" };
    if (reason === "no PR") h.host.forge.read.mockReturnValue(undefined);
    if (reason === "open PR")
      h.host.forge.read.mockReturnValue({
        number: 7,
        headSha: "head",
        requiredChecks: "none",
        state: "OPEN",
      });
    if (reason === "disabled") h.orchestration.configureCloseFinished(false);
    if (reason === "parent exited") h.exit("parent");
    if (reason === "shell") row.kind = "shell";
    if (reason === "starting") Object.assign(h.host, { starting: () => true });
    if (reason !== "running") h.exit(id);
    if (reason === "missing row") h.rows.delete(id);
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    h.orchestration.disposeUnreadChildren();
  });

  it("applies the switch live and retains failed closes without busy retrying", async () => {
    const h = fixture();
    h.orchestration.configureCloseFinished(false);
    const { id } = await h.child("feature");
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "none",
      state: "MERGED",
    });
    h.host.close.mockRejectedValue(new Error("host unavailable"));
    h.exit(id);
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    h.orchestration.configureCloseFinished(true);
    await h.sync();
    expect(h.host.close).toHaveBeenCalledExactlyOnceWith(id);
    for (let i = 0; i < 10; i++) await h.sync();
    expect(h.host.close).toHaveBeenCalledTimes(1);
  });

  it.each(["takeover", "setting", "resumed", "PR reopened", "revoked", "audit failed"])(
    "rechecks %s at the durable close boundary",
    async (change) => {
      const h = fixture();
      const { id } = await h.child("feature");
      h.host.forge.read.mockReturnValue({
        number: 7,
        headSha: "head",
        requiredChecks: "none",
        state: "MERGED",
      });
      h.persist.mockImplementationOnce(async () => {
        await Promise.resolve();
        if (change === "takeover") h.orchestration.takeOver(id);
        if (change === "setting") h.orchestration.configureCloseFinished(false);
        if (change === "resumed") {
          const row = h.rows.get(id);
          if (row) row.exited = false;
        }
        if (change === "PR reopened")
          h.host.forge.read.mockReturnValue({
            number: 7,
            headSha: "head",
            requiredChecks: "success",
            state: "OPEN",
          });
        if (change === "revoked") h.orchestration.revoke("parent");
        if (change === "audit failed") throw Error("audit unavailable");
      });
      h.exit(id);
      await h.sync();
      expect(h.host.close).not.toHaveBeenCalled();
      h.orchestration.disposeUnreadChildren();
    },
  );

  it.each(["clean", "findings"] as const)(
    "closes a reviewer only after its %s verdict is accepted and preserves the author's loop",
    async (verdict) => {
      const h = fixture();
      const author = await h.loop();
      expect(h.host.close).not.toHaveBeenCalled();
      h.report(
        "child-2",
        verdict === "clean"
          ? { verdict }
          : { verdict, findings: [{ file: "a.ts", line: 1, summary: "Bug", scenario: "Zero" }] },
      );
      await h.sync();
      expect(h.host.close).not.toHaveBeenCalled();
      h.host.close.mockImplementation((id) => {
        h.rows.delete(id);
        h.orchestration.removed(id);
        return Promise.resolve();
      });
      h.exit("child-2");
      await h.sync();
      expect(h.host.close).toHaveBeenCalledExactlyOnceWith("child-2");
      expect(h.orchestration.reviews.view(author)?.phase).toBe(
        verdict === "clean" ? "clean" : "fixing",
      );
      expect(h.rows.has(author)).toBe(true);
      h.orchestration.disposeUnreadChildren();
    },
  );

  it("keeps an exited reviewer whose verdict was rejected", async () => {
    const h = fixture();
    await h.loop();
    h.exit("child-2");
    h.report("child-2");
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    expect(h.orchestration.reviews.view("child-2")?.reason).toBe("missing verdict");
  });

  it.each(["building", "reviewing", "fixing", "waiting-on-parent", "clean", "escalated"] as const)(
    "protects resumable author phase %s",
    async (phase) => {
      const h = fixture();
      const { id } = await h.child("feature");
      const row = h.rows.get(id);
      if (!row) throw Error("missing author");
      // Main's saved metadata fallback is also subject to the resumable-author guard.
      row.review = {
        authorId: id,
        phase,
        rounds: 3,
        round: 1,
        agent: "claude",
        postFindings: false,
      };
      h.host.forge.read.mockReturnValue({
        number: 7,
        headSha: "head",
        requiredChecks: "none",
        state: "MERGED",
      });
      h.exit(id);
      await h.sync();
      expect(h.host.close).toHaveBeenCalledTimes(
        phase === "clean" || phase === "escalated" ? 1 : 0,
      );
    },
  );

  it("closes a clean author on a later merged update, retaining checkout and review state", async () => {
    const h = fixture();
    const author = await h.loop();
    h.report("child-2", { verdict: "clean" });
    h.exit("child-2");
    await h.sync();
    h.host.close.mockClear();
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "none",
      state: "MERGED",
    });
    await h.sync();
    expect(h.host.close).toHaveBeenCalledExactlyOnceWith(author);
    expect(h.host.remove).not.toHaveBeenCalled();
    expect(h.orchestration.reviews.view(author)?.phase).toBe("clean");
  });
});
