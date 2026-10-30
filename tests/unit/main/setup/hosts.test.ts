import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import type * as childProcess from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import type { Settings } from "../../../../src/shared/setup";
import type { HostManagement, HostResult } from "../../../../src/shared/registered-hosts.d";
const mock = vi.hoisted(() => ({ execute: vi.fn(), remote: vi.fn() }));
vi.mock("../../../../src/main/agents/agents", () => ({
  loginPath: () => Promise.resolve({ path: "/fixture-login" }),
}));
vi.mock("../../../../src/main/control/forge-process", () => ({
  resolveForgeExecutable: () => Promise.resolve({ executable: "git" }),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  const fn = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mock.execute });
  return { ...actual, execFile: fn };
});
vi.mock("../../../../src/main/terminals/remote-transport", () => ({
  remoteManagement: mock.remote,
}));
import { Hosts, hostsForStore } from "../../../../src/main/setup/hosts";
import { UncertainEffect } from "../../../../src/main/workspace/worktree-outcome";
let settings: Settings;
const store = {
  get: () => settings,
  update: vi.fn((patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    return Promise.resolve(settings);
  }),
};
const facts = {
  codeFolder: "/home/worker/code",
  version: "0.1.0",
  sessions: 3,
  cores: 8,
  load: [1, 2, 3],
  memoryTotal: 8000,
  memoryAvailable: 4000,
  agents: [],
};
let hosts: Hosts;
let repositories = [{ path: "/local/repo", name: "repo" }];
const run = vi.fn<(host: string, request: HostManagement) => Promise<HostResult>>();
beforeEach(() => {
  vi.clearAllMocks();
  settings = { ...DEFAULT_SETTINGS };
  repositories = [{ path: "/local/repo", name: "repo" }];
  run.mockReset().mockResolvedValue({ ok: true, facts });
  mock.execute.mockReset().mockResolvedValue({ stdout: "git@forge.test:me/repo.git\n" });
  hosts = new Hosts(store, () => repositories, "0.1.0", run);
});
test("test does not authorize, add requires a successful checked folder, refresh replaces stale facts, removal never kills", async () => {
  expect(await hosts.action({ action: "list" })).toEqual({ hosts: [], locations: [] });
  expect(
    (await hosts.action({ action: "test", host: "worker", codeFolder: "~/code" })).hosts,
  ).toEqual([]);
  expect(store.update).not.toHaveBeenCalled();
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(settings.registeredHosts).toEqual([{ host: "worker", codeFolder: facts.codeFolder }]);
  expect(run).toHaveBeenCalledWith(
    "worker",
    expect.objectContaining({
      operation: "inspect",
      agents: run.mock.calls[0]?.[1].agents,
    }),
  );
  await expect(
    hosts.action({ action: "add", host: "worker", codeFolder: "~/code" }),
  ).rejects.toThrow();
  run.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
  expect((await hosts.action({ action: "refresh", host: "worker" })).hosts[0]?.result).toEqual({
    ok: false,
    reason: "unreachable",
  });
  const calls = run.mock.calls.length;
  await hosts.action({ action: "remove", host: "worker" });
  expect(settings.registeredHosts).toEqual([]);
  expect(run.mock.calls.length).toBe(calls);
  await expect(hosts.action({ action: "refresh", host: "worker" })).rejects.toThrow(
    "not registered",
  );
});
test("untrusted selectors, failed connections, malformed remote facts and write failures never grant authority", async () => {
  await expect(
    hosts.action({ action: "add", host: "-oCommand", codeFolder: "~/code" }),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  run.mockRejectedValueOnce(new Error("raw host secret"));
  expect(
    (await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" })).result,
  ).toEqual({ ok: false, reason: "unreachable" });
  run.mockResolvedValueOnce({ ok: false, reason: "unsafe-folder" });
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(settings.registeredHosts).toBeUndefined();
  run.mockResolvedValueOnce({ ok: true, facts: { ...facts, cores: -1 } });
  expect(
    (await hosts.action({ action: "test", host: "worker", codeFolder: "~/code" })).result,
  ).toEqual({ ok: false, reason: "unreachable" });
  store.update.mockRejectedValueOnce(new Error("write failed"));
  await expect(
    hosts.action({ action: "add", host: "worker", codeFolder: "~/code" }),
  ).rejects.toThrow();
  expect(settings.registeredHosts).toBeUndefined();
  settings = {
    ...settings,
    registeredHosts: Array.from({ length: 32 }, (_, n) => ({
      host: `host${String(n)}`,
      codeFolder: "/code",
    })),
  };
  await expect(
    hosts.action({ action: "add", host: "extra", codeFolder: "~/code" }),
  ).rejects.toThrow("limit");
});
test("repository locations and clone use only registered repositories' own origin and approved host folders", async () => {
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  run.mockResolvedValue({
    ok: true,
    facts,
    checkout: { path: "/home/worker/code/repo", state: "absent" },
  });
  expect((await hosts.action({ action: "locations" })).locations).toHaveLength(1);
  expect(mock.execute).toHaveBeenCalledWith(
    "git",
    ["--no-optional-locks", "config", "--local", "--get", "remote.origin.url"],
    expect.objectContaining({ cwd: "/local/repo", shell: false, timeout: 5000 }),
  );
  expect(run).toHaveBeenLastCalledWith(
    "worker",
    expect.objectContaining({
      operation: "repository",
      codeFolder: facts.codeFolder,
      origin: "git@forge.test:me/repo.git",
    }),
  );
  run.mockResolvedValueOnce({ ok: false, reason: "clone-failed" });
  expect(
    (await hosts.action({ action: "clone", host: "worker", repository: "/local/repo" })).locations,
  ).toEqual([
    { repository: "/local/repo", host: "worker", result: { ok: false, reason: "clone-failed" } },
  ]);
  await expect(
    hosts.action({ action: "clone", host: "worker", repository: "/foreign" }),
  ).rejects.toThrow("not registered");
  for (const origin of ["https://user:secret@host/repo", "/local/path"]) {
    mock.execute.mockResolvedValueOnce({ stdout: origin });
    expect((await hosts.action({ action: "locations" })).locations[0]?.result).toEqual({
      ok: false,
      reason: "origin-unavailable",
    });
  }
  mock.execute.mockRejectedValueOnce(new Error("raw secret"));
  expect(
    (await hosts.action({ action: "clone", host: "worker", repository: "/local/repo" }))
      .locations[0]?.result,
  ).toEqual({ ok: false, reason: "origin-unavailable" });
  repositories = [];
  expect(hosts.state().locations).toEqual([]);
  await hosts.action({ action: "remove", host: "worker" });
  expect(hosts.state().locations).toEqual([]);
});
test("windows share the same serialized registration owner and production transport", async () => {
  const shared = hostsForStore(store, () => repositories, "0.1.0");
  expect(hostsForStore(store, () => repositories, "0.1.0")).toBe(shared);
  mock.remote.mockResolvedValue({ ok: true, facts });
  await shared.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(mock.remote).toHaveBeenCalledWith(
    { host: "worker" },
    "0.1.0",
    expect.objectContaining({ type: "manage" }),
    expect.any(AbortSignal),
  );
  expect(new Hosts(store, () => repositories, "0.1.0").state().hosts).toHaveLength(1);
});

test("initial registered host reads refresh facts once and reject foreign paths", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  await hosts.action({ action: "list" });
  await hosts.action({ action: "list" });
  expect(run).toHaveBeenCalledTimes(1);
  run.mockResolvedValueOnce({ ok: true, facts: { ...facts, codeFolder: "/foreign" } });
  expect((await hosts.action({ action: "refresh", host: "worker" })).hosts[0]?.result).toEqual({
    ok: false,
    reason: "unreachable",
  });
  expect((await hosts.action({ action: "locations" })).locations[0]?.result).toEqual({
    ok: false,
    reason: "checkout-refused",
  });
});

test("one shared host owner registers quit cancellation once", async () => {
  const isolated = { ...store };
  const quit = vi.fn<(dispose: () => void) => void>();
  const service = hostsForStore(isolated, () => repositories, "0.1.0", quit);
  expect(hostsForStore(isolated, () => repositories, "0.1.0", quit)).toBe(service);
  expect(quit).toHaveBeenCalledOnce();
  mock.remote.mockResolvedValue({ ok: false, reason: "unreachable" });
  await service.action({ action: "test", host: "worker", codeFolder: "~/foom" });
  quit.mock.calls[0]?.[0]();
  const signal: unknown = mock.remote.mock.calls.at(-1)?.[3];
  expect(signal instanceof AbortSignal && signal.aborted).toBe(true);
});

test("host inventory is projected onto Foom-selected enabled manifests, with missing replies unable to check", async () => {
  settings = {
    ...settings,
    agents: { claude: true, codex: true, agy: false, copilot: false, opencode: false, pi: false },
  };
  run.mockResolvedValueOnce({
    ok: true,
    facts: {
      ...facts,
      agents: [
        { id: "claude", state: "ready" },
        { id: "host-invented", state: "ready" },
      ],
    },
  });
  const state = await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(state.result).toMatchObject({
    ok: true,
    facts: {
      agents: [
        { id: "claude", state: "ready" },
        { id: "codex", state: "unable" },
      ],
    },
  });
  expect(JSON.stringify(state)).not.toContain("host-invented");
  expect(JSON.stringify(run.mock.calls[0]?.[1].agents)).not.toContain("agy");
});

test("fleet inventory uses registered hosts, shares in-flight probes, and refuses cached missing agents before preparation", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  const pending = Promise.withResolvers<HostResult>();
  run.mockReturnValueOnce(pending.promise);
  const first = hosts.requireAgent("worker", "codex");
  const second = hosts.inventory("worker");
  pending.resolve({ ok: true, facts: { ...facts, agents: [{ id: "codex", state: "missing" }] } });
  await expect(first).rejects.toMatchObject({ reason: "remote_agent_unavailable" });
  await second;
  await expect(hosts.requireAgent("worker", "codex")).rejects.toMatchObject({
    reason: "remote_agent_unavailable",
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(await hosts.fleet()).toHaveLength(1);
  await expect(hosts.requireAgent("unregistered", "claude")).rejects.toMatchObject({
    code: "not_found",
  });
  expect(run).toHaveBeenCalledTimes(1);
  settings = { ...settings, agents: { ...settings.agents, claude: false } };
  await expect(hosts.requireAgent("worker", "claude")).rejects.toMatchObject({
    reason: "agent_disabled",
  });
});

test("stale, missing, failed and changed-enabled inventories are probed rather than guessed", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    run.mockResolvedValue({
      ok: true,
      facts: { ...facts, agents: [{ id: "codex", state: "ready" }] },
    });
    await hosts.requireAgent("worker", "codex");
    await hosts.requireAgent("worker", "codex");
    expect(run).toHaveBeenCalledTimes(1);
    now.mockReturnValue(61000);
    run.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
    await expect(hosts.requireAgent("worker", "codex")).rejects.toMatchObject({
      reason: "remote_host_unreachable",
    });
    await hosts.requireAgent("worker", "codex");
    expect(run).toHaveBeenCalledTimes(3);
    settings = { ...settings, agents: { ...settings.agents, agy: false } };
    await hosts.inventory("worker");
    expect(run).toHaveBeenCalledTimes(4);
    now.mockReturnValue(0);
    await hosts.inventory("worker");
    expect(run).toHaveBeenCalledTimes(5);
  } finally {
    now.mockRestore();
  }
});

