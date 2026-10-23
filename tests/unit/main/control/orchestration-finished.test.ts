import { describe, expect, it, vi } from "vitest";
import { harness } from "./orchestration-helpers";
import { ForgeTracking } from "../../../../src/main/control/forge-tracking";
import type { PullRequest } from "../../../../src/main/control/forge.d";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
      expect(h.host.close).not.toHaveBeenCalled();
    },
  );

  it("keeps unread parent review attention and the last loop record when its PR merges", async () => {
    const h = fixture();
    const author = await h.loop();
    h.host.close.mockImplementation((id) => {
      h.rows.delete(id);
      h.orchestration.removed(id);
      return Promise.resolve();
    });
    h.report("child-2", { verdict: "clean" });
    h.exit("child-2");
    await h.sync();
    expect(h.host.close).toHaveBeenCalledExactlyOnceWith("child-2");
    expect(h.orchestration.reviewUnreadAt("parent")).toBeDefined();
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "none",
      state: "MERGED",
    });
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalledWith(author);
    expect(h.orchestration.reviewUnreadAt("parent")).toBeDefined();
    expect(h.orchestration.reviews.view(author)?.phase).toBe("clean");
    h.orchestration.readReviews("parent");
    await h.sync();
    // Even after acknowledgment, automatic close must retain the final review record.
    expect(h.rows.has(author)).toBe(true);
    expect(h.orchestration.reviews.view(author)?.phase).toBe("clean");
  });

  it("protects unread author attention even with another participant, then keeps that last reviewer", async () => {
    const h = fixture();
    const author = await h.loop();
    const reviewer = h.rows.get("child-2");
    if (!reviewer) throw Error("missing reviewer");
    reviewer.state = {
      id: reviewer.id,
      verdictId: null,
      state: "needs_input",
      reason: "Question",
      signal: "permission",
      confidence: 1,
      timestamp: 1,
    };
    h.host.close.mockImplementation((id) => {
      h.rows.delete(id);
      h.orchestration.removed(id);
      return Promise.resolve();
    });
    h.report(reviewer.id, { verdict: "clean" });
    h.exit(reviewer.id);
    await h.sync();
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "none",
      state: "MERGED",
    });
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    expect(h.orchestration.reviewUnreadAt("parent")).toBeDefined();
    h.orchestration.readReviews("parent");
    await h.sync();
    expect(h.host.close).toHaveBeenCalledExactlyOnceWith(author);
    reviewer.state = null;
    await h.sync();
    expect(h.host.close).toHaveBeenCalledTimes(1);
    expect(h.orchestration.reviews.view(reviewer.id)?.phase).toBe("clean");
  });

  it("reserves the last loop record across concurrent asynchronous closes", async () => {
    const h = fixture();
    h.orchestration.configureCloseFinished(false);
    const author = await h.loop();
    h.report("child-2", { verdict: "clean" });
    h.exit("child-2");
    await h.sync();
    h.orchestration.readReviews("parent");
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "none",
      state: "MERGED",
    });
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    h.host.close.mockImplementation(async (id) => {
      await gate;
      h.rows.delete(id);
      h.orchestration.removed(id);
    });
    h.orchestration.configureCloseFinished(true);
    await h.sync();
    try {
      expect(h.host.close).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await h.sync();
      h.orchestration.disposeUnreadChildren();
    }
    expect(h.rows.has(author) || h.rows.has("child-2")).toBe(true);
    expect(h.orchestration.reviews.view(h.rows.has(author) ? author : "child-2")?.phase).toBe(
      "clean",
    );
  });

  it.each(["takeover", "removed", "resumed", "disabled", "revoked"])(
    "cancels fresh-observation interest when the waiting child is %s",
    async (change) => {
      const h = fixture();
      const { id } = await h.child("feature");
      const cancel = vi.fn();
      h.host.forge.waitForRead.mockReturnValue(cancel);
      h.exit(id);
      await h.sync();
      expect(h.host.forge.waitForRead).toHaveBeenCalled();
      cancel.mockClear();
      h.host.forge.waitForRead.mockClear();
      if (change === "takeover") h.orchestration.takeOver(id);
      if (change === "removed") h.orchestration.removed(id);
      if (change === "resumed") h.orchestration.relaunched(id);
      if (change === "disabled") h.orchestration.configureCloseFinished(false);
      if (change === "revoked") h.orchestration.revoke("parent");
      await h.sync();
      expect(cancel).toHaveBeenCalled();
      expect(h.host.forge.waitForRead).not.toHaveBeenCalled();
      h.orchestration.disposeUnreadChildren();
    },
  );

  it.each(["single", "batch"] as const)(
    "closes a restored exited child on an unchanged periodic %s observation",
    async (mode) => {
      const h = fixture();
      const { id } = await h.child("feature");
      const row = h.rows.get(id);
      if (!row) throw Error("missing child");
      h.orchestration.removed(id);
      row.exited = true;
      const root = await mkdtemp(join(tmpdir(), "foom-close-restore-"));
      const closed: PullRequest = {
        number: 7,
        headSha: "a".repeat(40),
        requiredChecks: "none",
        state: "CLOSED",
      };
      const lookup = vi.fn(() => Promise.resolve(closed));
      const batch = vi.fn(() =>
        Promise.resolve(
          new Map([
            [
              "feature",
              {
                ...closed,
                board: {
                  number: 7,
                  title: "PR",
                  url: "https://github.com/o/r/pull/7",
                  state: "CLOSED" as const,
                  checks: { passed: 0, failed: 0, pending: 0 },
                },
              },
            ],
          ]),
        ),
      );
      let now = 100;
      const changed = vi.fn(() => {
        h.orchestration.childEvents.publish();
      });
      const tracker = new ForgeTracking(
        root,
        () => Promise.resolve("https://github.com/o/r"),
        changed,
        () => ({ lookup, ...(mode === "batch" ? { batch } : {}) }),
        () => now,
      );
      h.host.forge.read.mockImplementation((repository, path) => tracker.read(repository, path));
      h.host.forge.revision.mockImplementation(() => tracker.revision());
      h.host.forge.readSettled.mockImplementation((repository, path, after) =>
        tracker.readSettled(repository, path, after),
      );
      h.host.forge.waitForRead.mockImplementation((repository, path, after) =>
        tracker.waitForRead(repository, path, after),
      );
      try {
        tracker.track({
          repository: row.repository,
          path: row.worktree,
          branch: "feature",
          identity: "id-feature",
        });
        await tracker.poll();
        expect(await h.orchestration.restoreChild("parent", row)).toBe(true);
        await settled();
        expect(h.host.close).not.toHaveBeenCalled();
        changed.mockClear();
        now += 600000;
        await tracker.poll();
        // No unrelated child-event publication may be needed to discover this read.
        await settled();
        expect(h.host.close).toHaveBeenCalledExactlyOnceWith(id);
        expect(changed).toHaveBeenCalledTimes(1);
        now += 600000;
        await tracker.poll();
        await settled();
        expect(changed).toHaveBeenCalledTimes(1);
        expect(mode === "batch" ? batch : lookup).toHaveBeenCalledTimes(3);
      } finally {
        h.orchestration.disposeUnreadChildren();
        await tracker.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("waits for the exit-triggered forge read instead of closing a reopened cached CLOSED PR", async () => {
    const h = fixture();
    const { id } = await h.child("feature");
    const row = h.rows.get(id);
    if (!row) throw Error("missing child");
    const root = await mkdtemp(join(tmpdir(), "foom-close-refresh-"));
    const closed: PullRequest = {
      number: 7,
      headSha: "a".repeat(40),
      requiredChecks: "none",
      state: "CLOSED",
    };
    let release: ((pr: PullRequest) => void) | undefined;
    const pending = new Promise<PullRequest>((resolve) => {
      release = resolve;
    });
    const lookup = vi.fn(() => Promise.resolve(closed));
    const tracker = new ForgeTracking(
      root,
      () => Promise.resolve("https://github.com/o/r"),
      () => {
        h.orchestration.childEvents.publish();
      },
      () => ({ lookup }),
    );
    h.host.forge.read.mockImplementation((repository, path) => tracker.read(repository, path));
    h.host.forge.revision.mockImplementation(() => tracker.revision());
    h.host.forge.readSettled.mockImplementation((repository, path, after) =>
      tracker.readSettled(repository, path, after),
    );
    try {
      tracker.track({
        repository: row.repository,
        path: row.worktree,
        branch: "feature",
        identity: "id-feature",
      });
      await tracker.poll();
      // Exit can be published before the queued refresh callback runs.
      h.exit(id);
      await h.sync();
      expect(h.host.close).not.toHaveBeenCalled();
      lookup.mockReturnValueOnce(pending);
      tracker.recheck(row.worktree);
      await h.sync();
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(h.host.close).not.toHaveBeenCalled();
      release?.({ ...closed, state: "OPEN" });
      await tracker.poll();
      await h.sync();
      expect(h.host.close).not.toHaveBeenCalled();
      for (let index = 0; index < 10; index++) await h.sync();
      expect(lookup).toHaveBeenCalledTimes(2);
      lookup.mockResolvedValue({ ...closed, state: "MERGED" });
      tracker.recheck(row.worktree);
      await tracker.poll();
      await h.sync();
      expect(h.host.close).toHaveBeenCalledExactlyOnceWith(id);
    } finally {
      release?.(closed);
      await tracker.close();
      h.orchestration.disposeUnreadChildren();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a clean author after acknowledgment when it carries the last review record", async () => {
    const h = fixture();
    const author = await h.loop();
    h.host.close.mockImplementation((id) => {
      h.rows.delete(id);
      h.orchestration.removed(id);
      return Promise.resolve();
    });
    h.report("child-2", { verdict: "clean" });
    h.exit("child-2");
    await h.sync();
    h.orchestration.readReviews("parent");
    h.host.close.mockClear();
    h.host.forge.read.mockReturnValue({
      number: 7,
      headSha: "head",
      requiredChecks: "none",
      state: "MERGED",
    });
    await h.sync();
    expect(h.host.close).not.toHaveBeenCalled();
    expect(h.rows.has(author)).toBe(true);
    expect(h.host.remove).not.toHaveBeenCalled();
    expect(h.orchestration.reviews.view(author)?.phase).toBe("clean");
  });
});
