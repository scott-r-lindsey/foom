import * as reviewSnapshots from "../../../../src/main/workspace/review-snapshot";
import { ForgeTracking } from "../../../../src/main/control/forge-tracking";
import { expect, it, vi } from "vitest";
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

it.each([false, true])(
  "runs review steps through launches and author resume (resume failure: %s)",
  async (resumeFails) => {
    const snapshot = vi
      .spyOn(reviewSnapshots, "reviewSnapshot")
      .mockResolvedValue({ head: "head", digest: "same" });
    const forge = new ForgeTracking(
      "/unused",
      () => Promise.resolve(undefined),
      () => {},
    );
    vi.spyOn(forge, "track").mockImplementation(() => {});
    vi.spyOn(forge, "read").mockReturnValue({
      number: 7,
      headSha: "head",
      state: "OPEN",
      requiredChecks: "success",
    });
    scans.current = {
      ...scans.current,
      agents: scans.current.agents.map((agent) => ({ ...agent, resume: true })),
    };
    const workspace = createWorkspace({ ...deps, forge });
    await orchestrate(workspace);
    let next = 0;
    launch.mockImplementation((request) => {
      request.beforeSpawn?.();
      return Promise.resolve({
        id: request.terminalId ?? `child-${String(++next)}`,
        attention: "evaluator",
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
    const tree = await call("create_worktree", { branch: "feature", idempotencyKey: "tree" });
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
    report("child-1", 1);
    await workspace.exited("child-1", 0);
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
        phase: "reviewing",
        waiting: false,
      });
    });
    const snapshotCall = snapshot.mock.calls[0];
    expect(snapshotCall?.slice(1)).toEqual([repo.path, child.path, "identity"]);
    const snapshotService = snapshotCall?.[0];
    if (!snapshotService) throw new Error("missing snapshot capability");
    await expect(snapshotService.launchIdentity(repo.path, child.path)).resolves.toBe("identity");
    expect(deps.worktrees.launchIdentity).toHaveBeenLastCalledWith(repo.path, child.path);
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