test("registration revocation or a manifest-selection change during inventory cannot authorize launch", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  run.mockImplementationOnce(() => {
    settings = { ...settings, agents: { ...settings.agents, codex: false } };
    return Promise.resolve({ ok: true, facts });
  });
  expect(await hosts.inventory("worker")).toEqual({ ok: false, reason: "unreachable" });
  run.mockImplementationOnce(() => {
    settings = { ...settings, registeredHosts: [] };
    return Promise.resolve({ ok: true, facts });
  });
  await expect(hosts.inventory("worker")).rejects.toMatchObject({ code: "not_found" });
});

test("remote worktree commands never clone and only use the registered origin and approved code folder", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  const origin = "git@forge.test:me/repo.git";
  const { createHash } = await import("node:crypto");
  const directory = `repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
  const tree = {
    path: `${facts.codeFolder}/.foom-worktree-fixture`,
    branch: "feature",
    identity: "a".repeat(64),
    changes: "",
  };
  run
    .mockResolvedValueOnce({
      ok: true,
      facts,
      checkout: { path: `${facts.codeFolder}/${directory}`, state: "clean" },
    })
    .mockResolvedValueOnce({ ok: true, facts, worktree: tree });
  expect(
    await hosts.worktree("worker", "/local/repo", {
      operation: "create-worktree",
      branch: "feature",
    }),
  ).toEqual({ repository: `${facts.codeFolder}/${directory}`, ...tree, sourceOrigin: origin });
  expect(run.mock.calls.map((call) => call[1].operation)).toEqual([
    "repository",
    "create-worktree",
  ]);
  expect(run.mock.calls[1]?.[1]).toMatchObject({
    origin,
    directory,
    codeFolder: facts.codeFolder,
    branch: "feature",
  });
  await expect(
    hosts.worktree("worker", "/foreign", { operation: "create-worktree", branch: "feature" }),
  ).rejects.toMatchObject({ code: "not_found" });
  run.mockResolvedValueOnce({
    ok: true,
    facts,
    checkout: { path: `${facts.codeFolder}/${directory}`, state: "absent" },
  });
  await expect(
    hosts.worktree("worker", "/local/repo", { operation: "create-worktree", branch: "feature" }),
  ).rejects.toMatchObject({ reason: "remote_worktree_unavailable" });
  for (const result of [
    { ok: false, reason: "checkout-refused" } as const,
    { ok: true, facts } as const,
    { ok: true, facts, worktree: { ...tree, branch: "unexpected" } } as const,
    { ok: true, facts, worktree: { ...tree, path: "/outside" } } as const,
    { ok: true, facts, worktree: { ...tree, path: `${tree.path}/child` } } as const,
  ]) {
    run
      .mockResolvedValueOnce({
        ok: true,
        facts,
        checkout: { path: `${facts.codeFolder}/${directory}`, state: "clean" },
      })
      .mockResolvedValueOnce(result);
    await expect(
      hosts.worktree("worker", "/local/repo", { operation: "create-worktree", branch: "feature" }),
    ).rejects.toBeInstanceOf(UncertainEffect);
  }
  run
    .mockResolvedValueOnce({
      ok: true,
      facts,
      checkout: { path: `${facts.codeFolder}/${directory}`, state: "clean" },
    })
    .mockResolvedValueOnce({ ok: true, facts, worktree: tree });
  await expect(
    hosts.worktree("worker", "/local/repo", {
      operation: "inspect-worktree",
      path: tree.path,
      identity: "b".repeat(64),
    }),
  ).rejects.toMatchObject({ reason: "remote_worktree_unavailable" });
});

test("forge inspection binds registered host, folder, checkout identity, branch, HEAD and unchanged local and remote origins", async () => {
  const origin = "git@forge.test:me/repo.git";
  const { createHash } = await import("node:crypto");
  const repository = `${facts.codeFolder}/repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
  const binding = {
    host: "worker",
    codeFolder: facts.codeFolder,
    repository,
    path: `${facts.codeFolder}/.foom-worktree-fixture`,
    origin,
  };
  const tree = {
    repository: "/local/repo",
    path: "/opaque",
    branch: "feature",
    identity: "a".repeat(64),
    remoteCheckout: binding,
  };
  const worktree = {
    path: binding.path,
    branch: tree.branch,
    identity: tree.identity,
    head: "b".repeat(40),
    origin,
    changes: "",
  };
  settings = {
    ...settings,
    registeredHosts: [{ host: binding.host, codeFolder: facts.codeFolder }],
  };
  run.mockImplementation((_host, request) =>
    Promise.resolve(
      request.operation === "repository"
        ? { ok: true, facts, checkout: { path: repository, state: "clean" } }
        : { ok: true, facts, worktree },
    ),
  );
  expect(await hosts.inspectForge(tree)).toEqual({ remote: origin, head: worktree.head });
  expect(
    await hosts.inspectForge({
      repository: tree.repository,
      path: tree.path,
      branch: tree.branch,
      identity: tree.identity,
    }),
  ).toBeUndefined();
  for (const patch of [
    { branch: "changed" },
    { origin: "git@other.test:me/repo.git" },
    { head: "" },
  ]) {
    run.mockImplementation((_host, request) =>
      Promise.resolve(
        request.operation === "repository"
          ? { ok: true, facts, checkout: { path: repository, state: "clean" } }
          : { ok: true, facts, worktree: { ...worktree, ...patch } },
      ),
    );
    expect(await hosts.inspectForge(tree)).toBeUndefined();
  }
  mock.execute.mockResolvedValueOnce({ stdout: "git@other.test:me/repo.git" });
  expect(await hosts.inspectForge(tree)).toBeUndefined();
  expect(await hosts.inspectForge({ ...tree, identity: "c".repeat(64) })).toBeUndefined();
  settings = { ...settings, registeredHosts: [] };
  await expect(hosts.inspectForge(tree)).rejects.toMatchObject({ code: "not_found" });
});

test("unsupported remote providers refuse with a fixed listed reason before SSH inventory", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  await expect(hosts.requireAgent("worker", "custom")).rejects.toMatchObject({
    reason: "remote_agent_unsupported",
  });
  expect(run).not.toHaveBeenCalled();
});

test("a config provider cannot appear ready from a remote installation probe", async () => {
  const base = agentProvider("claude");
  replaceConfigProviders([
    { ...base, id: "custom", origin: "config", model: { ...base.model, id: "custom" } },
  ]);
  try {
    run.mockResolvedValue({
      ok: true,
      facts: { ...facts, agents: [{ id: "custom", state: "ready" }] },
    });
    const result = await hosts.action({ action: "test", host: "worker", codeFolder: "~/code" });
    if (!result.result?.ok) throw new Error("No inventory");
    expect(result.result.facts.agents).toContainEqual({ id: "custom", state: "unable" });
  } finally {
    replaceConfigProviders([]);
  }
});
