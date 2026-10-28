import {
  LaunchFailure,
  launchReasons,
  isLaunchReason,
} from "../../../../src/shared/launch-failure";
import { vi } from "vitest";
import { describe, expect, it } from "vitest";
import { ControlService } from "../../../../src/main/control/service";

import { harness, history, other, repo } from "./orchestration-helpers";

describe("orchestrator slots and authority", () => {
  it("reserves one parent per repository, offers the existing one and frees the slot on exit", () => {
    const { orchestration, exit } = harness();
    expect(orchestration.reserve(repo)).toEqual({ existing: "parent" });
    const pending = orchestration.reserve(other);
    expect(() => orchestration.reserve(other)).toThrow("already starting");
    if ("existing" in pending) throw new Error("unexpected");
    pending.release();
    const again = orchestration.reserve(other);
    expect("bind" in again).toBe(true);
    exit("parent");
    expect("bind" in orchestration.reserve(repo)).toBe(true);
    expect(orchestration.view("parent")).toMatchObject({ role: "orchestrator", active: false });
  });

  it("denies ordinary agents, CLI grants and a parent whose slot never bound", async () => {
    const { service, orchestration } = harness();
    const grant = service.prepare(repo, repo);
    grant.bind("agent");
    const agent = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
    const request = (method: string) => ({
      version: 1,
      instanceId: service.instanceId,
      method,
      params: { idempotencyKey: "k", branch: "x" },
    });
    await expect(service.call(agent, request("create_worktree"))).rejects.toThrow("forbidden");
    expect(service.capabilities(agent)).toEqual([
      "whoami",
      "sessions",
      "session_state",
      "manual",
      "open_preview",
      "list_previews",
      "close_preview",
    ]);
    const unbound = service.prepare(other, other, "orchestrator");
    unbound.bind("unbound");
    const actor = service.authenticate(unbound.env["FOOM_CONTROL_TOKEN"] ?? "");
    await expect(service.call(actor, request("create_worktree"))).rejects.toThrow("forbidden");
    await expect(
      orchestration.call(
        actor,
        "prompt",
        { id: "unknown", text: "hello", idempotencyKey: "key" },
        service.operations,
      ),
    ).rejects.toThrow("forbidden");
    await expect(
      service.call(actor, {
        version: 2,
        instanceId: service.instanceId,
        method: "tail",
        params: {},
      }),
    ).rejects.toThrow("invalid_request");
    const bare = new ControlService(service.operations);
    const lone = bare.prepare(repo, repo, "orchestrator");
    lone.bind("lone");
    const loneActor = bare.authenticate(lone.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(bare.capabilities(loneActor)).not.toContain("launch");
    await expect(
      bare.call(loneActor, { version: 1, instanceId: bare.instanceId, method: "tail", params: {} }),
    ).rejects.toThrow("forbidden");
    expect(
      await bare.call(loneActor, {
        version: 1,
        instanceId: bare.instanceId,
        method: "whoami",
        params: {},
      }),
    ).toMatchObject({ role: "orchestrator" });
  });

  it("parent exit revokes authority, cancels nothing running, and leaves children to the human", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.exit("parent");
    await expect(h.call("tail", { id })).rejects.toThrow("forbidden");
    h.grant.dispose();
    await expect(h.call("tail", { id })).rejects.toThrow("unauthorized");
    expect(h.host.stop).not.toHaveBeenCalled();
    expect(h.orchestration.view(id)).toEqual({
      role: "child",
      parentId: "parent",
      takenOver: false,
    });
    // A replacement orchestrator does not inherit the old children or worktrees.
    const replacement = h.launchParent("replacement");
    await expect(replacement.mutate("stop", { id })).rejects.toThrow("not_found");
    h.orchestration.removed("parent");
    expect(h.orchestration.view("parent")).toBeUndefined();
    expect(h.orchestration.view(id)).toBeUndefined();
  });

  it("takes over a child: the orchestrator loses stop, tail and wait access", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.orchestration.takeOver(id);
    h.orchestration.takeOver(id);
    expect(h.orchestration.view(id)).toMatchObject({ takenOver: true });
    expect(
      history(h.orchestration.view("parent")).filter((entry) => entry.action === "take_over"),
    ).toHaveLength(1);
    await expect(h.mutate("stop", { id })).rejects.toThrow("not_found");
    await expect(h.call("tail", { id })).rejects.toThrow("not_found");
    await expect(h.call("wait_for", { ids: [id] })).rejects.toThrow("not_found");
    expect(() => {
      h.orchestration.takeOver("parent");
    }).toThrow("no orchestrator");
  });
});

it.each(Object.keys(launchReasons))(
  "records a bounded launch failure %s and permits retry with a fresh operation",
  async (reason) => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "failed" });
    if (!isLaunchReason(reason)) throw new Error("Invalid fixture reason");
    h.host.launch.mockRejectedValueOnce(new LaunchFailure(reason));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
    expect(failed).toMatchObject({ status: "failed", reason });
    expect(log).toHaveBeenCalledWith(`Agent launch failed: ${reason}`);
    expect(await h.call("operation_status", { operationId: failed.operationId })).toEqual(failed);
    expect(await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" })).toMatchObject({
      status: "succeeded",
      placement: { kind: "local" },
    });
    log.mockRestore();
  },
);
it("publishes actual remote placement in the operation, deduplication and session state", async () => {
  const h = harness();
  const launch = h.host.launch.getMockImplementation();
  h.host.launch.mockImplementationOnce(async (...args) => {
    if (!launch) throw new Error("Missing launch");
    const id = await launch(...args);
    const row = h.rows.get(id);
    if (!row) throw new Error("Missing row");
    row.placement = { kind: "remote", host: "fixture-alias" };
    row.remote = true;
    return id;
  });
  const tree = await h.mutate("create_worktree", { branch: "remote" });
  const result = await h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
  expect(result.placement).toEqual({ kind: "remote", host: "fixture-alias" });
  expect(await h.call("session_state", { id: result.resultId })).toMatchObject({
    placement: result.placement,
  });
  expect(await h.call("operation_status", { operationId: result.operationId })).toMatchObject({
    placement: result.placement,
  });
});

it("keeps a remote child when close cannot reach the saved host", async () => {
  const h = harness();
  const { id } = await h.child("remote");
  h.exit(id);
  h.host.close.mockRejectedValueOnce(new LaunchFailure("remote_host_unreachable"));
  expect(await h.mutate("close", { id })).toMatchObject({
    status: "failed",
    reason: "remote_host_unreachable",
    resultId: id,
  });
  expect(h.rows.has(id)).toBe(true);
});
