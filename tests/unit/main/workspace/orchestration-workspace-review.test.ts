import * as reviewSnapshots from "../../../../src/main/workspace/review-snapshot";
import type { HostManagement } from "../../../../src/shared/registered-hosts.d";
import { ForgeTracking } from "../../../../src/main/control/forge-tracking";
import { expect, it, vi } from "vitest";
import { object } from "../../../../src/shared/control-validation";
import { Operations } from "../../../../src/main/control/operations";
import {
  repo,
  child,
  deps,
  launch,
  scans,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it("revalidates a standalone snapshot after preparation through the workspace launch request", async () => {
  const original = { head: "a".repeat(40), digest: "original" };
  const snapshot = vi.spyOn(reviewSnapshots, "reviewSnapshot").mockResolvedValue(original);
  const forge = new ForgeTracking(
    "/unused",
    () => Promise.resolve(undefined),
    () => {},
  );
  vi.spyOn(forge, "track").mockImplementation(() => {});
  vi.spyOn(forge, "bindPullRequest").mockResolvedValue();
  vi.spyOn(forge, "read").mockReturnValue({
    number: 7,
    headSha: original.head,
    state: "OPEN",
    requiredChecks: "success",
  });
  const workspace = createWorkspace({ ...deps, forge });
  await orchestrate(workspace);
  vi.mocked(deps.worktrees.adoptWorktree).mockResolvedValue({
    path: child.path,
    branch: child.branch,
    identity: "identity",
  });
  const spawned = vi.fn();
  launch.mockImplementationOnce(async (request) => {
    snapshot.mockResolvedValue({ head: "b".repeat(40), digest: "changed" });
    expect(request.prepareSpawn).toBeTypeOf("function");
    await request.prepareSpawn?.();
    request.beforeSpawn?.();
    spawned();
    return { id: "unexpected-reviewer", attention: "evaluator" };
  });
  const operations = new Operations(
    () => Promise.resolve(),
    () => {},
  );
  try {
    await expect(
      workspace.orchestration.call(
        principal(),
        "review",
        { pullRequest: 7, idempotencyKey: "standalone" },
        operations,
      ),
    ).rejects.toThrow("pr_binding_unresolved");
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(spawned).not.toHaveBeenCalled();
  } finally {
    await workspace.dispose();
  }
});

const runs: {
  resumeFails: boolean;
  remote: boolean;
  fault?:
    | "disconnect"
    | "identity"
    | "branch"
    | "missing"
    | "head"
    | "takeover"
    | "forge"
    | "capacity";
}[] = [
  { resumeFails: false, remote: false },
  { resumeFails: true, remote: false },
  { resumeFails: false, remote: true },
  { resumeFails: true, remote: true },
  ...(
    [
      "disconnect",
      "identity",
      "branch",
      "missing",
      "head",
      "takeover",
      "forge",
      "capacity",
    ] as const
  ).map((fault) => ({ remote: true, resumeFails: false, fault })),
];
it.each(runs)(
  "runs review steps through launches and author resume %j",
  async ({ resumeFails, remote, fault }) => {
    const snapshot = vi
      .spyOn(reviewSnapshots, "reviewSnapshot")
      .mockResolvedValue({ head: "head", digest: "same" });
    const forge = new ForgeTracking(
      "/unused",
      () => Promise.resolve(undefined),
      () => {},
    );
    vi.spyOn(forge, "track").mockImplementation(() => {});
    const forgeRead = vi.spyOn(forge, "read").mockReturnValue({
      number: 7,
      headSha: "head",
      state: "OPEN",
      requiredChecks: "success",
    });
    scans.current = {
      ...scans.current,
      agents: scans.current.agents.map((agent) => ({ ...agent, resume: true })),
    };
    const hostTree = {
      repository: "/code/repository-fixture",
      path: "/code/.foom-worktree-fixture",
      sourceOrigin: "https://forge.test/o/r",
      branch: "feature",
      identity: "a".repeat(64),
      changes: "",
      head: "head",
      snapshot: { head: "head", digest: "same" },
    };
    let invalidate = false;
    const snapshotGate = Promise.withResolvers<undefined>();
    const snapshotEntered = vi.fn();
    const hosts = {
      registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
      worktree: vi.fn(
        (
          _host: string,
          _repo: string,
          action: { operation: HostManagement["operation"]; branch?: string; path?: string },
        ) => {
          if (action.branch === "blocking" || action.path?.endsWith("blocking")) {
            return Promise.resolve({
              ...hostTree,
              path: "/code/.foom-worktree-blocking",
              branch: "blocking",
            });
          }
          if (invalidate && action.operation === "snapshot-worktree") {
            if (fault === "capacity") {
              snapshotEntered();
              return snapshotGate.promise.then(() => ({ ...hostTree }));
            }
            if (fault === "disconnect") return Promise.reject(new Error("Unreachable"));
            if (fault === "takeover") workspace.orchestration.takeOver("child-1");
            if (fault === "forge") forgeRead.mockReturnValue(undefined);
            if (fault === "missing") {
              return Promise.resolve({
                repository: hostTree.repository,
                path: hostTree.path,
                sourceOrigin: hostTree.sourceOrigin,
                branch: hostTree.branch,
                identity: hostTree.identity,
                changes: hostTree.changes,
                head: hostTree.head,
              });
            }
            return Promise.resolve({
              ...hostTree,
              ...(fault === "identity" ? { identity: "changed" } : {}),
              ...(fault === "branch" ? { branch: "other" } : {}),
              ...(fault === "head" ? { head: "other" } : {}),
            });
          }
          return Promise.resolve({ ...hostTree });
        },
      ),
      requireAgent: vi.fn(() => Promise.resolve()),
      fleet: vi.fn(() => Promise.resolve([])),
    };
    const workspace = createWorkspace({ ...deps, forge, ...(remote ? { hosts } : {}) });
    await orchestrate(workspace);
    let next = 0;
    launch.mockImplementation((request) => {
      request.beforeSpawn?.();
      return Promise.resolve({
        id: request.terminalId ?? `child-${String(++next)}`,
        attention: "evaluator",
        ...(remote ? { remote: true, placement: { kind: "remote", host: "worker" } } : {}),
        conversationId: request.conversationId ?? "author-conversation",
      });
    });
    const actor = principal();
    const operations = new Operations(
      () => Promise.resolve(),
      () => {},
    );
    const call = (method: string, params: Record<string, unknown>) =>
      workspace.orchestration.call(actor, method, params, operations);
    const tree = await call("create_worktree", {
      branch: "feature",
      idempotencyKey: "tree",
      ...(remote ? { host: "worker" } : {}),
    });
    if (typeof tree !== "object" || tree === null || !("resultId" in tree))
      throw new Error("missing tree");
    await call("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      prompt: "Build",
      review: {},
      idempotencyKey: "launch",
    });
    const report = (
      id: string,
      seq: number,
      review?:
        | { verdict: "clean" }
        | {
            verdict: "findings";
            findings: { file: string; line: number; summary: string; scenario: string }[];
          },
    ) => {
      workspace.orchestration.handoffs.restore(id, [
        ...workspace.orchestration.handoffs.entries(id),
        {
          seq,
          status: "done",
          summary: "Result",
          links: [],
          timestamp: new Date(0).toISOString(),
          ...(review ? { review } : {}),
        },
      ]);
    };
    expect(workspace.snapshot().terminals.find((row) => row.id === "child-1")?.review?.phase).toBe(
      "building",
    );
    invalidate = fault !== undefined;
    report("child-1", 1);
    await workspace.exited("child-1", 0);
    if (fault === "capacity") {
      await vi.waitFor(() => {
        expect(snapshotEntered).toHaveBeenCalled();
      });
      workspace.configure({
        hooks: false,
        agents: { claude: true, codex: true, agy: true },
        concurrentChildren: 1,
      });
      const blocker = object(
        await call("create_worktree", {
          host: "worker",
          branch: "blocking",
          idempotencyKey: "blocking-tree",
        }),
      );
      await call("launch", {
        worktreeId: blocker["resultId"],
        agent: "claude",
        idempotencyKey: "blocking-launch",
      });
      snapshotGate.resolve(undefined);
      await vi.waitFor(() => {
        expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
          phase: "reviewing",
          waiting: true,
        });
      });
      expect(launch.mock.calls.filter(([request]) => request.worktree !== repo.path)).toHaveLength(
        2,
      );
      await workspace.exited("child-2", 0);
      await vi.waitFor(() => {
        expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
          phase: "reviewing",
          waiting: false,
        });
      });
      expect(launch.mock.calls.at(-1)?.[0].remoteCheckout?.reviewSnapshot).toEqual(
        hostTree.snapshot,
      );
      workspace.orchestration.disposeUnreadChildren();
      return;
    }
    if (fault) {
      await vi.waitFor(() => {
        expect(workspace.orchestration.reviews.view("child-1")?.phase).toBe("escalated");
      });
      expect(launch.mock.calls.filter(([request]) => request.worktree !== repo.path)).toHaveLength(
        1,
      );
      workspace.orchestration.disposeUnreadChildren();
      return;
    }
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
        phase: "reviewing",
        waiting: false,
      });
    });
    if (remote) {
      expect(snapshot).not.toHaveBeenCalled();
      expect(hosts.worktree).toHaveBeenCalledWith(
        "worker",
        repo.path,
        expect.objectContaining({ operation: "snapshot-worktree", identity: hostTree.identity }),
      );
      expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({
        remoteCheckout: {
          target: { host: "worker" },
          worktree: hostTree.path,
          reviewSnapshot: hostTree.snapshot,
        },
        loop: { phase: "reviewing" },
        control: { parentId: "parent" },
      });
    } else {
      const snapshotCall = snapshot.mock.calls[0];
      expect(snapshotCall?.slice(1)).toEqual([repo.path, child.path, "identity"]);
      const snapshotService = snapshotCall?.[0];
      if (!snapshotService) throw new Error("missing snapshot capability");
      await expect(snapshotService.launchIdentity(repo.path, child.path)).resolves.toBe("identity");
      expect(deps.worktrees.launchIdentity).toHaveBeenLastCalledWith(repo.path, child.path);
    }
    expect(deps.placeChild).toHaveBeenLastCalledWith("child-2", "parent");
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      showNewChildren: false,
    });
    vi.mocked(deps.placeChild)?.mockClear();
    if (resumeFails) launch.mockRejectedValueOnce(new Error("Resume failed"));
    report("child-2", 1, {
      verdict: "findings",
      findings: [{ file: "a.ts", line: 1, summary: "Wrong", scenario: "Zero" }],
    });
    await workspace.exited("child-2", 0);
    if (resumeFails) {
      await vi.waitFor(() => {
        expect(workspace.orchestration.reviews.view("child-1")?.phase).toBe("escalated");
      });
      expect(workspace.snapshot().terminals.find((row) => row.id === "child-1")).toMatchObject({
        exited: true,
        dormant: true,
        review: { reason: "launch failed" },
      });
      workspace.orchestration.disposeUnreadChildren();
      snapshot.mockRestore();
      return;
    }
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
        phase: "fixing",
        waiting: false,
      });
    });
    expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({
      terminalId: "child-1",
      conversationId: "author-conversation",
    });
    expect(launch.mock.calls.at(-1)?.[0].prompt).toContain("Quoted review notes");
    expect(workspace.orchestration.handoffs.entries("child-1")).toHaveLength(1);
    report("child-1", 2);
    await workspace.exited("child-1", 0);
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
        phase: "reviewing",
        waiting: false,
      });
    });
    expect(deps.placeChild).not.toHaveBeenCalled();
    report("child-3", 1, { verdict: "clean" });
    await workspace.exited("child-3", 0);
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")?.phase).toBe("clean");
    });
    expect(workspace.snapshot().terminals.find((row) => row.id === "parent")?.state).toMatchObject({
      state: "needs_input",
      reason: "Review clean",
    });
    workspace.focusOrchestrator("parent");
    expect(workspace.orchestration.reviewUnreadAt("parent")).toBeUndefined();
    workspace.orchestration.disposeUnreadChildren();
    snapshot.mockRestore();
  },
);
