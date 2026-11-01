import { forgeAvailable, forgeUi, forgeMock, mock, start } from "./main-fixture";
import type { WorkspaceTerminal } from "../../../src/shared/workspace";
import { DEFAULT_SETTINGS } from "../../../src/main/setup/settings";

import { join } from "node:path";

import { expect, test, vi } from "vitest";

test("forge observations require registered, managed worktrees with matching branch and identity", async () => {
  const listRepositories = vi.fn(() => [{ path: "/repo", name: "Repo" }]);
  const listWorktrees = vi.fn(() =>
    Promise.resolve([{ path: "/tree", managed: true, branch: "child-one", head: "a".repeat(40) }]),
  );
  const launchIdentity = vi.fn(() => Promise.resolve("identity"));
  const forgeRemote = vi.fn(() => Promise.resolve<string | undefined>("https://github.com/o/r"));
  mock.openWorktrees.mockResolvedValue({
    listRepositories,
    listWorktrees,
    launchIdentity,
    forgeRemote,
    watchPaths: vi.fn(),
  });
  await start();
  const inspect = forgeMock.open.mock.lastCall?.[1];
  if (!inspect) throw new Error("Missing forge validator");
  const tree = { repository: "/repo", path: "/tree", identity: "identity", branch: "child-one" };
  expect(await inspect(tree)).toEqual({ remote: "https://github.com/o/r", head: "a".repeat(40) });
  expect(await inspect({ ...tree, repository: "/foreign" })).toBeUndefined();
  expect(await inspect({ ...tree, path: "/foreign" })).toBeUndefined();
  expect(await inspect({ ...tree, branch: "other" })).toBeUndefined();
  expect(await inspect({ ...tree, identity: "other" })).toBeUndefined();
  listWorktrees.mockResolvedValueOnce([
    { path: "/tree", managed: false, branch: "child-one", head: "a".repeat(40) },
  ]);
  expect(await inspect(tree)).toEqual({ remote: "https://github.com/o/r", head: "a".repeat(40) });
  listWorktrees.mockResolvedValueOnce([
    { path: "/tree", managed: false, branch: "child-one", head: "a".repeat(40) },
  ]);
  expect(await inspect(tree, true)).toBeUndefined();
  forgeRemote.mockResolvedValueOnce(undefined);
  expect(await inspect(tree)).toBeUndefined();
  forgeMock.open.mock.lastCall?.[2]();
  expect(mock.workspace.refresh).toHaveBeenCalled();
});

test("an unavailable private forge store leaves the app usable", async () => {
  forgeMock.open.mockRejectedValueOnce(new Error("private storage unavailable"));
  await start();
  expect(mock.workspace.deps?.forge).toBeUndefined();
});

test("forge default probes GitHub CLI login once unless the preference was already saved", async () => {
  const get = vi
    .spyOn(mock.settingsStore, "get")
    .mockReturnValue({ ...DEFAULT_SETTINGS, setupComplete: true });
  try {
    forgeAvailable.mockResolvedValueOnce(true);
    await start();
    expect(forgeAvailable).toHaveBeenCalledOnce();
    expect(mock.settingsStore.update).toHaveBeenCalledWith({ showPullRequests: true });
  } finally {
    get.mockRestore();
  }
});

test("missing or logged-out gh defaults board tracking off", async () => {
  const get = vi
    .spyOn(mock.settingsStore, "get")
    .mockReturnValue({ ...DEFAULT_SETTINGS, setupComplete: true });
  try {
    forgeAvailable.mockResolvedValueOnce(false);
    await start();
    expect(mock.settingsStore.update).toHaveBeenCalledWith({ showPullRequests: false });
  } finally {
    get.mockRestore();
  }
});

test("first run defers forge probes until the readiness step", async () => {
  vi.spyOn(mock.settingsStore, "get").mockReturnValue({ ...DEFAULT_SETTINGS });
  await start();
  expect(forgeAvailable).not.toHaveBeenCalled();
});

