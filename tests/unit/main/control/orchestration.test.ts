import pluginFixture from "../../../fixtures/agent-plugin.json";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { ControlError } from "../../../../src/node-common/control-validation";
import type { PullRequest } from "../../../../src/main/control/forge.d";
import type { DialogContent } from "../../../../src/shared/confirmation";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { Orchestration, UncertainEffect } from "../../../../src/main/control/orchestration";
import type { OrchestrationHost } from "../../../../src/main/control/orchestration";
import { locationId } from "../../../../src/main/control/metadata";
import type { Operation, StoredOperation } from "../../../../src/main/control/types";
import type { OrchestrationView, WorkspaceTerminal } from "../../../../src/shared/workspace";

const repo = join(tmpdir(), "orchestrated");
const history = (view: OrchestrationView | undefined) =>
  view?.role === "orchestrator" ? view.history : [];
const other = join(tmpdir(), "elsewhere");

function harness() {
  let limit = 4;
  const rows = new Map<string, WorkspaceTerminal>();
  let next = 0;
  let now = 1_000_000;
  const row = (id: string, worktree: string, branch: string): WorkspaceTerminal => ({
    id,
    kind: "agent",
    agent: "claude",
    repository: repo,
    worktree,
    branch,
    attention: "evaluator",
    state: null,
  });
  rows.set("parent", row("parent", repo, "main"));
  const host = {
    forge: {
      track: vi.fn(),
      read: vi.fn((_repository: string, _path: string): PullRequest | undefined => undefined),
    },
    terminals: () => [...rows.values()],
    adoptWorktree: vi.fn(
      (
        _repository: string,
        _number: number,
        _unused: readonly { path: string; identity: string }[],
        revalidate: (path?: string) => void,
      ) => {
        revalidate();
        return Promise.resolve({
          path: join(repo, "trees", "adopted"),
          branch: "adopted",
          identity: "id-adopted",
        });
      },
    ),
    createWorktree: vi.fn((_repository: string, branch: string) =>
      Promise.resolve({ path: join(repo, "trees", branch), branch, identity: `id-${branch}` }),
    ),
    launch: vi.fn(
      (
        _parent: string,
        _repository: string,
        worktree: string,
        _identity: string,
        _agent: string,
        _prompt: string | undefined,
      ) => {
        const id = `child-${String(++next)}`;
        rows.set(id, row(id, worktree, worktree.split("/").at(-1) ?? ""));
        return Promise.resolve(id);
      },
    ),
    restoreWorktree: vi.fn((_repository: string, path: string) =>
      Promise.resolve({
        branch: path.split("/").at(-1) ?? "child",
        identity: `id-${path.split("/").at(-1) ?? "child"}`,
      }),
    ),
    stop: vi.fn((_id: string) => Promise.resolve()),
    close: vi.fn((_id: string) => Promise.resolve()),
    place: vi.fn(),
    tail: vi.fn((_id: string, _lines: number) => Promise.resolve(["ready"])),
    remove: vi.fn(
      (
        _repository: string,
        _worktree: string,
        _identity: string,
        confirm: (branch: string, changes: string) => Promise<boolean>,
      ) => confirm("feature", ""),
    ),
    dialog: vi.fn((_content: DialogContent, _signal: AbortSignal) => Promise.resolve(true)),
    changed: vi.fn(),
  } satisfies OrchestrationHost;
  const persist = vi.fn((_record: StoredOperation) => Promise.resolve());
  const operations = new Operations(persist, (actor) => {
    service.assertActive(actor);
  });
  const orchestration = new Orchestration(
    host,
    () => now,
    () => limit,
  );
  const service = new ControlService(operations, host.terminals, orchestration);
  const launchParent = (terminalId: string, repository = repo) => {
    const slot = orchestration.reserve(repository);
    if ("existing" in slot) throw new Error("slot taken");
    const grant = service.prepare(repository, repository, "orchestrator");
    grant.bind(terminalId);
    slot.bind(terminalId);
    const actor = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
    let key = 0;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      service.call(actor, { version: 1, instanceId: service.instanceId, method, params });
    const mutate = (method: string, params: Record<string, unknown>) =>
      call(method, { idempotencyKey: `key-${String(++key)}`, ...params }) as Promise<Operation>;
    return { actor, grant, call, mutate };
  };
  const parent = launchParent("parent");
  const exit = (id: string) => {
    rows.set(id, { ...(rows.get(id) ?? row(id, repo, "")), exited: true });
    orchestration.exited(id);
  };
  const child = async (branch: string, mutate = parent.mutate) => {
    const tree = await mutate("create_worktree", { branch });
    const launched = await mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
    return { worktreeId: tree.resultId ?? "", id: launched.resultId ?? "" };
  };
  return {
    setLimit: (value: number) => {
      limit = value;
    },
    host,
    rows,
    service,
    operations,
    orchestration,
    persist,
    launchParent,
    exit,
    child,
    ...parent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

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
      "open_preview",
      "list_previews",
      "close_preview",
    ]);
    const unbound = service.prepare(other, other, "orchestrator");
    unbound.bind("unbound");
    const actor = service.authenticate(unbound.env["FOOM_CONTROL_TOKEN"] ?? "");
    await expect(service.call(actor, request("create_worktree"))).rejects.toThrow("forbidden");
    await expect(orchestration.call(actor, "reply", {}, service.operations)).rejects.toThrow(
      "forbidden",
    );
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
    expect(await h.mutate("create_worktree", { branch: "maybe" })).toMatchObject({
      status: "indeterminate",
      reason: "uncertain",
    });
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

