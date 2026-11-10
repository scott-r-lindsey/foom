import type * as VendorInstall from "../../../../src/node-common/vendor-install";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import {
  recipeDigestInput,
  selectHostRecipe,
} from "../../../../src/shared/registered-host-recipes";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import codex from "../../../../src/shared/bundled-agents/codex.json";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  version: vi.fn(),
  vendor: vi.fn(),
  stage: vi.fn(),
  plugin: vi.fn(),
  spawn:
    vi.fn<
      (
        command: string,
        args: readonly string[],
        options: { env: NodeJS.ProcessEnv },
      ) => EventEmitter
    >(),
  requirements: vi.fn(),
  executable: vi.fn(),
  discovery: vi.fn(),
  login: vi.fn(),
}));
vi.mock("../../../../src/node-common/vendor-install", async (original) => ({
  ...(await original<typeof VendorInstall>()),
  runVendorScript: mock.vendor,
}));
vi.mock("../../../../src/terminal-host/remote/agent-launch", () => ({
  stageRemotePlugin: mock.stage,
}));
vi.mock("../../../../src/terminal-host/remote/plugin-status", () => ({
  remotePluginState: mock.plugin,
}));
vi.mock("node:child_process", () => ({ spawn: mock.spawn, execFile: mock.version }));
Object.defineProperty(mock.version, promisify.custom, {
  value: async (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      mock.version(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
});
vi.mock("../../../../src/terminal-host/remote/daemon", () => ({
  remoteShell: () => "/fixture/shell",
}));
vi.mock("../../../../src/terminal-host/remote/host-facts", () => ({
  requirements: mock.requirements,
  executable: mock.executable,
}));
vi.mock("../../../../src/terminal-host/remote/agent-discovery", () => ({
  hostDiscovery: mock.discovery,
  hostLoginEnvironment: mock.login,
}));
import {
  runHostRecipe as executeRecipe,
  runOriginTrust,
} from "../../../../src/terminal-host/remote/host-recipe";
async function runHostRecipe(args: readonly string[], home: string) {
  const [tool, action, distro] = args;
  const recipe =
    tool &&
    (action === "install" ||
      action === "sign-in" ||
      action === "install-plugin" ||
      action === "install-sign-in") &&
    (distro === "debian" || distro === "rhel" || distro === "arch" || distro === "darwin")
      ? selectHostRecipe(
          { tool, action, distro },
          { distro, libc: "supported", packageManager: distro === "darwin" ? "brew" : "apt" },
          tool === "codex"
            ? parseAgentManifest(JSON.stringify(codex), "bundled").model.hostSetup
            : undefined,
        )
      : undefined;
  return executeRecipe(
    [
      ...args,
      createHash("sha256")
        .update(recipe ? recipeDigestInput(recipe) : "[]")
        .digest("hex"),
    ],
    home,
  );
}
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  mock.version
    .mockReset()
    .mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "gh version 2.103.3 (fixture)\n", "");
      },
    );
  mock.vendor.mockReset();
  mock.stage.mockReset();
  mock.plugin.mockReset();
  mock.requirements
    .mockReset()
    .mockResolvedValue({ distro: "debian", libc: "supported", packageManager: "apt" });
  mock.login.mockReset().mockResolvedValue({ PATH: "/fixture:/usr/local/bin" });
  mock.discovery.mockReset().mockResolvedValue({ command: "/fixture/gh" });
  mock.executable.mockReset().mockResolvedValue(true);
  mock.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
});
test("only fixed argv execute, in order, with terminal stdio and no shell or IDs", async () => {
  expect(await runHostRecipe(["git", "install", "debian"], "/fixture/home")).toBe(0);
  expect(mock.spawn.mock.calls.map((call: readonly unknown[]) => call.slice(0, 2))).toEqual([
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "update"]],
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "install", "-y", "git"]],
  ]);
  expect(mock.spawn).toHaveBeenNthCalledWith(1, "/usr/bin/sudo", ["/usr/bin/apt-get", "update"], {
    cwd: "/fixture/home",
    env: mock.spawn.mock.calls[0]?.[2].env,
    shell: false,
    stdio: "inherit",
  });
  expect(mock.spawn.mock.calls[0]?.[2].env).toMatchObject({
    HOME: "/fixture/home",
    USER: userInfo().username,
    PATH: "/fixture:/usr/local/bin",
  });
  mock.spawn.mockClear();
  expect(await runHostRecipe(["gh", "install", "debian"], "/fixture/home")).toBe(0);
  expect(mock.spawn.mock.calls.map((call: readonly unknown[]) => call.slice(0, 2))).toEqual([
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "update"]],
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "install", "-y", "extrepo"]],
    ["/usr/bin/sudo", ["/usr/bin/extrepo", "enable", "github-cli"]],
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "update"]],
    ["/usr/bin/sudo", ["/usr/bin/apt-get", "install", "-y", "gh"]],
  ]);
});
test("failed login PATH resolution cannot become a package-manager fallback", async () => {
  mock.login.mockResolvedValue({ PATH: "" });
  expect(await runHostRecipe(["git", "install", "debian"], "/fixture/home")).toBe(2);
  expect(mock.spawn).not.toHaveBeenCalled();
  expect(mock.vendor).not.toHaveBeenCalled();
});
test("status and device-code sign-in use the host's resolved executable", async () => {
  expect(await runHostRecipe(["gh", "sign-in", "debian"], "/fixture/home")).toBe(0);
  expect(mock.spawn).toHaveBeenCalledWith(
    "/fixture/gh",
    [
      "auth",
      "login",
      "--web",
      "--expiring",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--skip-ssh-key",
      "--scopes",
      "workflow",
    ],
    expect.any(Object),
  );
  mock.discovery.mockResolvedValue({ command: "/fixture/codex" });
  expect(await runHostRecipe(["codex", "sign-in", "debian"], "/fixture/home")).toBe(0);
  expect(mock.spawn).toHaveBeenLastCalledWith(
    "/fixture/codex",
    ["login", "--device-auth"],
    expect.any(Object),
  );
});
test("Homebrew requires a fixed installation on login PATH, never arbitrary paths", async () => {
  mock.login.mockResolvedValue({
    PATH: "/fixture:/usr/local/bin",
    FOOM_TOKEN: "secret",
    CODEX_API_KEY: "secret",
  });
  mock.requirements.mockResolvedValue({
    distro: "darwin",
    libc: "supported",
    packageManager: "brew",
  });
  expect(await runHostRecipe(["codex", "install", "darwin"], "/fixture/home")).toBe(0);
  expect(mock.spawn).toHaveBeenLastCalledWith(
    "/usr/local/bin/brew",
    ["install", "--cask", "codex"],
    expect.any(Object),
  );
  const environment = mock.spawn.mock.lastCall?.[2].env;
  expect(environment).toMatchObject({
    HOME: "/fixture/home",
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    PATH: "/fixture:/usr/local/bin",
  });
  expect(environment).not.toHaveProperty("FOOM_TOKEN");
  expect(environment).not.toHaveProperty("CODEX_API_KEY");
  mock.executable.mockResolvedValue(false);
  expect(await runHostRecipe(["git", "install", "darwin"], "/fixture/home")).toBe(2);
  mock.login.mockResolvedValue({});
  expect(await runHostRecipe(["git", "install", "darwin"], "/fixture/home")).toBe(2);
});
test("malformed, unsupported and missing recipes run nothing", async () => {
  for (const args of [
    [],
    ["git", "install", "debian", "extra"],
    ["git", "other", "debian"],

    ["git", "install", "rhel"],
  ])
    expect(await runHostRecipe(args, "/fixture/home")).toBe(2);
  expect(mock.spawn).not.toHaveBeenCalled();
});
test.each([7, null, "error"])(
  "failure %s stops later repository/install steps",
  async (outcome) => {
    mock.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit(
          outcome === "error" ? "error" : "exit",
          outcome === "error" ? new Error("fixture") : outcome,
        ),
      );
      return child;
    });
    expect(await runHostRecipe(["gh", "install", "debian"], "/fixture/home")).toBe(
      outcome === 7 ? 7 : 1,
    );
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(mock.spawn).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      ["/usr/bin/apt-get", "update"],
      expect.any(Object),
    );
  },
);

