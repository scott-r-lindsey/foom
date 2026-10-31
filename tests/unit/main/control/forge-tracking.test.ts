import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForgeTracking, forgeDelay } from "../../../../src/main/control/forge-tracking";
import { privateDirectory, atomicPrivate } from "../../../../src/node-common/private-files";
import type { ForgeMatch, ForgeWorktree, PullRequest } from "../../../../src/main/control/forge.d";
import { SessionMetadata } from "../../../../src/main/control/metadata";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";
import type { Principal } from "../../../../src/main/control/types";
let root: string;
let directory: string;
const trackers: ForgeTracking[] = [];
const tree = {
  repository: join(tmpdir(), "repo"),
  path: join(tmpdir(), "tree"),
  identity: "owned",
  branch: "child-one",
};
const pending: PullRequest = {
  number: 340,
  headSha: "a".repeat(40),
  state: "OPEN",
  requiredChecks: "pending",
};
beforeEach(async () => {
  vi.useFakeTimers();
  root = await mkdtemp(join(tmpdir(), "forge-tracking-"));
  directory = await privateDirectory(root);
});
afterEach(async () => {
  await Promise.all(trackers.splice(0).map((tracker) => tracker.close()));
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
function harness() {
  let now = 100;
  let result: PullRequest | undefined = pending;
  const inspect = vi.fn(() => Promise.resolve<string | undefined>("https://github.com/o/r"));
  const lookup = vi.fn((_branch: string, _number?: number) => Promise.resolve(result));
  const changed = vi.fn();
  const provider = vi.fn(() => ({ lookup }));
  const tracker = new ForgeTracking(directory, inspect, changed, provider, () => now);
  trackers.push(tracker);
  return {
    tracker,
    inspect,
    lookup,
    changed,
    provider,
    advance: (ms: number) => {
      now += ms;
    },
    result: (pr: PullRequest | undefined) => {
      result = pr;
    },
  };
}
it("bounds exponential backoff and serializes unchanged/success/failure polls", async () => {
  expect([0, 1, 2, 3, 4, 5, 100].map(forgeDelay)).toEqual([
    30000, 60000, 120000, 240000, 480000, 600000, 600000,
  ]);
  const h = harness();
  h.tracker.track(tree);
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)).toEqual(pending);
  expect(h.tracker.read("foreign", tree.path)).toBeUndefined();
  expect(h.changed).toHaveBeenCalledTimes(1);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledTimes(1);
  h.advance(30000);
  await Promise.all([h.tracker.poll(), h.tracker.poll()]);
  expect(h.lookup).toHaveBeenCalledTimes(2);
  expect(h.changed).toHaveBeenCalledTimes(1);
  expect(h.lookup).toHaveBeenLastCalledWith("child-one", 340);
  h.result({ ...pending, requiredChecks: "success" });
  h.advance(30000);
  await h.tracker.poll();
  expect(h.changed).toHaveBeenCalledTimes(2);
  h.result(undefined);
  h.advance(30000);
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)).toBeUndefined();
  h.advance(59999);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledTimes(4);
  h.advance(1);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledTimes(5);
  for (let index = 0; index < 6; index++) {
    h.advance(600000);
    await h.tracker.poll();
  }
});
it("persists mapping independently of a parent session or credential generation", async () => {
  const h = harness();
  h.tracker.track(tree);
  await h.tracker.poll();
  await h.tracker.close();
  const next = harness();
  next.result({ ...pending, state: "MERGED", requiredChecks: "success" });
  await next.tracker.load();
  expect(next.tracker.read(tree.repository, tree.path)).toBeUndefined();
  await next.tracker.poll();
  expect(next.lookup).toHaveBeenCalledWith("child-one", 340);
  expect(next.tracker.read(tree.repository, tree.path)).toEqual({
    ...pending,
    state: "MERGED",
    requiredChecks: "success",
  });
  next.tracker.track({ ...tree });
  expect(next.tracker.read(tree.repository, tree.path)).toEqual({
    ...pending,
    state: "MERGED",
    requiredChecks: "success",
  });
  next.tracker.track({ ...tree, identity: "replaced" });
  expect(next.tracker.read(tree.repository, tree.path)).toBeUndefined();
  await next.tracker.poll();
  expect(next.lookup).toHaveBeenLastCalledWith("child-one", undefined);
});
it("revalidates ownership and remote, clears unavailable observations, and continues after exceptions", async () => {
  const h = harness();
  h.tracker.track(tree);
  await h.tracker.poll();
  h.inspect.mockResolvedValueOnce("https://github.com/new/repo");
  h.advance(30000);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenLastCalledWith("child-one", undefined);
  h.lookup.mockRejectedValueOnce(new Error("offline"));
  h.advance(30000);
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)).toBeUndefined();
  h.inspect.mockRejectedValueOnce(new Error("removed"));
  h.advance(60000);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledTimes(3);
  const next = harness();
  await next.tracker.load();
  await next.tracker.poll();
  expect(next.inspect).not.toHaveBeenCalled();
});
it("discovers a not-yet-opened PR across restart and handles an unknown provider", async () => {
  const h = harness();
  h.result(undefined);
  h.tracker.track(tree);
  await h.tracker.poll();
  await h.tracker.close();
  const next = harness();
  await next.tracker.load();
  await next.tracker.poll();
  expect(next.lookup).toHaveBeenCalledWith("child-one", undefined);
  const unsupported = new ForgeTracking(
    directory,
    () => Promise.resolve("unknown"),
    () => {},
    () => undefined,
  );
  trackers.push(unsupported);
  unsupported.track(tree);
  await unsupported.poll();
  expect(unsupported.read(tree.repository, tree.path)).toBeUndefined();
});
it("ignores corrupt/oversized records and narrows saved fields", async () => {
  const h = harness();
  await h.tracker.load();
  await atomicPrivate(directory, "forge.json", [
    null,
    { ...tree, pr: { ...pending, number: "340" } },
    { ...tree, remote: 123, pr: pending },
    { ...tree, path: "relative" },
    { ...tree, pr: pending, remote: "https://github.com/o/r", token: "secret" },
  ]);
  await h.tracker.load();
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)).toEqual(pending);
  await writeFile(join(directory, "forge.json"), "not json");
  await h.tracker.load();
  await atomicPrivate(directory, "forge.json", {});
  await h.tracker.load();
  await atomicPrivate(
    directory,
    "forge.json",
    Array.from({ length: 1001 }, () => tree),
  );
  await h.tracker.load();
  await writeFile(join(directory, "forge.json"), " ".repeat(16 * 1024 * 1024 + 1));
  await h.tracker.load();
  h.tracker.track({ ...tree, branch: "--help" });
  h.tracker.track({ ...tree, path: "relative" });
});
it("caps tracked worktrees and stops polling on shutdown, including in-flight results", async () => {
  const h = harness();
  for (let index = 0; index < 1001; index++)
    h.tracker.track({ ...tree, path: join(tmpdir(), `tree-${String(index)}`) });
  await h.tracker.poll();
  expect(h.inspect).toHaveBeenCalledTimes(1);
  h.tracker.track({ ...tree, path: join(tmpdir(), "tree-0"), identity: "new" });
  await h.tracker.close();
  h.tracker.track(tree);
  await h.tracker.poll();
  expect(h.inspect).toHaveBeenCalledTimes(1);
  const late = harness();
  late.tracker.track(tree);
  let resolve: (remote: string) => void = () => {};
  late.inspect.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const poll = late.tracker.poll();
  await Promise.resolve();
  const close = late.tracker.close();
  resolve("https://github.com/o/r");
  await Promise.all([poll, close]);
  expect(late.lookup).not.toHaveBeenCalled();
});
it("runs scheduled polls with no overlapping processes and closes cleanly", async () => {
  const h = harness();
  h.tracker.track(tree);
  await vi.advanceTimersByTimeAsync(1000);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledTimes(1);
  await h.tracker.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.lookup).toHaveBeenCalledTimes(1);
  const opened = await ForgeTracking.open(
    root,
    () => Promise.resolve(undefined),
    () => {},
  );
  trackers.push(opened);
  await opened.poll();
});
it("changes metadata revision on PR conclusion while narrowing untrusted fields", async () => {
  const h = harness();
  h.tracker.track(tree);
  await h.tracker.poll();
  const row: WorkspaceTerminal = {
    id: "child",
    agent: "claude",
    kind: "agent",
    repository: tree.repository,
    worktree: tree.path,
    branch: tree.branch,
    attention: "evaluator",
    state: null,
  };
  const actor: Principal = {
    grantedAt: "2026-10-15T00:00:00.000Z",
    generation: "new-generation",
    sessionId: "parent",
    terminalId: "parent",
    repository: tree.repository,
    worktree: tree.repository,
    parentId: null,
    role: "orchestrator",
  };
  const metadata = new SessionMetadata(
    () => [row],
    (row) => h.tracker.read(row.repository, row.worktree),
  );
  const before = metadata.read(actor, "session_state", { id: "child" });
  h.advance(30000);
  h.result({ ...pending, requiredChecks: "success" });
  await h.tracker.poll();
  const after = metadata.read(actor, "session_state", { id: "child" });
  expect(after).not.toEqual(before);
  expect(after).toMatchObject({ state: "quiet_ok", pullRequest: { requiredChecks: "success" } });
  expect(metadata.read(actor, "sessions", {})).toMatchObject({
    sessions: [{ pullRequest: { number: 340 } }],
  });
  h.advance(30000);
  h.result({ ...pending, requiredChecks: "success", checksMeaning: "commit-status" });
  await h.tracker.poll();
  const meaning = metadata.read(actor, "session_state", { id: "child" });
  expect(meaning).not.toEqual(after);
  expect(meaning).toMatchObject({
    pullRequest: { checksMeaning: "commit-status", requiredChecks: "success" },
  });
  const hostile = new SessionMetadata(
    () => [row],
    () => ({ ...pending, number: "340" }),
  );
  expect(hostile.read(actor, "session_state", { id: "child" })).not.toHaveProperty("pullRequest");
});

