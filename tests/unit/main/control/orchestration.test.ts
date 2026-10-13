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
    terminals: () => [...rows.values()],
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
    stop: vi.fn((_id: string) => Promise.resolve()),
    tail: vi.fn((_id: string, _lines: number) => Promise.resolve(["ready"])),
    remove: vi.fn(
      (
        _repository: string,
        _worktree: string,
        _identity: string,
        confirm: (branch: string, changes: string) => Promise<boolean>,
      ) => confirm("feature", ""),
    ),
    dialog: vi.fn((_content: unknown, _signal: AbortSignal) => Promise.resolve(true)),
    changed: vi.fn(),
  } satisfies OrchestrationHost;
  const persist = vi.fn((_record: StoredOperation) => Promise.resolve());
  const operations = new Operations(persist, (actor) => {
    service.assertActive(actor);
  });
  const orchestration = new Orchestration(host, () => now);
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
    expect(service.capabilities(agent)).toEqual(["whoami", "sessions", "session_state"]);
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
        title: "Remove worktree?",
        subject: "feature",
        accept: "Remove worktree",
      }),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(h.host.dialog.mock.calls[0]?.[0])).toMatch(/branch is kept/u);
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
      accept: "Discard changes and remove",
      changes: " M file\0",
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
  expect(orchestration.restoreChild("parent", row)).toBe(true);
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
