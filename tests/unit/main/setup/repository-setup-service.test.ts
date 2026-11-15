import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  openRepositorySetup,
  repositorySetupFor,
  repositoryToolchainPrefix,
} from "../../../../src/main/setup/repository-setup-service";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { inspectSetupSources } from "../../../../src/node-common/repository-setup-sources";
import { checkSetupList } from "../../../../src/node-common/repository-setup-check";
import type { SetupCheck } from "../../../../src/shared/repository-setup.d";
import type { Worktree } from "../../../../src/shared/worktrees";
import type { Hosts } from "../../../../src/main/setup/hosts";
vi.mock("../../../../src/main/agents/agents", () => ({
  loginPath: vi.fn(() => Promise.resolve({ path: "/fixture/bin" })),
}));
vi.mock("../../../../src/node-common/repository-setup-check", () => ({
  checkSetupList: vi.fn(),
  repositorySetupEnvironment: vi.fn(() => Promise.resolve({ PATH: "/fixture/bin" })),
  setupProbeDependencies: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../../../../src/node-common/repository-toolchain", () => ({
  selectedToolchainBins: vi.fn(() => Promise.resolve(["/private/toolchain/bin"])),
}));
let profile: string;
let repository: string;
const checked: SetupCheck = {
  platform: { distro: "debian", os: "linux", arch: "x64", nodeAbi: true },
  items: [{ id: "node", state: "met" }],
};
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "repository-setup-service-"));
  repository = join(profile, "repo");
  await mkdir(repository);
  await writeFile(join(repository, "package.json"), "{}");
  vi.mocked(checkSetupList).mockResolvedValue(checked);
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(profile, { recursive: true, force: true });
});
it("composes one profile owner and never uses saved facts as launch authority", async () => {
  const store = {
    get: () => ({
      ...DEFAULT_SETTINGS,
      registeredHosts: [{ host: "build", codeFolder: "/remote" }],
    }),
  };
  let removed: ((repository: string) => Promise<void>) | undefined;
  let hostRemoved: ((host: string) => Promise<void>) | undefined;
  const worktrees = {
    listRepositories: () => [{ path: repository, name: "repo" }],
    registrationIdentity: () => "registration",
    persistRegistrationIdentities: vi.fn(() => Promise.resolve()),
    launchIdentity: vi.fn(() => Promise.resolve("identity")),
    listWorktrees: (): Promise<readonly Worktree[]> =>
      Promise.resolve([
        {
          path: repository,
          head: "a".repeat(40),
          branch: "main",
          bare: false,
          managed: false,
          locked: false,
          prunable: false,
        },
      ]),
    onRemoved: (listener: (repository: string) => Promise<void>) => {
      removed = listener;
      return () => undefined;
    },
  };
  const sources = await inspectSetupSources(repository, ["package.json"]);
  const hosts = {
    repositorySetup: vi.fn<Hosts["repositorySetup"]>(() =>
      Promise.resolve({
        check: checked,
        sources,
        checkout: "/remote/repository",
        root: "/remote",
        sourcePath: "/remote/repository",
        head: "a".repeat(40),
      }),
    ),
    onRemoved: (listener: (host: string) => Promise<void>) => {
      hostRemoved = listener;
      return () => undefined;
    },
  };
  expect(() => repositorySetupFor(store)).toThrow("unavailable");
  expect(() => repositoryToolchainPrefix(store)).toThrow("unavailable");
  const service = await openRepositorySetup(store, profile, worktrees, hosts);
  expect(await openRepositorySetup(store, profile, worktrees, hosts)).toBe(service);
  expect(repositorySetupFor(store)).toBe(service);
  expect(repositoryToolchainPrefix(store)).toContain("toolchains");
  const launch = () => Promise.resolve("fixture");
  const confirm = () => Promise.resolve(true);
  const signal = new AbortController().signal;
  const reviewed = await service.action(
    "board",
    {
      action: "review",
      repository,
      draft: JSON.stringify({
        requirements: [
          {
            kind: "toolchain",
            id: "node",
            tool: "node",
            version: "24.x",
            purpose: "Build",
            sources: ["package.json"],
          },
        ],
        evidence: [],
      }),
    },
    confirm,
    launch,
    signal,
  );
  if (!reviewed.review) throw new Error("No review");
  expect(worktrees.persistRegistrationIdentities).not.toHaveBeenCalled();
  worktrees.persistRegistrationIdentities.mockRejectedValueOnce(
    new Error("Registration save failed"),
  );
  await expect(
    service.action(
      "board",
      { action: "approve", token: reviewed.review.token },
      confirm,
      launch,
      signal,
    ),
  ).rejects.toThrow("Registration save failed");
  expect(service.state("board").rows.every((row) => row.state === "no-list")).toBe(true);
  await service.action(
    "board",
    { action: "approve", token: reviewed.review.token },
    confirm,
    launch,
    signal,
  );
  expect((await service.admit(null, repository, repository)).paths).toEqual([
    "/private/toolchain/bin",
  ]);
  const remoteAdmission = await service.admit("build", repository, "/remote/worktree");
  expect(remoteAdmission.approval?.revision).toBe(1);
  if (!remoteAdmission.approval) throw new Error("No admission");
  expect(remoteAdmission.codeRoot).toBe("/remote");
  expect(hosts.repositorySetup).toHaveBeenCalledWith(
    "build",
    repository,
    expect.anything(),
    expect.anything(),
    "/remote/worktree",
  );
  hosts.repositorySetup.mockResolvedValueOnce({
    check: checked,
    root: "/remote",
    sourcePath: "/remote/repository",
  });
  await expect(service.admit("build", repository, "/remote/worktree")).rejects.toThrow();
  worktrees.launchIdentity.mockResolvedValueOnce("before").mockResolvedValueOnce("after");
  await expect(
    service.action("board", { action: "review", repository }, confirm, launch, signal),
  ).rejects.toThrow("Checkout changed");
  if (!removed || !hostRemoved) throw new Error("No removal listeners");
  await hostRemoved("build");
  await removed(repository);
  expect(service.state("board").rows.every((row) => row.state === "no-list")).toBe(true);
});