it("persists unknown check conclusions, refreshes normally and publishes recovery", async () => {
  const h = harness();
  const unknown: PullRequest = { ...pending, requiredChecks: "unknown" };
  h.result(unknown);
  h.tracker.track(tree);
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)).toEqual(unknown);
  h.advance(29999);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledTimes(1);
  h.advance(1);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledTimes(2);
  expect(h.changed).toHaveBeenCalledTimes(1);
  await h.tracker.close();
  const next = harness();
  next.result(unknown);
  await next.tracker.load();
  expect(next.tracker.read(tree.repository, tree.path)).toBeUndefined();
  await next.tracker.poll();
  expect(next.lookup).toHaveBeenCalledWith(tree.branch, pending.number);
  expect(next.tracker.read(tree.repository, tree.path)).toEqual(unknown);
  next.advance(30000);
  next.result({ ...pending, requiredChecks: "success" });
  await next.tracker.poll();
  expect(next.changed).toHaveBeenCalledTimes(2);
  expect(next.tracker.read(tree.repository, tree.path)?.requiredChecks).toBe("success");
});
it("binds an adopted checkout to its requested PR, including before the first successful poll", async () => {
  const h = harness();
  h.result(undefined);
  h.tracker.track(tree, 337);
  h.tracker.track(tree);
  await h.tracker.poll();
  expect(h.lookup).toHaveBeenCalledWith("child-one", 337);
  await h.tracker.close();
  const next = harness();
  next.result({ ...pending, number: 337 });
  await next.tracker.load();
  await next.tracker.poll();
  expect(next.lookup).toHaveBeenCalledWith("child-one", 337);
  expect(next.tracker.read(tree.repository, tree.path)?.number).toBe(337);
  next.tracker.track(tree, 338);
  await next.tracker.poll();
  expect(next.lookup).toHaveBeenLastCalledWith("child-one", 338);
  next.advance(30000);
  next.inspect.mockResolvedValueOnce("https://github.com/other/repo");
  await next.tracker.poll();
  expect(next.lookup).toHaveBeenLastCalledWith("child-one", undefined);
});
it("refuses invalid adoption numbers in memory and persisted tracking", async () => {
  const h = harness();
  for (const number of [0, -1, 1.5, NaN]) h.tracker.track(tree, number);
  await h.tracker.poll();
  expect(h.lookup).not.toHaveBeenCalled();
  for (const number of [0, -1, 1.5, "337"]) {
    await atomicPrivate(directory, "forge.json", [{ ...tree, number }]);
    await h.tracker.load();
    await h.tracker.poll();
  }
  expect(h.lookup).not.toHaveBeenCalled();
});

