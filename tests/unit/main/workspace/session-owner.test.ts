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
    orchestrator: { identity: "identity", history: [] },
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
    handoffs: new Handoffs(),
    view: vi.fn<SessionOwnerDependencies["orchestration"]["view"]>(),
    ownedWorktrees: vi.fn(() => []),
    uncertainWorktrees: vi.fn(() => 0),
    exited: vi.fn(),
    reserve: vi.fn<SessionOwnerDependencies["orchestration"]["reserve"]>(() => ({ bind, release })),
    restoreChild: vi.fn((_parent: string, _entry: WorkspaceTerminal) => Promise.resolve(true)),
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
      rows.set(entry.id, { ...entry, dormant: false, exited: false });
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
  f.owner.rememberIdentity("/repo", "identity");
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
  expect(f.orchestration.restoreChild).toHaveBeenCalledWith("parent", { ...child, exited: false });
  expect(f.orchestration.restoreChild).toHaveBeenCalledWith("parent", { ...exited, exited: true });
  expect(f.deps.launch).toHaveBeenLastCalledWith(child, { parentId: "parent" }, undefined);
  expect(f.owner.isRestoring("child")).toBe(false);
  expect(f.owner.roleNotRestored("parent")).toBe(false);
  expect(f.deps.busy).toHaveBeenCalledWith("parent", false);
});

it.each(["disabled", "closed", "removed", "quitting"] as const)(
  "skips queued launches when %s and releases markers",
  async (mode) => {
    const f = fixture([row("one"), row("two")]);
    // Both use one checkout, so the second waits for the first.
    const second = row("two", { worktree: "/repo/one" });
    f.store.load.mockResolvedValue([row("one"), second]);
    const gate = Promise.withResolvers<string>();
    vi.mocked(f.deps.launch).mockImplementationOnce(() => gate.promise);
    await f.owner.restore();
    if (mode === "quitting") await f.owner.prepareQuit();
    const work = f.owner.restartSaved();
    await vi.waitFor(() => {
      if (mode !== "quitting") expect(f.deps.launch).toHaveBeenCalledOnce();
    });
    if (mode === "disabled") f.owner.configure(false);
    if (mode === "closed") vi.mocked(f.deps.closed).mockReturnValue(true);
    if (mode === "removed") f.rows.delete("two");
    gate.resolve("one");
    await work;
    expect(f.deps.launch).toHaveBeenCalledTimes(mode === "quitting" ? 0 : 1);
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
      expect(f.deps.failed).toHaveBeenCalledWith("parent");
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
  expect(f.deps.failed).toHaveBeenCalledWith("running");
  expect(f.rows.get("running")?.dormant).toBe(true);
});
