import { createHash } from "node:crypto";
import { selectHostRecipe } from "../../../../src/shared/registered-host-recipes";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import codex from "../../../../src/shared/bundled-agents/codex.json";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  vendor: vi.fn(),
  stage: vi.fn(),
  plugin: vi.fn(),
  spawn: vi.fn(),
  requirements: vi.fn(),
  executable: vi.fn(),
  discovery: vi.fn(),
  login: vi.fn(),
}));
vi.mock("../../../../src/node-common/vendor-install", () => ({ runVendorScript: mock.vendor }));
vi.mock("../../../../src/terminal-host/remote/agent-launch", () => ({
  stageRemotePlugin: mock.stage,
}));
vi.mock("../../../../src/terminal-host/remote/plugin-status", () => ({
  remotePluginState: mock.plugin,
}));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));
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
    (action === "install" || action === "sign-in" || action === "install-plugin") &&
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
        .update(JSON.stringify(recipe?.steps ?? []))
        .digest("hex"),
    ],
    home,
  );
}
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
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
    env: { PATH: "/fixture:/usr/local/bin" },
    shell: false,
    stdio: "inherit",
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
test("status and device-code sign-in use the host's resolved executable", async () => {
  expect(await runHostRecipe(["gh", "sign-in", "debian"], "/fixture/home")).toBe(0);
  expect(mock.spawn).toHaveBeenCalledWith(
    "/fixture/gh",
    ["auth", "login", "--web", "--git-protocol", "https", "--skip-ssh-key"],
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
          createHash("sha256").update(JSON.stringify(recipe.steps)).digest("hex"),
        ],
        "/fixture/home",
      ),
    ).toBe(settings ? 7 : 2);
    if (!settings) {
      expect(mock.vendor).not.toHaveBeenCalled();
      return;
    }
    expect(mock.vendor).toHaveBeenCalledWith(setup?.script, "/fixture/home", {
      PATH: "/fixture:/usr/local/bin",
    });
    expect(mock.spawn).not.toHaveBeenCalled();
  },
);