describe("worktree removal", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it.each(["OPEN", "CLOSED", "MERGED", undefined] as const)(
    "includes only available cached PR metadata in removal review (%s)",
    async (state) => {
      const h = harness();
      const tree = await h.mutate("create_worktree", { branch: "review" });
      if (state)
        h.host.forge.read.mockReturnValue({
          number: 338,
          state,
          headSha: "a".repeat(40),
          requiredChecks: "success",
        });
      await h.call("remove_worktree", { idempotencyKey: "remove", worktreeId: tree.resultId });
      await vi.waitFor(() => {
        expect(h.host.dialog).toHaveBeenCalledOnce();
      });
      expect(h.host.dialog.mock.calls[0]?.[0].removal?.item.pullRequest).toEqual(
        state ? { number: 338, state } : undefined,
      );
      expect(h.host.forge.read).toHaveBeenCalledWith(repo, join(repo, "trees", "review"));
    },
  );

  it("always asks the human, even for a clean worktree, and keeps the branch", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "done" });
    const pending = await h.call("remove_worktree", {
      idempotencyKey: "remove",
      worktreeId: tree.resultId,
    });
    expect(pending).toMatchObject({ status: "pending_confirmation", action: "remove_worktree" });
    await vi.waitFor(async () => {
      expect(await h.call("operation_status", { idempotencyKey: "remove" })).toMatchObject({
        status: "succeeded",
        resultId: tree.resultId,
      });
    });
    expect(h.host.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Remove worktrees?",
        removal: expect.objectContaining({
          item: expect.objectContaining({ branch: "feature", changes: "" }) as unknown,
        }) as unknown,
        accept: "Approve all",
      }),
      expect.any(AbortSignal),
    );

    // The removed worktree no longer belongs to the orchestrator.
    await expect(
      h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" }),
    ).rejects.toThrow("not_found");
  });

  it("records a declined removal and shows changed files in the dialog", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "dirty" });
    h.host.dialog.mockResolvedValueOnce(false);
    h.host.remove.mockImplementationOnce((_repository, _worktree, _identity, confirm) =>
      confirm("dirty", " M file\0"),
    );
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(async () => {
      expect(await h.call("operation_status", { idempotencyKey: "r" })).toMatchObject({
        status: "declined",
        reason: "refused",
      });
    });
    expect(h.host.dialog.mock.calls[0]?.[0]).toMatchObject({
      removal: { item: { changes: " M file\0" } },
    });
  });

  it("cancels a pending confirmation when the parent exits, even if the dialog later accepts", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "stale" });
    let answer: (value: boolean) => void = () => undefined;
    let signal: AbortSignal | undefined;
    h.host.dialog.mockImplementationOnce((_content, abort) => {
      signal = abort;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });
    let removed = false;
    h.host.remove.mockImplementationOnce(async (_repository, _worktree, _identity, confirm) => {
      removed = await confirm("stale", "");
      return removed;
    });
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });
    h.exit("parent");
    expect(signal?.aborted).toBe(true);
    h.grant.dispose();
    answer(true);
    await settle();
    await settle();
    expect(removed).toBe(false);
    const entries = history(h.orchestration.view("parent"));
    expect(entries.at(-1)?.status).toBe("cancelled");
  });

  it("marks a failure after acceptance and refuses foreign or occupied worktrees", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "racy" });
    h.host.remove.mockImplementationOnce(async (_repository, _worktree, _identity, confirm) => {
      await confirm("racy", "");
      throw new Error("Worktree changes have changed");
    });
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(async () => {
      expect(await h.call("operation_status", { idempotencyKey: "r" })).toMatchObject({
        status: "failed",
      });
    });
    await expect(h.mutate("remove_worktree", { worktreeId: locationId(repo) })).rejects.toThrow(
      "not_found",
    );
    const { worktreeId } = await h.child("busy");
    await expect(h.mutate("remove_worktree", { worktreeId })).rejects.toThrow("conflict");
    expect(h.host.dialog).toHaveBeenCalledTimes(1);
  });

  it("records an indeterminate outcome when the parent exits after the human accepted", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "late" });
    h.host.remove.mockImplementationOnce(async (_repository, _worktree, _identity, confirm) => {
      await confirm("late", "");
      h.exit("parent");
      h.grant.dispose();
      throw new Error("interrupted");
    });
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(() => {
      const entries = history(h.orchestration.view("parent"));
      expect(entries.at(-1)?.status).toBe("indeterminate");
    });
  });
});

