import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { LaunchFailure } from "../../../../src/shared/launch-failure";
import { ENABLED_AGENTS } from "../../../helpers/enabled-agents";
import { agents, deps, repo, tree } from "./workspace-fixture";

test("repository prerequisite refusal reaches launch wiring before any agent starts", async () => {
  const admit = vi.fn(() => Promise.reject(new LaunchFailure("repository_setup_missing")));
  deps.repositorySetup = { admit };
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ reason: "repository_setup_missing" });
  expect(admit).toHaveBeenCalledWith(null, repo.path, tree.path);
  expect(agents.launch).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toEqual([]);
  await workspace.dispose();
});

test("approval changes between preparation and spawn refuse a repository launch", async () => {
  const validate = vi.fn(() => {});
  const admit = vi.fn(() => Promise.resolve({ paths: ["/profile/toolchains/node/bin"], validate }));
  deps.repositorySetup = { admit };
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  agents.launch.mockImplementationOnce(async (request) => {
    await request.prepareSpawn?.();
    validate.mockImplementationOnce(() => {
      throw new LaunchFailure("repository_setup_changed");
    });
    request.beforeSpawn?.();
    return { id: "unexpected", attention: "hooks" };
  });
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toMatchObject({ reason: "repository_setup_changed" });
  expect(admit).toHaveBeenCalledTimes(2);
  expect(workspace.snapshot().terminals).toEqual([]);
  await workspace.dispose();
});

test("human setup uses only the fixed private CLI helper and cannot be restarted", async () => {
  const { configDep } = await import("./workspace-fixture");
  const run = {
    list: { requirements: [], evidence: [] },
    catalog: "a".repeat(64),
    revision: 1,
    repository: repo.path,
    registration: "fixture",
    host: "local",
    sources: "b".repeat(64),
    location: { root: repo.path, path: repo.path, present: true },
    digest: "c".repeat(64),
    check: {
      platform: {
        distro: "debian" as const,
        os: "linux" as const,
        arch: "x64" as const,
        nodeAbi: true,
      },
      items: [],
    },
  };
  const unavailable = new Workspace(deps);
  await expect(unavailable.startRepositorySetup(run, "/profile/toolchains")).rejects.toThrow(
    "unavailable",
  );
  await unavailable.dispose();
  deps.config = configDep();
  const create = vi.spyOn(deps.terminals, "create");
  const workspace = new Workspace(deps);
  const validate = vi.fn<() => Promise<void>>(() => Promise.resolve());
  validate.mockRejectedValueOnce(new Error("Sources changed"));
  await expect(
    workspace.startRepositorySetup(run, "/profile/toolchains", validate),
  ).rejects.toThrow("Sources changed");
  expect(create).not.toHaveBeenCalled();
  validate.mockClear();
  await workspace.startRepositorySetup(run, "/profile/toolchains", validate);
  expect(validate).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      command: join("/app/console", "foom"),
      args: ["--repository-setup", JSON.stringify(run), "/profile/toolchains"],
      replaceEnvironment: true,
      env: expect.objectContaining({ FOOM_SETTINGS_INSTALL: "1" }) as unknown,
    }),
  );
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    recipe: true,
    kind: "shell",
    home: true,
  });
  await workspace.dispose();
});
