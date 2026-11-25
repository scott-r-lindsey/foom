import { afterEach, expect, it, vi } from "vitest";
import { SessionOwner } from "../../../../src/main/workspace/session-owner";
import type { SessionOwnerDependencies } from "../../../../src/main/workspace/session-owner";
import type { StoredSession } from "../../../../src/main/workspace/session-restore.d";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";
import { Handoffs } from "../../../../src/main/control/handoffs";
import { homeDirectory } from "../../../../src/main/workspace/home-shell";

const row = (id: string, extra: Partial<StoredSession> = {}): StoredSession => ({
  id,
  agent: "claude",
  kind: "agent",
  repository: "/repo",
  worktree: `/repo/${id}`,
  branch: id,
  attention: "evaluator",
  state: null,
  exited: true,
  dormant: true,
  running: true,
  conversationId: `conversation-${id}`,
  ...extra,
});
const parent = (extra: Partial<StoredSession> = {}) =>
  row("parent", {
    orchestrator: { identity: "identity", worktreeIdentity: "identity", history: [] },
    ...extra,
  });
function fixture(entries: StoredSession[] = []) {
  const rows = new Map<string, WorkspaceTerminal>();
  const store = {
    load: vi.fn(() => Promise.resolve(entries)),
    save: vi.fn(async (_records: readonly StoredSession[]) => {}),
    flush: vi.fn(async () => {}),
  };
  const bind = vi.fn();
  const release = vi.fn();
  const orchestration = {
    identity: vi.fn<SessionOwnerDependencies["orchestration"]["identity"]>(),
    handoffs: new Handoffs(),
    view: vi.fn<SessionOwnerDependencies["orchestration"]["view"]>(),
    savedWorktrees: vi.fn<SessionOwnerDependencies["orchestration"]["savedWorktrees"]>(() => []),
    uncertainWorktrees: vi.fn(() => 0),
    exited: vi.fn(),
    reserve: vi.fn<SessionOwnerDependencies["orchestration"]["reserve"]>(() => ({
      bind,
      isCurrent: () => true,
      release,
    })),
    restoreChild: vi.fn<SessionOwnerDependencies["orchestration"]["restoreChild"]>(() =>
      Promise.resolve(true),
    ),
    restoreHistory: vi.fn(),
    restoreWorktrees: vi.fn(async () => {}),
  };
  const deps: SessionOwnerDependencies = {
    store,
    configRoot: "/config",
    orchestration,
    terminals: () => [...rows.values()],
    terminal: (id) => rows.get(id),
    restoreRow: (entry) => {
      rows.set(entry.id, entry);
    },
    failed: vi.fn(),
    busy: vi.fn(),
    closed: vi.fn(() => false),
    identity: vi.fn(() => Promise.resolve("identity")),
    agents: vi.fn(() =>
      Promise.resolve([
        {
          id: "claude",
          path: "/fixture/claude",
          version: "fixture",
          hooks: false,
          mcp: true,
          restoreControl: true,
          reason: "ok",
        },
      ]),
    ),
    launch: vi.fn<SessionOwnerDependencies["launch"]>((entry) => {
      const replacement = { ...entry, dormant: false, exited: false };
      delete replacement.parentId;
      delete replacement.orchestrator;
      rows.set(entry.id, replacement);
      return Promise.resolve(entry.id);
    }),
    onChange: vi.fn(),
  };
  const owner = new SessionOwner(deps);
  return { owner, deps, rows, store, orchestration, bind, release };
}
afterEach(() => {
  vi.restoreAllMocks();
});

it("loads only matching home/config rows and strips stored authority from the live inventory", async () => {
  const home = row("home", {
    home: true,
    agent: "shell",
    kind: "shell",
    repository: homeDirectory,
    worktree: homeDirectory,
  });
  const config = row("config", { config: true, repository: "/config", worktree: "/config" });
  const f = fixture([
    parent(),
    row("child", { parentId: "parent" }),
    home,
    config,
    { ...home, id: "wrong-kind", kind: "agent" },
    { ...home, id: "wrong-home", worktree: "/elsewhere" },
    { ...home, id: "wrong-home-repo", repository: "/elsewhere" },
    { ...config, id: "wrong-config", worktree: "/elsewhere" },
    { ...config, id: "wrong-config-repo", repository: "/elsewhere" },
  ]);
  await f.owner.restore();
  expect([...f.rows.keys()]).toEqual(["parent", "child", "home", "config"]);
  expect(f.rows.get("parent")).not.toHaveProperty("orchestrator");
  expect(f.rows.get("child")).not.toHaveProperty("parentId");
  expect(f.rows.get("home")).not.toHaveProperty("running");
  expect(f.rows.get("parent")).not.toHaveProperty("handoffs");
  await f.owner.restartSaved();
  expect(f.deps.launch).toHaveBeenCalledWith(home);
  expect(f.deps.launch).toHaveBeenCalledWith(config);
});

it("restores and saves handoff history independently of restart eligibility", async () => {
  const handoff = {
    seq: 1,
    status: "blocked" as const,
    summary: "Waiting for review",
    links: [],
    timestamp: "2026-10-17T00:00:00.000Z",
  };
  const f = fixture([row("child", { running: false, handoffs: [handoff] })]);
  await f.owner.restore();
  await f.owner.restartSaved();
  expect(f.orchestration.handoffs.entries("child")).toEqual([handoff]);
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0]).toMatchObject([
    { id: "child", running: false, handoffs: [handoff] },
  ]);
  expect(f.rows.get("child")).not.toHaveProperty("handoffs");
});

