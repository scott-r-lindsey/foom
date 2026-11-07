import { restartedBrewHost } from "./hosts-saved-fixture";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredHosts } from "../../../../src/shared/registered-hosts";
import type { RemoteInventoryResult, RemoteSessionInfo } from "../../../../src/shared/remote-host";
import type * as remoteTransport from "../../../../src/main/terminals/remote-transport";

import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import type * as childProcess from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../../../../src/main/setup/settings";
import type { Settings } from "../../../../src/shared/setup";
import type { HostManagement, HostResult } from "../../../../src/shared/registered-hosts.d";
const mock = vi.hoisted(() => ({
  execute: vi.fn(),
  remote: vi.fn(),
  inventory: vi.fn<typeof remoteTransport.remoteInventory>(),
}));
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
  remoteInventory: mock.inventory,
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
test("test does not authorize, add records enrollment, refresh replaces stale facts, removal never kills", async () => {
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
  expect(settings.registeredHosts).toEqual([{ host: "worker", codeFolder: "~/code" }]);
  await hosts.action({ action: "remove", host: "worker" });
  run.mockResolvedValueOnce({ ok: true, facts: { ...facts, cores: -1 } });
  expect(
    (await hosts.action({ action: "test", host: "worker", codeFolder: "~/code" })).result,
  ).toEqual({ ok: false, reason: "invalid-reply" });
  store.update.mockRejectedValueOnce(new Error("write failed"));
  await expect(
    hosts.action({ action: "add", host: "worker", codeFolder: "~/code" }),
  ).rejects.toThrow();
  expect(settings.registeredHosts).toEqual([]);
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

test("listing saved hosts performs no remote reads and refresh rejects foreign paths", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  await hosts.action({ action: "list" });
  await hosts.action({ action: "list" });
  expect(run).not.toHaveBeenCalled();
  run.mockResolvedValueOnce({ ok: true, facts: { ...facts, codeFolder: "/foreign" } });
  expect((await hosts.action({ action: "refresh", host: "worker" })).hosts[0]?.result).toEqual({
    ok: false,
    reason: "invalid-reply",
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

test.each([true, false])(
  "late background inventory cannot replace a newer explicit host check (%s)",
  async (ok) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
      repositories = [];
      const older = Promise.withResolvers<HostResult>();
      const latest: HostResult = ok
        ? { ok: true, facts: { ...facts, agents: [{ id: "claude", state: "missing" }] } }
        : { ok: false, reason: "unreachable" };
      run.mockReturnValueOnce(older.promise).mockResolvedValue(latest);
      const pending = hosts.inventory("worker");
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledTimes(1);
      });
      now.mockReturnValue(2000);
      await hosts.action({ action: "preflight", host: "worker", codeFolder: facts.codeFolder });
      const checked = (await hosts.fleet(false))[0]?.result;
      expect(checked).toMatchObject({ ok });
      if (checked?.ok)
        expect(checked.facts.agents).toContainEqual(
          expect.objectContaining({ id: "claude", state: "missing" }),
        );
      now.mockReturnValue(70_000);
      older.resolve({ ok: true, facts: { ...facts, agents: [{ id: "claude", state: "ready" }] } });
      await expect(pending).resolves.toEqual(checked);
      await expect(hosts.requireAgent("worker", "claude")).rejects.toMatchObject({
        reason: ok ? "remote_agent_unavailable" : "remote_host_unreachable",
      });
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
    }
  },
);

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
  expect((await hosts.inventory("worker")).ok).toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  settings = { ...settings, agents: { ...settings.agents, codex: true } };
  run.mockImplementationOnce(() => {
    settings = { ...settings, registeredHosts: [] };
    return Promise.resolve({ ok: true, facts });
  });
  await expect(hosts.inventory("worker")).rejects.toMatchObject({ code: "not_found" });
});

test("remote worktree commands never clone and only use the registered origin and approved code folder", async () => {
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
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
  run.mockResolvedValueOnce({ ok: true, facts, worktree: tree });
  await expect(
    hosts.worktree("worker", "/local/repo", {
      operation: "inspect-worktree",
      path: tree.path,
      identity: "b".repeat(64),
    }),
  ).rejects.toMatchObject({ reason: "remote_worktree_unavailable" });
});