function batched(minimumIntervalMs = 0, batchSize?: (matches: readonly ForgeMatch[]) => number) {
  let now = 100;
  const observation = {
    ...pending,
    board: {
      number: 340,
      title: "PR",
      url: "https://github.com/o/r/pull/340",
      state: "OPEN" as const,
      checks: { passed: 0, failed: 0, pending: 1 },
    },
  };
  let result: ReadonlyMap<string, typeof observation> | undefined = new Map([
    [tree.branch, observation],
  ]);
  const batch = vi.fn(() => Promise.resolve(result));
  const inspect = vi.fn(() => Promise.resolve("https://github.com/o/r"));
  const changed = vi.fn();
  const tracker = new ForgeTracking(
    directory,
    inspect,
    changed,
    () => ({ batch, lookup: vi.fn(), minimumIntervalMs, ...(batchSize ? { batchSize } : {}) }),
    () => now,
  );
  trackers.push(tracker);
  return {
    tracker,
    observation,
    batch,
    inspect,
    changed,
    result: (next: typeof result) => {
      result = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("batches every checkout in a repository, discovers required checks, and changes cadence", async () => {
  const h = batched();
  h.tracker.setEnabled(true);
  h.tracker.sync(tree.repository, [tree, { ...tree, path: join(root, "second"), branch: "other" }]);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(1);
  expect(h.tracker.readBoard(tree.repository, tree.path)).toEqual(h.observation.board);
  h.advance(1000);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(2);
  h.advance(19999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(2);
  h.advance(1);
  h.result(
    new Map([
      [
        tree.branch,
        {
          ...h.observation,
          requiredChecks: "success",
          board: { ...h.observation.board, checks: { passed: 1, failed: 0, pending: 0 } },
        },
      ],
    ]),
  );
  const complete = vi.fn();
  h.tracker.onCompleted = complete;
  await h.tracker.poll();
  expect(complete).toHaveBeenCalledTimes(1);
  h.advance(119999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(3);
  h.advance(1);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(4);
  expect(complete).toHaveBeenCalledTimes(1);
  h.result(new Map());
  h.advance(120000);
  await h.tracker.poll();
  expect(h.tracker.readBoard(tree.repository, tree.path)).toBeUndefined();
  h.advance(599999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(5);
  h.advance(1);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(6);
});
it("pauses on sleep and lock, rechecks on idle, and disables only board polling", async () => {
  const h = batched();
  h.tracker.sync(tree.repository, [tree]);
  await h.tracker.poll();
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(h.batch).not.toHaveBeenCalled();
  h.tracker.setEnabled(true);
  h.tracker.pause("sleep", true);
  h.tracker.pause("lock", true);
  await h.tracker.poll();
  h.tracker.pause("sleep", false);
  await h.tracker.poll();
  expect(h.batch).not.toHaveBeenCalled();
  h.tracker.pause("lock", false);
  await h.tracker.poll();
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(2);
  h.tracker.setEnabled(false);
  expect(h.tracker.readBoard(tree.repository, tree.path)).toBeUndefined();
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(2);
  h.tracker.track(tree);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(3);
  expect(h.tracker.read(tree.repository, tree.path)).toEqual(pending);
  h.tracker.sync(tree.repository, []);
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(4);
});
it("backs off failed repository reads, retires removed identities, and resumes on setting enable", async () => {
  const h = batched();
  h.tracker.setEnabled(true);
  h.tracker.sync(tree.repository, [tree]);
  h.result(undefined);
  await h.tracker.poll();
  h.advance(59999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(1);
  h.advance(1);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(2);
  h.tracker.setEnabled(false);
  h.tracker.setEnabled(true);
  h.result(new Map([[tree.branch, h.observation]]));
  await h.tracker.poll();
  expect(h.tracker.readBoard(tree.repository, tree.path)).toBeDefined();
  h.tracker.sync(tree.repository, []);
  expect(h.tracker.readBoard(tree.repository, tree.path)).toBeUndefined();
  h.tracker.recheck("missing");
  h.tracker.sync(tree.repository, [tree]);
  h.inspect.mockResolvedValueOnce("https://github.com/o/r").mockResolvedValueOnce("changed");
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)).toBeUndefined();
});

it("handles rejected batch reads and revalidation failures without leaking observations", async () => {
  const h = batched();
  h.tracker.setEnabled(true);
  h.tracker.sync(tree.repository, [tree]);
  await h.tracker.poll();
  h.batch.mockRejectedValueOnce(new Error("offline"));
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(h.tracker.readBoard(tree.repository, tree.path)).toBeUndefined();
  h.inspect
    .mockResolvedValueOnce("https://github.com/o/r")
    .mockRejectedValueOnce(new Error("removed"));
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)).toBeUndefined();
});
it("discards in-flight batch replies on pause, disable and checkout replacement", async () => {
  for (const action of ["pause", "disable", "replace"] as const) {
    const h = batched();
    h.tracker.setEnabled(true);
    h.tracker.sync(tree.repository, [tree]);
    let finish: (value: ReadonlyMap<string, typeof h.observation>) => void = () => {};
    let announce = () => {};
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    h.batch.mockImplementationOnce(() => {
      announce();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const poll = h.tracker.poll();
    await started;
    expect(h.batch).toHaveBeenCalledTimes(1);
    if (action === "pause") h.tracker.pause("sleep", true);
    else if (action === "disable") h.tracker.setEnabled(false);
    else h.tracker.sync(tree.repository, [{ ...tree, identity: "replacement" }]);
    finish(new Map([[tree.branch, h.observation]]));
    await poll;
    expect(h.tracker.readBoard(tree.repository, tree.path)).toBeUndefined();
  }
});

it.each(["single", "batch"] as const)(
  "does not let an in-flight %s read postpone a newer board-setting refresh",
  async (mode) => {
    const open = { ...pending, requiredChecks: "success" as const };
    const merged = { ...open, state: "MERGED" as const };
    let result: PullRequest = open;
    const lookup = vi.fn((): Promise<PullRequest> => Promise.resolve(result));
    const batch = async () => {
      const pr = await lookup();
      return new Map([
        [
          tree.branch,
          {
            ...pr,
            board: {
              number: pr.number,
              title: "PR",
              url: "https://github.com/o/r/pull/340",
              state: pr.state,
              checks: { passed: 1, failed: 0, pending: 0 },
            },
          },
        ],
      ]);
    };
    const tracker = new ForgeTracking(
      directory,
      () => Promise.resolve("https://github.com/o/r"),
      vi.fn(),
      () => (mode === "batch" ? { lookup, batch } : { lookup }),
      () => 100,
    );
    trackers.push(tracker);
    tracker.setEnabled(true);
    tracker.track(tree, 340);
    await tracker.poll();
    let announce = () => {};
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let finish: (pr: PullRequest) => void = () => {};
    lookup.mockImplementationOnce(() => {
      announce();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    tracker.recheck(tree.path);
    await started;
    tracker.setEnabled(false);
    result = merged;
    tracker.setEnabled(true);
    finish(open);
    // No clock advance: the newer request must survive the stale completion,
    // rather than waiting for the regular poll cadence.
    await tracker.poll();
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(tracker.read(tree.repository, tree.path)).toEqual(merged);
    expect(tracker.readSettled(tree.repository, tree.path)).toEqual(merged);
  },
);

it("does not lose an idle refresh that arrives during an in-flight repository read", async () => {
  const h = batched();
  h.tracker.setEnabled(true);
  h.tracker.sync(tree.repository, [tree]);
  let announce = () => {};
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let finish: (value: ReadonlyMap<string, typeof h.observation>) => void = () => {};
  h.batch.mockImplementationOnce(() => {
    announce();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = h.tracker.poll();
  await started;
  h.tracker.recheck(tree.path);
  finish(new Map([[tree.branch, h.observation]]));
  await first;
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(2);
});

it("notifies for a new failed head even when checks finish between polls", async () => {
  const h = batched();
  const completed = vi.fn();
  h.tracker.onCompleted = completed;
  h.tracker.setEnabled(true);
  h.tracker.sync(tree.repository, [tree]);
  const failed = {
    ...h.observation,
    requiredChecks: "failure" as const,
    board: { ...h.observation.board, checks: { passed: 0, failed: 1, pending: 0 } },
  };
  h.result(new Map([[tree.branch, failed]]));
  await h.tracker.poll();
  expect(completed).not.toHaveBeenCalled();
  h.result(new Map([[tree.branch, { ...failed, headSha: "b".repeat(40) }]]));
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(completed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ path: tree.path }),
    failed.board,
  );
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(completed).toHaveBeenCalledTimes(1);
});

it.each([20000, 30000, 180000, 86400000])(
  "manifest minima only slow regular cadence (%s)",
  async (minimum) => {
    const h = batched(minimum);
    h.tracker.track(tree);
    await h.tracker.poll();
    h.advance(1000);
    await h.tracker.poll(); // Discovery always binds on the next tick.
    expect(h.batch).toHaveBeenCalledTimes(2);
    h.advance(Math.max(20000, minimum) - 1);
    await h.tracker.poll();
    expect(h.batch).toHaveBeenCalledTimes(2);
    h.advance(1);
    const settled = {
      ...h.observation,
      requiredChecks: "success" as const,
      board: { ...h.observation.board, checks: { passed: 1, failed: 0, pending: 0 } },
    };
    h.result(new Map([[tree.branch, settled]]));
    await h.tracker.poll();
    h.advance(Math.max(120000, minimum) - 1);
    await h.tracker.poll();
    expect(h.batch).toHaveBeenCalledTimes(3);
    h.advance(1);
    h.result(undefined);
    await h.tracker.poll();
    h.advance(Math.max(60000, minimum) - 1);
    await h.tracker.poll();
    expect(h.batch).toHaveBeenCalledTimes(4);
    h.advance(1);
    await h.tracker.poll();
    expect(h.batch).toHaveBeenCalledTimes(5);
  },
);
it("samples one bounded prefix per tick and leaves the suffix due", async () => {
  const h = batched(20000, () => 1);
  const second = { ...tree, path: join(root, "second"), branch: "second" };
  h.tracker.sync(tree.repository, [tree, second]);
  h.tracker.setEnabled(true);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenLastCalledWith([{ branch: tree.branch }]);
  h.advance(1000);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenLastCalledWith([{ branch: tree.branch, number: 340 }]);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenLastCalledWith([{ branch: second.branch }]);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(3);
});

it.each([true, false])(
  "migrates legacy bindings only for the approved bundled GitHub route (%s)",
  async (acceptLegacyBinding) => {
    await atomicPrivate(directory, "forge.json", [
      { ...tree, remote: "https://github.com/o/r", pr: pending },
    ]);
    const lookup = vi.fn(() => Promise.resolve(pending));
    const tracker = new ForgeTracking(
      directory,
      () => Promise.resolve("https://github.com/o/r"),
      vi.fn(),
      () => ({ lookup, binding: "selected-manifest", acceptLegacyBinding }),
    );
    trackers.push(tracker);
    await tracker.load();
    expect(tracker.read(tree.repository, tree.path)).toBeUndefined();
    await tracker.poll();
    expect(lookup).toHaveBeenCalledWith(
      tree.branch,
      acceptLegacyBinding ? pending.number : undefined,
    );
    await tracker.close();
    expect(JSON.parse(await readFile(join(directory, "forge.json"), "utf8"))).toMatchObject({
      version: 1,
      entries: [{ binding: "selected-manifest", pr: pending }],
    });
  },
);
it("invalidates persisted provider bindings before lookup and rejects unknown persistence versions", async () => {
  for (const version of [2, null]) {
    await atomicPrivate(directory, "forge.json", { version, entries: [{ ...tree, pr: pending }] });
    const h = harness();
    await h.tracker.load();
    await h.tracker.poll();
    expect(h.lookup).not.toHaveBeenCalled();
  }
  for (const binding of [null, 1, "x".repeat(8193)]) {
    await atomicPrivate(directory, "forge.json", {
      version: 1,
      entries: [{ ...tree, binding, pr: pending }],
    });
    const h = harness();
    await h.tracker.load();
    await h.tracker.poll();
    expect(h.lookup).not.toHaveBeenCalled();
  }
  await atomicPrivate(directory, "forge.json", {
    version: 1,
    entries: [{ ...tree, remote: "https://github.com/o/r", binding: "old", pr: pending }],
  });
  let binding = "old";
  const lookup = vi.fn(() => Promise.resolve(pending));
  const tracker = new ForgeTracking(
    directory,
    () => Promise.resolve("https://github.com/o/r"),
    vi.fn(),
    () => ({ lookup, binding }),
  );
  trackers.push(tracker);
  await tracker.load();
  await tracker.poll();
  expect(lookup).toHaveBeenLastCalledWith(tree.branch, pending.number);
  binding = "new";
  tracker.recheck(tree.path);
  await tracker.poll();
  expect(lookup).toHaveBeenLastCalledWith(tree.branch, undefined);
  tracker.invalidate();
  tracker.recheck(tree.path);
  await tracker.poll();
  expect(lookup).toHaveBeenLastCalledWith(tree.branch, undefined);
});

it("deduplicates matching branches before request sizing and publishes to every checkout", async () => {
  const size = vi.fn(() => 1);
  const h = batched(20000, size);
  const second = { ...tree, path: join(root, "same-branch") };
  h.tracker.setEnabled(true);
  h.tracker.sync(tree.repository, [tree, second]);
  await h.tracker.poll();
  expect(size).toHaveBeenCalledWith([{ branch: tree.branch }]);
  expect(h.batch).toHaveBeenCalledWith([{ branch: tree.branch }]);
  expect(h.tracker.readBoard(tree.repository, tree.path)).toEqual(h.observation.board);
  expect(h.tracker.readBoard(tree.repository, second.path)).toEqual(h.observation.board);
});

it("resolves a branch once when a newly added review has a different cached PR hint", async () => {
  const h = batched();
  h.tracker.setEnabled(true);
  h.tracker.track(tree);
  await h.tracker.poll();
  h.tracker.track({ ...tree, path: join(root, "review") });
  h.tracker.recheck(tree.path);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenLastCalledWith([{ branch: tree.branch }]);
  expect(h.tracker.readBoard(tree.repository, tree.path)).toEqual(h.observation.board);
  expect(h.tracker.readBoard(tree.repository, join(root, "review"))).toEqual(h.observation.board);
});

it("retires removed review checkouts from the provider context before sampling", async () => {
  const review = { ...tree, path: join(root, "removed-review") };
  let removed = false;
  const h = batched();
  const tracker = new ForgeTracking(
    directory,
    (row) =>
      Promise.resolve(removed && row.path === review.path ? undefined : "https://github.com/o/r"),
    vi.fn(),
    async (_remote, getContext) => {
      const context = await getContext?.();
      return {
        lookup: () => Promise.resolve(undefined),
        batch: async (matches) => {
          await context?.validate(matches.map((match) => match.branch));
          return new Map([[tree.branch, h.observation]]);
        },
      };
    },
  );
  trackers.push(tracker);
  tracker.track(tree, pending.number);
  tracker.track(review, pending.number);
  await tracker.poll();
  expect(tracker.read(tree.repository, review.path)).toEqual(pending);
  removed = true;
  tracker.recheck(tree.path);
  await tracker.poll();
  expect(tracker.read(tree.repository, review.path)).toBeUndefined();
  expect(tracker.read(tree.repository, tree.path)).toEqual(pending);
  expect(tracker.readSettled(tree.repository, tree.path)).toEqual(pending);
});

it("revalidates the sampled chunk without publishing observations for unselected checkouts", async () => {
  let sampling = false;
  const second = { ...tree, path: join(root, "unselected"), branch: "other" };
  const tracker = new ForgeTracking(
    directory,
    (row) =>
      Promise.resolve(
        sampling && row.branch === second.branch ? undefined : "https://github.com/o/r",
      ),
    vi.fn(),
    async (_remote, getContext) => {
      const context = await getContext?.();
      return {
        lookup: () => Promise.resolve(undefined),
        batchSize: () => 1,
        batch: async (matches) => {
          sampling = true;
          await context?.validate(matches.map((match) => match.branch));
          return new Map([
            [
              tree.branch,
              {
                ...pending,
                board: {
                  number: pending.number,
                  title: "PR",
                  url: "https://github.com/o/r/pull/340",
                  state: "OPEN" as const,
                  checks: { passed: 0, failed: 0, pending: 1 },
                },
              },
            ],
          ]);
        },
      };
    },
  );
  trackers.push(tracker);
  tracker.setEnabled(true);
  tracker.sync(tree.repository, [tree, second]);
  await tracker.poll();
  expect(tracker.read(tree.repository, tree.path)).toEqual(pending);
  expect(tracker.read(tree.repository, second.path)).toBeUndefined();
});

it("keeps repository cadence across chunks with active, settled and absent PRs", async () => {
  let capacity = 2;
  const h = batched(20000, () => capacity);
  const second = { ...tree, path: join(root, "second"), branch: "other" };
  h.tracker.sync(tree.repository, [tree, second]);
  h.tracker.setEnabled(true);
  h.result(
    new Map([
      [tree.branch, h.observation],
      [second.branch, h.observation],
    ]),
  );
  await h.tracker.poll();
  h.advance(1000);
  await h.tracker.poll();
  capacity = 1;
  h.result(
    new Map([
      [
        tree.branch,
        {
          ...h.observation,
          requiredChecks: "success",
          board: { ...h.observation.board, checks: { passed: 1, failed: 0, pending: 0 } },
        },
      ],
    ]),
  );
  h.advance(20000);
  await h.tracker.poll();
  h.result(new Map());
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(4);
  h.advance(19999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(4);
  h.advance(1);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenLastCalledWith([{ branch: tree.branch, number: 340 }]);
  h.advance(99999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(5);
  h.advance(1);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenLastCalledWith([{ branch: second.branch, number: 340 }]);
});

it("backs off the entire repository after a failed chunk and hides unsampled stale observations", async () => {
  let capacity = 2;
  const h = batched(20000, () => capacity);
  const second = { ...tree, path: join(root, "second"), branch: "other" };
  h.tracker.sync(tree.repository, [tree, second]);
  h.tracker.setEnabled(true);
  h.result(
    new Map([
      [tree.branch, h.observation],
      [second.branch, h.observation],
    ]),
  );
  await h.tracker.poll();
  h.advance(1000);
  await h.tracker.poll();
  capacity = 1;
  h.result(undefined);
  h.advance(20000);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(3);
  expect(h.tracker.read(tree.repository, tree.path)).toBeUndefined();
  expect(h.tracker.read(tree.repository, second.path)).toBeUndefined();
  h.advance(59999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(3);
  h.advance(1);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(4);
  h.advance(119999);
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(4);
  h.advance(1);
  h.result(new Map());
  await h.tracker.poll();
  expect(h.batch).toHaveBeenCalledTimes(5);
});

it("persists checks meaning and hides restored data until fresh validation", async () => {
  const h = harness();
  h.result({ ...pending, checksMeaning: "head-pipeline" });
  h.tracker.track(tree);
  await h.tracker.poll();
  expect(h.tracker.read(tree.repository, tree.path)?.checksMeaning).toBe("head-pipeline");
  await h.tracker.close();
  const saved: unknown = JSON.parse(await readFile(join(directory, "forge.json"), "utf8"));
  expect(saved).toMatchObject({
    version: 1,
    entries: [{ pr: { checksMeaning: "head-pipeline" } }],
  });
  const restored = new ForgeTracking(directory, h.inspect, h.changed, h.provider);
  trackers.push(restored);
  await restored.load();
  expect(restored.read(tree.repository, tree.path)).toBeUndefined();
  await restored.poll();
  expect(restored.read(tree.repository, tree.path)?.checksMeaning).toBe("head-pipeline");
});

it("revalidates stored display URLs against the routed host on open", async () => {
  let routedHost: string | undefined = "github.com";
  let url: string | undefined = "https://github.com/o/r/pull/340";
  const tracker = new ForgeTracking(
    directory,
    () => Promise.resolve("git@github.com:o/r.git"),
    () => {},
    () => ({
      ...(routedHost === undefined ? {} : { routedHost }),
      lookup: () => Promise.resolve(undefined),
      batch: () =>
        Promise.resolve(
          new Map([
            [
              tree.branch,
              {
                ...pending,
                board: {
                  number: 340,
                  state: "OPEN",
                  checks: null,
                  ...(url === undefined ? {} : { url }),
                },
              },
            ],
          ]),
        ),
    }),
  );
  trackers.push(tracker);
  tracker.setEnabled(true);
  tracker.track(tree);
  await tracker.poll();
  expect(tracker.readUrl(tree.repository, tree.path)).toBe(url);
  expect(tracker.readUrl("other", tree.path)).toBeUndefined();
  for (const value of ["https://other.org/pr/1", "javascript:alert(1)", undefined]) {
    url = value;
    tracker.recheck(tree.path);
    await tracker.poll();
    expect(tracker.readUrl(tree.repository, tree.path)).toBeUndefined();
  }
  routedHost = undefined;
  url = "https://github.com/o/r/pull/340";
  tracker.recheck(tree.path);
  await tracker.poll();
  expect(tracker.readUrl(tree.repository, tree.path)).toBeUndefined();
});

it.each(["single", "batch"])(
  "close evidence waits for the newest %s recheck and notifies even when metadata is unchanged",
  async (mode) => {
    const closed = { ...pending, state: "CLOSED" as const };
    const lookup = vi.fn((): Promise<PullRequest | undefined> => Promise.resolve(closed));
    const batch = async () => {
      const pr = await lookup();
      return pr
        ? new Map([
            [
              tree.branch,
              {
                ...pr,
                board: {
                  number: pr.number,
                  title: "PR",
                  url: "https://github.com/o/r/pull/340",
                  state: pr.state,
                  checks: null,
                },
              },
            ],
          ])
        : undefined;
    };
    const changed = vi.fn();
    const tracker = new ForgeTracking(
      directory,
      () => Promise.resolve("https://github.com/o/r"),
      changed,
      () => (mode === "batch" ? { lookup, batch } : { lookup }),
    );
    trackers.push(tracker);
    tracker.track(tree, 340);
    expect(tracker.readSettled(tree.repository, tree.path)).toBeUndefined();
    await tracker.poll();
    expect(tracker.readSettled(tree.repository, tree.path)).toMatchObject(closed);
    expect(tracker.readSettled("foreign", tree.path)).toBeUndefined();
    expect(tracker.readSettled(tree.repository, "missing")).toBeUndefined();
    const beforeExit = tracker.revision();
    expect(tracker.readSettled(tree.repository, tree.path, beforeExit)).toBeUndefined();
    const notifications = changed.mock.calls.length;
    let firstStarted = () => {};
    const first = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted = () => {};
    const second = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let finishFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let finishSecond = () => {};
    const secondGate = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    lookup.mockImplementationOnce(async () => {
      firstStarted();
      await firstGate;
      return closed;
    });
    lookup.mockImplementationOnce(async () => {
      secondStarted();
      await secondGate;
      return closed;
    });
    tracker.recheck(tree.path);
    await first;
    tracker.recheck(tree.path);
    expect(tracker.read(tree.repository, tree.path)).toMatchObject(closed);
    expect(tracker.readSettled(tree.repository, tree.path)).toBeUndefined();
    finishFirst();
    await second;
    // The first response predates the exit's newer recheck request.
    expect(tracker.readSettled(tree.repository, tree.path)).toBeUndefined();
    finishSecond();
    await tracker.poll();
    expect(tracker.readSettled(tree.repository, tree.path)).toMatchObject(closed);
    expect(tracker.readSettled(tree.repository, tree.path, beforeExit)).toMatchObject(closed);
    expect(tracker.readSettled(tree.repository, tree.path, tracker.revision())).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(notifications + 1);
    for (let index = 0; index < 10; index++) await tracker.poll();
    expect(lookup).toHaveBeenCalledTimes(3);
    lookup.mockRejectedValueOnce(Error("offline"));
    tracker.recheck(tree.path);
    await tracker.poll();
    expect(tracker.readSettled(tree.repository, tree.path)).toBeUndefined();
  },
);

it.each(["single", "batch"] as const)(
  "unchanged periodic %s reads without a waiting child publish nothing",
  async (mode) => {
    const h = mode === "batch" ? batched() : harness();
    h.tracker.track(tree);
    await h.tracker.poll();
    // Settle discovery's existing follow-up, then count only regular reads.
    h.advance(600000);
    await h.tracker.poll();
    h.changed.mockClear();
    for (let index = 0; index < 3; index++) {
      h.advance(600000);
      await h.tracker.poll();
    }
    expect(h.changed).not.toHaveBeenCalled();
  },
);

it.each(["single", "batch"] as const)(
  "settles %s observation waiters once, respecting cancellation and fresh evidence",
  async (mode) => {
    const h = mode === "batch" ? batched() : harness();
    h.tracker.track(tree);
    await h.tracker.poll();
    h.advance(600000);
    await h.tracker.poll();
    const marker = h.tracker.revision();
    // Wrong checkout and already-settled observations cannot create interest.
    h.tracker.waitForRead("foreign", tree.path, marker)();
    h.tracker.waitForRead(tree.repository, "missing", marker)();
    h.tracker.waitForRead(tree.repository, tree.path, marker - 1)();
    const cancel = h.tracker.waitForRead(tree.repository, tree.path, marker);
    cancel();
    cancel();
    h.changed.mockClear();
    h.advance(600000);
    await h.tracker.poll();
    expect(h.changed).not.toHaveBeenCalled();

    const after = h.tracker.revision();
    const first = h.tracker.waitForRead(tree.repository, tree.path, after);
    const second = h.tracker.waitForRead(tree.repository, tree.path, after);
    const future = h.tracker.waitForRead(tree.repository, tree.path, after + 1);
    h.advance(600000);
    await h.tracker.poll();
    expect(h.changed).toHaveBeenCalledTimes(1);
    first();
    second();
    h.advance(600000);
    await h.tracker.poll();
    expect(h.changed).toHaveBeenCalledTimes(2);
    future();
    h.advance(600000);
    await h.tracker.poll();
    expect(h.changed).toHaveBeenCalledTimes(2);
  },
);

it("honors unavailable remote backoff while a local checkout keeps polling the shared repository", async () => {
  const { locationId } = await import("../../../../src/main/control/metadata");
  const binding = {
    host: "alpha",
    codeFolder: "/code",
    repository: "/code/repository-fixture",
    path: "/code/.foom-worktree-fixture",
    origin: "https://github.com/o/r",
  };
  const remote = {
    ...tree,
    path: `/foom-remote/${locationId(JSON.stringify([binding.host, binding.path]))}`,
    remoteCheckout: binding,
  };
  let now = 0;
  let disconnected = false;
  const remoteInspect = vi.fn(() => {
    if (disconnected) return Promise.reject(new Error("SSH disconnected"));
    return Promise.resolve({ remote: binding.origin, head: pending.headSha });
  });
  const batches = vi.fn();
  const tracker = new ForgeTracking(
    directory,
    (row) => (row.remoteCheckout ? remoteInspect() : Promise.resolve(binding.origin)),
    vi.fn(),
    async (_origin, getContext) => {
      const context = await getContext?.();
      return {
        lookup: () => Promise.resolve(pending),
        batch: async (matches) => {
          await context?.validate(matches.map((match) => match.branch));
          batches();
          await context?.validate(matches.map((match) => match.branch));
          return new Map(
            matches.map(({ branch }) => [
              branch,
              {
                ...pending,
                board: {
                  number: pending.number,
                  state: pending.state,
                  checks: { pending: 1, passed: 0, failed: 0 },
                },
              },
            ]),
          );
        },
      };
    },
    () => now,
  );
  trackers.push(tracker);
  tracker.track(remote, pending.number);
  tracker.track(tree, pending.number);
  await tracker.poll();
  expect(tracker.read(tree.repository, remote.path)).toBeDefined();
  disconnected = true;
  now = 20000;
  await tracker.poll();
  expect(tracker.read(tree.repository, remote.path)).toBeUndefined();
  const failedCalls = remoteInspect.mock.calls.length;
  for (now of [40000, 60000]) {
    await tracker.poll();
    expect(tracker.read(tree.repository, tree.path)?.requiredChecks).toBe("pending");
    expect(remoteInspect).toHaveBeenCalledTimes(failedCalls);
  }
  expect(batches).toHaveBeenCalledTimes(3);
  now = 80000;
  await tracker.poll();
  expect(remoteInspect).toHaveBeenCalledTimes(failedCalls + 1);
  // The second failure backs off to 200000, even as local polling continues.
  now = 100000;
  await tracker.poll();
  expect(remoteInspect).toHaveBeenCalledTimes(failedCalls + 1);
  disconnected = false;
  now = 200000;
  await tracker.poll();
  expect(tracker.read(tree.repository, remote.path)?.requiredChecks).toBe("pending");
});

it("tracks two host-bound checkouts on the same branch, adoption, pushes and CI; disconnect hides only that host and restart revalidates", async () => {
  const { locationId } = await import("../../../../src/main/control/metadata");
  const remoteTree = (host: string) => {
    const binding = {
      host,
      codeFolder: "/code",
      repository: "/code/repository-fixture",
      path: "/code/.foom-worktree-fixture",
      origin: "https://github.com/o/r",
    };
    return {
      ...tree,
      path: `/foom-remote/${locationId(JSON.stringify([host, binding.path]))}`,
      remoteCheckout: binding,
    };
  };
  const a = remoteTree("alpha");
  const b = remoteTree("beta");
  let disconnected = false;
  let betaDisconnected = false;
  let head = "a".repeat(40);
  let conclusion: PullRequest["requiredChecks"] = "pending";
  const inspect = vi.fn((row: ForgeWorktree) =>
    Promise.resolve(
      (disconnected && row.remoteCheckout?.host === "alpha") ||
        (betaDisconnected && row.remoteCheckout?.host === "beta")
        ? undefined
        : { remote: row.remoteCheckout?.origin ?? "", head },
    ),
  );
  const batch = vi.fn(() =>
    Promise.resolve(
      new Map([
        [
          tree.branch,
          {
            ...pending,
            headSha: head,
            requiredChecks: conclusion,
            board: {
              number: 340,
              state: "OPEN" as const,
              checks: {
                pending: conclusion === "pending" ? 1 : 0,
                passed: conclusion === "success" ? 1 : 0,
                failed: 0,
              },
            },
          },
        ],
      ]),
    ),
  );
  const changed = vi.fn();
  let now = 0;
  const tracker = new ForgeTracking(
    directory,
    inspect,
    changed,
    async (_remote, getContext) => {
      const context = await getContext?.();
      return {
        lookup: () => Promise.resolve(pending),
        batch: async (matches) => {
          await context?.validate(matches.map((match) => match.branch));
          const result = await batch();
          await context?.validate(matches.map((match) => match.branch));
          return result;
        },
      };
    },
    () => now,
  );
  trackers.push(tracker);
  tracker.setEnabled(true);
  tracker.track(a, 340);
  tracker.track(b);
  await tracker.poll();
  expect(tracker.read(a.repository, a.path)?.requiredChecks).toBe("pending");
  expect(tracker.read(b.repository, b.path)?.headSha).toBe(head);
  expect(batch).toHaveBeenCalledOnce();
  conclusion = "success";
  head = "b".repeat(40);
  now += 30000;
  await tracker.poll();
  expect(tracker.read(a.repository, a.path)).toMatchObject({
    headSha: head,
    requiredChecks: "success",
  });
  expect(tracker.readBoard(a.repository, a.path)?.checks?.passed).toBe(1);
  disconnected = true;
  now += 120000;
  await tracker.poll();
  expect(tracker.read(a.repository, a.path)).toBeUndefined();
  await tracker.poll();
  expect(tracker.read(b.repository, b.path)).toBeDefined();
  disconnected = false;
  now += 120000;
  await tracker.poll();
  expect(tracker.read(a.repository, a.path)).toBeDefined();
  betaDisconnected = true;
  tracker.recheck(a.path);
  await tracker.poll();
  expect(tracker.read(a.repository, a.path)).toBeDefined();
  expect(tracker.read(b.repository, b.path)).toBeUndefined();
  tracker.sync(tree.repository, []);
  await tracker.close();
  const saved: unknown = JSON.parse(await readFile(join(directory, "forge.json"), "utf8"));
  expect(saved).toMatchObject({
    entries: [{ remoteCheckout: a.remoteCheckout }, { remoteCheckout: b.remoteCheckout }],
  });
  const restored = new ForgeTracking(
    directory,
    inspect,
    changed,
    () => ({ lookup: () => Promise.resolve(pending), batch }),
    () => now,
  );
  trackers.push(restored);
  await restored.load();
  expect(restored.read(a.repository, a.path)).toBeUndefined();
  await restored.poll();
  expect(restored.read(a.repository, a.path)).toBeDefined();
});

it("refuses stale remote HEAD and revoked bindings after a query, retaining retry and never accepting unbound synthetic paths", async () => {
  const { locationId } = await import("../../../../src/main/control/metadata");
  const binding = {
    host: "alpha",
    codeFolder: "/code",
    repository: "/code/repository-fixture",
    path: "/code/.foom-worktree-fixture",
    origin: "https://github.com/o/r",
  };
  const remoteTree = {
    ...tree,
    path: `/foom-remote/${locationId(JSON.stringify([binding.host, binding.path]))}`,
    remoteCheckout: binding,
  };
  let head = "a".repeat(40);
  let valid = true;
  const inspect = vi.fn(() =>
    Promise.resolve(valid ? { remote: binding.origin, head } : undefined),
  );
  const lookup = vi.fn(() => {
    head = "b".repeat(40);
    return Promise.resolve(pending);
  });
  const tracker = new ForgeTracking(directory, inspect, vi.fn(), () => ({ lookup }));
  trackers.push(tracker);
  tracker.track({ ...tree, path: remoteTree.path });
  await tracker.poll();
  expect(inspect).not.toHaveBeenCalled();
  tracker.track(remoteTree, 340);
  await tracker.poll();
  expect(tracker.read(tree.repository, remoteTree.path)).toBeUndefined();
  lookup.mockImplementation(() => Promise.resolve(pending));
  tracker.recheck(remoteTree.path);
  await tracker.poll();
  expect(tracker.read(tree.repository, remoteTree.path)).toBeDefined();
  lookup.mockImplementation(() => {
    valid = false;
    return Promise.resolve(pending);
  });
  tracker.recheck(remoteTree.path);
  await tracker.poll();
  expect(tracker.read(tree.repository, remoteTree.path)).toBeUndefined();
});

it.each([false, true])(
  "remote publication refuses invalidation during the final inspection (batch=%s)",
  async (batched) => {
    const { locationId } = await import("../../../../src/main/control/metadata");
    const binding = {
      host: "alpha",
      codeFolder: "/code",
      repository: "/code/repository-fixture",
      path: "/code/.foom-worktree-fixture",
      origin: "https://github.com/o/r",
    };
    const remote = {
      ...tree,
      path: `/foom-remote/${locationId(JSON.stringify([binding.host, binding.path]))}`,
      remoteCheckout: binding,
    };
    let sampled = false;
    const inspect = vi.fn(() => {
      if (sampled) {
        tracker.invalidate();
        return Promise.reject(new Error("Registration revoked during revalidation"));
      }
      return Promise.resolve({ remote: binding.origin, head: "a".repeat(40) });
    });
    const lookup = vi.fn(() => {
      sampled = true;
      return Promise.resolve(pending);
    });
    const batch = vi.fn(() => {
      sampled = true;
      return Promise.resolve(
        new Map([
          [
            tree.branch,
            { ...pending, board: { number: pending.number, state: pending.state, checks: null } },
          ],
        ]),
      );
    });
    const tracker = new ForgeTracking(directory, inspect, vi.fn(), () => ({
      lookup,
      ...(batched ? { batch } : {}),
    }));
    trackers.push(tracker);
    tracker.track(remote, pending.number);
    await tracker.poll();
    expect(sampled).toBe(true);
    expect(tracker.read(tree.repository, remote.path)).toBeUndefined();
    expect(tracker.readSettled(tree.repository, remote.path)).toBeUndefined();
  },
);