test("mismatched command digests refuse before executing anything", async () => {
  expect(await executeRecipe(["git", "install", "debian", "a".repeat(64)], "/fixture/home")).toBe(
    2,
  );
  expect(mock.spawn).not.toHaveBeenCalled();
});

test("origin trust runs only interactive ssh argv with fingerprint confirmation left to the user", async () => {
  mock.discovery.mockResolvedValue({ command: "/fixture/ssh" });
  expect(await runOriginTrust(["ssh://git@forge.test:2222/repo"], "/fixture/home")).toBe(0);
  expect(mock.spawn).toHaveBeenCalledWith(
    "/fixture/ssh",
    [
      "-T",
      "-o",
      "StrictHostKeyChecking=ask",
      "-o",
      "BatchMode=no",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "ClearAllForwardings=yes",
      "-p",
      "2222",
      "--",
      "git@forge.test",
    ],
    {
      cwd: "/fixture/home",
      env: { PATH: "/fixture:/usr/local/bin" },
      shell: false,
      stdio: "inherit",
    },
  );
  for (const argv of [[], ["https://forge.test/repo"], ["git@forge.test:repo", "extra"]])
    expect(await runOriginTrust(argv, "/fixture/home")).toBe(2);
  mock.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("missing")));
    return child;
  });
  expect(await runOriginTrust(["git@forge.test:repo"], "/fixture/home")).toBe(1);
  mock.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", null));
    return child;
  });
  expect(await runOriginTrust(["git@forge.test:repo"], "/fixture/home")).toBe(1);
});