test.each(["inspect-worktree", "snapshot-worktree", "remove-worktree"] as const)(
  "%s validates the canonical checkout in one management connection",
  async (operation) => {
    settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
    hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
    const origin = "git@forge.test:me/repo.git";
    const { createHash } = await import("node:crypto");
    const directory = `repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    const snapshot = { head: "a".repeat(40), digest: "b".repeat(64) };
    const tree = {
      path: `${facts.codeFolder}/.foom-worktree-fixture`,
      branch: "feature",
      identity: "a".repeat(64),
      changes: "",
      head: snapshot.head,
      origin,
      ...(operation === "snapshot-worktree" ? { snapshot } : {}),
    };
    run.mockResolvedValueOnce({ ok: true, facts, worktree: tree });
    await expect(
      hosts.worktree("worker", "/local/repo", {
        operation,
        path: tree.path,
        identity: tree.identity,
        ...(operation === "remove-worktree" ? { changes: "" } : {}),
      }),
    ).resolves.toMatchObject({
      repository: `${facts.codeFolder}/${directory}`,
      ...tree,
      sourceOrigin: origin,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "worker",
      expect.objectContaining({
        operation,
        directory,
        origin,
        codeFolder: facts.codeFolder,
        profile: "a".repeat(32),
        path: tree.path,
        identity: tree.identity,
      }),
    );
  },
);

test("profile inventories project only counts to Settings and End confirms exact session incarnations", async () => {
  const profile = "a".repeat(32);
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  hosts = new Hosts(store, () => repositories, "0.1.0", run, profile);
  const snapshot: RemoteInventoryResult = {
    type: "inventory-result",
    own: [{ id: "mine" }],
    foreign: [{ id: "foreign", generation: "b".repeat(32) }],
  };
  mock.inventory.mockResolvedValue(snapshot);
  expect(await hosts.sessions()).toEqual([{ host: "worker", session: { id: "mine" } }]);
  expect(hosts.state().hosts[0]).toMatchObject({ foreignSessions: 1 });
  await hosts.action({ action: "refresh", host: "worker" });
  expect(hosts.state().hosts[0]?.result).toMatchObject({ ok: true, facts: { sessions: 2 } });
  mock.inventory.mockResolvedValueOnce({
    ...snapshot,
    foreign: [{ id: "foreign", generation: "b".repeat(32), count: 3 }],
  });
  await hosts.sessions();
  expect(hosts.state().hosts[0]).toMatchObject({
    foreignSessions: 3,
    result: { facts: { sessions: 4 } },
  });
  expect(JSON.stringify(hosts.state())).not.toContain('foreign"');
  const decline = vi.fn().mockResolvedValue(false);
  await hosts.action({ action: "end", host: "worker" }, decline);
  expect(decline).toHaveBeenCalledWith(
    expect.objectContaining({ title: "End remote sessions?", accept: "End sessions" }),
  );
  expect(mock.inventory.mock.calls.filter((call) => call[2].type === "end-sessions")).toHaveLength(
    0,
  );
  const confirm = vi.fn().mockResolvedValue(true);
  mock.inventory
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ type: "inventory-result", own: [{ id: "mine" }], foreign: [] });
  await hosts.action({ action: "end", host: "worker" }, confirm);
  expect(mock.inventory).toHaveBeenLastCalledWith(
    { host: "worker" },
    "0.1.0",
    { type: "end-sessions", profile, ids: snapshot.foreign },
    expect.any(AbortSignal),
  );
  expect(hosts.state().hosts[0]).toMatchObject({ foreignSessions: 0 });
  mock.inventory.mockResolvedValueOnce({ type: "inventory-result", own: [], foreign: [] });
  confirm.mockClear();
  await hosts.action({ action: "end", host: "worker" }, confirm);
  expect(confirm).not.toHaveBeenCalled();
  mock.inventory.mockRejectedValue(new Error("private network detail"));
  expect(await hosts.sessions()).toEqual([]);
  await expect(hosts.action({ action: "refresh", host: "worker" })).rejects.toThrow();
});

test("recovery placements are profile-owned, registered, and bound to the hashed host/path checkout key", async () => {
  const { locationId } = await import("../../../../src/main/control/metadata");
  const host = "worker";
  const path = `${facts.codeFolder}/.foom-worktree-topic`;
  const key = `/foom-remote/${locationId(JSON.stringify([host, path]))}`;
  settings = { ...settings, registeredHosts: [{ host, codeFolder: facts.codeFolder }] };
  const session = {
    id: "mine",
    context: { repository: "/local/repo", worktree: key, branch: "topic", agent: "claude" },
    checkout: { repository: `${facts.codeFolder}/repo`, path, identity: "c".repeat(64) },
  };
  mock.inventory.mockResolvedValue({ type: "inventory-result", own: [session], foreign: [] });
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
  await hosts.sessions();
  expect(hosts.placement(key)).toMatchObject({
    host,
    path,
    localRepository: "/local/repo",
    identity: "c".repeat(64),
  });
  expect(hosts.placement(key, "/local/repo")?.localRepository).toBe("/local/repo");
  expect(hosts.placement(key, "/local/other")).toBeUndefined();
  expect(hosts.placement("unknown")).toBeUndefined();
  repositories = [];
  expect(hosts.placement(key)).toBeUndefined();
  repositories = [{ path: "/local/repo", name: "repo" }];
  const withoutContext: RemoteSessionInfo = { id: session.id, checkout: session.checkout };
  const withoutCheckout: RemoteSessionInfo = { id: session.id, context: session.context };
  for (const changed of [
    withoutContext,
    withoutCheckout,
    { ...session, context: { ...session.context, worktree: "/forged" } },
    { ...session, checkout: { ...session.checkout, path: `${path}/nested` } },
  ]) {
    mock.inventory.mockResolvedValueOnce({ type: "inventory-result", own: [changed], foreign: [] });
    await hosts.sessions();
    expect(hosts.placement(key)).toBeUndefined();
  }
  await hosts.action({ action: "remove", host });
  expect(hosts.placement(key)).toBeUndefined();
  const untagged = new Hosts(store, () => repositories, "0.1.0", run);
  settings = { ...settings, registeredHosts: [{ host, codeFolder: facts.codeFolder }] };
  await expect(untagged.action({ action: "end", host })).rejects.toThrow("Profile unavailable");
});

test("saved locators survive expired daemon tombstones but never authorize a different folder, host or repository", async () => {
  const { locationId } = await import("../../../../src/main/control/metadata");
  const path = `${facts.codeFolder}/.foom-worktree-topic`;
  const key = `/foom-remote/${locationId(JSON.stringify(["worker", path]))}`;
  const value = {
    repository: `${facts.codeFolder}/repo`,
    path,
    branch: "topic",
    identity: "a".repeat(64),
  };
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  hosts.rememberPlacement("/local/repo", key, "worker", value);
  expect(hosts.placement(key)).toMatchObject({ host: "worker", path, identity: value.identity });
  expect(hosts.placement(key, "/local/repo")?.localRepository).toBe("/local/repo");
  expect(hosts.placement(key, "/local/other")).toBeUndefined();
  for (const badPath of ["/outside/.foom-worktree-topic", `${path}/nested`]) {
    const badKey = `/foom-remote/${locationId(JSON.stringify(["worker", badPath]))}`;
    hosts.rememberPlacement("/local/repo", badKey, "worker", { ...value, path: badPath });
    expect(hosts.placement(badKey)).toBeUndefined();
  }
  for (const [repository, worktree, host, location] of [
    ["/foreign", "/unknown", "worker", value],
    ["/local/repo", "/unknown", "missing", value],
    ["/local/repo", "/unknown", "worker", value],
    ["/local/repo", "/unknown", "worker", { ...value, path: `${path}/nested` }],
  ] as const) {
    hosts.rememberPlacement(repository, worktree, host, location);
    expect(hosts.placement(worktree)).toBeUndefined();
  }
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: "/different" }] };
  expect(hosts.placement(key)).toBeUndefined();
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  await hosts.action({ action: "remove", host: "worker" });
  expect(hosts.placement(key)).toBeUndefined();
});

test("forge inspection binds registered host, folder, checkout identity, branch, HEAD and unchanged local and remote origins", async () => {
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
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
    expect(result.result.facts.agents).toContainEqual({
      id: "custom",
      state: "unable",
      signIn: "unknown",
    });
  } finally {
    replaceConfigProviders([]);
  }
});

test("host copy resolves registrations and cached checkout paths without contacting a host", async () => {
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(hosts.copyValue({ kind: "copy-host-alias", host: "worker" })).toBe("worker");
  expect(hosts.copyValue({ kind: "copy-host-code-folder", host: "worker" })).toBe(facts.codeFolder);
  expect(
    hosts.copyValue({ kind: "copy-checkout-path", host: null, repository: "/local/repo" }),
  ).toBe("/local/repo");
  expect(() =>
    hosts.copyValue({ kind: "copy-checkout-path", host: "worker", repository: "/local/repo" }),
  ).toThrow();
  const { createHash } = await import("node:crypto");
  const checkout = `${facts.codeFolder}/repository-${createHash("sha256").update("git@forge.test:me/repo.git").digest("hex").slice(0, 24)}`;
  run.mockResolvedValueOnce({ ok: true, facts, checkout: { path: checkout, state: "clean" } });
  await hosts.action({ action: "locations" });
  run.mockClear();
  expect(
    hosts.copyValue({ kind: "copy-checkout-path", host: "worker", repository: "/local/repo" }),
  ).toBe(checkout);
  expect(run).not.toHaveBeenCalled();
  for (const input of [
    null,
    {},
    { kind: "unknown", host: "worker" },
    { kind: "copy-host-alias", host: "unknown" },
    { kind: "copy-host-code-folder", host: "worker", value: "secret" },
    { kind: "copy-checkout-path", host: "worker", repository: "/unknown" },
    { kind: "copy-checkout-path", host: 1, repository: "/local/repo" },
    { kind: "copy-checkout-path", host: "unknown", repository: "/local/repo" },
  ])
    expect(() => hosts.copyValue(input)).toThrow();
  repositories = [];
  expect(() =>
    hosts.copyValue({ kind: "copy-checkout-path", host: "worker", repository: "/local/repo" }),
  ).toThrow();
  await hosts.action({ action: "remove", host: "worker" });
  for (const kind of ["copy-host-alias", "copy-host-code-folder"])
    expect(() => hosts.copyValue({ kind, host: "worker" })).toThrow();
});

test.each([
  "valid",
  "missing",
  "head",
  "remote-origin",
  "local-origin",
  "repository",
  "registration",
])("review snapshots bind host evidence and recheck local authorization: %s", async (mode) => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  const origin = "git@forge.test:me/repo.git";
  const snapshot = { head: "b".repeat(40), digest: "c".repeat(64) };
  const tree = {
    path: `${facts.codeFolder}/.foom-worktree-review`,
    branch: "feature",
    identity: "a".repeat(64),
    changes: "",
    head: mode === "head" ? "d".repeat(40) : snapshot.head,
    origin: mode === "remote-origin" ? "https://other.test/o/r" : origin,
    ...(mode === "missing" ? {} : { snapshot }),
  };
  run.mockImplementationOnce(() => {
    if (mode === "local-origin")
      mock.execute.mockResolvedValue({ stdout: "git@other.test:me/repo.git" });
    if (mode === "repository") repositories = [];
    if (mode === "registration") settings = { ...settings, registeredHosts: [] };
    return Promise.resolve({ ok: true, facts, worktree: tree });
  });
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
  const result = hosts.worktree("worker", "/local/repo", {
    operation: "snapshot-worktree",
    path: tree.path,
    identity: tree.identity,
  });
  if (mode === "valid") await expect(result).resolves.toMatchObject({ snapshot });
  else await expect(result).rejects.toThrow();
});
test("tagged inventory survives a new hub owner, last-row absence and re-registration without adopting a foreign clone", async () => {
  const { createHash } = await import("node:crypto");
  const { locationId } = await import("../../../../src/main/control/metadata");
  const origin = "git@forge.test:me/repo.git";
  const directory = `repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
  const tree = {
    repository: `${facts.codeFolder}/${directory}`,
    path: `${facts.codeFolder}/.foom-worktree-orphan`,
    origin,
    branch: "unused",
    identity: "a".repeat(64),
  };
  const key = `/foom-remote/${locationId(JSON.stringify(["worker", tree.path]))}`;
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  const profile = "a".repeat(32);
  const inventory = { ok: true, facts, inventory: { own: [tree], other: 3 } } as const;
  run.mockResolvedValue(inventory);
  const fresh = () => new Hosts(store, () => repositories, "0.1.0", run, profile);
  hosts = fresh();
  const recovered = await hosts.worktrees("/local/repo");
  expect(recovered).toMatchObject([
    { path: key, host: "worker", branch: "unused", managed: false },
  ]);
  expect(hosts.placement(key)).toMatchObject({
    ...tree,
    localRepository: "/local/repo",
    host: "worker",
  });
  repositories = [{ path: "/local/second", name: "second" }, ...repositories];
  await hosts.worktrees("/local/second");
  expect(hosts.placement(key)?.localRepository).toBe("/local/second");
  expect(hosts.placement(key, "/local/repo")?.localRepository).toBe("/local/repo");
  expect(hosts.placement(key, "/local/second")?.localRepository).toBe("/local/second");
  expect(hosts.placement(key, "/local/unknown")).toBeUndefined();
  repositories = repositories.filter((repo) => repo.path !== "/local/second");
  expect(hosts.state().hosts[0]).toMatchObject({ foreignWorktrees: 3 });
  expect(JSON.stringify(hosts.state())).not.toContain(tree.path);
  expect(
    run.mock.calls.every(
      ([, request]) => request.operation === "list-worktrees" && request.profile === profile,
    ),
  ).toBe(true);
  hosts = fresh();
  expect(hosts.placement(key)).toBeUndefined();
  expect(await hosts.worktrees("/local/repo")).toEqual(recovered);
  await hosts.action({ action: "remove", host: "worker" });
  expect(hosts.placement(key)).toBeUndefined();
  expect(await hosts.worktrees("/local/repo")).toEqual([]);
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  expect(await fresh().worktrees("/local/repo")).toEqual(recovered);
  run.mockResolvedValue({
    ...inventory,
    inventory: {
      own: [
        { ...tree, repository: "/foreign/clone" },
        { ...tree, path: "/outside" },
      ],
      other: 3,
    },
  });
  expect(await fresh().worktrees("/local/repo")).toEqual([]);
  run.mockResolvedValue(inventory);
  mock.execute.mockResolvedValue({ stdout: "git@other.test:other/repo.git" });
  expect(await fresh().worktrees("/local/repo")).toEqual([]);
  mock.execute.mockResolvedValue({ stdout: origin });
  run.mockResolvedValue({ ...inventory, inventory: { own: [tree, tree], other: 3 } });
  expect(await fresh().worktrees("/local/repo")).toEqual([]);
  run.mockResolvedValue({ ok: false, reason: "unreachable" });
  hosts = fresh();
  expect(await hosts.worktrees("/local/repo")).toEqual([]);
  expect(hosts.state().hosts[0]?.foreignWorktrees).toBeUndefined();
});

