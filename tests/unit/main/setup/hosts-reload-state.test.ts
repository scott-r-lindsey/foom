import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Hosts } from "../../../../src/main/setup/hosts";
import { SettingsStore } from "../../../../src/main/setup/settings";
import type { HostManagement, HostResult } from "../../../../src/shared/registered-hosts.d";

const connection = {
  ssh: { state: "pass" as const },
  platform: { state: "pass" as const },
  artifact: { state: "pass" as const },
};
const good: Extract<HostResult, { ok: true }> = {
  ok: true,
  connection,
  facts: {
    codeFolder: "/remote/code",
    version: "0.1.0",
    sessions: 0,
    cores: 8,
    load: [0, 0, 0],
    memoryTotal: 8000,
    memoryAvailable: 4000,
    folder: { state: "pass" },
    requirements: { distro: "debian", libc: "supported", packageManager: "apt" },
    tools: [{ id: "git", state: "ready", signIn: "unknown" }],
    agents: [{ id: "codex", state: "ready", signIn: "signed-in" }],
  },
};
// The bootstrap verified every connection stage before the daemon stopped responding.
const failed: HostResult = { ok: false, reason: "unreachable", connection };
const roots: string[] = [];
const owners: Hosts[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hosts-reload-state-"));
  roots.push(root);
  const run = vi
    .fn<(host: string, request: HostManagement) => Promise<HostResult>>()
    .mockResolvedValue(good);
  const store = await SettingsStore.open(root);
  await store.update({
    registeredHosts: [
      {
        host: "fixture",
        codeFolder: good.facts.codeFolder,
        observation: {
          checkedAt: 1234,
          preflight: {
            ...connection,
            result: good,
            repositories: [
              {
                repository: "/local/repo",
                origin: { state: "pass" },
                checkout: { ...good, checkout: { path: "/remote/code/repo", state: "clean" } },
              },
            ],
          },
        },
      },
    ],
  });
  const reopen = async () => {
    const reopened = await SettingsStore.open(root);
    const hosts = new Hosts(reopened, () => [], "0.1.0", run);
    owners.push(hosts);
    return hosts;
  };
  return { hosts: await reopen(), reopen, run };
}

test.each(["ssh", "platform", "artifact"] as const)(
  "%s reload persists the same daemon failure as a full check after artifact verification",
  async (kind) => {
    const { hosts, reopen, run } = await fixture();
    run.mockResolvedValue(failed);
    const row = await hosts.action({ action: "reload", host: "fixture", target: { kind } });
    expect(row.preflight).toMatchObject({
      ssh: { state: "pass" },
      platform: { state: "pass" },
      artifact: { state: "fail", reason: "unreachable" },
      result: failed,
    });
    const restarted = await reopen();
    const saved = (await restarted.action({ action: "list" })).hosts[0]?.observation;
    expect(saved?.preflight).toEqual(row.preflight);
    expect(saved?.lastAgents).toEqual({ checkedAt: 1234, result: good });
    const full = await restarted.action({
      action: "preflight",
      host: "fixture",
      codeFolder: good.facts.codeFolder,
    });
    for (const stage of ["ssh", "platform", "artifact", "result"] as const)
      expect(row.preflight?.[stage]).toEqual(full.preflight?.[stage]);
  },
);

test.each(["ssh", "platform", "artifact"] as const)(
  "%s recovery survives reopening without fabricating dependent passes or a fresh full check",
  async (kind) => {
    const { hosts, reopen, run } = await fixture();
    run.mockResolvedValue(failed);
    await hosts.action({ action: "reload", host: "fixture", target: { kind: "artifact" } });
    hosts.dispose();
    const restarted = await reopen();
    run.mockClear().mockResolvedValue(good);
    await restarted.action({ action: "reload", host: "fixture", target: { kind } });
    restarted.dispose();
    const recovered = (await (await reopen()).action({ action: "list" })).hosts[0]?.observation;
    expect(recovered?.checkedAt).toBe(1234);
    expect(recovered?.preflight).toMatchObject({
      ...connection,
      result: { ok: true, facts: { folder: { state: "not-checked" }, agents: [] } },
    });
    expect(recovered?.preflight.result).not.toHaveProperty("facts.tools");
    expect(recovered?.preflight.result).not.toHaveProperty("facts.requirements");
    expect(recovered?.preflight.repositories[0]?.origin).toEqual({ state: "not-checked" });
    expect(recovered?.preflight.repositories[0]?.checkout).not.toHaveProperty("checkout");
    expect(recovered?.lastAgents).toEqual({ checkedAt: 1234, result: good });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.lastCall?.[1]).toMatchObject({ operation: "inspect", target: { kind } });
  },
);

test("connection recovery invalidates the old inventory timestamp instead of authorizing partial facts", async () => {
  const { hosts, run } = await fixture();
  vi.spyOn(Date, "now").mockReturnValue(10000);
  await hosts.inventory("fixture");
  run.mockResolvedValue(failed);
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "ssh" } });
  run.mockResolvedValue(good);
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "artifact" } });
  run.mockClear();
  await hosts.inventory("fixture");
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.lastCall?.[1]).not.toHaveProperty("target");
});

test("connection recovery removes an obsolete resource refresh failure from the reply", async () => {
  const { hosts, run } = await fixture();
  run.mockResolvedValue(failed);
  await hosts.action({ action: "refresh", host: "fixture" });
  run.mockResolvedValue(good);
  const recovered = await hosts.action({
    action: "reload",
    host: "fixture",
    target: { kind: "artifact" },
  });
  expect(recovered.hosts[0]?.result?.ok).toBe(true);
  expect((await hosts.action({ action: "list" })).hosts[0]?.result?.ok).toBe(true);
});

test("a second failure after partial recovery retains the last full successful agent history", async () => {
  const { hosts, run, reopen } = await fixture();
  run.mockResolvedValue(failed);
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "artifact" } });
  run.mockResolvedValue(good);
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "artifact" } });
  run.mockResolvedValue(failed);
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "ssh" } });
  const saved = (await (await reopen()).action({ action: "list" })).hosts[0]?.observation;
  expect(saved?.lastAgents).toEqual({ checkedAt: 1234, result: good });
  expect(saved?.preflight.result.ok).toBe(false);
});

test("a failed full check after partial recovery keeps the last full successful agent history", async () => {
  const { hosts, run, reopen } = await fixture();
  run.mockResolvedValue(failed);
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "artifact" } });
  run.mockResolvedValue(good);
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "artifact" } });
  run.mockResolvedValue(failed);
  await hosts.action({ action: "preflight", host: "fixture", codeFolder: good.facts.codeFolder });
  const saved = (await (await reopen()).action({ action: "list" })).hosts[0]?.observation;
  expect(saved?.lastAgents).toEqual({ checkedAt: 1234, result: good });
  expect(saved?.preflight.result.ok).toBe(false);
});
