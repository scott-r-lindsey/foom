import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { locationId } from "../../../../src/main/control/metadata";
import { UncertainEffect } from "../../../../src/main/workspace/worktree-outcome";
import type { Operation } from "../../../../src/main/control/types";
import { ControlError } from "../../../../src/node-common/control-validation";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import pluginFixture from "../../../fixtures/agent-plugin.json";

import { harness, repo } from "./orchestration-helpers";

describe("worktrees and children", () => {
  it("creates new worktrees idempotently and bounds unused ones to four", async () => {
    const h = harness();
    const first = await h.call("create_worktree", { idempotencyKey: "same", branch: "a" });
    expect(first).toMatchObject({
      status: "succeeded",
      resultId: locationId(join(repo, "trees", "a")),
    });
    expect(first).not.toHaveProperty("created");
    expect(await h.call("create_worktree", { idempotencyKey: "same", branch: "a" })).toEqual(first);
    await expect(
      h.call("create_worktree", { idempotencyKey: "same", branch: "b" }),
    ).rejects.toThrow("conflict");
    expect(h.host.createWorktree).toHaveBeenCalledTimes(1);
    for (const branch of ["b", "c", "d"]) await h.mutate("create_worktree", { branch });
    await expect(
      h.call("create_worktree", { idempotencyKey: "fifth", branch: "e" }),
    ).rejects.toThrow("capacity");
    expect(await h.call("operation_status", { idempotencyKey: "fifth" })).toMatchObject({
      status: "failed",
      reason: "refused",
    });
    for (const branch of ["-flag", "two words", "bad‮name", "", "x".repeat(201)])
      await expect(h.mutate("create_worktree", { branch })).rejects.toThrow("invalid_request");
    await expect(h.mutate("create_worktree", { branch: "a", path: "/tmp" })).rejects.toThrow(
      "invalid_request",
    );
  });

  it("records a failed worktree creation and frees its reservation", async () => {
    const h = harness();
    h.host.createWorktree.mockRejectedValueOnce(new Error("Branch already exists"));
    expect(await h.mutate("create_worktree", { branch: "taken" })).toMatchObject({
      status: "failed",
      reason: "error",
    });
    for (const branch of ["a", "b", "c", "d"]) await h.mutate("create_worktree", { branch });
  });

  it("launches one ordinary child per fresh worktree and refuses foreign or reused worktrees", async () => {
    const h = harness();
    const { id, worktreeId } = await h.child("feature");
    expect(h.host.launch).toHaveBeenCalledWith(
      "parent",
      repo,
      join(repo, "trees", "feature"),
      "id-feature",
      "claude",
      undefined,
    );
    await expect(h.mutate("launch", { worktreeId, agent: "codex" })).rejects.toThrow("conflict");
    await expect(
      h.mutate("launch", { worktreeId: locationId(repo), agent: "claude" }),
    ).rejects.toThrow("not_found");
    const tree = await h.mutate("create_worktree", { branch: "prompted" });
    await h.mutate("launch", {
      worktreeId: tree.resultId,
      agent: "agy",
      prompt: "Fix it\nthen test",
    });
    expect(h.host.launch).toHaveBeenLastCalledWith(
      "parent",
      repo,
      join(repo, "trees", "prompted"),
      "id-prompted",
      "agy",
      "Fix it\nthen test",
    );
    for (const params of [
      { worktreeId, agent: "bash" },
      { worktreeId, agent: "claude", prompt: "--dangerously-skip-permissions" },
      { worktreeId, agent: "claude", prompt: "x".repeat(16385) },
      { worktreeId, agent: "claude", prompt: "esc\u001b[2J" },
      { worktreeId, agent: "claude", executable: "/bin/sh" },
      { worktreeId, agent: "claude", role: "orchestrator" },
    ])
      await expect(h.mutate("launch", params)).rejects.toThrow("invalid_request");
    expect(h.orchestration.view(id)).toEqual({
      role: "child",
      parentId: "parent",
      takenOver: false,
    });
  });

  it("allows four simultaneous children and denies the fifth, counting starting children", async () => {
    const h = harness();
    const trees: Operation[] = [];
    for (const branch of ["a", "b", "c", "d"])
      trees.push(await h.mutate("create_worktree", { branch }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = h.host.launch.getMockImplementation();
    h.host.launch.mockImplementation(async (...args) => {
      await gate;
      return launch?.(...args) ?? "";
    });
    const pending = trees.map((tree) =>
      h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" }),
    );
    await vi.waitFor(() => {
      expect(h.host.launch).toHaveBeenCalledTimes(4);
    });
    // Starting launches stay charged to the unused-worktree budget until they succeed.
    await expect(h.mutate("create_worktree", { branch: "early" })).rejects.toThrow("capacity");
    release();
    const launched = await Promise.all(pending);
    expect(launched.every((record) => record.status === "succeeded")).toBe(true);
    const fifth = await h.mutate("create_worktree", { branch: "e" });
    await expect(
      h.mutate("launch", { worktreeId: fifth.resultId, agent: "claude" }),
    ).rejects.toThrow("capacity");
    expect(h.orchestration.view("parent")).toMatchObject({ children: 4 });
    // A stopped child frees its slot only once its exit is confirmed.
    h.exit(launched[0]?.resultId ?? "");
    expect(await h.mutate("launch", { worktreeId: fifth.resultId, agent: "claude" })).toMatchObject(
      { status: "succeeded" },
    );
  });

  it("restores the unused budget when every starting launch fails", async () => {
    const h = harness();
    const trees: Operation[] = [];
    for (const branch of ["a", "b", "c", "d"])
      trees.push(await h.mutate("create_worktree", { branch }));
    h.host.launch.mockRejectedValue(new Error("spawn failed"));
    for (const tree of trees)
      expect(
        await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" }),
      ).toMatchObject({ status: "failed" });
    await expect(h.mutate("create_worktree", { branch: "e" })).rejects.toThrow("capacity");
  });

  it("reports a possibly created worktree as indeterminate and keeps it charged", async () => {
    const h = harness();
    h.host.createWorktree.mockRejectedValueOnce(new UncertainEffect());
    const params = { idempotencyKey: "uncertain", branch: "maybe" };
    const first = await h.call("create_worktree", params);
    expect(first).toMatchObject({
      status: "indeterminate",
      reason: "uncertain",
    });
    expect(await h.call("create_worktree", params)).toEqual(first);
    expect(h.host.createWorktree).toHaveBeenCalledOnce();
    for (const branch of ["a", "b", "c"]) await h.mutate("create_worktree", { branch });
    await expect(h.mutate("create_worktree", { branch: "d" })).rejects.toThrow("capacity");
  });

  it("drops ownership when the human relaunches a child under the same ID", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.exit(id);
    h.orchestration.relaunched(id);
    expect(h.orchestration.view(id)).toBeUndefined();
    await expect(h.call("tail", { id })).rejects.toThrow("not_found");
    await expect(h.mutate("stop", { id })).rejects.toThrow("not_found");
  });

  it("records a failed spawn, keeps the worktree usable and counts an early exit", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "flaky" });
    h.host.launch.mockRejectedValueOnce(new Error("spawn failed"));
    expect(await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" })).toMatchObject({
      status: "failed",
      reason: "error",
    });
    h.host.launch.mockImplementationOnce(() => {
      h.orchestration.exited("early");
      return Promise.resolve("early");
    });
    await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
    expect(h.orchestration.view("parent")).toMatchObject({ children: 0 });
    h.orchestration.exited("not-a-child");
    h.orchestration.removed("not-a-child");
  });

  it("refuses to record when audit persistence fails, never launching", async () => {
    const h = harness();
    h.persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.mutate("create_worktree", { branch: "a" })).rejects.toThrow("unavailable");
    expect(h.host.createWorktree).not.toHaveBeenCalled();
  });

  it("reports an indeterminate outcome when the parent exits while a child is launching", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "slow" });
    h.host.launch.mockImplementationOnce(() => {
      h.exit("parent");
      h.grant.dispose();
      return Promise.resolve("orphan");
    });
    await expect(
      h.call("launch", { idempotencyKey: "slow", worktreeId: tree.resultId, agent: "claude" }),
    ).rejects.toThrow("unauthorized");
    expect(h.orchestration.view("orphan")).toEqual({
      role: "child",
      parentId: "parent",
      takenOver: false,
    });
  });
});

