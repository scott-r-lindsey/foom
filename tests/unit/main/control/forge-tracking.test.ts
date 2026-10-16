import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForgeTracking, forgeDelay } from "../../../../src/main/control/forge-tracking";
import { privateDirectory, atomicPrivate } from "../../../../src/main/control/private-files";
import type { PullRequest } from "../../../../src/main/control/forge.d";
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

function batched() {
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
    () => ({ batch, lookup: vi.fn() }),
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
