import { afterEach, expect, it, vi } from "vitest";
import { validateSetupAdmission } from "../../../src/node-common/repository-setup-admission";
import { inspectSetupSources } from "../../../src/node-common/repository-setup-sources";
import { checkSetupList } from "../../../src/node-common/repository-setup-check";
import { setupCatalogDigest } from "../../../src/node-common/repository-setup-digest";
import type { SetupAdmission, SetupCheck } from "../../../src/shared/repository-setup.d";
vi.mock("../../../src/node-common/repository-setup-sources", () => ({
  inspectSetupSources: vi.fn(),
}));
vi.mock("../../../src/node-common/repository-setup-check", () => ({
  checkSetupList: vi.fn(),
  repositorySetupEnvironment: vi.fn(() =>
    Promise.resolve({ HOME: "/fixture", PATH: "/fixture/bin" }),
  ),
  setupProbeDependencies: vi.fn(() => Promise.resolve({})),
}));
const admission: SetupAdmission = {
  list: {
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
    evidence: ["README.md"],
  },
  catalog: setupCatalogDigest,
  revision: 1,
  sources: "a".repeat(64),
};
const check: SetupCheck = {
  platform: { os: "linux", arch: "x64", distro: "debian", nodeAbi: true },
  items: [{ id: "node", state: "met" }],
};
const run = (value: SetupAdmission | undefined = admission, signal?: AbortSignal) =>
  validateSetupAdmission(value, "/fixture/checkout", "/fixture/prefix", {}, "/fixture", signal);
afterEach(() => {
  vi.resetAllMocks();
});
it("skips absent lists and independently validates sources and host facts for approved ones", async () => {
  expect(
    await validateSetupAdmission(undefined, "/checkout", "/prefix", {}, "/home"),
  ).toBeUndefined();
  vi.mocked(inspectSetupSources).mockResolvedValue({ fingerprint: admission.sources, files: [] });
  vi.mocked(checkSetupList).mockResolvedValue(check);
  expect(await run()).toMatchObject({ PATH: "/fixture/bin" });
  expect(inspectSetupSources).toHaveBeenCalledWith("/fixture/checkout", [
    "README.md",
    "package.json",
  ]);
});
it("rejects catalog and source changes and unreadable evidence", async () => {
  await expect(run({ ...admission, catalog: "b".repeat(64) })).rejects.toMatchObject({
    reason: "repository_setup_changed",
  });
  vi.mocked(inspectSetupSources).mockResolvedValueOnce({ fingerprint: "b".repeat(64), files: [] });
  await expect(run()).rejects.toMatchObject({ reason: "repository_setup_changed" });
  vi.mocked(inspectSetupSources).mockRejectedValueOnce(new Error("unreadable"));
  await expect(run()).rejects.toMatchObject({ reason: "repository_setup_unavailable" });
});
it("keeps missing, unknown and unsupported checks separate and rechecks cancellation", async () => {
  vi.mocked(inspectSetupSources).mockResolvedValue({ fingerprint: admission.sources, files: [] });
  for (const state of ["missing", "unable", "manual"] as const) {
    vi.mocked(checkSetupList).mockResolvedValueOnce({ ...check, items: [{ id: "node", state }] });
    await expect(run()).rejects.toMatchObject({
      reason:
        state === "missing"
          ? "repository_setup_missing"
          : state === "unable"
            ? "repository_setup_unavailable"
            : "repository_setup_manual",
    });
  }
  const abort = new AbortController();
  abort.abort();
  vi.mocked(checkSetupList).mockResolvedValueOnce(check);
  await expect(run(admission, abort.signal)).rejects.toThrow();
});