it("validates the narrow PR-number schema and deduplicates adoption", async () => {
  const h = harness();
  for (const params of [
    {},
    { pullRequest: 0 },
    { pullRequest: -1 },
    { pullRequest: 1.5 },
    { pullRequest: "337" },
    { pullRequest: 337, branch: "x" },
    { pullRequest: 337, remote: "origin" },
    { pullRequest: 337, path: "/tmp" },
  ]) {
    await expect(h.mutate("create_worktree", params)).rejects.toThrow("invalid_request");
  }
  const first = await h.call("create_worktree", { idempotencyKey: "adopt", pullRequest: 337 });
  expect(first).toMatchObject({ status: "succeeded" });
  expect(await h.call("create_worktree", { idempotencyKey: "adopt", pullRequest: 337 })).toEqual(
    first,
  );
  await expect(
    h.call("create_worktree", { idempotencyKey: "adopt", pullRequest: 338 }),
  ).rejects.toThrow("conflict");
  expect(h.host.adoptWorktree).toHaveBeenCalledOnce();
  expect(h.host.forge.track).toHaveBeenCalledWith(
    {
      repository: repo,
      path: join(repo, "trees", "adopted"),
      branch: "adopted",
      identity: "id-adopted",
    },
    337,
  );
});
it("charges adoption to the unused budget and permits owned unused reuse at capacity", async () => {
  const h = harness();
  const tree = await h.mutate("create_worktree", { pullRequest: 337 });
  for (const branch of ["a", "b", "c"]) await h.mutate("create_worktree", { branch });
  await expect(h.mutate("create_worktree", { pullRequest: 338 })).rejects.toThrow("capacity");
  h.host.adoptWorktree.mockImplementationOnce((_repo, _number, unused, revalidate) => {
    const adopted = unused.find((row) => row.path.endsWith("adopted"));
    if (!adopted) throw new Error("Missing ownership");
    revalidate(adopted.path);
    return Promise.resolve({ ...adopted, branch: "adopted" });
  });
  expect(await h.mutate("create_worktree", { pullRequest: 337 })).toMatchObject({
    resultId: tree.resultId,
  });
  expect(await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" })).toMatchObject({
    status: "succeeded",
  });
});
it("records adoption refusals without leaking provider diagnostics", async () => {
  const h = harness();
  h.host.adoptWorktree.mockRejectedValueOnce(new ControlError("pr_from_fork"));
  await expect(h.mutate("create_worktree", { pullRequest: 337 })).rejects.toThrow("pr_from_fork");
  expect(h.persist.mock.calls.at(-1)?.[0].operation).toMatchObject({
    status: "failed",
    reason: "refused",
  });
});

it("launches a validated manifest provider through the ordinary child authorization path", async () => {
  const manifest = parseAgentManifest(JSON.stringify(pluginFixture)).model;
  replaceConfigProviders([v2Provider(manifest, () => Promise.resolve())]);
  try {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "fixture-plugin" });
    const launch = await h.mutate("launch", { worktreeId: tree.resultId, agent: manifest.id });
    expect(launch.status).toBe("succeeded");
    expect(h.host.launch).toHaveBeenCalledWith(
      "parent",
      repo,
      expect.any(String),
      expect.any(String),
      manifest.id,
      undefined,
    );
    replaceConfigProviders([]);
    await expect(
      h.mutate("launch", { worktreeId: tree.resultId, agent: manifest.id }),
    ).rejects.toThrow("invalid_request");
  } finally {
    replaceConfigProviders([]);
  }
});