it("supports an absent store and does not swallow load or explicit save/flush failures", async () => {
  const f = fixture();
  delete f.deps.store;
  delete f.deps.onChange;
  await f.owner.restore();
  await f.owner.restartSaved();
  f.owner.persist();
  await f.owner.save();
  await f.owner.flush();
  await f.owner.prepareQuit();
  f.owner.cancelQuit();
  f.deps.store = f.store;
  f.store.load.mockRejectedValueOnce(new Error("load"));
  await expect(f.owner.restore()).rejects.toThrow("load");
  f.store.save.mockRejectedValueOnce(new Error("save"));
  await expect(f.owner.save()).rejects.toThrow("save");
  f.store.flush.mockRejectedValueOnce(new Error("flush"));
  await expect(f.owner.flush()).rejects.toThrow("flush");
});

it("persists current provenance only for active parents with identity and children without takeover", async () => {
  const f = fixture();
  f.rows.set("parent", row("parent", { exited: false }));
  f.rows.set("child", row("child"));
  f.orchestration.view.mockImplementation((id) =>
    id === "parent"
      ? { role: "orchestrator", active: true, children: 1, history: [] }
      : { role: "child", parentId: "parent", takenOver: false },
  );
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0][0]).not.toHaveProperty("orchestrator");
  f.orchestration.identity.mockReturnValue({ repository: "identity", worktree: "identity" });
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0]).toMatchObject([
    {
      id: "parent",
      running: true,
      orchestrator: { identity: "identity", history: [], worktrees: [], uncertain: 0 },
    },
    { id: "child", running: false, parentId: "parent" },
  ]);
  f.orchestration.view.mockImplementation((id) =>
    id === "parent"
      ? { role: "orchestrator", active: false, children: 0, history: [] }
      : { role: "child", parentId: "parent", takenOver: true },
  );
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0][0]).not.toHaveProperty("orchestrator");
  expect(f.store.save.mock.lastCall?.[0][1]).not.toHaveProperty("parentId");
});

it("marks every planned session busy before launching and preserves saved child provenance until launch settles", async () => {
  const child = row("child", { parentId: "parent" });
  const exited = row("exited", { parentId: "parent", running: false });
  const f = fixture([child, parent(), exited]);
  const gate = Promise.withResolvers<string>();
  vi.mocked(f.deps.launch).mockImplementationOnce(() => gate.promise);
  await f.owner.restore();
  const work = f.owner.restartSaved();
  expect(f.owner.restartSaved()).toBe(work);
  expect(f.owner.isRestoring("parent")).toBe(true);
  expect(f.owner.roleNotRestored("parent")).toBe(false);
  expect(f.owner.isRestoring("child")).toBe(true);
  expect(f.owner.isRestoring("exited")).toBe(false);
  expect(f.deps.busy).toHaveBeenCalledWith("parent", true);
  expect(f.deps.busy).toHaveBeenCalledWith("child", true);
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0]).toMatchObject([
    { id: "child", running: true, parentId: "parent" },
    { id: "parent", running: true, orchestrator: { identity: "identity" } },
    { id: "exited", running: false },
  ]);
  gate.resolve("parent");
  await work;
  expect(f.bind).toHaveBeenCalledWith("parent");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.orchestration.restoreChild).toHaveBeenCalledWith(
    "parent",
    { ...child, exited: false },
    expect.any(Function),
  );
  expect(f.orchestration.restoreChild).toHaveBeenCalledWith(
    "parent",
    { ...exited, exited: true },
    expect.any(Function),
  );
  expect(f.deps.launch).toHaveBeenLastCalledWith(child, { parentId: "parent" }, undefined);
  expect(f.owner.isRestoring("child")).toBe(false);
  expect(f.owner.roleNotRestored("parent")).toBe(false);
  expect(f.deps.busy).toHaveBeenCalledWith("parent", false);
});

it.each(["disabled", "closed", "removed", "claimed"] as const)(
  "skips queued launches when %s and releases markers",
  async (mode) => {
    const f = fixture([row("one"), row("two")]);
    // Both use one checkout, so the second waits for the first.
    const second = row("two", { worktree: "/repo/one" });
    f.store.load.mockResolvedValue([row("one"), second]);
    const gate = Promise.withResolvers<string>();
    vi.mocked(f.deps.launch).mockImplementationOnce(() => gate.promise);
    await f.owner.restore();
    const work = f.owner.restartSaved();
    await vi.waitFor(() => {
      expect(f.deps.launch).toHaveBeenCalledOnce();
    });
    if (mode === "disabled") f.owner.configure(false);
    if (mode === "closed") vi.mocked(f.deps.closed).mockReturnValue(true);
    if (mode === "removed") f.rows.delete("two");
    if (mode === "claimed") f.owner.claim("two");
    gate.resolve("one");
    await work;
    expect(f.deps.launch).toHaveBeenCalledOnce();
    expect(f.owner.isRestoring("two")).toBe(false);
    expect(f.deps.busy).toHaveBeenCalledWith("two", false);
  },
);

it("keeps disabled rows dormant for manual resume", async () => {
  const f = fixture([parent()]);
  f.owner.configure(false);
  await f.owner.restore();
  await f.owner.restartSaved();
  expect(f.deps.launch).not.toHaveBeenCalled();
  expect(f.rows.get("parent")?.dormant).toBe(true);
});