test("forge lifecycle pauses on power events and completion notifications honor preferences", async () => {
  let settings = { ...DEFAULT_SETTINGS, showPullRequests: true };
  const get = vi.spyOn(mock.settingsStore, "get").mockImplementation(() => settings);
  try {
    await start();
    const tracker = mock.workspace.deps?.forge;
    if (!tracker) throw new Error("Missing tracker");
    const pause = vi.spyOn(tracker, "pause");
    for (const name of ["suspend", "resume", "lock-screen", "unlock-screen"])
      forgeUi.events.get(name)?.();
    expect(pause).toHaveBeenCalledWith("sleep", true);
    expect(pause).toHaveBeenCalledWith("lock", false);
    const tree = { repository: "/repo", path: "/tree", identity: "identity", branch: "feature" };
    const pr = {
      number: 12,
      title: "PR",
      url: "https://github.com/o/r/pull/12",
      state: "OPEN" as const,
      checks: { passed: 0, pending: 0, failed: 2 },
    };
    tracker.onCompleted?.(tree, pr);
    expect(forgeUi.notices[0]).toMatchObject({
      title: "Pull request #12",
      body: "2 checks failed",
    });
    forgeUi.notices[0]?.click?.();
    expect(mock.window.webContents.send).toHaveBeenCalledWith("workspace:focus-worktree", "/tree");
    tracker.onCompleted?.(tree, { ...pr, checks: { passed: 2, pending: 0, failed: 0 } });
    expect(forgeUi.notices[1]?.body).toBe("Checks passed");
    tracker.onCompleted?.(tree, { ...pr, checks: null });
    for (const patch of [
      { showPullRequests: false },
      { sound: { ...DEFAULT_SETTINGS.sound, alerts: false } },
      { sound: { ...DEFAULT_SETTINGS.sound, muted: true } },
    ]) {
      settings = { ...DEFAULT_SETTINGS, showPullRequests: true, ...patch };
      tracker.onCompleted?.(tree, pr);
    }
    settings = { ...DEFAULT_SETTINGS, showPullRequests: true };
    forgeUi.supported = false;
    tracker.onCompleted?.(tree, pr);
    expect(forgeUi.notices).toHaveLength(2);
  } finally {
    get.mockRestore();
  }
});

test("pass notifications use current execution evidence rather than stale verdicts", async () => {
  const get = vi
    .spyOn(mock.settingsStore, "get")
    .mockReturnValue({ ...DEFAULT_SETTINGS, showPullRequests: true });
  try {
    await start();
    const tracker = mock.workspace.deps?.forge;
    if (!tracker) throw new Error("Missing tracker");
    const tree = { repository: "/repo", path: "/tree", identity: "id", branch: "feature" };
    const pr = {
      number: 12,
      title: "PR",
      url: "https://github.com/o/r/pull/12",
      state: "OPEN" as const,
      checks: { passed: 1, pending: 0, failed: 0 },
    };
    const row: WorkspaceTerminal = {
      id: "t1",
      kind: "agent",
      agent: "claude",
      repository: "/repo",
      worktree: "/tree",
      branch: "feature",
      state: null,
      attention: "hooks",
    };
    for (const phase of ["starting", "working"] as const) {
      forgeUi.rows = [
        { ...row, execution: { terminalId: "t1", launch: 1, revision: 1, turn: 1, phase } },
      ];
      tracker.onCompleted?.(tree, pr);
    }
    forgeUi.rows = [row];
    tracker.onCompleted?.(tree, pr);
    expect(forgeUi.notices).toHaveLength(0);
    forgeUi.rows = [
      { ...row, execution: { terminalId: "t1", launch: 1, revision: 2, turn: 1, phase: "idle" } },
    ];
    tracker.onCompleted?.(tree, pr);
    expect(forgeUi.notices).toHaveLength(1);
    forgeUi.rows = [{ ...row, exited: true }];
    tracker.onCompleted?.(tree, pr);
    expect(forgeUi.notices).toHaveLength(2);
    mock.window.isMinimized.mockReturnValueOnce(true);
    forgeUi.notices[1]?.click?.();
    expect(mock.window.restore).toHaveBeenCalled();
  } finally {
    get.mockRestore();
  }
});

