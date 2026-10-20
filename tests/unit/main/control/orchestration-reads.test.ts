import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequest } from "../../../../src/main/control/forge.d";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

import { harness, repo } from "./orchestration-helpers";

describe("stop, tail and wait_for", () => {
  it("stops only its own children and reports ambiguous failures as indeterminate", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    expect(await h.mutate("stop", { id })).toMatchObject({ status: "succeeded", resultId: id });
    expect(h.host.stop).toHaveBeenCalledWith(id);
    h.host.stop.mockRejectedValueOnce(new Error("timeout"));
    expect(await h.mutate("stop", { id })).toMatchObject({ status: "indeterminate" });
    h.exit(id);
    expect(await h.mutate("stop", { id })).toMatchObject({ status: "succeeded" });
    expect(h.host.stop).toHaveBeenCalledTimes(2);
    await expect(h.mutate("stop", { id: "parent" })).rejects.toThrow("not_found");
  });

  it("tails redacted, bounded lines once per second per child, as untrusted data", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.host.tail.mockResolvedValueOnce([
      ...Array.from({ length: 60 }, (_, index) => `line ${String(index)}`),
      "password=hunter2",
    ]);
    const result = (await h.call("tail", { id, lines: 3 })) as Record<string, unknown>;
    expect(result).toMatchObject({
      id,
      lines: ["line 58", "line 59", "[REDACTED CREDENTIAL]"],
      truncated: true,
      untrusted: true,
    });
    expect(result["notice"]).toMatch(/untrusted data/u);
    expect(result["revision"]).toMatch(/^[a-f0-9]{64}$/u);
    await expect(h.call("tail", { id })).rejects.toThrow("capacity");
    h.advance(1000);
    h.host.tail.mockResolvedValueOnce(Array.from({ length: 40 }, () => "é".repeat(400)));
    const wide = (await h.call("tail", { id })) as { lines: string[]; truncated: boolean };
    expect(Buffer.byteLength(wide.lines.join("\n"))).toBeLessThanOrEqual(16384);
    expect(wide.truncated).toBe(true);
    h.advance(1000);
    h.host.tail.mockResolvedValueOnce(["€".repeat(6000)]);
    const long = (await h.call("tail", { id })) as { lines: string[] };
    expect(Buffer.byteLength(long.lines[0] ?? "")).toBeLessThanOrEqual(16384);
    expect(long.lines[0]).toMatch(/^€+$/u);
    h.advance(1000);
    h.host.tail.mockResolvedValueOnce(["x".repeat(140_000)]);
    await expect(h.call("tail", { id })).rejects.toThrow("unavailable");
    h.advance(1000);
    h.host.tail.mockRejectedValueOnce(new Error("gone"));
    await expect(h.call("tail", { id })).rejects.toThrow("unavailable");
    for (const lines of [0, 41, 1.5, "3"])
      await expect(h.call("tail", { id, lines })).rejects.toThrow("invalid_request");
    await expect(h.call("tail", { id: "parent" })).rejects.toThrow("not_found");
  });

  it("refuses a tail when the child is taken over while its screen is read", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.host.tail.mockImplementationOnce(() => {
      h.orchestration.takeOver(id);
      return Promise.resolve(["secret plan"]);
    });
    await expect(h.call("tail", { id })).rejects.toThrow("not_found");
  });

  it("waits for a revision change within the bound and validates its cursor", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    const first = (await h.call("wait_for", { ids: [id] })) as {
      sessions: { revision: string }[];
      changed: string[];
      timedOut: boolean;
    };
    expect(first).toMatchObject({ changed: [id], timedOut: false });
    const revision = first.sessions[0]?.revision ?? "";
    expect(await h.call("wait_for", { ids: [id], after: { [id]: revision } })).toMatchObject({
      changed: [],
      timedOut: true,
    });
    const waiting = h.call("wait_for", { ids: [id], after: { [id]: revision }, timeoutMs: 5000 });
    h.rows.set(id, { ...(h.rows.get(id) as WorkspaceTerminal), exited: true });
    expect(await waiting).toMatchObject({ changed: [id], timedOut: false });
    for (const params of [
      { ids: [] },
      { ids: ["a", "b", "c", "d", "e"] },
      { ids: [id, id] },
      { ids: id },
      { ids: [id], timeoutMs: 30001 },
      { ids: [id], timeoutMs: -1 },
      { ids: [id], after: [] },
      { ids: [id], after: { other: revision } },
      { ids: [id], after: { [id]: "bad revision" } },
    ])
      await expect(h.call("wait_for", params)).rejects.toThrow("invalid_request");
    await expect(h.call("wait_for", { ids: ["parent"] })).rejects.toThrow("not_found");
  });

  it("ends a wait when the parent exits", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    const revision = (
      (await h.call("wait_for", { ids: [id] })) as { sessions: { revision: string }[] }
    ).sessions[0]?.revision;
    const waiting = h.call("wait_for", { ids: [id], after: { [id]: revision }, timeoutMs: 5000 });
    h.exit("parent");
    await expect(waiting).rejects.toThrow("forbidden");
  });
});

it("wakes wait_for on required checks and exposes old mappings to a new generation without child authority", async () => {
  const h = harness();
  const child = await h.child("pr-child");
  expect(h.host.forge.track).toHaveBeenCalledWith({
    repository: repo,
    path: join(repo, "trees", "pr-child"),
    branch: "pr-child",
    identity: "id-pr-child",
  });
  const pr: PullRequest = {
    number: 340,
    headSha: "a".repeat(40),
    state: "OPEN",
    requiredChecks: "pending",
  };
  h.host.forge.read.mockReturnValue(pr);
  const before = (await h.call("session_state", { id: child.id })) as { revision: string };
  const waiting = h.call("wait_for", {
    ids: [child.id],
    after: { [child.id]: before.revision },
    timeoutMs: 1000,
  });
  h.host.forge.read.mockReturnValue({ ...pr, requiredChecks: "success" });
  expect(await waiting).toMatchObject({
    changed: [child.id],
    timedOut: false,
    sessions: [{ pullRequest: { requiredChecks: "success" } }],
  });
  h.exit("parent");
  const next = h.launchParent("new-parent");
  expect(await next.call("session_state", { id: child.id })).toMatchObject({
    pullRequest: { number: 340, requiredChecks: "success" },
  });
  await expect(next.call("wait_for", { ids: [child.id] })).rejects.toThrow("not_found");
});