it.each(["identity", "agent", "existing", "launch", "no-id", "worktrees", "child"] as const)(
  "retains retryable rows and releases reservations after %s restoration failure",
  async (failure) => {
    const f = fixture([parent(), row("child", { parentId: "parent" })]);
    if (failure === "identity") vi.mocked(f.deps.identity).mockRejectedValue(new Error("missing"));
    if (failure === "agent") vi.mocked(f.deps.agents).mockResolvedValue([]);
    if (failure === "existing") f.orchestration.reserve.mockReturnValue({ existing: "other" });
    if (failure === "launch") vi.mocked(f.deps.launch).mockRejectedValueOnce(new Error("spawn"));
    if (failure === "no-id") vi.mocked(f.deps.launch).mockResolvedValueOnce(undefined);
    if (failure === "worktrees")
      f.orchestration.restoreWorktrees.mockRejectedValueOnce(new Error("inventory"));
    if (failure === "child") f.orchestration.restoreChild.mockResolvedValue(false);
    await f.owner.restore();
    await f.owner.restartSaved();
    expect(f.owner.isRestoring("parent")).toBe(false);
    expect(f.owner.roleNotRestored("parent")).toBe(failure !== "child");
    expect(f.release).toHaveBeenCalledTimes(
      ["identity", "agent", "existing"].includes(failure) ? 0 : 1,
    );
    if (failure === "launch" || failure === "worktrees")
      expect(f.deps.failed).toHaveBeenCalledWith("parent", expect.any(Error));
    if (failure === "child")
      expect(f.deps.launch).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "child" }),
        undefined,
        undefined,
      );
    expect(f.rows.has("parent")).toBe(true);
  },
);

it("waits for restoration before freezing writes and resumes persistence on cancelled quit", async () => {
  const f = fixture([row("one")]);
  const gate = Promise.withResolvers<string>();
  vi.mocked(f.deps.launch).mockImplementationOnce(async () => {
    await gate.promise;
    f.rows.set("one", row("one", { dormant: false, exited: false }));
    return "one";
  });
  await f.owner.restore();
  const work = f.owner.restartSaved();
  const quit = f.owner.prepareQuit();
  expect(f.store.flush).not.toHaveBeenCalled();
  gate.resolve("one");
  await work;
  await quit;
  expect(f.store.save.mock.lastCall?.[0]).toMatchObject([{ id: "one", running: true }]);
  expect(f.store.flush).toHaveBeenCalledOnce();
  const count = f.store.save.mock.calls.length;
  f.rows.set("one", row("one", { exited: true }));
  f.owner.persist();
  expect(f.store.save).toHaveBeenCalledTimes(count);
  f.owner.cancelQuit();
  expect(f.store.save).toHaveBeenCalledTimes(count + 1);
  expect(f.store.save.mock.lastCall?.[0]).toMatchObject([{ id: "one", running: false }]);
});

it.each(["save", "flush"] as const)(
  "unfreezes on quit %s failure and reports background save failures",
  async (method) => {
    const f = fixture();
    f.store[method].mockRejectedValueOnce(new Error("disk"));
    await expect(f.owner.prepareQuit()).rejects.toThrow("disk");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.store.save.mockRejectedValueOnce(new Error("background"));
    f.owner.persist();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith("Unable to save sessions:", expect.any(Error));
    });
  },
);

it("marks only eligible running rows before inventory, and clears the reservation on failure", async () => {
  const legacy = row("legacy");
  delete legacy.running;
  const f = fixture([row("running"), row("exited", { running: false }), legacy]);
  await f.owner.restore();
  expect(f.owner.isRestoring("running")).toBe(true);
  expect(f.owner.isRestoring("exited")).toBe(false);
  expect(f.owner.isRestoring("legacy")).toBe(false);
  vi.mocked(f.deps.launch).mockRejectedValueOnce(new Error("fixture failure"));
  await f.owner.restartSaved();
  expect(f.owner.isRestoring("running")).toBe(false);
  expect(f.deps.failed).toHaveBeenCalledWith("running", expect.any(Error));
  expect(f.rows.get("running")?.dormant).toBe(true);
});

it("deduplicates discovered sessions against saved records without restoring grants or exposing the discovery marker", async () => {
  const saved = row("saved");
  const f = fixture([saved]);
  const restored = vi.spyOn(f.deps, "restoreRow");
  f.deps.discover = () =>
    Promise.resolve([
      row("saved", { recovered: true }),
      row("new", { recovered: true }),
      row("new", { recovered: true }),
    ]);
  await f.owner.restore();
  expect([...f.rows.keys()]).toEqual(["saved"]);
  await f.owner.restartSaved();
  expect([...f.rows.keys()]).toEqual(["saved", "new"]);
  expect(restored.mock.lastCall?.[0]).not.toHaveProperty("recovered");
  expect(f.deps.launch).toHaveBeenCalledTimes(2);
  expect(f.deps.launch).toHaveBeenCalledWith(
    expect.objectContaining({ id: "new", recovered: true }),
    undefined,
    undefined,
  );
  expect(f.orchestration.reserve).not.toHaveBeenCalled();
});

it("keeps checkout locators private while preserving them for exited remote rows and prunes removed sessions", async () => {
  const remoteCheckout = {
    repository: "/remote/repo",
    path: "/remote/.foom-worktree-topic",
    branch: "topic",
    identity: "a".repeat(64),
  };
  const remote = row("remote", {
    remote: true,
    running: false,
    placement: { kind: "remote", host: "worker" },
    remoteCheckout,
  });
  const f = fixture([remote]);
  const remember = vi.fn();
  f.deps.rememberRemote = remember;
  await f.owner.restore();
  expect(remember).toHaveBeenCalledWith(remote);
  expect(f.rows.get("remote")).not.toHaveProperty("remoteCheckout");
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0][0]).toMatchObject({ remoteCheckout, running: false });
  f.owner.rememberRemote("remote", { ...remoteCheckout, branch: "updated" });
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0][0]?.remoteCheckout?.branch).toBe("updated");
  f.rows.delete("remote");
  await f.owner.save();
  f.rows.set("remote", row("remote"));
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0][0]).not.toHaveProperty("remoteCheckout");
});

