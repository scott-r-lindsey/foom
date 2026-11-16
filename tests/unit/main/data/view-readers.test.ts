import { expect, test, vi } from "vitest";
import { createViewReader } from "../../../../src/main/data/view-readers";
import type { ViewOwners } from "../../../../src/main/data/view-readers";
import type { DataView } from "../../../../src/shared/data-views";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import type { HostsState, HostResult } from "../../../../src/shared/registered-hosts.d";
const result: HostResult = {
  ok: true,
  facts: {
    codeFolder: "/code",
    version: "1",
    sessions: 0,
    cores: 1,
    load: [],
    memoryTotal: 1,
    memoryAvailable: 1,
    tools: [],
    agents: [
      {
        id: "codex",
        state: "ready",
        signIn: "signed-in",
        details: { path: "/bin/codex", version: "1", capabilities: [] },
      },
      { id: "missing", state: "missing", signIn: "unknown" },
    ],
  },
};
function fixture() {
  let hosts: HostsState = {
    hosts: [{ host: "worker", codeFolder: "/code", result }],
    locations: [],
  };
  const owners: ViewOwners = {
    settings: vi.fn(() => ({ settings: DEFAULT_SETTINGS, worktreeRoot: "/root" })),
    hosts: vi.fn(() => hosts),
    agents: vi.fn(() => Promise.resolve({ warning: null, agents: [] })),
    repositories: vi.fn(() => [{ path: "/registered", name: "registered" }]),
    worktrees: vi.fn(() => Promise.resolve([])),
    sessions: vi.fn(() => []),
    environment: vi.fn(() => ({
      lists: { all: [], claude: [], codex: [], agy: [] },
      windows: false,
      secrets: false,
    })),
    config: vi.fn(() => ({ folder: "/config", available: true, pending: null, rejected: [] })),
    fonts: vi.fn(() => Promise.resolve([])),
    sounds: vi.fn(() => Promise.resolve([])),
    readiness: vi.fn<ViewOwners["readiness"]>(() =>
      Promise.resolve({ git: "ready", platform: "linux", forges: [] }),
    ),
  };
  return {
    owners,
    read: createViewReader(owners),
    hosts: (next: HostsState) => {
      hosts = next;
    },
  };
}
test("closed views delegate only to the owning projection", async () => {
  const { owners, read } = fixture();
  const views: DataView[] = [
    "settings",
    "hosts",
    "agents",
    "repositories",
    "worktrees",
    "sessions",
    "environment",
    "config",
    "fonts",
    "sounds",
    "readiness",
  ];
  for (const view of views)
    await read(view, view === "worktrees" ? { repository: "/registered" } : {});
  expect(owners.worktrees).toHaveBeenCalledWith("/registered");
  expect(() => read("worktrees", {})).toThrow("Unknown repository");
  expect(() => read("worktrees", { repository: "/foreign" })).toThrow("Unknown repository");
  await read("agents", { machine: "local" });
  expect(owners.agents).toHaveBeenCalledTimes(2);
});
test("remote agents are observations of registered hosts and never invoke discovery", async () => {
  const f = fixture();
  const observed = await f.read("agents", { machine: "host:worker" });
  expect(observed).toMatchObject({
    agents: [
      { id: "codex", path: "/bin/codex", version: "1" },
      { id: "missing", path: null, version: null },
    ],
    machine: { hosts: [expect.objectContaining({ host: "worker" })] },
  });
  expect(f.owners.agents).not.toHaveBeenCalled();
  expect(() => f.read("agents", { machine: "host:foreign" })).toThrow("Unknown machine");
  f.hosts({
    hosts: [{ host: "worker", codeFolder: "/code", result: { ok: false, reason: "unreachable" } }],
    locations: [],
  });
  expect(await f.read("agents", { machine: "host:worker" })).toMatchObject({ agents: [] });
  f.hosts({ hosts: [{ host: "worker", codeFolder: "/code" }], locations: [] });
  expect(await f.read("agents", { machine: "host:worker" })).toMatchObject({ agents: [] });
});

test("the host projection primes local display capabilities before its snapshot", async () => {
  const f = fixture();
  const prepare = vi.fn(() => Promise.resolve());
  f.owners.prepareHosts = prepare;
  expect(await f.read("hosts", {})).toEqual(f.owners.hosts());
  expect(prepare).toHaveBeenCalledOnce();
});