test("a lost create reply reconciles tagged inventory without replaying creation or returning success", async () => {
  const { createHash } = await import("node:crypto");
  const origin = "git@forge.test:me/repo.git";
  const repository = `${facts.codeFolder}/repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
  const tree = {
    repository,
    origin,
    path: `${facts.codeFolder}/.foom-worktree-lost`,
    branch: "lost",
    identity: "a".repeat(64),
  };
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
  run.mockImplementation((_host, request) => {
    if (request.operation === "repository")
      return Promise.resolve({ ok: true, facts, checkout: { path: repository, state: "clean" } });
    if (request.operation === "create-worktree")
      return Promise.resolve({ ok: false, reason: "unreachable" });
    if (request.operation === "list-worktrees")
      return Promise.resolve({ ok: true, facts, inventory: { own: [tree], other: 0 } });
    throw new Error("Unexpected operation");
  });
  await expect(
    hosts.worktree("worker", "/local/repo", { operation: "create-worktree", branch: "lost" }),
  ).rejects.toBeInstanceOf(UncertainEffect);
  expect(run.mock.calls.map(([, request]) => request.operation)).toEqual([
    "repository",
    "create-worktree",
    "list-worktrees",
  ]);
  expect(await hosts.worktrees("/local/repo")).toMatchObject([{ branch: "lost" }]);
  expect(
    run.mock.calls.filter(([, request]) => request.operation === "create-worktree"),
  ).toHaveLength(1);
});

test.each([
  ["create", "before"],
  ["create", "after"],
  ["lost-create", "before"],
  ["lost-create", "after"],
  ["remove", "before"],
  ["remove", "after"],
] as const)(
  "%s discards a pending pre-mutation inventory resolving %s the fresh response",
  async (mutation, staleOrder) => {
    const { createHash } = await import("node:crypto");
    const origin = "git@forge.test:me/repo.git";
    const repository = `${facts.codeFolder}/repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    const tree = {
      repository,
      origin,
      path: `${facts.codeFolder}/.foom-worktree-race`,
      branch: "race",
      identity: "a".repeat(64),
    };
    settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
    hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
    const stale = Promise.withResolvers<HostResult>();
    const fresh = Promise.withResolvers<HostResult>();
    let reads = 0;
    run.mockImplementation((_host, request) => {
      if (request.operation === "repository")
        return Promise.resolve({ ok: true, facts, checkout: { path: repository, state: "clean" } });
      if (request.operation === "list-worktrees")
        return ++reads === 1 ? stale.promise : fresh.promise;
      if (request.operation === "create-worktree" || request.operation === "remove-worktree")
        return Promise.resolve(
          mutation === "lost-create"
            ? { ok: false, reason: "unreachable" }
            : {
                ok: true,
                facts,
                worktree: {
                  path: tree.path,
                  branch: tree.branch,
                  identity: tree.identity,
                  changes: "",
                },
              },
        );
      throw new Error("Unexpected operation");
    });
    const oldInventory = hosts.worktrees("/local/repo");
    await vi.waitFor(() => {
      expect(reads).toBe(1);
    });
    const action =
      mutation === "remove"
        ? ({ operation: "remove-worktree", path: tree.path, identity: tree.identity } as const)
        : ({ operation: "create-worktree", branch: tree.branch } as const);
    const result = hosts.worktree("worker", "/local/repo", action).catch((error: unknown) => error);
    if (mutation === "lost-create")
      await vi.waitFor(() => {
        expect(reads).toBe(2);
      });
    else expect(await result).toMatchObject({ path: tree.path });
    const newInventory = hosts.worktrees("/local/repo");
    await vi.waitFor(() => {
      expect(reads).toBe(2);
    });
    const staleResult = {
      ok: true,
      facts,
      inventory: { own: mutation === "remove" ? [tree] : [], other: 7 },
    } as const;
    const freshResult = {
      ok: true,
      facts,
      inventory: { own: mutation === "remove" ? [] : [tree], other: 2 },
    } as const;
    if (staleOrder === "before") stale.resolve(staleResult);
    fresh.resolve(freshResult);
    const expected = mutation === "remove" ? [] : [expect.objectContaining({ branch: "race" })];
    expect(await newInventory).toEqual(expected);
    if (staleOrder === "after") stale.resolve(staleResult);
    expect(await oldInventory).toEqual(expected);
    if (mutation === "lost-create") expect(await result).toBeInstanceOf(UncertainEffect);
    expect(await hosts.worktrees("/local/repo")).toEqual(expected);
    expect(hosts.state().hosts[0]?.foreignWorktrees).toBe(2);
    expect(reads).toBe(2);
    expect(
      run.mock.calls.filter(([, request]) => request.operation === action.operation),
    ).toHaveLength(1);
  },
);