it("rejects stop while a restored child is queued instead of claiming it stopped", async () => {
  const fixture = harness();
  const starting = vi.fn(() => true);
  const orchestration = new Orchestration({ ...fixture.host, starting });
  const slot = orchestration.reserve(repo);
  if ("existing" in slot) throw new Error("unexpected parent");
  slot.bind("parent");
  const row: WorkspaceTerminal = {
    id: "queued",
    kind: "agent",
    agent: "claude",
    repository: repo,
    worktree: join(repo, "child"),
    branch: "child",
    attention: "evaluator",
    state: null,
  };
  expect(await orchestration.restoreChild("parent", row)).toBe(true);
  await expect(
    orchestration.call(
      fixture.actor,
      "stop",
      { id: row.id, idempotencyKey: "queued-stop" },
      fixture.operations,
    ),
  ).rejects.toThrow();
  expect(fixture.host.stop).not.toHaveBeenCalled();
  starting.mockReturnValue(false);
  await orchestration.call(
    fixture.actor,
    "stop",
    { id: row.id, idempotencyKey: "ready-stop" },
    fixture.operations,
  );
  expect(fixture.host.stop).toHaveBeenCalledWith(row.id);
});

it("restores unused ownership for launch and used ownership for confirmed removal", async () => {
  const h = harness();
  const path = join(repo, "trees", "saved");
  await h.orchestration.restoreWorktrees("missing", []);
  await h.orchestration.restoreWorktrees("parent", [
    { path, identity: "id-saved", state: "unused" },
  ]);
  expect(h.orchestration.ownedWorktrees("missing")).toEqual([]);
  expect(h.orchestration.uncertainWorktrees("missing")).toBe(0);
  expect(h.orchestration.ownedWorktrees("parent")).toEqual([
    { path, identity: "id-saved", state: "unused" },
  ]);
  const launched = await h.mutate("launch", { worktreeId: locationId(path), agent: "claude" });
  expect(launched.status).toBe("succeeded");
  h.exit(launched.resultId ?? "");
  await expect(
    h.mutate("launch", { worktreeId: locationId(path), agent: "claude" }),
  ).rejects.toThrow("conflict");
  expect((await h.mutate("remove_worktree", { worktreeId: locationId(path) })).status).toBe(
    "pending_confirmation",
  );
  await vi.waitFor(() => {
    expect(h.host.remove).toHaveBeenCalled();
  });
});

