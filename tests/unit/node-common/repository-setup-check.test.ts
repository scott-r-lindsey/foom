import type * as FileSystem from "node:fs/promises";
import type * as Probe from "../../../src/node-common/repository-setup-probe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, chmod, rm, writeFile, open, realpath, symlink } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import {
  checkSetupList,
  repositorySetupEnvironment,
  setupProbeDependencies,
} from "../../../src/node-common/repository-setup-check";
import type { SetupProbeDependencies } from "../../../src/node-common/repository-setup-check";
import { setupProbe, SetupProbeExit } from "../../../src/node-common/repository-setup-probe";
import { parseSetupList } from "../../../src/shared/repository-setup";
import { selectedToolchainBins } from "../../../src/node-common/repository-toolchain";
vi.mock("../../../src/node-common/repository-setup-probe", async (original) => ({
  ...(await original<typeof Probe>()),
  setupProbe: vi.fn(),
}));
vi.mock("../../../src/node-common/repository-toolchain", () => ({
  selectedToolchainBins: vi.fn(() => Promise.resolve([])),
}));
let root: string;
const originalPlatform = process.platform;
const originalArch = process.arch;
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof FileSystem>("node:fs/promises");
  vi.mocked(realpath).mockImplementation(actual.realpath);
  root = await mkdtemp(join(tmpdir(), "setup-check-"));
  await writeFile(join(root, "libstdcpp"), "GLIBCXX_3.4.25\0");
  await writeFile(join(root, "os-release"), "ID=debian\n");
  const { open: realOpen } = await vi.importActual<typeof FileSystem>("node:fs/promises");
  vi.mocked(open).mockImplementation((file, flags, mode) =>
    realOpen(
      file === "/etc/os-release"
        ? join(root, "os-release")
        : typeof file === "string" && file.endsWith("libstdc++.so.6")
          ? join(root, "libstdcpp")
          : file,
      flags,
      mode,
    ),
  );
  vi.mocked(setupProbe).mockResolvedValue("glibc 2.36\n");
});
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  Object.defineProperty(process, "arch", { value: originalArch });
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const list = parseSetupList(
  JSON.stringify({
    evidence: [],
    requirements: [
      {
        kind: "package",
        id: "native",
        purpose: "Native modules",
        sources: [],
        packages: { debian: ["gcc"], rhel: ["gcc"], arch: ["gcc"], darwin: ["pkg-config"] },
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
  }),
);
function deps(
  distro: SetupProbeDependencies["platform"]["distro"] = "debian",
): SetupProbeDependencies {
  return {
    platform: { distro, os: distro === "darwin" ? "darwin" : "linux", arch: "x64", nodeAbi: true },
    home: "/fixture",
    env: {},
    probe: vi.fn((command: string) =>
      Promise.resolve(
        command.endsWith("node") ? "v24.17.0\n" : distro === "debian" ? "installed" : "fixture 1.0",
      ),
    ),
    resolve: vi.fn((tool: string) => Promise.resolve(`/fixture/bin/${tool}`)),
  };
}
describe("fixed host prerequisite queries", () => {
  it.each(["debian", "rhel", "arch", "darwin"] as const)(
    "reduces met %s requirements without checkout execution",
    async (distro) => {
      const d = deps(distro);
      expect((await checkSetupList(list, d)).items.map((item) => item.state)).toEqual([
        "met",
        "met",
      ]);
      const calls = vi.mocked(d.probe).mock.calls;
      expect(calls[0]).toEqual(
        distro === "debian"
          ? ["/usr/bin/dpkg-query", ["--show", "--showformat=${db:Status-Status}", "--", "gcc"]]
          : distro === "rhel"
            ? ["/usr/bin/rpm", ["--query", "--", "gcc"]]
            : distro === "arch"
              ? ["/usr/bin/pacman", ["-Q", "--", "gcc"]]
              : ["/fixture/bin/brew", ["list", "--versions", "pkg-config"]],
      );
      expect(calls[1]?.[1]).toEqual(["--version"]);
    },
  );
  it("distinguishes missing, wrong version, unknown, unsupported and failed probes", async () => {
    const d = deps();
    vi.mocked(d.probe).mockResolvedValueOnce("not-installed").mockResolvedValueOnce("v26.0.0");
    expect((await checkSetupList(list, d)).items.map((item) => item.state)).toEqual([
      "missing",
      "missing",
    ]);
    vi.mocked(d.probe)
      .mockRejectedValueOnce(new SetupProbeExit(1))
      .mockResolvedValueOnce("custom unknown");
    expect((await checkSetupList(list, d)).items.map((item) => item.state)).toEqual([
      "missing",
      "unable",
    ]);
    vi.mocked(d.probe).mockRejectedValue(new Error("timeout"));
    expect((await checkSetupList(list, d)).items.every((item) => item.state === "unable")).toBe(
      true,
    );
    vi.mocked(d.resolve).mockResolvedValue(undefined);
    expect((await checkSetupList(list, d)).items[1]?.state).toBe("missing");
    expect(
      (await checkSetupList(list, deps("unsupported"))).items.every(
        (item) => item.state === "manual",
      ),
    ).toBe(true);
    const mac = deps("darwin");
    vi.mocked(mac.resolve).mockResolvedValue(undefined);
    expect((await checkSetupList(list, mac)).items[0]?.state).toBe("manual");
  });
  it("keeps absent Homebrew packages missing and explicit unsupported mappings manual", async () => {
    const mac = deps("darwin");
    vi.mocked(mac.probe).mockResolvedValue("");
    expect((await checkSetupList(list, mac)).items[0]?.state).toBe("missing");
    const unsupported = parseSetupList(
      JSON.stringify({
        requirements: [
          {
            kind: "package",
            id: "os",
            purpose: "Unsupported",
            sources: [],
            packages: { debian: "unsupported", rhel: [], arch: [], darwin: [] },
          },
        ],
        evidence: [],
      }),
    );
    expect((await checkSetupList(unsupported, deps())).items[0]?.state).toBe("manual");
  });
  it("omits all inherited secrets and unsafe PATH entries", async () => {
    const bins = join(root, "bin");
    const checkout = join(root, "checkout");
    await mkdir(bins);
    await mkdir(checkout);
    vi.mocked(selectedToolchainBins).mockResolvedValueOnce([bins]);
    const env = await repositorySetupEnvironment(
      {
        PATH: [".", "relative", checkout, bins, "/missing"].join(delimiter),
        FOOM_CONTROL_TOKEN: "secret",
        NODE_OPTIONS: "--require bad",
        ANTHROPIC_API_KEY: "secret",
      },
      checkout,
      root,
      ["node"],
      root,
    );
    expect(env).toEqual({ HOME: root, PATH: bins, LANG: "C", LC_ALL: "C", TERM: "xterm-256color" });
  });
  it("derives platform/ABI separately and resolves only safe installed executables", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    Object.defineProperty(process, "arch", { value: "x64" });
    await writeFile(join(root, "node"), "fixture");
    await chmod(join(root, "node"), 0o700);
    const d = await setupProbeDependencies({ PATH: [".", "/missing", root].join(delimiter) }, root);
    expect(d.platform).toMatchObject({ distro: "debian", arch: "x64", nodeAbi: true });
    expect(setupProbe).toHaveBeenCalledWith(
      "/usr/bin/getconf",
      ["GNU_LIBC_VERSION"],
      root,
      expect.objectContaining({
        COREPACK_ENABLE_NETWORK: "0",
        HOMEBREW_NO_AUTO_UPDATE: "1",
        HOMEBREW_NO_ANALYTICS: "1",
      }),
      undefined,
    );
    expect(await d.resolve("node")).toBe(join(root, "node"));
    expect(await d.resolve("pnpm")).toBeUndefined();
    expect(await d.resolve("brew")).toBeUndefined();
    vi.mocked(setupProbe).mockResolvedValueOnce("glibc 2.17\n");
    expect((await setupProbeDependencies({}, root)).platform.nodeAbi).toBe(false);
    Object.defineProperty(process, "platform", { value: "darwin" });
    vi.mocked(setupProbe).mockResolvedValueOnce("13.4\n");
    expect((await setupProbeDependencies({}, root)).platform.nodeAbi).toBe(false);
    vi.mocked(setupProbe).mockResolvedValueOnce("14.0\n");
    expect((await setupProbeDependencies({}, root)).platform.nodeAbi).toBe(true);
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "arch", { value: "ia32" });
    expect((await setupProbeDependencies({}, root)).platform).toMatchObject({
      distro: "unsupported",
      nodeAbi: false,
      arch: "unsupported",
    });
  });
});