test("recipe clicks select main-owned data, recheck registrations, and return fixed unavailability", async () => {
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "f".repeat(32));
  const enriched = {
    ...facts,
    requirements: {
      distro: "debian" as const,
      libc: "supported" as const,
      packageManager: "apt" as const,
    },
  };
  run.mockResolvedValue({ ok: true, facts: enriched });
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  const launch = vi.fn(() => Promise.resolve());
  const state = await hosts.action(
    { action: "recipe", host: "worker", tool: "git", operation: "install" },
    undefined,
    launch,
  );
  expect(state.hosts[0]?.recipes).toContainEqual({ tool: "git", install: true, signIn: false });
  expect(launch).toHaveBeenCalledExactlyOnceWith({
    host: "worker",
    profile: "f".repeat(32),
    human: true,
    recipe: {
      tool: "git",
      distro: "debian",
      action: "install",
      digest: "ade67c0afec628cd6fba950e3f32b1160240445f9d486751b938e694fee2d3c2",
    },
  });
  expect(run).toHaveBeenLastCalledWith("worker", expect.objectContaining({ readOnly: true }));
  expect(
    (
      await hosts.action(
        { action: "recipe", host: "worker", tool: "codex", operation: "install" },
        undefined,
        launch,
      )
    ).recipeFailure,
  ).toBe("recipe-unavailable");
  expect(
    (await hosts.action({ action: "recipe", host: "worker", tool: "gh", operation: "sign-in" }))
      .recipeFailure,
  ).toBe("recipe-unavailable");
  settings.agents = { ...settings.agents, codex: false };
  expect(
    (
      await hosts.action(
        { action: "recipe", host: "worker", tool: "codex", operation: "sign-in" },
        undefined,
        launch,
      )
    ).recipeFailure,
  ).toBe("recipe-unavailable");
  await expect(
    hosts.action(
      { action: "recipe", host: "worker", tool: "git", operation: "install", argv: ["id"] },
      undefined,
      launch,
    ),
  ).rejects.toThrow("Invalid");
  run.mockResolvedValue({ ok: false, reason: "unreachable" });
  expect(
    (
      await hosts.action(
        { action: "recipe", host: "worker", tool: "git", operation: "install" },
        undefined,
        launch,
      )
    ).recipeFailure,
  ).toBe("recipe-unavailable");
  expect(launch).toHaveBeenCalledTimes(1);
});

test.each([
  ["facts-unavailable", "remote_host_facts_unavailable"],
  ["libc-too-old", "remote_host_libc_too_old"],
  ["libc-unsupported", "remote_host_libc_unsupported"],
  ["unsupported", "remote_artifact_mismatch"],
] as const)(
  "unsupported inventory %s retains a specific launch reason",
  async (reason, launchReason) => {
    await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
    hosts = new Hosts(store, () => repositories, "0.1.0", run);
    run.mockResolvedValue({ ok: false, reason });
    await expect(hosts.requireAgent("worker", "codex")).rejects.toMatchObject({
      reason: launchReason,
    });
  },
);