it("recovers daemon-live rows saved as exited as human sessions without inheriting stale grants", async () => {
  const placement = { kind: "remote", host: "worker" } as const;
  const saved = row("remote", { remote: true, placement, running: false, parentId: "old-parent" });
  const f = fixture([saved]);
  const recovered = row("remote", { remote: true, placement, recovered: true });
  f.deps.discover = () => Promise.resolve([recovered]);
  await f.owner.restore();
  await f.owner.restartSaved();
  expect(f.deps.launch).toHaveBeenCalledWith(recovered, undefined, undefined);
  expect(f.orchestration.restoreChild).not.toHaveBeenCalled();
});

it.each(["/home/fixture", "/home/fixture/foom"])(
  "remote machine restoration preserves the recorded directory %s",
  async (directory) => {
    const machine = row("machine", {
      home: true,
      machine: true,
      remote: true,
      placement: { kind: "remote", host: "fixture" },
      repository: directory,
      worktree: directory,
      branch: null,
    });
    const local = { ...machine, id: "local" };
    delete local.remote;
    const f = fixture([
      machine,
      local,
      { ...machine, id: "local-placement", placement: { kind: "local" } },
      { ...machine, id: "ordinary-home", machine: false },
    ]);
    await f.owner.restore();
    expect([...f.rows.keys()]).toEqual(["machine"]);
    await f.owner.restartSaved();
    expect(f.deps.launch).toHaveBeenCalledWith(machine);
  },
);

it("does not infer a linked parent's checkout identity from legacy repository-only provenance", async () => {
  const f = fixture([row("parent", { orchestrator: { identity: "identity", history: [] } })]);
  await f.owner.restore();
  await f.owner.restartSaved();
  expect(f.deps.launch).toHaveBeenCalledWith(
    expect.objectContaining({ id: "parent" }),
    undefined,
    undefined,
  );
  expect(f.orchestration.reserve).not.toHaveBeenCalled();
  expect(f.owner.roleNotRestored("parent")).toBe(true);
});

it("repairs stale host rows on load before restoring authority and retains cleanup recovery", async () => {
  const remote = { remote: true as const, placement: { kind: "remote" as const, host: "gone" } };
  const owned = { path: "/repo/owned", identity: "tree", state: "used" as const };
  const f = fixture([
    parent({ ...remote }),
    row("orphan", { parentId: "parent", running: false }),
    row("stale-child", { ...remote, parentId: "local-parent" }),
    row("local-parent", { orchestrator: { identity: "local", history: [], worktrees: [owned] } }),
    row("cleanup", { ...remote, closeState: "closing" }),
    row("other", { remote: true, placement: { kind: "remote", host: "kept" } }),
  ]);
  f.deps.registeredHost = (host) => host === "kept";
  await f.owner.restore();
  expect([...f.rows.keys()]).toEqual(["orphan", "local-parent", "cleanup", "other"]);
  const repaired = f.store.save.mock.lastCall?.[0];
  expect(repaired?.map((entry) => entry.id)).toEqual([...f.rows.keys()]);
  expect(repaired?.find((entry) => entry.id === "orphan")).not.toHaveProperty("parentId");
  expect(repaired?.find((entry) => entry.id === "local-parent")?.orchestrator?.worktrees).toEqual([
    owned,
  ]);
  expect(f.rows.get("cleanup")?.closeState).toBe("failed");
  expect(f.orchestration.handoffs.entries("parent")).toEqual([]);
  await f.owner.restartSaved();
  expect(f.deps.launch).not.toHaveBeenCalledWith(
    expect.objectContaining({ id: "parent" }),
    expect.anything(),
    expect.anything(),
  );
});

it("removes forgotten dormant/exited rows, keeps live connections until exit and never saves them", async () => {
  const remote = { remote: true as const, placement: { kind: "remote" as const, host: "worker" } };
  const f = fixture([row("dormant", remote)]);
  let registered = true;
  f.deps.registeredHost = () => registered;
  const removed: string[] = [];
  f.deps.removeRow = (id) => {
    removed.push(id);
    f.rows.delete(id);
    // The workspace's ordinary removal path persists recursively.
    f.owner.persist();
  };
  f.owner.configure(false);
  await f.owner.restore();
  f.rows.set("exited", row("exited", { ...remote, dormant: false }));
  f.rows.set("live", row("live", { ...remote, exited: false, dormant: false }));
  f.rows.set("cleanup", row("cleanup", { ...remote, closeState: "failed" }));
  f.rows.set("local", row("local"));
  f.owner.rememberRemote("live", {
    repository: "/remote/repo",
    path: "/remote/tree",
    branch: "topic",
    identity: "a".repeat(64),
  });
  registered = false;
  await f.owner.pruneHosts("worker");
  expect(removed).toEqual(["dormant", "exited"]);
  expect([...f.rows.keys()]).toEqual(["live", "cleanup", "local"]);
  expect(f.store.save.mock.lastCall?.[0].map((entry) => entry.id)).toEqual(["cleanup", "local"]);
  // Re-enrollment cannot resurrect persistence for a tile already forgotten.
  registered = true;
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0].map((entry) => entry.id)).toEqual(["cleanup", "local"]);
  f.rows.set("live", row("live", { ...remote, exited: true, dormant: false }));
  f.owner.persist();
  expect(removed).toEqual(["dormant", "exited", "live"]);
  await f.owner.restartSaved();
  expect(f.deps.launch).not.toHaveBeenCalled();
});

