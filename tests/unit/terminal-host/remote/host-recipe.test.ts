import { createHash } from "node:crypto";
import { selectHostRecipe } from "../../../../src/shared/registered-host-recipes";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import codex from "../../../../src/shared/bundled-agents/codex.json";
import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  requirements: vi.fn(),
  executable: vi.fn(),
  discovery: vi.fn(),
  login: vi.fn(),
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
import { runHostRecipe as executeRecipe } from "../../../../src/terminal-host/remote/host-recipe";
async function runHostRecipe(args: readonly string[], home: string) {
  const [tool, action, distro] = args;
  const recipe =
    tool &&
    (action === "install" || action === "sign-in") &&
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
beforeEach(() => {
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
  expect(mock.spawn).toHaveBeenCalledExactlyOnceWith(
    "/usr/bin/sudo",
    ["/usr/bin/apt-get", "install", "-y", "git"],
    {
      cwd: "/fixture/home",
      env: { PATH: "/fixture:/usr/local/bin" },
      shell: false,
      stdio: "inherit",
    },
  );
  mock.spawn.mockClear();
  expect(await runHostRecipe(["gh", "install", "debian"], "/fixture/home")).toBe(0);
  expect(mock.spawn.mock.calls.map((call: readonly unknown[]) => call.slice(0, 2))).toEqual([
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
    ["codex", "install", "debian"],
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
  },
);

test("mismatched command digests refuse before executing anything", async () => {
  expect(await executeRecipe(["git", "install", "debian", "a".repeat(64)], "/fixture/home")).toBe(
    2,
  );
  expect(mock.spawn).not.toHaveBeenCalled();
});