it("restores legacy exited children as used without consuming the live child budget", async () => {
  const h = harness();
  for (let i = 0; i < 6; i++) {
    expect(
      await h.orchestration.restoreChild("parent", {
        ...h.rows.get("parent"),
        id: `old-${String(i)}`,
        kind: "agent",
        agent: "claude",
        repository: repo,
        worktree: join(repo, "trees", String(i)),
        branch: "untrusted",
        attention: "evaluator",
        state: null,
        exited: true,
      }),
    ).toBe(true);
  }
  expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(6);
  expect(h.orchestration.ownedWorktrees("parent").every((tree) => tree.state === "used")).toBe(
    true,
  );
  for (let i = 0; i < 4; i++) await h.child(`live-${String(i)}`);
  const row = h.rows.get("parent");
  if (!row) throw new Error("missing row");
  expect(
    await h.orchestration.restoreChild("parent", {
      ...row,
      id: "overflow",
      worktree: join(repo, "extra"),
    }),
  ).toBe(false);
  expect(await h.orchestration.restoreChild("missing", row)).toBe(false);
  expect(
    await h.orchestration.restoreChild("parent", { ...row, id: "foreign", repository: other }),
  ).toBe(false);
});

it("keeps restore within the unused budget and refuses missing or changed identities", async () => {
  const h = harness();
  const trees = Array.from({ length: 5 }, (_, i) => ({
    path: join(repo, String(i)),
    identity: `id-${String(i)}`,
    state: "unused" as const,
  }));
  await h.orchestration.restoreWorktrees("parent", trees, 1);
  expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(3);
  expect(h.orchestration.uncertainWorktrees("parent")).toBe(1);
  await expect(h.mutate("create_worktree", { branch: "overflow" })).rejects.toThrow("capacity");
  await h.orchestration.restoreWorktrees("parent", [
    trees[0] ?? { path: repo, identity: "bad", state: "used" },
  ]);
  await h.orchestration.restoreWorktrees("parent", [
    { path: join(repo, "changed"), identity: "old", state: "used" },
  ]);
  h.host.restoreWorktree.mockRejectedValue(new Error("missing"));
  const row = h.rows.get("parent");
  if (!row) throw new Error("missing row");
  expect(await h.orchestration.restoreChild("parent", { ...row, id: "missing" })).toBe(false);
  await h.orchestration.restoreWorktrees("parent", [
    { path: join(repo, "missing"), identity: "old", state: "used" },
  ]);
  expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(3);
});

it.each([1, 2, 5, 16])("reserves exactly %i children with the current setting", async (limit) => {
  const h = harness();
  h.setLimit(limit);
  for (let i = 0; i < limit; i++) await h.child(`child-${String(i)}`);
  const tree = await h.mutate("create_worktree", { branch: "extra" });
  await expect(h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" })).rejects.toThrow(
    "capacity",
  );
  expect(h.host.launch).toHaveBeenCalledTimes(limit);
  const ids = [...h.rows.keys()].filter((id) => id !== "parent");
  expect(await h.call("wait_for", { ids })).toMatchObject({ sessions: ids.map((id) => ({ id })) });
  await expect(h.call("wait_for", { ids: [...ids, "extra"] })).rejects.toThrow("invalid_request");
});

it("lowering mid-run leaves children alive and blocks until below the new limit", async () => {
  const h = harness();
  h.setLimit(3);
  const first = (await h.child("a")).id;
  const second = (await h.child("b")).id;
  await h.child("c");
  h.setLimit(2);
  expect(h.host.stop).not.toHaveBeenCalled();
  expect(h.orchestration.view("parent")).toMatchObject({ children: 3 });
  const tree = await h.mutate("create_worktree", { branch: "d" });
  const launch = () => h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
  await expect(launch()).rejects.toThrow("capacity");
  await h.mutate("stop", { id: first });
  await expect(launch()).rejects.toThrow("capacity");
  h.exit(first);
  await expect(launch()).rejects.toThrow("capacity");
  h.exit(second);
  expect(await launch()).toMatchObject({ status: "succeeded" });
  h.setLimit(3);
  expect(await h.child("e")).toHaveProperty("id");
});