it("filters late discovery for forgotten hosts and propagates repair write failures", async () => {
  const stale = row("stale", { remote: true, placement: { kind: "remote", host: "gone" } });
  const f = fixture([stale]);
  f.deps.registeredHost = () => false;
  f.store.save.mockRejectedValueOnce(new Error("repair failed"));
  await expect(f.owner.restore()).rejects.toThrow("repair failed");
  expect(f.rows.size).toBe(0);
  f.store.load.mockResolvedValue([]);
  f.deps.discover = () => Promise.resolve([stale]);
  await f.owner.restore();
  await f.owner.restartSaved();
  expect(f.rows.size).toBe(0);
  expect(f.deps.launch).not.toHaveBeenCalled();
});

it("keeps never-registered developer sessions in runtime inventory until their own Close", async () => {
  const f = fixture();
  f.deps.registeredHost = () => false;
  f.deps.removeRow = (id) => {
    f.rows.delete(id);
  };
  f.rows.set(
    "spike",
    row("spike", { remote: true, placement: { kind: "remote", host: "developer" } }),
  );
  f.owner.persist();
  expect(f.rows.has("spike")).toBe(true);
  await f.owner.pruneHosts("different-host");
  expect(f.rows.has("spike")).toBe(true);
  expect(f.store.save.mock.lastCall?.[0]).toEqual([]);
  await f.owner.pruneHosts("developer");
  expect(f.rows.has("spike")).toBe(false);
});

it("forgets locally after a durable write, rejects late discovery and permits human recovery on restart", async () => {
  const remote = row("remote", { remote: true, placement: { kind: "remote", host: "worker" } });
  const f = fixture([remote]);
  f.deps.discover = () => Promise.resolve([remote]);
  f.deps.removeRow = (id) => {
    f.rows.delete(id);
  };
  f.owner.configure(false);
  await f.owner.restore();
  f.store.save.mockRejectedValueOnce(new Error("disk full"));
  await expect(f.owner.forget(remote.id)).rejects.toThrow("disk full");
  expect(f.rows.has(remote.id)).toBe(true);
  await f.owner.forget(remote.id);
  await f.owner.restartSaved();
  expect(f.rows.size).toBe(0);
  expect(f.deps.launch).not.toHaveBeenCalled();
  expect(f.store.save).toHaveBeenLastCalledWith([]);
  const recovered = fixture();
  recovered.deps.discover = () => Promise.resolve([{ ...remote, recovered: true }]);
  await recovered.owner.restore();
  await recovered.owner.restartSaved();
  expect(recovered.deps.launch).toHaveBeenCalledWith(
    expect.objectContaining({ id: remote.id }),
    undefined,
    undefined,
  );
  expect(recovered.orchestration.restoreChild).not.toHaveBeenCalled();
  expect(recovered.orchestration.reserve).not.toHaveBeenCalled();
});

it("background saves during Forget cannot resurrect its row or surviving children's parent links", async () => {
  const remote = row("remote", {
    remote: true,
    placement: { kind: "remote", host: "worker" },
    closeState: "failed",
  });
  const f = fixture([remote, row("child")]);
  f.deps.removeRow = (id) => {
    f.rows.delete(id);
    f.owner.persist();
  };
  f.orchestration.view.mockImplementation((id) =>
    id === "child" ? { role: "child", parentId: "remote", takenOver: false } : undefined,
  );
  await f.owner.restore();
  const pending = Promise.withResolvers<undefined>();
  f.store.save.mockReturnValueOnce(pending.promise);
  const forget = f.owner.forget("remote");
  expect(f.rows.has("remote")).toBe(true);
  f.owner.persist();
  expect(f.store.save.mock.lastCall?.[0]).toEqual([expect.objectContaining({ id: "child" })]);
  expect(f.store.save.mock.lastCall?.[0][0]).not.toHaveProperty("parentId");
  pending.resolve(undefined);
  await forget;
  expect(f.rows.has("remote")).toBe(false);
  await f.owner.prepareQuit();
  expect(f.store.save.mock.lastCall?.[0]).toEqual([expect.objectContaining({ id: "child" })]);
  expect(f.store.save.mock.lastCall?.[0][0]).not.toHaveProperty("parentId");
});

it.each(["during-save", "after-save"])(
  "suppresses daemon discovery %s when a dormant session is forgotten",
  async (ordering) => {
    const remote = row("remote", {
      running: false,
      remote: true,
      placement: { kind: "remote", host: "worker" },
    });
    const f = fixture([remote]);
    const discovery = Promise.withResolvers<readonly StoredSession[]>();
    f.deps.discover = () => discovery.promise;
    f.deps.removeRow = (id) => {
      f.rows.delete(id);
    };
    await f.owner.restore();
    const restoring = f.owner.restartSaved();
    expect(f.owner.isRestoring(remote.id)).toBe(false);
    const write = Promise.withResolvers<undefined>();
    f.store.save.mockReturnValueOnce(write.promise);
    const forgetting = f.owner.forget(remote.id);
    if (ordering === "after-save") {
      write.resolve(undefined);
      await forgetting;
    }
    discovery.resolve([{ ...remote, running: true, recovered: true }]);
    await restoring;
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.owner.isRestoring(remote.id)).toBe(false);
    if (ordering === "during-save") {
      expect(f.rows.get(remote.id)).toMatchObject({ dormant: true, exited: true });
      write.resolve(undefined);
      await forgetting;
    }
    expect(f.rows.has(remote.id)).toBe(false);
    expect(f.store.save).toHaveBeenLastCalledWith([]);
  },
);

