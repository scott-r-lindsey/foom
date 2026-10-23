import type * as operations from "../../../../src/main/workspace/worktree-operations";
import { expect, it, vi } from "vitest";
import { fetchAdvertisedDefault } from "../../../../src/main/workspace/fetch-default";
import { WorktreeFetchState } from "../../../../src/main/workspace/worktree-fetch-state";
import { git } from "../../../../src/main/workspace/worktree-operations";
import { WorktreePanelFacts } from "../../../../src/main/workspace/worktree-panel-facts";

vi.mock("../../../../src/main/workspace/fetch-default", () => ({
  fetchAdvertisedDefault: vi.fn(),
}));
vi.mock("../../../../src/main/workspace/worktree-operations", async (original) => ({
  ...(await original<typeof operations>()),
  git: vi.fn(),
}));

it("keeps panel and fetch lifetimes separate while authorizing every panel cache hit", async () => {
  let now = 1000;
  const launchIdentity = vi.fn(() => Promise.resolve("identity"));
  const panels = new WorktreePanelFacts({
    launchIdentity,
    fetchFacts: (repository) => state.facts(repository),
    now: () => now,
  });
  const state = new WorktreeFetchState({
    repository: (path) => ({ path, name: "repo" }),
    validateBranch: () => Promise.resolve(),
    invalidatePanels: () => {
      panels.invalidate();
    },
    now: () => now,
  });
  vi.mocked(git).mockImplementation((_path, args) =>
    Promise.resolve(args[0] === "remote" && args.length === 1 ? "origin\n" : ""),
  );
  vi.mocked(fetchAdvertisedDefault).mockResolvedValue({ branch: "main", commit: "a".repeat(40) });
  const first = await panels.panelFacts("repo", "tree");
  now += 2999;
  expect(await panels.panelFacts("repo", "tree")).toBe(first);
  expect(launchIdentity).toHaveBeenCalledTimes(2);
  expect(fetchAdvertisedDefault).not.toHaveBeenCalled();
  await state.mergedDefault("repo");
  expect(state.mergedFetchTime("repo")).toBe(now);
  const fetched = await panels.panelFacts("repo", "tree");
  expect(fetched).not.toBe(first);
  expect(fetched.lastFetch).toBe(now);
  now += 3000;
  expect(await panels.panelFacts("repo", "tree")).not.toBe(fetched);
  await state.mergedDefault("repo");
  expect(fetchAdvertisedDefault).toHaveBeenCalledTimes(1);
  now += 57_000;
  await state.mergedDefault("repo");
  expect(fetchAdvertisedDefault).toHaveBeenCalledTimes(2);
});

it("queues forced refreshes through failure and invalidates panels on both outcomes", async () => {
  const invalidatePanels = vi.fn();
  const state = new WorktreeFetchState({
    repository: (path) => ({ path, name: "repo" }),
    validateBranch: () => Promise.resolve(),
    invalidatePanels,
    now: () => 1234,
  });
  vi.mocked(git).mockResolvedValue("origin\n");
  const first = Promise.withResolvers<{ branch: string; commit: string }>();
  const entered = Promise.withResolvers<undefined>();
  vi.mocked(fetchAdvertisedDefault)
    .mockReset()
    .mockImplementationOnce(() => {
      entered.resolve(undefined);
      return first.promise;
    })
    .mockResolvedValue({ branch: "main", commit: "b".repeat(40) });
  const one = state.mergedDefault("repo", true);
  const failed = expect(one).rejects.toThrow("fetch failed");
  await entered.promise;
  const two = state.mergedDefault("repo", true);
  expect(fetchAdvertisedDefault).toHaveBeenCalledTimes(1);
  first.reject(new Error("offline"));
  await failed;
  expect(await two).toBe("b".repeat(40));
  expect(fetchAdvertisedDefault).toHaveBeenCalledTimes(2);
  expect(invalidatePanels).toHaveBeenCalledTimes(2);
  expect(state.facts("repo")).toEqual({
    branch: "main",
    time: 1234,
    failed: false,
    head: "b".repeat(40),
  });
});
