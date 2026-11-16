import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateSetupAdmission } from "../../../src/node-common/repository-setup-admission";
import { inspectSetupSources } from "../../../src/node-common/repository-setup-sources";
import { openRepositorySetup } from "../../../src/main/setup/repository-setup-service";
import { DEFAULT_SETTINGS } from "../../../src/main/setup/settings";
import type { Worktree } from "../../../src/shared/worktrees";
import { setupCatalogDigest } from "../../../src/node-common/repository-setup-digest";
import type * as FileSystem from "node:fs/promises";
import type * as Probe from "../../../src/node-common/repository-setup-probe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  lstat,
  mkdir,
  chmod,
  rm,
  writeFile,
  open,
  realpath,
  symlink,
  readFile,
} from "node:fs/promises";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import {
  checkSetupList,
  repositorySetupEnvironment,
  setupProbeDependencies as createProbeDependencies,
} from "../../../src/node-common/repository-setup-check";
import type { SetupProbeDependencies } from "../../../src/node-common/repository-setup-check";
import { setupProbe, SetupProbeExit } from "../../../src/node-common/repository-setup-probe";
import { parseSetupList } from "../../../src/shared/repository-setup";
import { selectedToolchainBins } from "../../../src/node-common/repository-toolchain";
const login = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../src/main/agents/agents", () => ({
  loginPath: vi.fn(() => Promise.resolve({ path: login.path })),
}));
vi.mock("../../../src/node-common/repository-setup-probe", async (original) => ({
  ...(await original<typeof Probe>()),
  setupProbe: vi.fn(),
}));
vi.mock("../../../src/node-common/repository-toolchain", () => ({
  selectedToolchainBins: vi.fn(() => Promise.resolve([])),
}));
const scopes: SetupProbeDependencies[] = [];
const setupProbeDependencies = async (...args: Parameters<typeof createProbeDependencies>) => {
  const deps = await createProbeDependencies(...args);
  scopes.push(deps);
  return deps;
};
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
  root = await actual.realpath(await mkdtemp(join(tmpdir(), "setup-check-")));
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
  await Promise.all(scopes.splice(0).map((deps) => deps.dispose()));
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
    dispose: () => Promise.resolve(),
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
  it.skipIf(originalPlatform === "win32")(
    "derives platform/ABI separately and resolves only safe installed executables",
    async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "x64" });
      await writeFile(join(root, "node"), "fixture");
      await chmod(join(root, "node"), 0o700);
      const d = await setupProbeDependencies(
        { PATH: [".", "/missing", root].join(delimiter) },
        root,
      );
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
    },
  );
});

it.skipIf(originalPlatform === "win32")(
  "fails ABI compatibility closed on unknown probes or missing runtime libraries",
  async () => {
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
  },
);

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