it("refuses Forget while an earlier reattach is pending and keeps its eventual live row", async () => {
  const remote = row("remote", { remote: true, placement: { kind: "remote", host: "worker" } });
  const f = fixture([remote]);
  const attaching = Promise.withResolvers<undefined>();
  const attached = Promise.withResolvers<undefined>();
  f.deps.launch = vi.fn<SessionOwnerDependencies["launch"]>(async (entry) => {
    attaching.resolve(undefined);
    await attached.promise;
    f.rows.set(entry.id, { ...entry, dormant: false, exited: false });
    return entry.id;
  });
  f.deps.removeRow = (id) => {
    f.rows.delete(id);
  };
  await f.owner.restore();
  const restoring = f.owner.restartSaved();
  await attaching.promise;
  try {
    await expect(f.owner.forget(remote.id)).rejects.toThrow("session-busy");
    expect(f.store.save).not.toHaveBeenCalled();
  } finally {
    attached.resolve(undefined);
    await restoring;
  }
  expect(f.rows.get(remote.id)).toMatchObject({ dormant: false, exited: false });
  expect(f.store.save).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: remote.id, running: true }),
  ]);
});

it("aborts Forget and repairs its saved record when the dormant row becomes live during the write", async () => {
  const remote = row("remote", {
    running: false,
    remote: true,
    placement: { kind: "remote", host: "worker" },
  });
  const f = fixture([remote]);
  f.deps.removeRow = (id) => {
    f.rows.delete(id);
  };
  await f.owner.restore();
  const write = Promise.withResolvers<undefined>();
  f.store.save.mockReturnValueOnce(write.promise);
  const forgetting = f.owner.forget(remote.id);
  const current = f.rows.get(remote.id);
  if (!current) throw new Error("Missing row");
  current.dormant = false;
  current.exited = false;
  write.resolve(undefined);
  await expect(forgetting).rejects.toThrow("session-busy");
  expect(f.rows.get(remote.id)).toBe(current);
  expect(f.store.save).toHaveBeenLastCalledWith([
    expect.objectContaining({ id: remote.id, running: true }),
  ]);
});

it("restores private review leases before rows and persists them without exposing the baseline", async () => {
  const baseline = {
    authorId: "author",
    identity: "id",
    head: "a".repeat(40),
    digest: "b".repeat(64),
  };
  const h = fixture([row("reviewer", { sharedReview: baseline })]);
  const restore = vi.fn();
  h.deps.restoreSharedReview = restore;
  h.deps.sharedReview = (id) => (id === "reviewer" ? baseline : undefined);
  await h.owner.restore();
  expect(restore).toHaveBeenCalledWith(expect.objectContaining({ sharedReview: baseline }));
  expect(h.rows.get("reviewer")).not.toHaveProperty("sharedReview");
  await h.owner.save();
  expect(h.store.save).toHaveBeenLastCalledWith([
    expect.objectContaining({ sharedReview: baseline }),
  ]);
  await h.owner.restartSaved();
  expect(h.deps.launch).not.toHaveBeenCalled();
});

it("keeps unverified parent links private for running and dormant children until the original grant ends", async () => {
  const child = row("child", { parentId: "parent" });
  const dormant = row("dormant", { parentId: "parent", running: false });
  const refused = row("refused", { parentId: "parent" });
  const f = fixture([parent(), child, dormant, refused]);
  let parentActive = true;
  f.orchestration.restoreChild.mockImplementation((_parent, entry) =>
    Promise.resolve(entry.id === "refused" ? false : { parentStillActive: () => parentActive }),
  );
  await f.owner.restore();
  await f.owner.restartSaved();
  expect(f.deps.launch).toHaveBeenCalledWith(child, undefined, undefined);
  expect(
    f.orchestration.restoreChild.mock.calls.filter(([, entry]) => entry.id === child.id),
  ).toHaveLength(1);
  const persistedParent = (id: string) =>
    f.store.save.mock.lastCall?.[0].find((entry) => entry.id === id)?.parentId;
  expect(persistedParent(child.id)).toBe("parent");
  expect(persistedParent(dormant.id)).toBe("parent");
  expect(persistedParent(refused.id)).toBeUndefined();
  expect(f.rows.get(child.id)).not.toHaveProperty("parentId");
  expect(f.rows.get(dormant.id)).not.toHaveProperty("parentId");

  f.owner.claim(child.id);
  await f.owner.save();
  expect(persistedParent(child.id)).toBeUndefined();
  expect(persistedParent(dormant.id)).toBe("parent");
  parentActive = false;
  await f.owner.save();
  expect(persistedParent(dormant.id)).toBeUndefined();
});

it.each([true, false])(
  "suppresses claimed rows before stale discovery for saved running=%s",
  async (running) => {
    const previous = row("remote", {
      running,
      remote: true,
      placement: { kind: "remote", host: "worker" },
    });
    const closed = { ...previous, id: "closed" };
    const f = fixture([previous, closed]);
    const discovery = Promise.withResolvers<readonly StoredSession[]>();
    f.deps.discover = () => discovery.promise;
    await f.owner.restore();
    const restart = f.owner.restartSaved();
    f.owner.claim(previous.id);
    const current = f.rows.get(previous.id);
    expect(f.owner.isRestoring(previous.id)).toBe(false);
    await f.owner.save();
    expect(f.store.save.mock.lastCall?.[0].find((entry) => entry.id === previous.id)?.running).toBe(
      false,
    );
    f.owner.claim(closed.id);
    f.rows.delete(closed.id);
    discovery.resolve(
      [previous, closed].map((entry) => ({ ...entry, running: true, recovered: true })),
    );
    await restart;
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.deps.busy).not.toHaveBeenCalled();
    expect(f.rows.get(previous.id)).toBe(current);
    expect(f.rows.has(closed.id)).toBe(false);
  },
);