test("plugin installation stages only bundled bytes after an absent inventory and binds the printed path as one argv", async () => {
  mock.discovery.mockResolvedValue({ command: "/fixture/agy" });
  mock.plugin.mockResolvedValue("not-installed");
  mock.stage.mockResolvedValue("/fixture/plugin with spaces");
  expect(await runHostRecipe(["agy", "install-plugin", "debian"], "/fixture/home")).toBe(0);
  expect(mock.stage).toHaveBeenCalledWith("agy", "/fixture/home");
  expect(mock.spawn).toHaveBeenCalledExactlyOnceWith(
    "/fixture/agy",
    ["plugin", "install", "/fixture/plugin with spaces"],
    expect.objectContaining({ shell: false, stdio: "inherit" }),
  );
  mock.spawn.mockClear();
  mock.stage.mockClear();
  for (const state of ["present", "unavailable"]) {
    mock.plugin.mockResolvedValue(state);
    expect(await runHostRecipe(["agy", "install-plugin", "debian"], "/fixture/home")).toBe(2);
  }
  expect(mock.stage).not.toHaveBeenCalled();
  expect(mock.spawn).not.toHaveBeenCalled();
});

test("failed plugin staging never reaches the install command", async () => {
  mock.discovery.mockResolvedValue({ command: "/fixture/agy" });
  mock.plugin.mockResolvedValue("not-installed");
  mock.stage.mockRejectedValue(new Error("fixture staging failed"));
  await expect(runHostRecipe(["agy", "install-plugin", "debian"], "/fixture/home")).rejects.toThrow(
    "fixture staging failed",
  );
  expect(mock.spawn).not.toHaveBeenCalled();
});

