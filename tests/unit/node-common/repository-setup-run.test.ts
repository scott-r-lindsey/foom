import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SetupCheck } from "../../../src/shared/repository-setup.d";
const mocks = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args: readonly string[], options: unknown) => EventEmitter>(),
  check: vi.fn(),
  install: vi.fn(() => Promise.resolve()),
  directory: vi.fn(() => Promise.resolve("/fixture")),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../../src/node-common/private-files", () => ({ privateDirectory: mocks.directory }));
vi.mock("../../../src/node-common/repository-toolchain", () => ({
  installSetupToolchain: mocks.install,
}));
vi.mock("../../../src/node-common/repository-setup-check", () => ({
  checkSetupList: mocks.check,
  repositorySetupEnvironment: vi.fn(() =>
    Promise.resolve({ HOME: "/fixture", PATH: "/fixture/bin" }),
  ),
  setupProbeDependencies: vi.fn(() =>
    Promise.resolve({ resolve: () => Promise.resolve("/fixture/brew") }),
  ),
}));
import {
  runRepositorySetup,
  setupRunDigest,
  remoteToolchainPrefix,
} from "../../../src/node-common/repository-setup-run";
import { setupCatalogDigest } from "../../../src/node-common/repository-setup-digest";
import { parseSetupList } from "../../../src/shared/repository-setup";
const list = parseSetupList(
  JSON.stringify({
    requirements: [
      {
        kind: "package",
        id: "native",
        purpose: "Build",
        sources: [],
        packages: { debian: ["gcc"], rhel: [], arch: [], darwin: ["pkg-config"] },
      },
      {
        kind: "toolchain",
        id: "node",
        tool: "node",
        version: "24.x",
        purpose: "Build",
        sources: [],
      },
    ],
    evidence: [],
  }),
);
const check: SetupCheck = {
  platform: { distro: "debian", os: "linux", arch: "x64", nodeAbi: true },
  items: [
    { id: "native", state: "missing" },
    { id: "node", state: "missing" },
  ],
};
const binding = {
  list,
  catalog: setupCatalogDigest,
  revision: 1,
  repository: "/repo",
  registration: "registration",
  host: "fixture",
  sources: "a".repeat(64),
  check,
};
const run = () => JSON.stringify({ ...binding, digest: setupRunDigest(binding) });
beforeEach(() => {
  mocks.check.mockResolvedValue(check);
  mocks.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it("reconstructs the digest and dispatches fixed argv in order without secrets", async () => {
  expect(await runRepositorySetup(run(), "/fixture/toolchains", {}, "/fixture")).toBe(0);
  expect(mocks.spawn.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "update"]],
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "install", "-y", "gcc"]],
  ]);
  expect(mocks.install).toHaveBeenCalledTimes(1);
  expect(remoteToolchainPrefix("/fixture")).toContain(".foom-repository-setup");
});
it("starts no later step after failure or Stop", async () => {
  mocks.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 7));
    return child;
  });
  expect(await runRepositorySetup(run(), "/fixture/toolchains", {}, "/fixture")).toBe(7);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.install).not.toHaveBeenCalled();
  mocks.spawn.mockClear();
  mocks.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      process.emit("SIGHUP");
      child.emit("exit", 0);
    });
    return child;
  });
  await expect(runRepositorySetup(run(), "/fixture/toolchains", {}, "/fixture")).rejects.toThrow();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(mocks.install).not.toHaveBeenCalled();
});
it("refuses changed facts, digests, catalogs and malformed input before dispatch", async () => {
  expect(await runRepositorySetup(undefined, "/fixture", {}, "/fixture")).toBe(2);
  expect(await runRepositorySetup("{}", undefined, {}, "/fixture")).toBe(2);
  expect(await runRepositorySetup("{", "/fixture", {}, "/fixture")).toBe(2);
  for (const value of [
    "x".repeat(65537),
    "{}",
    JSON.stringify({ ...binding, digest: "0".repeat(64) }),
    JSON.stringify({ ...binding, catalog: "b".repeat(64), digest: "0".repeat(64) }),
  ])
    expect(await runRepositorySetup(value, "/fixture", {}, "/fixture")).toBe(2);
  mocks.check.mockResolvedValueOnce({
    ...check,
    items: check.items.map((item) => ({ ...item, state: "met" })),
  });
  expect(await runRepositorySetup(run(), "/fixture", {}, "/fixture")).toBe(2);
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it("does not dispatch later steps after a package process cannot start", async () => {
  mocks.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("missing manager")));
    return child;
  });
  expect(await runRepositorySetup(run(), "/fixture/toolchains", {}, "/fixture")).toBe(1);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("uses only a validated Homebrew path and refuses its disappearance", async () => {
  const mac = {
    ...binding,
    check: {
      ...check,
      platform: { ...check.platform, os: "darwin" as const, distro: "darwin" as const },
    },
  };
  mocks.check.mockResolvedValue(mac.check);
  expect(
    await runRepositorySetup(
      JSON.stringify({ ...mac, digest: setupRunDigest(mac) }),
      remoteToolchainPrefix("/fixture"),
      {},
      "/fixture",
    ),
  ).toBe(0);
  expect(mocks.spawn).toHaveBeenCalledWith(
    "/fixture/brew",
    ["install", "pkg-config"],
    expect.objectContaining({ shell: false, cwd: "/fixture" }),
  );
  const { setupProbeDependencies } = await import(
    "../../../src/node-common/repository-setup-check"
  );
  const dependencies = await setupProbeDependencies({}, "/fixture");
  vi.mocked(setupProbeDependencies).mockResolvedValueOnce({
    ...dependencies,
    resolve: () => Promise.resolve(undefined),
  });
  expect(
    await runRepositorySetup(
      JSON.stringify({ ...mac, digest: setupRunDigest(mac) }),
      "/fixture/prefix",
      {},
      "/fixture",
    ),
  ).toBe(2);
});

it("keeps the canonical list bound separate from the bounded execution envelope", async () => {
  const list = parseSetupList(
    JSON.stringify({
      requirements: Array.from({ length: 128 }, (_, index) => ({
        kind: "package",
        id: `item-${String(index)}`,
        purpose: "a".repeat(370),
        sources: [],
        packages: { debian: [], rhel: [], arch: [], darwin: [] },
      })),
      evidence: [],
    }),
  );
  const checked = {
    ...check,
    items: list.requirements.map((item) => ({ id: item.id, state: "met" as const })),
  };
  const value = { ...binding, list, check: checked };
  const text = JSON.stringify({ ...value, digest: setupRunDigest(value) });
  expect(Buffer.byteLength(text)).toBeGreaterThan(65536);
  mocks.check.mockResolvedValueOnce(checked);
  expect(await runRepositorySetup(text, "/fixture/prefix", {}, "/fixture")).toBe(0);
  expect(await runRepositorySetup("x".repeat(128 * 1024 + 1), "/fixture", {}, "/fixture")).toBe(2);
});