it("fails ABI compatibility closed on unknown probes or missing runtime libraries", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  await writeFile(join(root, "libstdcpp"), "old runtime");
  expect((await setupProbeDependencies({}, root)).platform.nodeAbi).toBe(false);
  await rm(join(root, "libstdcpp"));
  expect((await setupProbeDependencies({}, root)).platform.nodeAbi).toBe(false);
  vi.mocked(setupProbe).mockRejectedValueOnce(new Error("timeout"));
  expect((await setupProbeDependencies({}, root)).platform.nodeAbi).toBe(false);
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.mocked(setupProbe).mockRejectedValueOnce(new Error("timeout"));
  expect((await setupProbeDependencies({}, root)).platform.nodeAbi).toBe(false);
});

it("excludes login bins whose tool symlink resolves back into the checkout", async () => {
  const bins = join(root, "bin");
  const checkout = join(root, "checkout");
  await mkdir(bins);
  await mkdir(checkout);
  const actual = await vi.importActual<typeof FileSystem>("node:fs/promises");
  vi.mocked(realpath).mockImplementation((path, options) =>
    path === join(bins, "node")
      ? Promise.resolve(join(checkout, "fixture-node"))
      : actual.realpath(path, options),
  );
  const env = await repositorySetupEnvironment({ PATH: bins }, checkout, root, [], root);
  expect(env["PATH"]).toBe("");
});