test.each([true, false])(
  "vendor helpers check the recipe digest and accidental-use marker (%s)",
  async (settings) => {
    vi.stubEnv("FOOM_SETTINGS_INSTALL", settings ? "1" : undefined);
    const setup = parseAgentManifest(JSON.stringify(codex), "bundled").model.hostSetup;
    const recipe = selectHostRecipe(
      { tool: "codex", action: "install", distro: "debian" },
      { distro: "debian", libc: "supported", packageManager: "none" },
      setup,
    );
    if (!recipe) throw new Error("Missing fixture recipe");
    mock.requirements.mockResolvedValue({
      distro: "debian",
      libc: "supported",
      packageManager: "none",
    });
    mock.vendor.mockResolvedValue(7);
    expect(
      await executeRecipe(
        [
          "codex",
          "install",
          "debian",
          createHash("sha256").update(recipeDigestInput(recipe)).digest("hex"),
        ],
        "/fixture/home",
      ),
    ).toBe(settings ? 7 : 2);
    if (!settings) {
      expect(mock.vendor).not.toHaveBeenCalled();
      return;
    }
    expect(mock.vendor).toHaveBeenCalledWith(
      setup?.script,
      "/fixture/home",
      expect.objectContaining({
        PATH: "/fixture:/usr/local/bin",
        HOME: "/fixture/home",
        USER: userInfo().username,
        SHELL: userInfo().shell || "/bin/sh",
      }),
    );
    expect(mock.spawn).not.toHaveBeenCalled();
  },
);

test.each(["2.102.9", "2.103.0", "3.0.0", "1.99.0", "unknown"])(
  "gh version %s selects only the fixed expiry variant and ignores auth stdin",
  async (version) => {
    mock.version.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, `gh version ${version}\n`, "");
      },
    );
    expect(await runHostRecipe(["gh", "sign-in", "debian"], "/fixture/home")).toBe(0);
    const login = mock.spawn.mock.calls[0];
    expect(login?.[1].includes("--expiring")).toBe(["2.103.0", "3.0.0"].includes(version));
    expect(login?.[2]).toMatchObject({ shell: false, stdio: ["ignore", "inherit", "inherit"] });
    expect(mock.spawn.mock.lastCall?.[1]).toEqual([
      "auth",
      "setup-git",
      "--hostname",
      "github.com",
    ]);
    expect(mock.version).toHaveBeenCalledWith(
      "/fixture/gh",
      ["--version"],
      expect.objectContaining({ timeout: 5000, maxBuffer: 4096 }),
      expect.any(Function),
    );
  },
);
test("a failed version probe keeps compatible login, but failed login never runs setup-git", async () => {
  mock.version.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      callback(new Error("failed"));
    },
  );
  mock.spawn.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 7));
    return child;
  });
  expect(await runHostRecipe(["gh", "sign-in", "debian"], "/fixture/home")).toBe(7);
  expect(mock.spawn).toHaveBeenCalledOnce();
  expect(mock.spawn.mock.calls[0]?.[1]).not.toContain("--expiring");
});

test("install & sign in keeps install stdin interactive, auth stdin ignored, and stops on installation failure", async () => {
  mock.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 23));
    return child;
  });
  expect(await runHostRecipe(["gh", "install-sign-in", "debian"], "/fixture/home")).toBe(23);
  expect(mock.spawn).toHaveBeenCalledOnce();
  expect(mock.version).not.toHaveBeenCalled();
  mock.spawn.mockClear();
  expect(await runHostRecipe(["gh", "install-sign-in", "debian"], "/fixture/home")).toBe(0);
  expect(mock.spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: "inherit" });
  expect(mock.spawn.mock.calls.at(-2)?.[2]).toMatchObject({
    stdio: ["ignore", "inherit", "inherit"],
  });
  expect(mock.spawn.mock.lastCall?.[1]).toEqual(["auth", "setup-git", "--hostname", "github.com"]);
});