test("wires the forge catalog and shares the manifest selector between tracking and adoption", async () => {
  const agents = await import("../../../src/main/agents/agents");
  vi.spyOn(agents, "loginPath").mockResolvedValue({ path: "/fixture/bin", warning: null });
  await start();
  const provider = forgeMock.open.mock.calls[0]?.[3];
  expect(provider).toEqual(expect.any(Function));
  expect(mock.openWorktrees).toHaveBeenCalledWith(
    "/test/user-data",
    undefined,
    [join("/test/user-data", ".foom", "config")],
    provider,
  );
  await expect(
    provider?.("https://github.com/o/r", () =>
      Promise.resolve({ identity: "fixture", validate: async () => {} }),
    ),
  ).resolves.toHaveProperty("batch");
  await expect(provider?.("https://unassigned.example/o/r")).resolves.toBeUndefined();
  const deps = mock.config.deps;
  if (!deps?.applyForges) throw new Error("Missing forge catalog wiring");
  deps.applyForges([]);
  await expect(
    provider?.("https://github.com/o/r", () =>
      Promise.resolve({ identity: "fixture", validate: async () => {} }),
    ),
  ).resolves.toHaveProperty("batch");
});

test("manifest composition uses live profile choices, discovered PATH and tracker invalidation", async () => {
  let current = { ...DEFAULT_SETTINGS };
  const get = vi.spyOn(mock.settingsStore, "get").mockImplementation(() => current);
  const agents = await import("../../../src/main/agents/agents");
  const discover = vi
    .spyOn(agents, "loginPath")
    .mockResolvedValue({ path: "/fixture/discovered/bin", warning: null });
  try {
    await start();
    const provider = forgeMock.open.mock.calls[0]?.[3];
    const tracker = mock.workspace.deps?.forge;
    const setup = mock.setup.deps;
    if (!provider || !tracker || !setup) throw new Error("Missing forge composition");
    const invalidate = vi.spyOn(tracker, "invalidate");
    const context = () =>
      Promise.resolve({ identity: "registered-fixture", validate: () => Promise.resolve() });
    expect(await provider("https://github.com/o/r", context)).toHaveProperty("batch");
    expect(discover).toHaveBeenCalledOnce();
    current = { ...current, forges: { github: false } };
    setup.apply(current);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(await provider("https://github.com/o/r", context)).toBeUndefined();
    expect(discover).toHaveBeenCalledOnce();
    current = { ...current, forges: { github: true }, forgeHosts: { "self.example": "github" } };
    setup.apply(current);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(await provider("https://github.com/o/r", context)).toBeUndefined();
    expect(await provider("https://self.example/o/r", context)).toHaveProperty("batch");
    expect(discover).toHaveBeenCalledTimes(2);
  } finally {
    get.mockRestore();
    discover.mockRestore();
  }
});

test("remote forge routing uses registered host inspection and never treats synthetic checkout IDs as local paths", async () => {
  const { Hosts } = await import("../../../src/main/setup/hosts");
  const evidence = { remote: "https://github.com/o/r", head: "a".repeat(40) };
  const remote = vi.spyOn(Hosts.prototype, "inspectForge").mockResolvedValue(evidence);
  const listWorktrees = vi.fn(() => Promise.resolve([]));
  const launchIdentity = vi.fn();
  mock.openWorktrees.mockResolvedValue({
    listRepositories: () => [{ path: "/repo", name: "Repo" }],
    listWorktrees,
    launchIdentity,
    watchPaths: vi.fn(),
  });
  await start();
  const inspect = forgeMock.open.mock.lastCall?.[1];
  if (!inspect) throw new Error("Missing forge inspector");
  const tree = {
    repository: "/repo",
    path: "/foom-remote/opaque",
    identity: "a".repeat(64),
    branch: "feature",
  };
  const bound = {
    ...tree,
    remoteCheckout: {
      host: "worker",
      codeFolder: "/code",
      repository: "/code/repository-fixture",
      path: "/code/.foom-worktree-fixture",
      origin: evidence.remote,
    },
  };
  expect(await inspect(bound, true)).toEqual(evidence);
  expect(remote).toHaveBeenCalledWith(bound);
  expect(await inspect(tree)).toBeUndefined();
  expect(await inspect({ ...bound, repository: "/unregistered" })).toBeUndefined();
  expect(remote).toHaveBeenCalledOnce();
  expect(listWorktrees).not.toHaveBeenCalled();
  expect(launchIdentity).not.toHaveBeenCalled();
});
