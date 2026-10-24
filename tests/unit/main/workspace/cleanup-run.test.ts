import { expect, test, vi } from "vitest";
import { CleanupRun, KeptWorktree } from "../../../../src/main/workspace/cleanup-run";
import type { CleanupCandidate } from "../../../../src/main/workspace/cleanup-run";
const candidates = (count: number): CleanupCandidate[] =>
  Array.from({ length: count }, (_, index) => ({
    tree: {
      path: `/private/${String(index)}`,
      branch: `branch-${String(index)}`,
      head: "a".repeat(40),
      bare: false,
      locked: false,
      prunable: false,
      managed: false,
    },
    reason: undefined,
    identity: "original",
  }));
function setup() {
  const deps = {
    checkingCount: 8,
    fetchedAt: vi.fn<() => number | undefined>(() => 1000),
    fetch: vi.fn(() => Promise.resolve("base")),
    remove: vi.fn((_candidate: CleanupCandidate, _base: string) => Promise.resolve()),
    branches: vi.fn(
      (_removed: readonly CleanupCandidate[]): Promise<readonly string[]> => Promise.resolve([]),
    ),
    changed: vi.fn(),
  };
  return { deps, run: new CleanupRun(deps) };
}
test("checking cannot approve, snapshots omit paths, and hiding only unsubscribes", async () => {
  const { deps, run } = setup();
  expect(run.current()).toMatchObject({ checkingCount: 8, fetchedAt: 1000 });
  deps.fetchedAt.mockReturnValueOnce(undefined);
  expect(run.current()).not.toHaveProperty("fetchedAt");
  run.act();
  await run.settled();
  expect(deps.fetch).not.toHaveBeenCalled();
  const render = vi.fn();
  const hide = run.subscribe(render);
  run.ready(candidates(8));
  expect(run.current().stage).toBe("ready");
  expect(JSON.stringify(run.current())).not.toContain("/private/");
  run.act();
  hide();
  const calls = render.mock.calls.length;
  await run.settled();
  expect(render).toHaveBeenCalledTimes(calls);
  expect(deps.remove).toHaveBeenCalledTimes(8);
  expect(run.progress).toMatchObject({ total: 8, done: 8, phase: "finished", stopped: false });
  expect(run.active).toBe(false);
  expect(run.pending).toBe(false);
  const reopened = vi.fn();
  run.subscribe(reopened);
  expect(run.current().progress.items.every((item) => item.state === "removed")).toBe(true);
  run.act();
  expect(deps.fetch).toHaveBeenCalledOnce();
});
test("four removals maximum; Stop drains in-flight work and keeps unstarted checkouts", async () => {
  const { deps, run } = setup();
  const finish: (() => void)[] = [];
  deps.remove.mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  run.ready(candidates(9));
  run.act();
  await vi.waitFor(() => {
    expect(deps.remove).toHaveBeenCalledTimes(4);
  });
  expect(run.progress.items.filter((item) => item.state === "removing")).toHaveLength(4);
  finish.shift()?.();
  await vi.waitFor(() => {
    expect(deps.remove).toHaveBeenCalledTimes(5);
  });
  run.act();
  for (const done of finish) done();
  await run.settled();
  expect(run.progress).toMatchObject({ done: 5, total: 9, stopped: true, phase: "finished" });
  expect(run.progress.items.filter((item) => item.reason === "not started")).toHaveLength(4);
});
test("fixed reasons distinguish changed candidates and removal errors; others continue", async () => {
  const { deps, run } = setup();
  deps.remove
    .mockRejectedValueOnce(new KeptWorktree("worktree changed"))
    .mockRejectedValueOnce(new Error("secret git output"));
  deps.branches.mockResolvedValue(["branch-2"]);
  const plan = candidates(4);
  const first = plan[0];
  if (!first) throw new Error("Missing fixture");
  plan.push({ tree: { ...first.tree, path: "/main", branch: null }, reason: "main checkout" });
  run.ready(plan);
  run.act();
  await run.settled();
  expect(run.progress.items.map((item) => [item.state, item.reason])).toEqual([
    ["kept", "worktree changed"],
    ["error", "removal failed"],
    ["removed", "branch kept"],
    ["removed", undefined],
    ["kept", "main checkout"],
  ]);
  expect(JSON.stringify(run.current())).not.toContain("secret");
  expect(deps.branches).toHaveBeenCalledOnce();
});
test("failed fresh fetch refuses all removals, empty plans cannot start", async () => {
  const { deps, run } = setup();
  run.ready([]);
  run.act();
  expect(deps.fetch).not.toHaveBeenCalled();
  run.ready(candidates(2));
  deps.fetch.mockRejectedValue(new Error("credentials"));
  run.act();
  await run.settled();
  expect(deps.remove).not.toHaveBeenCalled();
  expect(run.progress.items.every((item) => item.reason === "fetch failed")).toBe(true);
});
test("Stop during fetch starts nothing and branch transaction failure retains refs", async () => {
  const { deps, run } = setup();
  run.ready(candidates(2));
  run.act();
  run.act();
  await run.settled();
  expect(deps.remove).not.toHaveBeenCalled();
  const next = setup();
  next.deps.branches.mockRejectedValue(new Error("lock"));
  next.run.ready(candidates(2));
  next.run.act();
  await next.run.settled();
  expect(next.run.progress.items.every((item) => item.reason === "branch kept")).toBe(true);
});

test("bounds the combined untracked and ignored list and reports every omitted path", () => {
  const { run } = setup();
  const first = candidates(1)[0];
  if (!first) throw new Error("Missing fixture");
  const changes = Array.from(
    { length: 57 },
    (_, index) => `${index % 2 ? "!!" : "??"} ${String(index)}-${"x".repeat(600)}`,
  ).join("\0");
  run.ready([{ ...first, changes }]);
  const item = run.current().progress.items[0];
  expect(item?.omittedChanges).toBe(7);
  expect(item?.changes?.split("\0")).toHaveLength(50);
  expect(item?.changes?.split("\0").every((path) => path.length === 500)).toBe(true);
  expect(item?.changes).toContain("!! ");
});