it("counts starting reservations at a changed limit", async () => {
  const h = harness();
  h.setLimit(1);
  const a = await h.mutate("create_worktree", { branch: "a" });
  const b = await h.mutate("create_worktree", { branch: "b" });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.host.launch.getMockImplementation();
  h.host.launch.mockImplementation(async (...args) => {
    await gate;
    return original?.(...args) ?? "";
  });
  const pending = h.mutate("launch", { worktreeId: a.resultId, agent: "claude" });
  await vi.waitFor(() => {
    expect(h.host.launch).toHaveBeenCalledOnce();
  });
  await expect(h.mutate("launch", { worktreeId: b.resultId, agent: "claude" })).rejects.toThrow(
    "capacity",
  );
  release();
  expect(await pending).toMatchObject({ status: "succeeded" });
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

describe("close exited children", () => {
  it("places a new child once, but never places restored children", async () => {
    const h = harness();
    const { id } = await h.child("placed");
    expect(h.host.place).toHaveBeenCalledExactlyOnceWith(id, "parent");
    const row = h.rows.get(id);
    if (!row) throw new Error("Missing child");
    await h.orchestration.restoreChild("parent", row);
    expect(h.host.place).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "stopping", "taken-over", "foreign", "unknown"])(
    "refuses a %s child with a fixed reason and records the refusal",
    async (state) => {
      const h = harness();
      const { id } = await h.child("feature");
      if (state === "stopping") await h.mutate("stop", { id });
      if (state === "taken-over") {
        h.exit(id);
        h.orchestration.takeOver(id);
      }
      const caller = state === "foreign" ? h.launchParent("other-parent", other) : h;
      const target = state === "unknown" ? "missing" : id;
      const reason =
        state === "taken-over"
          ? "forbidden"
          : state === "foreign" || state === "unknown"
            ? "not_found"
            : "conflict";
      await expect(caller.mutate("close", { id: target })).rejects.toThrow(reason);
      expect(h.host.close).not.toHaveBeenCalled();
      expect(history(h.orchestration.view(caller.actor.terminalId)).at(-1)).toMatchObject({
        action: "close",
        status: "failed",
      });
      expect(h.persist.mock.calls.at(-1)?.[0].operation.reason).toBe("refused");
    },
  );

  it("closes an exited child once with an operation, keeping the owned worktree", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.exit(id);
    h.host.close.mockImplementation((target) => {
      h.rows.delete(target);
      h.orchestration.removed(target);
      return Promise.resolve();
    });
    const params = { id, idempotencyKey: "close-once" };
    const first = await h.call("close", params);
    expect(first).toMatchObject({ action: "close", status: "succeeded", resultId: id });
    expect(await h.call("close", params)).toEqual(first);
    expect(h.host.close).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(1);
    expect(h.host.remove).not.toHaveBeenCalled();
    expect(history(h.orchestration.view("parent")).at(-1)?.action).toBe("close");
  });

  it("records a close failure without removing child ownership", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.exit(id);
    h.host.close.mockRejectedValueOnce(new Error("host failure"));
    expect(await h.mutate("close", { id })).toMatchObject({ status: "failed" });
    expect(h.orchestration.view(id)).toMatchObject({ role: "child" });
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

describe("child handoff ownership and waits", () => {
  async function setup() {
    const h = harness();
    const child = await h.child("reports");
    const grant = h.service.prepare(repo, join(repo, "trees", "reports"), "agent", "parent");
    grant.bind(child.id);
    const actor = h.service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
    const report = (params: Record<string, unknown> = {}) =>
      h.service.call(actor, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "handoff",
        params: { status: "blocked", summary: "CI failed", idempotencyKey: "report", ...params },
      });
    return { h, child, actor, grant, report };
  }
  it.each(["read_handoff", "session_state", "wait_for"])(
    "acknowledges child events through %s, excluding sessions and tail",
    async (method) => {
      const { h, child, actor, report } = await setup();
      await report();
      h.orchestration.syncUnreadChildEvents();
      h.advance(300000);
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      await h.call("sessions");
      await h.service.call(actor, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "session_state",
        params: { id: child.id },
      });
      h.orchestration.childRead(h.actor, "foreign");
      await h.call("tail", { id: child.id });
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      await h.call(method, method === "wait_for" ? { ids: [child.id] } : { id: child.id });
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
      h.orchestration.disposeUnreadChildren();
    },
  );

  it.each([false, true])(
    "acknowledges existing events at wait entry (blocking=%s)",
    async (blocking) => {
      const { h, child, report } = await setup();
      await report();
      h.orchestration.syncUnreadChildEvents();
      h.advance(300000);
      const listed = (await h.call("sessions")) as { sessions: { id: string; revision: string }[] };
      const revision = listed.sessions.find((row) => row.id === child.id)?.revision;
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      await expect(h.call("wait_for", { ids: [child.id, "foreign"] })).rejects.toThrow("not_found");
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      const waiting = h.call("wait_for", {
        ids: [child.id],
        after: { [child.id]: revision },
        timeoutMs: 1000,
        ...(blocking ? { untilEvent: true } : {}),
      });
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
      h.exit(child.id);
      await expect(waiting).resolves.toMatchObject({ changed: [child.id], timedOut: false });
      h.advance(300000);
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
      h.orchestration.disposeUnreadChildren();
    },
  );

  it("observes the shared child-event stream and unsubscribes at disposal", async () => {
    const { h, child } = await setup();
    const row = h.rows.get(child.id);
    if (!row) throw new Error("Missing child");
    h.rows.set(child.id, {
      ...row,
      execution: { terminalId: child.id, launch: 1, revision: 1, turn: 1, phase: "idle" },
    });
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    h.advance(300000);
    expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
    h.orchestration.disposeUnreadChildren();
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
  });

  it("counts running children and unread reports, clearing only the latest read", async () => {
    const { h, child, report } = await setup();
    expect(h.orchestration.waitingOn("missing")).toBe(0);
    expect(h.orchestration.waitingOn("parent")).toBe(1);
    await report();
    h.exit(child.id);
    expect(h.orchestration.waitingOn("parent")).toBe(1);
    await h.call("read_handoff", { id: child.id });
    expect(h.orchestration.waitingOn("parent")).toBe(0);
  });
  it("keeps newer reports unread and permits a running child to hand off", async () => {
    const { h, child, report } = await setup();
    await report();
    await h.call("read_handoff", { id: child.id });
    expect(h.orchestration.waitingOn("parent")).toBe(0);
    h.advance(10000);
    await report({ idempotencyKey: "next" });
    await h.call("read_handoff", { id: child.id, seq: 1 });
    expect(h.orchestration.waitingOn("parent")).toBe(1);
    await h.call("read_handoff", { id: child.id });
    await h.call("read_handoff", { id: child.id, seq: 1 });
    expect(h.orchestration.waitingOn("parent")).toBe(0);
  });
  it.each(["exit", "takeover", "revoke", "parent-exit", "close"])(
    "clears waiting on the last child's %s",
    async (change) => {
      const { h, child } = await setup();
      expect(h.orchestration.waitingOn("parent")).toBe(1);
      if (change === "exit") h.exit(child.id);
      else if (change === "takeover") h.orchestration.takeOver(child.id);
      else if (change === "revoke") h.orchestration.revoke("parent");
      else if (change === "parent-exit") h.exit("parent");
      else h.orchestration.removed(child.id);
      expect(h.orchestration.waitingOn("parent")).toBe(0);
    },
  );
  it("lists reports only for children, reads only for parents, and wakes a metadata-only wait", async () => {
    const { h, child, actor, report } = await setup();
    expect(h.service.listed(actor)).toContain("handoff");
    expect(h.service.listed(actor)).not.toContain("read_handoff");
    expect(h.service.listed(h.actor)).toContain("read_handoff");
    expect(h.service.listed(h.actor)).not.toContain("handoff");
    const ordinary = h.service.prepare(repo, repo);
    ordinary.bind("ordinary");
    const plain = h.service.authenticate(ordinary.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(h.service.listed(plain)).not.toContain("handoff");
    await expect(
      h.service.call(plain, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "handoff",
        params: {},
      }),
    ).rejects.toThrow("no_parent");
    await expect(h.call("handoff", {})).rejects.toThrow("no_parent");
    await expect(h.call("read_handoff", { id: child.id })).rejects.toThrow("not_found");
    const state = (await h.call("session_state", { id: child.id })) as { revision: string };
    vi.useFakeTimers();
    try {
      const wait = h.call("wait_for", {
        ids: [child.id],
        after: { [child.id]: state.revision },
        timeoutMs: 1000,
      });
      const blocking = h.call("wait_for", { ids: [child.id], untilEvent: true });
      await report();
      await vi.advanceTimersByTimeAsync(250);
      expect(await blocking).toMatchObject({
        changed: [child.id],
        timedOut: false,
        sessions: [{ handoff: { seq: 1, status: "blocked" } }],
      });
      const result = await wait;
      expect(result).toMatchObject({
        changed: [child.id],
        timedOut: false,
        sessions: [{ handoff: { seq: 1, status: "blocked" } }],
      });
      expect(JSON.stringify(result)).not.toContain("CI failed");
    } finally {
      vi.useRealTimers();
    }
    expect(await h.call("read_handoff", { id: child.id })).toMatchObject({
      seq: 1,
      summary: "CI failed",
      untrusted: true,
    });
    expect(await h.call("read_handoff", { id: child.id, seq: 1 })).toMatchObject({ seq: 1 });
    await expect(h.call("read_handoff", { id: child.id, seq: 2 })).rejects.toThrow("not_found");
    await expect(h.call("read_handoff", { id: "foreign" })).rejects.toThrow("not_found");
    await expect(
      h.service.call(actor, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "read_handoff",
        params: { id: child.id },
      }),
    ).rejects.toThrow("forbidden");
  });
  it.each(["takeover", "revoke", "exit", "transfer"])("ends handoff access on %s", async (kind) => {
    const { h, child, actor, report } = await setup();
    await report();
    if (kind === "takeover") h.orchestration.takeOver(child.id);
    else if (kind === "exit") h.exit("parent");
    else {
      h.orchestration.revoke("parent");
      if (kind === "transfer") {
        const next = h.launchParent("replacement");
        await expect(next.call("read_handoff", { id: child.id })).rejects.toThrow("not_found");
      }
    }
    expect(h.service.listed(actor)).not.toContain("handoff");
    await expect(report()).rejects.toThrow("no_parent");
    await expect(h.call("read_handoff", { id: child.id })).rejects.toThrow();
    expect(h.orchestration.handoffs.latest(child.id)?.summary).toBe("CI failed");
  });
  it("restores access only after ownership is restored and deletes reports on close", async () => {
    const { h, child, report } = await setup();
    await report();
    h.orchestration.revoke("parent");
    const next = h.launchParent("parent");
    await expect(next.call("read_handoff", { id: child.id })).rejects.toThrow("not_found");
    const row = h.rows.get(child.id);
    if (!row) throw new Error("missing child");
    await h.orchestration.restoreChild("parent", row);
    expect(await next.call("read_handoff", { id: child.id })).toMatchObject({ seq: 1 });
    h.orchestration.removed(child.id);
    expect(h.orchestration.handoffs.latest(child.id)).toBeUndefined();
  });
});

describe("blocking child-event waits", () => {
  it("captures a baseline, ignores unrelated notifications and wakes on state and PR metadata", async () => {
    const h = harness();
    const { id } = await h.child("event");
    const off = vi.fn();
    const subscribe = h.orchestration.childEvents.subscribe.bind(h.orchestration.childEvents);
    vi.spyOn(h.orchestration.childEvents, "subscribe").mockImplementation((listener, deadline) => {
      const dispose = subscribe(listener, deadline);
      return () => {
        off();
        dispose();
      };
    });
    let settled = false;
    const wait = h.call("wait_for", { untilEvent: true }).then((result) => {
      settled = true;
      return result;
    });
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    expect(settled).toBe(false);
    const row = h.rows.get(id);
    if (!row) throw new Error("missing child");
    h.rows.set(id, { ...row, exited: true });
    h.orchestration.childEvents.publish();
    expect(await wait).toMatchObject({
      changed: [id],
      timedOut: false,
      sessions: [{ state: "exited" }],
    });
    expect(off).toHaveBeenCalledTimes(1);
    const next = h.call("wait_for", { ids: [id], untilEvent: true });
    h.host.forge.read.mockReturnValue({
      number: 549,
      headSha: "a".repeat(40),
      state: "OPEN",
      requiredChecks: "success",
    });
    h.orchestration.childEvents.publish();
    expect(await next).toMatchObject({
      changed: [id],
      timedOut: false,
      sessions: [{ pullRequest: { requiredChecks: "success" } }],
    });
  });

  it("ignores output-only revisions and resumes from the returned event cursor", async () => {
    const h = harness();
    const { id } = await h.child("event");
    const before = (await h.call("session_state", { id })) as { revision: string };
    let settled = false;
    const wait = h.call("wait_for", { ids: [id], untilEvent: true }).then((result) => {
      settled = true;
      return result as { sessions: { event: string }[] };
    });
    const row = h.rows.get(id);
    if (!row) throw new Error("missing child");
    h.rows.set(id, { ...row, outputRevision: (row.outputRevision ?? 0) + 1 });
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    await Promise.resolve();
    const after = (await h.call("session_state", { id })) as { revision: string };
    expect(after.revision).not.toBe(before.revision);
    expect(settled).toBe(false);
    const current = h.rows.get(id);
    if (!current) throw new Error("missing child");
    h.rows.set(id, { ...current, exited: true });
    h.orchestration.childEvents.publish();
    const result = await wait;
    expect(result).toMatchObject({ changed: [id], timedOut: false });
    const cursor = result.sessions[0]?.event;
    if (!cursor) throw new Error("missing event cursor");
    expect(
      await h.call("wait_for", {
        ids: [id],
        untilEvent: true,
        after: { [id]: cursor },
        timeoutMs: 5,
      }),
    ).toMatchObject({ changed: [], timedOut: true });
    const live = (await h.call("session_state", { id })) as { revision: string };
    expect(
      await h.call("wait_for", {
        ids: [id],
        untilEvent: true,
        after: { [id]: live.revision },
        timeoutMs: 5,
      }),
    ).toMatchObject({ changed: [], timedOut: true });
  });

  it("supports cursors, overall timeout and validates long-wait parameters", async () => {
    const h = harness();
    const { id } = await h.child("event");
    expect(
      await h.call("wait_for", { ids: [id], untilEvent: true, after: { [id]: "older" } }),
    ).toMatchObject({ changed: [id], timedOut: false });
    expect(await h.call("wait_for", { untilEvent: true, timeoutMs: 0 })).toMatchObject({
      changed: [],
      timedOut: true,
    });
    expect(await h.call("wait_for", { untilEvent: true, timeoutMs: 5 })).toMatchObject({
      changed: [],
      timedOut: true,
    });
    for (const params of [
      { untilEvent: false },
      { untilEvent: true, ids: null },
      { untilEvent: "true" },
      { untilEvent: true, timeoutMs: -1 },
      { untilEvent: true, timeoutMs: 2147483648 },
      { untilEvent: true, timeoutMs: "5" },
      { untilEvent: true, after: { foreign: "revision" } },
      { untilEvent: true, ids: ["parent"] },
    ])
      await expect(h.call("wait_for", params)).rejects.toThrow(
        params.ids ? "not_found" : "invalid_request",
      );
  });

  it.each(["revoke", "dispose", "role", "close", "takeover", "remove", "relaunch"])(
    "ends and unsubscribes on %s",
    async (action) => {
      const h = harness();
      const { id } = await h.child("event");
      const subscribe = h.orchestration.childEvents.subscribe.bind(h.orchestration.childEvents);
      const off = vi.fn();
      vi.spyOn(h.orchestration.childEvents, "subscribe").mockImplementation(
        (listener, deadline) => {
          const dispose = subscribe(listener, deadline);
          return () => {
            off();
            dispose();
          };
        },
      );
      const wait = h.call("wait_for", { untilEvent: true });
      const rejected = expect(wait).rejects.toThrow();
      if (action === "revoke") h.orchestration.revoke("parent");
      if (action === "dispose") h.grant.dispose();
      if (action === "role") h.service.setRole("parent", "agent");
      if (action === "close") h.service.close();
      if (action === "takeover") h.orchestration.takeOver(id);
      if (action === "remove") h.orchestration.removed(id);
      if (action === "relaunch") h.orchestration.relaunched(id);
      await rejected;
      expect(off).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "releases a disconnected wait (already aborted: %s)",
    async (alreadyAborted) => {
      const h = harness();
      await h.child("event");
      const signal = new AbortController();
      if (alreadyAborted) signal.abort();
      const wait = h.service.call(
        h.actor,
        {
          version: 1,
          instanceId: h.service.instanceId,
          method: "wait_for",
          params: { untilEvent: true },
        },
        signal.signal,
      );
      const rejected = expect(wait).rejects.toThrow("unavailable");
      signal.abort();
      await rejected;
    },
  );
});
