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