test("remote home shells require a current registration and profile tag", async () => {
  expect(() => hosts.shellTarget("unknown")).toThrow();
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(() => hosts.shellTarget("worker")).toThrow();
  const tagged = new Hosts(store, () => repositories, "0.1.0", run, "f".repeat(32));
  expect(tagged.shellTarget("worker")).toEqual({
    host: "worker",
    profile: "f".repeat(32),
    human: true,
  });
});

test("preflight collects repository origin and checkout observations despite a missing folder", async () => {
  run.mockImplementation((_host, request) =>
    Promise.resolve(
      request.operation === "inspect"
        ? {
            ok: true,
            facts: {
              ...facts,
              folder: { state: "fail", reason: "folder-missing" },
              tools: [{ id: "git", state: "ready", signIn: "unknown" }],
            },
          }
        : { ok: false, reason: request.operation === "origin" ? "origin-auth" : "folder-refused" },
    ),
  );
  const state = await hosts.action({ action: "preflight", host: "worker", codeFolder: "~/code" });
  expect(state.preflight).toMatchObject({
    ssh: { state: "pass" },
    platform: { state: "pass" },
    artifact: { state: "pass" },
    result: { ok: true, facts: { folder: { state: "fail", reason: "folder-missing" } } },
    repositories: [
      {
        repository: "/local/repo",
        origin: { state: "fail", reason: "origin-auth" },
        checkout: { ok: false, reason: "folder-refused" },
      },
    ],
  });
  expect(run.mock.calls.map(([, request]) => request.operation)).toEqual([
    "inspect",
    "origin",
    "repository",
  ]);
  expect(store.update).not.toHaveBeenCalled();
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(settings.registeredHosts).toEqual([{ host: "worker", codeFolder: facts.codeFolder }]);
  run.mockResolvedValue({ ok: true, facts });
  await hosts.action({ action: "create-folder", host: "worker" });
  expect(run.mock.lastCall?.[1].operation).toBe("create-folder");
  await hosts.action({ action: "change-folder", host: "worker", codeFolder: "~/different" });
  expect(run.mock.lastCall?.[1]).toMatchObject({
    operation: "inspect",
    readOnly: true,
    partial: true,
  });
});

test.each([
  "unreachable",
  "artifact-unavailable",
  "unsupported",
  "libc-too-old",
  "facts-unavailable",
] as const)("incomplete enrollment retains %s and can be retried", async (reason) => {
  run.mockResolvedValue({ ok: false, reason });
  const state = await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  expect(state.hosts[0]).toMatchObject({
    host: "worker",
    codeFolder: "~/code",
    result: { ok: false, reason },
  });
  run.mockResolvedValue({ ok: true, facts });
  await hosts.action({ action: "refresh", host: "worker" });
  expect(settings.registeredHosts).toEqual([{ host: "worker", codeFolder: facts.codeFolder }]);
});

test("preflight preserves independent bootstrap observations and local origin refusal", async () => {
  run.mockResolvedValue({
    ok: false,
    reason: "artifact-unavailable",
    connection: {
      ssh: { state: "pass" },
      platform: { state: "fail", reason: "libc-too-old" },
      artifact: { state: "fail", reason: "artifact-unavailable" },
    },
  });
  mock.execute.mockRejectedValue(new Error("raw local origin"));
  const state = await hosts.action({ action: "preflight", host: "worker", codeFolder: "~/code" });
  expect(state.preflight).toMatchObject({
    ssh: { state: "pass" },
    platform: { state: "fail", reason: "libc-too-old" },
    artifact: { state: "fail", reason: "artifact-unavailable" },
    repositories: [
      {
        origin: { state: "fail", reason: "origin-unavailable" },
        checkout: { ok: false, reason: "origin-unavailable" },
      },
    ],
  });
  expect(JSON.stringify(state)).not.toContain("raw");
});

test("opening Hosts retains pending folders without remote reads", async () => {
  settings = {
    ...settings,
    registeredHosts: [
      { host: "worker", codeFolder: "~/code" },
      { host: "other", codeFolder: "/other/code" },
    ],
  };
  run.mockImplementation((_host, request) =>
    Promise.resolve({
      ok: true,
      facts: {
        ...facts,
        codeFolder: request.codeFolder.startsWith("~/") ? facts.codeFolder : request.codeFolder,
      },
    }),
  );
  const state = await hosts.action({ action: "list" });
  expect(state.hosts.map(({ host, codeFolder }) => ({ host, codeFolder }))).toEqual([
    { host: "worker", codeFolder: "~/code" },
    { host: "other", codeFolder: "/other/code" },
  ]);
  expect(run).not.toHaveBeenCalled();
});

test("preflight refreshes registered facts without running origin Git when Git is missing", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: "~/code" }] };
  run.mockImplementation((_host, request) =>
    Promise.resolve(
      request.operation === "inspect"
        ? {
            ok: true,
            facts: { ...facts, tools: [{ id: "git", state: "missing", signIn: "unknown" }] },
          }
        : { ok: false, reason: "folder-refused" },
    ),
  );
  const state = await hosts.action({ action: "preflight", host: "worker", codeFolder: "~/code" });
  expect(state.preflight?.repositories[0]?.origin).toEqual({ state: "not-checked" });
  expect(state.hosts[0]?.codeFolder).toBe(facts.codeFolder);
  expect(state.hosts[0]?.result).toMatchObject({
    ok: true,
    facts: { tools: [{ id: "git", state: "missing" }] },
  });
  expect(run.mock.calls.map(([, request]) => request.operation)).toEqual(["inspect", "repository"]);
});

test("refresh recovers an incomplete host with profile session inventory before its folder is expanded", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: "~/code" }] };
  mock.inventory.mockResolvedValue({ type: "inventory-result", own: [], foreign: [] });
  const service = new Hosts(store, () => [], "0.1.0", run, "f".repeat(32));
  await service.action({ action: "refresh", host: "worker" });
  expect(mock.inventory.mock.lastCall?.[2]).toEqual({ type: "inventory", profile: "f".repeat(32) });
  expect(settings.registeredHosts).toEqual([{ host: "worker", codeFolder: facts.codeFolder }]);
  service.dispose();
});

test("sidebar location reads share a freshness cache and host mutations invalidate it", async () => {
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  const first = hosts.locationsForSidebar();
  expect(hosts.locationsForSidebar()).toBe(first);
  await first;
  await hosts.action({ action: "progress" });
  expect(hosts.locationsForSidebar()).toBe(first);
  const before = run.mock.calls.length;
  await hosts.locationsForSidebar();
  expect(run.mock.calls).toHaveLength(before);
  await hosts.action({ action: "remove", host: "worker" });
  expect(hosts.locationsForSidebar()).not.toBe(first);
  await hosts.locationsForSidebar();
});