it("requires the parent's original startup grant before checking saved children", async () => {
  const child = row("child", { parentId: "parent" });
  const f = fixture([parent(), child]);
  const discovery = Promise.withResolvers<readonly StoredSession[]>();
  f.deps.discover = () => discovery.promise;
  await f.owner.restore();
  const restoring = f.owner.restartSaved();
  f.owner.claim("parent");
  // An ordinary manual invocation can later become an orchestrator at the
  // same terminal ID. The old child link conveys no authority to its grant.
  f.orchestration.view.mockImplementation((id) =>
    id === "parent" ? { role: "orchestrator", active: true, children: 0, history: [] } : undefined,
  );
  f.orchestration.identity.mockReturnValue({ repository: "identity", worktree: "identity" });
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0].find((entry) => entry.id === child.id)).not.toHaveProperty(
    "parentId",
  );
  discovery.resolve([]);
  await restoring;
  expect(f.orchestration.restoreChild).not.toHaveBeenCalled();
  expect(f.deps.launch).toHaveBeenCalledExactlyOnceWith(child, undefined, undefined);
  expect(f.store.save.mock.lastCall?.[0].find((entry) => entry.id === child.id)).not.toHaveProperty(
    "parentId",
  );
});

it.each([false, true])(
  "releases only the parent's dependents when its manual launch settles (started=%s)",
  async (started) => {
    const child = row("child", { parentId: "parent" });
    const f = fixture([parent(), child]);
    const discovery = Promise.withResolvers<readonly StoredSession[]>();
    f.deps.discover = () => discovery.promise;
    await f.owner.restore();
    const settle = f.owner.reserveManualLaunch("parent");
    const starting = f.owner.restartSaved();
    discovery.resolve([]);
    await starting;
    await f.owner.save();
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.store.save.mock.lastCall?.[0][0]?.orchestrator).toBeDefined();
    expect(f.store.save.mock.lastCall?.[0][1]?.parentId).toBe("parent");

    if (started) {
      const manual = row("parent", { exited: false, dormant: false });
      f.rows.set(manual.id, manual);
      // The launch path persists the new invocation before returning its ID.
      await f.owner.save();
      expect(f.store.save.mock.lastCall?.[0][0]).not.toHaveProperty("orchestrator");
      expect(f.store.save.mock.lastCall?.[0][1]).not.toHaveProperty("parentId");
    }
    settle(started);
    await vi.waitFor(() => {
      expect(
        vi.mocked(f.deps.launch).mock.calls.map(([entry, control]) => [entry.id, control]),
      ).toEqual(
        started
          ? [["child", undefined]]
          : [
              ["parent", { role: "orchestrator" }],
              ["child", { parentId: "parent" }],
            ],
      );
    });
  },
);

it("delays daemon reconciliation for an exited row until a manual claim is released", async () => {
  const remote = row("remote", {
    running: false,
    remote: true,
    placement: { kind: "remote", host: "worker" },
  });
  const f = fixture([remote]);
  f.deps.discover = () => Promise.resolve([{ ...remote, running: true, recovered: true }]);
  await f.owner.restore();
  const settle = f.owner.reserveManualLaunch(remote.id);
  const starting = f.owner.restartSaved();
  await starting;
  expect(f.deps.launch).not.toHaveBeenCalled();
  settle(false);
  await vi.waitFor(() => {
    expect(f.deps.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: remote.id, recovered: true }),
      undefined,
      undefined,
    );
  });
});

it("restores unrelated rows and freezes saved provenance while a parent's manual confirmation stays open", async () => {
  const savedParent = parent();
  const child = row("child", { parentId: savedParent.id });
  const dormant = row("dormant", { parentId: savedParent.id, running: false });
  const peer = row("same-checkout", { worktree: savedParent.worktree });
  const unrelated = row("unrelated");
  const f = fixture([savedParent, child, dormant, peer, unrelated]);
  const discovery = Promise.withResolvers<readonly StoredSession[]>();
  f.deps.discover = () => discovery.promise;
  await f.owner.restore();
  const settle = f.owner.reserveManualLaunch(savedParent.id);
  const starting = f.owner.restartSaved();
  discovery.resolve([]);

  await vi.waitFor(() => {
    expect(f.deps.launch).toHaveBeenCalledExactlyOnceWith(unrelated, undefined, undefined);
  });
  await f.owner.prepareQuit();
  expect(f.orchestration.restoreChild).not.toHaveBeenCalled();
  expect(f.store.flush).toHaveBeenCalledOnce();
  expect(f.store.save.mock.lastCall?.[0]).toMatchObject([
    { id: savedParent.id, running: true, orchestrator: savedParent.orchestrator },
    { id: child.id, running: true, parentId: savedParent.id },
    { id: dormant.id, running: false, parentId: savedParent.id },
    { id: peer.id, running: true },
    { id: unrelated.id, running: true },
  ]);
  settle(false);
  await starting;
  expect(f.deps.launch).toHaveBeenCalledOnce();

  f.owner.cancelQuit();
  await vi.waitFor(() => {
    expect(f.deps.launch).toHaveBeenCalledWith(
      savedParent,
      { role: "orchestrator" },
      expect.anything(),
    );
    expect(f.deps.launch).toHaveBeenCalledWith(child, { parentId: savedParent.id }, undefined);
    expect(f.deps.launch).toHaveBeenCalledWith(peer, undefined, undefined);
    expect(
      f.orchestration.restoreChild.mock.calls.some(([, entry]) => entry.id === dormant.id),
    ).toBe(true);
  });
});