it.skipIf(originalPlatform === "win32")(
  "retains checkout exclusion when its canonical root becomes unreadable",
  async () => {
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
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "remote admission excludes registered root and retargeted symlinks (external checkout: %s)",
  async (externalCheckout) => {
    const codeRoot = join(root, "code");
    const checkout = externalCheckout ? join(root, "external-checkout") : join(codeRoot, "repo");
    const tools = join(codeRoot, "tools");
    const safe = join(root, "safe");
    const external = join(root, "external");
    await Promise.all([
      mkdir(checkout, { recursive: true }),
      mkdir(tools, { recursive: true }),
      mkdir(safe),
      mkdir(external),
    ]);
    await writeFile(join(checkout, "package.json"), "{}");
    const calls = join(root, "calls");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const [directory, label] of [
      [tools, "code-root"],
      [checkout, "checkout"],
      [safe, "safe"],
      [external, "external"],
    ]) {
      if (!directory || !label) throw new Error("Invalid fixture");
      await writeFile(
        join(directory, "node"),
        `#!/bin/sh\nprintf '%s\\n' ${quote(label)} >> ${quote(calls)}\nprintf 'v24.17.0\\n'\n`,
        { mode: 0o700 },
      );
    }
    const onlyNode = parseSetupList(
      JSON.stringify({
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
    );
    const sources = await inspectSetupSources(checkout, ["package.json"]);
    const admission = {
      codeRoot,
      list: onlyNode,
      catalog: setupCatalogDigest,
      revision: 1,
      sources: sources.fingerprint,
    };
    const execute = promisify(execFile);
    vi.mocked(setupProbe).mockImplementation(async (command, args, cwd, env) => {
      if (command === "/usr/bin/getconf") return "glibc 2.36";
      if (command === "/usr/bin/sw_vers") return "14.0";
      if (!command.startsWith(root + "/")) throw new Error("Nonfixture CLI");
      return (await execute(command, [...args], { cwd, env })).stdout;
    });
    const env = await validateSetupAdmission(
      admission,
      checkout,
      join(root, "private"),
      { PATH: [tools, safe].join(delimiter) },
      root,
    );
    expect(env?.["PATH"]).toBe(safe);
    expect(await readFile(calls, "utf8")).toBe("safe\n");
    await rm(join(external, "node"));
    await symlink(join(safe, "node"), join(external, "node"));
    const prior = vi.mocked(setupProbe).getMockImplementation();
    if (!prior) throw new Error("No fixture probe");
    vi.mocked(setupProbe).mockImplementation(async (...args) => {
      if (args[0] === "/usr/bin/getconf" || args[0] === "/usr/bin/sw_vers") {
        await rm(join(external, "node"));
        await symlink(join(checkout, "node"), join(external, "node"));
      }
      return prior(...args);
    });
    await validateSetupAdmission(
      admission,
      checkout,
      join(root, "private"),
      { PATH: [external, safe].join(delimiter) },
      root,
    );
    expect(await readFile(calls, "utf8")).toBe("safe\nsafe\n");
  },
);

it.skipIf(process.platform === "win32").each(["symlink", "nested-bin", "retarget"])(
  "local linked-worktree admission excludes main repository tools (%s)",
  async (kind) => {
    const repository = join(root, "repository");
    const worktree = join(root, "linked");
    const bins = join(root, "login-bin");
    const safe = join(root, "safe");
    const nested = join(repository, "node_modules", ".bin");
    await Promise.all([
      mkdir(nested, { recursive: true }),
      mkdir(worktree),
      mkdir(bins),
      mkdir(safe),
    ]);
    for (const path of [repository, worktree]) await writeFile(join(path, "package.json"), "{}");
    const calls = join(root, "calls");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const [path, label] of [
      [repository, "repository"],
      [worktree, "worktree"],
      [safe, "safe"],
    ]) {
      if (!path || !label) throw new Error("Invalid fixture");
      await writeFile(
        join(path, "node"),
        `#!/bin/sh\nprintf '%s\\n' ${quote(label)} >> ${quote(calls)}\nprintf 'v24.17.0\\n'\n`,
        { mode: 0o700 },
      );
    }
    await symlink(join(repository, "node"), join(nested, "node"));
    await symlink(join(kind === "retarget" ? safe : repository, "node"), join(bins, "node"));
    login.path = [kind === "nested-bin" ? nested : bins, safe].join(delimiter);
    const execute = promisify(execFile);
    vi.mocked(setupProbe).mockImplementation(async (command, args, cwd, env) => {
      if (command === "/usr/bin/getconf" || command === "/usr/bin/sw_vers") {
        if (kind === "retarget") {
          await rm(join(bins, "node"));
          await symlink(join(repository, "node"), join(bins, "node"));
        }
        return command === "/usr/bin/getconf" ? "glibc 2.36" : "14.0";
      }
      if (!command.startsWith(root + "/")) throw new Error("Nonfixture executable");
      return (await execute(command, [...args], { cwd, env })).stdout;
    });
    const store = { get: () => ({ ...DEFAULT_SETTINGS, registeredHosts: [] }) };
    const trees: Worktree[] = [repository, worktree].map((path) => ({
      path,
      head: "a".repeat(40),
      branch: "main",
      bare: false,
      managed: false,
      locked: false,
      prunable: false,
    }));
    const service = await openRepositorySetup(
      store,
      root,
      {
        listRepositories: () => [{ path: repository, name: "fixture" }],
        registrationIdentity: () => "fixture-registration",
        persistRegistrationIdentities: () => Promise.resolve(),
        launchIdentity: () => Promise.resolve("fixture-identity"),
        listWorktrees: () => Promise.resolve(trees),
        onRemoved: () => () => {},
      },
      {
        repositorySetup: () => Promise.reject(new Error("Unexpected remote check")),
        onRemoved: () => () => {},
      },
    );
    const signal = new AbortController().signal;
    const confirm = () => Promise.resolve(true);
    const launch = () => Promise.reject(new Error("Unexpected setup execution"));
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
    await service.action(
      "board",
      { action: "approve", token: reviewed.review.token },
      confirm,
      launch,
      signal,
    );
    const admitted = await service.admit(null, repository, worktree);
    if (!admitted.approval) throw new Error("No approval");
    expect(admitted.codeRoot).toBe(repository);
    expect(await readFile(calls, "utf8")).toBe("safe\n");
  },
);

it.skipIf(originalPlatform === "win32").each([false, true])(
  "env-selected pnpm interpreter remains pinned when login symlink changes: %s",
  async (retarget) => {
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    const bins = join(root, "login-bin");
    const safe = join(root, "safe");
    await Promise.all([mkdir(repository), mkdir(worktree), mkdir(bins), mkdir(safe)]);
    const marker = join(root, "repository-node-called");
    await writeFile(join(safe, "node"), "#!/bin/sh\nprintf '10.34.7\\n'\n", { mode: 0o700 });
    await writeFile(
      join(repository, "node"),
      `#!/bin/sh\nprintf called > '${marker}'\nprintf '10.34.7\\n'\n`,
      { mode: 0o700 },
    );
    await symlink(join(safe, "node"), join(bins, "node"));
    await writeFile(join(bins, "pnpm"), "#!/usr/bin/env node\n", { mode: 0o700 });
    const execute = promisify(execFile);
    let pinned = "";
    vi.mocked(setupProbe).mockImplementation(async (command, args, cwd, env) => {
      pinned = (env["PATH"] ?? "").split(delimiter)[0] ?? "";
      expect((await lstat(pinned)).mode & 0o777).toBe(0o700);
      expect((env["PATH"] ?? "").split(delimiter)).not.toContain(bins);
      if (command === "/usr/bin/getconf" || command === "/usr/bin/sw_vers") {
        if (retarget) {
          await rm(join(bins, "node"));
          await symlink(join(repository, "node"), join(bins, "node"));
        }
        return command === "/usr/bin/getconf" ? "glibc 2.36" : "14.0";
      }
      if (!command.startsWith(root + "/")) throw new Error("Nonfixture executable");
      return (await execute(command, [...args], { cwd, env })).stdout;
    });
    const excluded = [repository, worktree];
    const env = await repositorySetupEnvironment(
      { PATH: bins },
      excluded,
      join(root, "prefix"),
      ["pnpm"],
      root,
    );
    const requirements = parseSetupList(
      JSON.stringify({
        evidence: [],
        requirements: [
          {
            kind: "toolchain",
            id: "pnpm",
            tool: "pnpm",
            version: "10.x",
            purpose: "Build",
            sources: [],
          },
        ],
      }),
    );
    const { withSetupProbeDependencies } = await import(
      "../../../src/node-common/repository-setup-check"
    );
    const checked = await withSetupProbeDependencies(env, root, undefined, excluded, (deps) =>
      checkSetupList(requirements, deps),
    );
    expect(checked.items[0]?.state).toBe("met");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(pinned)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(originalPlatform === "win32")(
  "pnpm cannot select an excluded interpreter even when an external script is discoverable",
  async () => {
    const repository = join(root, "repository"),
      bins = join(root, "pnpm-bin"),
      nodeBins = join(root, "node-bin");
    await Promise.all([mkdir(repository), mkdir(bins), mkdir(nodeBins)]);
    const marker = join(root, "repository-node-called");
    await writeFile(
      join(repository, "node"),
      `#!/bin/sh\nprintf called > '${marker}'\nprintf '10.34.7\\n'\n`,
      { mode: 0o700 },
    );
    await symlink(join(repository, "node"), join(nodeBins, "node"));
    await writeFile(join(bins, "pnpm"), "#!/usr/bin/env node\n", { mode: 0o700 });
    const execute = promisify(execFile);
    vi.mocked(setupProbe).mockImplementation(async (command, args, cwd, env) => {
      if (command === "/usr/bin/getconf") return "glibc 2.36";
      if (command === "/usr/bin/sw_vers") return "14.0";
      if (!command.startsWith(root + "/")) throw new Error("Nonfixture executable");
      return (await execute(command, [...args], { cwd, env })).stdout;
    });
    const env = await repositorySetupEnvironment(
      { PATH: [bins, nodeBins].join(delimiter) },
      repository,
      join(root, "prefix"),
      ["pnpm"],
      root,
    );
    const requirements = parseSetupList(
      JSON.stringify({
        evidence: [],
        requirements: [
          {
            kind: "toolchain",
            id: "pnpm",
            tool: "pnpm",
            version: "10.x",
            purpose: "Build",
            sources: [],
          },
        ],
      }),
    );
    const { withSetupProbeDependencies } = await import(
      "../../../src/node-common/repository-setup-check"
    );
    const checked = await withSetupProbeDependencies(env, root, undefined, repository, (deps) =>
      checkSetupList(requirements, deps),
    );
    expect(checked.items[0]?.state).toBe("unable");
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it.skipIf(originalPlatform === "win32")(
  "cleans a scoped probe PATH when its caller fails or is cancelled",
  async () => {
    const { withSetupProbeDependencies } = await import(
      "../../../src/node-common/repository-setup-check"
    );
    for (const failure of [new Error("Caller failed"), new DOMException("Aborted", "AbortError")]) {
      let pinned = "";
      await expect(
        withSetupProbeDependencies({}, root, undefined, [], (deps) => {
          pinned = (deps.env["PATH"] ?? "").split(delimiter)[0] ?? "";
          return Promise.reject(failure);
        }),
      ).rejects.toBe(failure);
      await expect(lstat(pinned)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
it("native Windows remains manual without exposing an interpreter PATH", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const deps = await setupProbeDependencies({ PATH: "untrusted" }, root);
  expect(deps.platform.distro).toBe("unsupported");
  expect(deps.env["PATH"]).toBe("");
  expect(await deps.resolve("node")).toBeUndefined();
  await expect(deps.probe("node", ["--version"])).rejects.toThrow("manual");
});