test("sidebar locations refresh after repository additions and removals within the cache lifetime", async () => {
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  run.mockImplementation((_host, request) =>
    Promise.resolve({
      ok: true,
      facts,
      ...(request.operation === "repository"
        ? {
            checkout: { path: `${facts.codeFolder}/${request.directory}`, state: "clean" as const },
          }
        : {}),
    }),
  );
  try {
    const first = hosts.locationsForSidebar();
    expect((await first).locations.map((location) => location.repository)).toEqual(["/local/repo"]);
    expect(hosts.locationsForSidebar()).toBe(first);

    repositories.push({ path: "/local/added", name: "added" });
    const added = hosts.locationsForSidebar();
    expect(added).not.toBe(first);
    expect(hosts.locationsForSidebar()).toBe(added);
    expect((await added).locations.map((location) => location.repository)).toEqual([
      "/local/repo",
      "/local/added",
    ]);
    const probes = run.mock.calls.length;
    repositories = [...repositories].reverse().map((repo) => ({ ...repo, name: "renamed" }));
    expect(hosts.locationsForSidebar()).toBe(added);
    expect(run.mock.calls).toHaveLength(probes);

    repositories = repositories.filter((repo) => repo.path !== "/local/repo");
    const removed = hosts.locationsForSidebar();
    expect(removed).not.toBe(added);
    expect((await removed).locations.map((location) => location.repository)).toEqual([
      "/local/added",
    ]);
    expect(run.mock.calls).toHaveLength(probes + 1);
    expect(hosts.locationsForSidebar()).toBe(removed);

    now.mockReturnValue(61_001);
    const expired = hosts.locationsForSidebar();
    expect(expired).not.toBe(removed);
    await expired;
    expect(run.mock.calls).toHaveLength(probes + 2);
  } finally {
    now.mockRestore();
  }
});

test("repository human launch targets require an approved registration and checked clone", async () => {
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
  run.mockImplementation((_host, request) =>
    Promise.resolve({
      ok: true,
      facts,
      ...(request.operation === "repository"
        ? {
            checkout: { path: `${facts.codeFolder}/${request.directory}`, state: "clean" as const },
          }
        : {}),
    }),
  );
  const target = await hosts.repositoryTarget("worker", "/local/repo");
  expect(target).toMatchObject({
    host: "worker",
    human: true,
    profile: "a".repeat(32),
    machine: { codeFolder: facts.codeFolder, repository: { origin: "git@forge.test:me/repo.git" } },
  });
  expect(target.machine?.repository?.directory).toMatch(/^repository-[a-f0-9]{24}$/);
  await expect(hosts.repositoryTarget("unregistered", "/local/repo")).rejects.toThrow();
  await expect(hosts.repositoryTarget("worker", "/foreign")).rejects.toThrow();
  run.mockResolvedValue({ ok: false, reason: "unreachable" });
  await expect(hosts.repositoryTarget("worker", "/local/repo")).rejects.toThrow();
  run.mockResolvedValue({ ok: true, facts });
  await expect(hosts.repositoryTarget("worker", "/local/repo")).rejects.toThrow();
});

test("rename is profile-only, rejects collisions and preserves labels across folder updates", async () => {
  settings.registeredHosts = [
    { host: "worker", codeFolder: "~/code" },
    { host: "other", codeFolder: "~/code", nickname: "Other box" },
  ];
  await expect(
    hosts.action({ action: "rename", host: "missing", nickname: "Box" }),
  ).rejects.toThrow();
  await expect(
    hosts.action({ action: "rename", host: "worker", nickname: "OTHER BOX" }),
  ).rejects.toThrow("Name already used");
  await expect(
    hosts.action({ action: "rename", host: "worker", nickname: "<x>" }),
  ).rejects.toThrow();
  const renamed = await hosts.action({ action: "rename", host: "worker", nickname: "Build box" });
  expect(renamed.hosts[0]).toMatchObject({ host: "worker", nickname: "Build box" });
  expect(run).not.toHaveBeenCalled();
  expect(mock.remote).not.toHaveBeenCalled();
  expect(mock.execute).not.toHaveBeenCalled();
  await hosts.action({ action: "preflight", host: "worker", codeFolder: "~/code" });
  expect(settings.registeredHosts[0]?.nickname).toBe("Build box");
  await hosts.action({ action: "change-folder", host: "worker", codeFolder: "~/new" });
  expect(settings.registeredHosts[0]?.nickname).toBe("Build box");
  expect(JSON.stringify(run.mock.calls)).not.toContain("Build box");
  await hosts.action({ action: "rename", host: "worker", nickname: "" });
  expect(settings.registeredHosts[0]).toMatchObject({
    host: "worker",
    codeFolder: facts.codeFolder,
  });
  expect(settings.registeredHosts[0]?.nickname).toBeUndefined();
});

test("enrollment cannot introduce a default label that collides with an existing nickname", async () => {
  settings.registeredHosts = [{ host: "worker", codeFolder: "~/code", nickname: "Dozer" }];
  await expect(
    hosts.action({ action: "add", host: "me@dozer.local", codeFolder: "~/code" }),
  ).rejects.toThrow("Name already used");
  expect(run).not.toHaveBeenCalled();
});

test("a colliding nickname reset leaves the profile valid and survives reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-nickname-reset-"));
  const persisted = await SettingsStore.open(directory);
  const service = new Hosts(persisted, () => [], "0.1.0", run);
  try {
    await persisted.update({ setupComplete: true, hooks: false });
    for (const host of ["one.local", "two.local"])
      await service.action({ action: "add", host, codeFolder: "~/code" });
    await service.action({ action: "rename", host: "one.local", nickname: "Build box" });
    await service.action({ action: "rename", host: "two.local", nickname: "ONE" });
    expect(registeredHosts(persisted.get().registeredHosts)).toBe(true);
    const before = await readFile(join(directory, "settings.json"), "utf8");
    await expect(
      service.action({ action: "rename", host: "one.local", nickname: "" }),
    ).rejects.toThrow("Name already used");
    expect(await readFile(join(directory, "settings.json"), "utf8")).toBe(before);
    const reopened = await SettingsStore.open(directory);
    expect(reopened.get()).toEqual(persisted.get());
    expect(reopened.get()).toMatchObject({
      setupComplete: true,
      hooks: false,
      registeredHosts: [
        { host: "one.local", nickname: "Build box" },
        { host: "two.local", nickname: "ONE" },
      ],
    });
    expect(registeredHosts(reopened.get().registeredHosts)).toBe(true);
  } finally {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local progress reads bypass the mutation queue and retain completed repository checks", async () => {
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  repositories = [
    { path: "/local/repo", name: "repo" },
    { path: "/local/next", name: "next" },
  ];
  const held: { release?: (result: HostResult) => void } = {};
  run.mockImplementation((_host, request) =>
    request.operation === "origin"
      ? new Promise((resolve) => {
          held.release = resolve;
        })
      : Promise.resolve({ ok: true, facts }),
  );
  const pending = hosts.action({
    action: "preflight",
    host: "worker",
    codeFolder: facts.codeFolder,
  });
  await vi.waitFor(() => {
    expect(held.release).toBeDefined();
  });
  const calls = run.mock.calls.length;
  const snapshot = await hosts.action({ action: "progress" });
  expect(run).toHaveBeenCalledTimes(calls);
  expect(snapshot.progress).toMatchObject({
    host: "worker",
    phase: "origin",
    repository: "/local/repo",
    repositories: [{ repository: "/local/repo" }, { repository: "/local/next" }],
  });
  const finish = (result: HostResult) => {
    held.release?.(result);
    delete held.release;
  };
  finish({ ok: false, reason: "origin-auth" });
  await vi.waitFor(() => {
    expect(held.release).toBeDefined();
  });
  expect((await hosts.action({ action: "progress" })).progress).toMatchObject({
    phase: "origin",
    repository: "/local/next",
    repositories: [
      {
        repository: "/local/repo",
        origin: { state: "fail", reason: "origin-auth" },
        checkout: { ok: false, reason: "checkout-refused" },
      },
      { repository: "/local/next" },
    ],
  });
  expect(snapshot.progress?.repositories[0]?.origin).toBeUndefined();
  finish({ ok: true, facts });
  await pending;
  expect((await hosts.action({ action: "progress" })).progress).toBeUndefined();
});

