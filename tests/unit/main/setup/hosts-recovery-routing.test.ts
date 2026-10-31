import type * as remoteTransport from "../../../../src/main/terminals/remote-transport";

import type * as childProcess from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
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
import { Hosts } from "../../../../src/main/setup/hosts";
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

import { createWorkspace, deps, confirm } from "../workspace/orchestration-workspace-fixture";
import { createHash } from "node:crypto";

test.each(["/local/repo", "/local/second"])(
  "recovered checkout can be removed from the listing clone %s",
  async (repository) => {
    const origin = "git@forge.test:me/repo.git";
    repositories = [
      { path: "/local/repo", name: "first-clone" },
      { path: "/local/second", name: "second-clone" },
    ];
    settings.registeredHosts = [{ host: "worker", codeFolder: facts.codeFolder }];
    const remoteRepository = `${facts.codeFolder}/repository-${createHash("sha256").update(origin).digest("hex").slice(0, 24)}`;
    const tree = {
      repository: remoteRepository,
      path: `${facts.codeFolder}/.foom-worktree-owned`,
      origin,
      branch: "topic",
      identity: "a".repeat(64),
    };
    let removed = false;
    run.mockImplementation((_host, request) => {
      if (request.operation === "list-worktrees")
        return Promise.resolve({
          ok: true,
          facts,
          inventory: { own: removed ? [] : [tree], other: 0 },
        });
      if (request.operation === "repository")
        return Promise.resolve({
          ok: true,
          facts,
          checkout: { path: remoteRepository, state: "clean" },
        });
      if (request.operation === "remove-worktree") removed = true;
      return Promise.resolve({
        ok: true,
        facts,
        worktree: { path: tree.path, branch: tree.branch, identity: tree.identity, changes: "" },
      });
    });
    hosts = new Hosts(store, () => repositories, "0.1.0", run, "a".repeat(32));
    const first = await hosts.worktrees("/local/repo");
    const second = await hosts.worktrees("/local/second");
    expect(second).toEqual(first);
    const path = second[0]?.path;
    if (!path) throw new Error("Missing recovered checkout");
    expect(hosts.placement(path, repository)?.localRepository).toBe(repository);
    expect(hosts.placement(path, "/unregistered")).toBeUndefined();
    const workspace = createWorkspace({
      ...deps,
      hosts,
      worktrees: {
        ...deps.worktrees,
        listRepositories: () => repositories,
        listWorktrees: () => Promise.resolve([]),
      },
    });
    await expect(
      workspace.sidebarCommand({ kind: "remove-worktree", repository, worktree: path }, confirm),
    ).resolves.toBeUndefined();
    expect(removed).toBe(true);
  },
);