it.skipIf(process.platform === "win32")(
  "never probes repository node or pnpm through real login-bin symlinks",
  async () => {
    const checkout = join(root, "checkout");
    const bins = join(root, "login-bin");
    const safe = join(root, "safe-bin");
    await Promise.all([mkdir(checkout), mkdir(bins), mkdir(safe)]);
    for (const tool of ["node", "pnpm"]) {
      await writeFile(join(checkout, tool), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      await symlink(join(checkout, tool), join(bins, tool));
    }
    const env = await repositorySetupEnvironment(
      { PATH: [checkout, bins, safe].join(delimiter) },
      checkout,
      join(root, "private"),
      [],
      root,
    );
    expect(env["PATH"]).toBe(safe);
    const d = await setupProbeDependencies(env, root, undefined, checkout);
    const probe = vi.fn(() => Promise.resolve("must-not-probe-checkout"));
    const onlyTools = parseSetupList(
      JSON.stringify({
        requirements: [
          {
            kind: "toolchain",
            id: "node",
            tool: "node",
            version: "24.x",
            purpose: "Build",
            sources: [],
          },
          {
            kind: "toolchain",
            id: "pnpm",
            tool: "pnpm",
            version: "10.x",
            purpose: "Build",
            sources: [],
          },
        ],
        evidence: [],
      }),
    );
    expect(
      (await checkSetupList(onlyTools, { ...d, probe })).items.map((item) => item.state),
    ).toEqual(["missing", "missing"]);
    expect(probe).not.toHaveBeenCalled();
    // Re-resolve at the probe boundary too, in case a safe login bin gained a link.
    await symlink(join(checkout, "node"), join(safe, "node"));
    expect(await d.resolve("node")).toBeUndefined();
  },
);

it("retains checkout exclusion when its canonical root becomes unreadable", async () => {
  const checkout = join(root, "missing-checkout");
  const bins = join(root, "login-bin");
  await mkdir(bins);
  const env = await repositorySetupEnvironment(
    { PATH: bins },
    checkout,
    join(root, "private"),
    [],
    root,
  );
  expect(env["PATH"]).toBe(bins);
  const d = await setupProbeDependencies(env, root, undefined, checkout);
  expect(await d.resolve("node")).toBeUndefined();
});