it("defers an exited child's link without holding up startup or quit", async () => {
  const savedParent = parent();
  const dormant = row("dormant", { parentId: savedParent.id, running: false });
  const unrelated = row("unrelated");
  const f = fixture([savedParent, dormant, unrelated]);
  f.orchestration.identity.mockReturnValue({ repository: "identity", worktree: "identity" });
  f.orchestration.view.mockImplementation((id) =>
    id === savedParent.id && f.bind.mock.calls.length
      ? { role: "orchestrator", active: true, children: 0, history: [] }
      : undefined,
  );
  await f.owner.restore();
  const settle = f.owner.reserveManualLaunch(dormant.id);
  const starting = f.owner.restartSaved();

  await vi.waitFor(() => {
    expect(f.deps.launch).toHaveBeenCalledWith(unrelated, undefined, undefined);
  });
  await f.owner.prepareQuit();
  expect(f.orchestration.restoreChild).not.toHaveBeenCalled();
  expect(f.store.save.mock.lastCall?.[0]).toMatchObject([
    { id: savedParent.id, running: true, orchestrator: savedParent.orchestrator },
    { id: dormant.id, running: false, parentId: savedParent.id },
    { id: unrelated.id, running: true },
  ]);
  settle(false);
  await starting;
  expect(f.orchestration.restoreChild).not.toHaveBeenCalled();

  f.owner.cancelQuit();
  await vi.waitFor(() => {
    expect(f.orchestration.restoreChild).toHaveBeenCalledExactlyOnceWith(
      savedParent.id,
      { ...dormant, exited: true },
      expect.any(Function),
    );
  });
  expect(f.deps.launch).toHaveBeenCalledTimes(2);
});

it("drops deferred child provenance when its original checkout identity is superseded", async () => {
  const dormant = row("dormant", { parentId: "parent", running: false });
  const tree = { path: dormant.worktree, identity: "original", state: "used" as const };
  const savedParent = parent({
    orchestrator: {
      identity: "identity",
      worktreeIdentity: "identity",
      history: [],
      worktrees: [tree],
    },
  });
  const f = fixture([savedParent, dormant]);
  f.orchestration.savedWorktrees.mockReturnValue([tree]);
  await f.owner.restore();
  const settle = f.owner.reserveManualLaunch(dormant.id);
  await f.owner.restartSaved();
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0][1]?.parentId).toBe(savedParent.id);

  f.orchestration.savedWorktrees.mockReturnValue([{ ...tree, identity: "replacement" }]);
  await f.owner.save();
  expect(f.store.save.mock.lastCall?.[0][1]).not.toHaveProperty("parentId");
  vi.mocked(f.deps.busy).mockClear();
  settle(false);
  await f.owner.prepareQuit();
  expect(f.orchestration.restoreChild).not.toHaveBeenCalled();
  expect(f.deps.busy).not.toHaveBeenCalled();
});

it.each([false, true])(
  "lets unrelated launches and quit proceed during a child check (cancel quit=%s)",
  async (cancelQuit) => {
    const savedParent = parent();
    const dormant = row("dormant", { parentId: savedParent.id, running: false });
    const unrelated = row("unrelated");
    const f = fixture([savedParent, dormant, unrelated]);
    const probe = Promise.withResolvers<undefined>();
    const accepted = vi.fn();
    f.orchestration.restoreChild.mockImplementation(async (_id, _entry, eligible) => {
      await probe.promise;
      const allowed = eligible?.() === true;
      accepted(allowed);
      return allowed;
    });
    await f.owner.restore();
    const settleChild = f.owner.reserveManualLaunch(dormant.id);
    const settleUnrelated = f.owner.reserveManualLaunch(unrelated.id);
    await f.owner.restartSaved();

    settleChild(false);
    expect(f.orchestration.restoreChild).toHaveBeenCalledOnce();
    try {
      settleUnrelated(false);
      await vi.waitFor(() => {
        expect(f.deps.launch).toHaveBeenCalledWith(unrelated, undefined, undefined);
      });
      await f.owner.prepareQuit();
      expect(f.store.save.mock.lastCall?.[0][1]?.parentId).toBe(savedParent.id);
      expect(accepted).not.toHaveBeenCalled();
      if (cancelQuit) f.owner.cancelQuit();
    } finally {
      probe.resolve(undefined);
    }
    await vi.waitFor(() => {
      expect(accepted.mock.calls).toEqual(cancelQuit ? [[false], [true]] : [[false]]);
      expect(f.deps.busy).toHaveBeenCalledWith(dormant.id, false);
    });
  },
);

it("drops the old deferred child link before reattaching a discovered daemon invocation", async () => {
  const savedParent = parent();
  const remoteChild = row("remote-child", {
    parentId: savedParent.id,
    running: false,
    remote: true,
    placement: { kind: "remote", host: "worker" },
  });
  const discovered = { ...remoteChild, running: true, recovered: true as const };
  delete discovered.parentId;
  const f = fixture([savedParent, remoteChild]);
  f.deps.discover = () => Promise.resolve([discovered]);
  await f.owner.restore();
  const settle = f.owner.reserveManualLaunch(remoteChild.id);
  await f.owner.restartSaved();
  expect(f.deps.launch).toHaveBeenCalledOnce();

  settle(false);
  await vi.waitFor(() => {
    expect(f.deps.launch).toHaveBeenLastCalledWith(discovered, undefined, undefined);
  });
  await f.owner.prepareQuit();
  expect(f.orchestration.restoreChild).not.toHaveBeenCalled();
  expect(f.store.save.mock.lastCall?.[0][1]).not.toHaveProperty("parentId");
});