test("Trust host key re-reads registered origin and launches a human tile with no renderer command", async () => {
  hosts = new Hosts(store, () => repositories, "0.1.0", run, "f".repeat(32));
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code" });
  const launch = vi.fn(async () => {});
  await hosts.action(
    { action: "trust-origin", host: "worker", repository: "/local/repo" },
    undefined,
    launch,
  );
  expect(launch).toHaveBeenCalledExactlyOnceWith({
    host: "worker",
    profile: "f".repeat(32),
    human: true,
    trustOrigin: "git@forge.test:me/repo.git",
  });
  await expect(
    hosts.action(
      { action: "trust-origin", host: "worker", repository: "/unregistered" },
      undefined,
      launch,
    ),
  ).rejects.toThrow("not registered");
  mock.execute.mockResolvedValue({ stdout: "https://forge.test/me/repo.git" });
  expect(
    (
      await hosts.action(
        { action: "trust-origin", host: "worker", repository: "/local/repo" },
        undefined,
        launch,
      )
    ).recipeFailure,
  ).toBe("recipe-unavailable");
  expect(launch).toHaveBeenCalledTimes(1);
});

test("session metadata can read cached fleet observations without waiting for stale or unavailable SSH", async () => {
  settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] };
  expect(await hosts.fleet(false)).toEqual([
    { host: "worker", result: { ok: false, reason: "facts-unavailable" } },
  ]);
  expect(run).not.toHaveBeenCalled();
  const cached = await hosts.inventory("worker");
  run.mockClear();
  settings = { ...settings, agents: { ...settings.agents, codex: false } };
  expect(await hosts.fleet(false)).toEqual([{ host: "worker", result: cached }]);
  expect(run).not.toHaveBeenCalled();
  run.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
  await hosts.fleet();
  run.mockClear();
  expect(await hosts.fleet(false)).toEqual([
    { host: "worker", result: { ok: false, reason: "unreachable" } },
  ]);
  expect(run).not.toHaveBeenCalled();
  settings = { ...settings, registeredHosts: [] };
  expect(await hosts.fleet(false)).toEqual([]);
});

test("saved full checks survive restart as display data, list makes no SSH reads and remove deletes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-observation-"));
  const profile = "a".repeat(32);
  try {
    const persisted = await SettingsStore.open(root);
    await persisted.update({ registeredHosts: [{ host: "worker", codeFolder: facts.codeFolder }] });
    mock.inventory.mockResolvedValue({
      type: "inventory-result",
      own: [{ id: "private-own-id" }],
      foreign: [{ id: "private-other-id", generation: "b".repeat(32) }],
    });
    const first = new Hosts(persisted, () => repositories, "0.1.0", run, profile);
    const checked = await first.action({
      action: "preflight",
      host: "worker",
      codeFolder: facts.codeFolder,
    });
    const observation = checked.hosts[0]?.observation;
    expect(observation?.checkedAt).toBeGreaterThan(0);
    expect(observation?.foreignSessions).toBe(1);
    expect(mock.inventory).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.some(([, request]) => request.operation === "list-worktrees")).toBe(true);
    first.dispose();
    run.mockClear();
    mock.inventory.mockClear();
    const reopened = await SettingsStore.open(root);
    const second = new Hosts(reopened, () => repositories, "0.1.0", run, profile);
    const listed = await second.action({ action: "list" });
    expect(listed.hosts[0]?.observation).toEqual(observation);
    expect(listed.hosts[0]?.result).toEqual(checked.hosts[0]?.result);
    expect(listed.hosts[0]?.result).toMatchObject({ facts: { sessions: 2 } });
    expect(listed.hosts[0]?.foreignSessions).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(mock.inventory).not.toHaveBeenCalled();
    const disk = await readFile(join(root, "settings.json"), "utf8");
    expect(disk).not.toContain("private-own-id");
    expect(disk).not.toContain("private-other-id");
    await second.action({ action: "remove", host: "worker" });
    expect(await readFile(join(root, "settings.json"), "utf8")).not.toContain("observation");
    second.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list bypasses a pending remote check without starting session or worktree inventory", async () => {
  settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
  let finish: ((result: HostResult) => void) | undefined;
  run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = hosts.action({
    action: "preflight",
    host: "worker",
    codeFolder: facts.codeFolder,
  });
  await vi.waitFor(() => {
    expect(run).toHaveBeenCalledTimes(1);
  });
  expect((await hosts.action({ action: "list" })).hosts).toHaveLength(1);
  expect(run).toHaveBeenCalledTimes(1);
  expect(mock.inventory).not.toHaveBeenCalled();
  finish?.({ ok: false, reason: "unreachable" });
  await pending;
  expect((await hosts.action({ action: "list" })).hosts[0]?.observation?.preflight.result).toEqual({
    ok: false,
    reason: "unreachable",
  });
});

test("a saved ready result cannot authorize an agent launch after restart", async () => {
  const result: HostResult = {
    ok: true,
    facts: { ...facts, agents: [{ id: "claude", state: "ready" }] },
  };
  settings.registeredHosts = [
    {
      host: "worker",
      codeFolder: facts.codeFolder,
      observation: {
        checkedAt: Date.now(),
        preflight: {
          result,
          ssh: { state: "pass" },
          platform: { state: "pass" },
          artifact: { state: "pass" },
          repositories: [],
        },
      },
    },
  ];
  expect((await hosts.action({ action: "list" })).hosts[0]?.result).toEqual(result);
  expect(run).not.toHaveBeenCalled();
  run.mockResolvedValueOnce({ ok: false, reason: "unreachable" });
  await expect(hosts.requireAgent("worker", "claude")).rejects.toMatchObject({
    reason: "remote_host_unreachable",
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect((await hosts.action({ action: "list" })).hosts[0]?.result).toEqual(result);
});

test("saved Brew recipes survive a new owner without remote reads but cannot authorize actions", async () => {
  const fixture = await restartedBrewHost();
  try {
    const listed = await fixture.hosts.action({ action: "list" });
    expect(listed.hosts[0]?.recipes).toEqual(fixture.checked.hosts[0]?.recipes);
    for (const recipe of [
      { tool: "git", install: true, signIn: false },
      { tool: "gh", install: true, signIn: true },
      { tool: "codex", install: true, signIn: true },
    ])
      expect(listed.hosts[0]?.recipes).toContainEqual(recipe);
    expect(fixture.run).not.toHaveBeenCalled();
    expect(mock.inventory).not.toHaveBeenCalled();
    const launch = vi.fn(() => Promise.resolve());
    fixture.run.mockResolvedValue({ ok: false, reason: "unreachable" });
    for (const [tool, operation] of [
      ["git", "install"],
      ["gh", "sign-in"],
      ["codex", "sign-in"],
    ] as const) {
      expect(
        (
          await fixture.hosts.action(
            { action: "recipe", host: "mac-fixture", tool, operation },
            undefined,
            launch,
          )
        ).recipeFailure,
      ).toBe("recipe-unavailable");
    }
    expect(fixture.run).toHaveBeenCalledTimes(3);
    expect(fixture.run).toHaveBeenLastCalledWith(
      "mac-fixture",
      expect.objectContaining({ operation: "inspect", readOnly: true, partial: true }),
    );
    expect(launch).not.toHaveBeenCalled();
    expect((await fixture.hosts.action({ action: "list" })).hosts[0]?.recipes).toEqual(
      listed.hosts[0]?.recipes,
    );
  } finally {
    await fixture.dispose();
  }
});

test.each([undefined, { distro: "unknown", libc: "supported", packageManager: "none" }] as const)(
  "older or unsupported saved requirements %j expose no recipes",
  async (requirements) => {
    settings.registeredHosts = [
      {
        host: "worker",
        codeFolder: facts.codeFolder,
        observation: {
          checkedAt: 1,
          preflight: {
            ssh: { state: "pass" },
            platform: { state: "pass" },
            artifact: { state: "pass" },
            repositories: [],
            result: { ok: true, facts: { ...facts, ...(requirements ? { requirements } : {}) } },
          },
        },
      },
    ];
    const listed = await hosts.action({ action: "list" });
    expect(listed.hosts[0]?.recipes?.every((recipe) => !recipe.install && !recipe.signIn)).toBe(
      true,
    );
    expect(run).not.toHaveBeenCalled();
  },
);

test("malformed saved requirements are rejected on reload without remote reads", async () => {
  const fixture = await restartedBrewHost();
  try {
    const registrations = fixture.store.get().registeredHosts?.map((entry) => ({
      ...entry,
      observation: entry.observation && {
        ...entry.observation,
        preflight: {
          ...entry.observation.preflight,
          result: {
            ok: true,
            facts: {
              ...facts,
              requirements: {
                distro: "darwin",
                libc: "supported",
                packageManager: "run-this-command",
              },
            },
          },
        },
      },
    }));
    await writeFile(
      join(fixture.root, "settings.json"),
      JSON.stringify({ version: 1, settings: { registeredHosts: registrations } }),
    );
    const reopened = await SettingsStore.open(fixture.root);
    const owner = new Hosts(reopened, () => [], "0.1.0", fixture.run);
    try {
      expect((await owner.action({ action: "list" })).hosts).toEqual([]);
      expect(fixture.run).not.toHaveBeenCalled();
    } finally {
      owner.dispose();
    }
  } finally {
    await fixture.dispose();
  }
});

test.each(["preflight", "refresh", "change-folder", "create-folder"] as const)(
  "rename saves while %s is pending and survives its reply",
  async (action) => {
    settings.registeredHosts = [{ host: "worker", codeFolder: "~/code" }];
    let finish: ((result: HostResult) => void) | undefined;
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const check = hosts.action({
      action,
      host: "worker",
      ...(action === "preflight" || action === "change-folder" ? { codeFolder: "~/code" } : {}),
    });
    await vi.waitFor(() => {
      expect(finish).toBeDefined();
    });
    await hosts.action({ action: "rename", host: "worker", nickname: "During check" });
    expect(settings.registeredHosts[0]?.nickname).toBe("During check");
    finish?.({ ok: true, facts });
    const reply = await check;
    expect(reply.hosts[0]?.nickname).toBe("During check");
    expect(settings.registeredHosts[0]?.nickname).toBe("During check");
  },
);

test("enrollment validates optional nicknames and saves them only with enrollment", async () => {
  await hosts.action({ action: "add", host: "worker", codeFolder: "~/code", nickname: "" });
  expect(settings.registeredHosts?.[0]?.nickname).toBeUndefined();
  await hosts.action({
    action: "add",
    host: "second",
    codeFolder: "~/code",
    nickname: "Build box",
  });
  expect(settings.registeredHosts?.[1]?.nickname).toBe("Build box");
  const calls = run.mock.calls.length;
  await expect(
    hosts.action({ action: "add", host: "third", codeFolder: "~/code", nickname: "BUILD BOX" }),
  ).rejects.toThrow("Name already used");
  await expect(
    hosts.action({ action: "add", host: "third", codeFolder: "~/code", nickname: " bad " }),
  ).rejects.toThrow("Invalid host action");
  expect(run).toHaveBeenCalledTimes(calls);
  run.mockResolvedValueOnce({ ok: false, reason: "invalid-reply" });
  await hosts.action({ action: "add", host: "third", codeFolder: "~/code", nickname: "Third" });
  expect(settings.registeredHosts).toHaveLength(2);
});

test("enrollment revalidates a nickname claimed during inspection and preserves concurrent renames", async () => {
  settings.registeredHosts = [{ host: "worker", codeFolder: "~/code" }];
  let finish: ((result: HostResult) => void) | undefined;
  run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const add = hosts.action({
    action: "add",
    host: "second",
    codeFolder: "~/code",
    nickname: "Claimed",
  });
  const rejected = expect(add).rejects.toThrow("Name already used");
  await vi.waitFor(() => {
    expect(finish).toBeDefined();
  });
  await hosts.action({ action: "rename", host: "worker", nickname: "Claimed" });
  finish?.({ ok: true, facts });
  await rejected;
  expect(settings.registeredHosts).toEqual([
    { host: "worker", codeFolder: "~/code", nickname: "Claimed" },
  ]);
});
