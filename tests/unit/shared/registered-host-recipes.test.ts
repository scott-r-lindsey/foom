import { expect, test } from "vitest";
import {
  recipeRequest,
  recipeLaunch,
  selectHostRecipe,
} from "../../../src/shared/registered-host-recipes";
import type { HostRequirements, HostRecipeRequest } from "../../../src/shared/registered-hosts.d";
const facts: HostRequirements = { distro: "debian", libc: "supported", packageManager: "apt" };
test("recipe requests reject extra commands, unknown values and injection", () => {
  for (const value of [
    null,
    [],
    {},
    { tool: "git", action: "install", distro: "unknown" },
    { tool: "git;id", action: "install", distro: "debian" },
    { tool: "git", action: "other", distro: "debian" },
    { tool: "git", action: "install", distro: "debian", argv: ["id"] },
  ])
    expect(recipeRequest(value)).toBe(false);
  expect(recipeRequest({ tool: "git", action: "install", distro: "debian" })).toBe(true);
});
test("selects each checked-in package-manager recipe and stops unsupported hosts", () => {
  const managers = { debian: "apt", rhel: "dnf", arch: "pacman", darwin: "brew" } as const;
  for (const distro of ["debian", "rhel", "arch", "darwin"] as const)
    for (const tool of ["git", "gh"]) {
      const request: HostRecipeRequest = { distro, tool, action: "install" };
      const recipe = selectHostRecipe(request, {
        distro,
        libc: "supported",
        packageManager: managers[distro],
      });
      expect(recipe?.steps.at(-1)).toEqual(
        distro === "darwin"
          ? ["brew", "install", tool]
          : [
              "/usr/bin/sudo",
              distro === "debian"
                ? "/usr/bin/apt-get"
                : distro === "rhel"
                  ? "/usr/bin/dnf"
                  : "/usr/bin/pacman",
              distro === "arch" ? "-S" : "install",
              distro === "arch" ? "--noconfirm" : "-y",
              tool === "gh" && distro === "arch" ? "github-cli" : tool,
            ],
      );
      expect(
        selectHostRecipe(request, { distro, libc: "supported", packageManager: "none" }),
      ).toBeUndefined();
    }
  const request: HostRecipeRequest = { tool: "git", distro: "debian", action: "install" };
  for (const system of [
    { ...facts, distro: "unknown" as const },
    { ...facts, libc: "too-old" as const },
    { ...facts, libc: "unsupported" as const },
    { ...facts, distro: "arch" as const },
  ])
    expect(selectHostRecipe(request, system)).toBeUndefined();
});
test("agent recipes are opt-in per distro; sign-in does not require a package manager", () => {
  const request: HostRecipeRequest = { tool: "custom", distro: "debian", action: "install" };
  expect(selectHostRecipe(request, facts)).toBeUndefined();
  expect(
    selectHostRecipe(request, facts, {
      install: { debian: ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "custom"] },
    })?.steps,
  ).toEqual([
    ["/usr/bin/sudo", "/usr/bin/apt-get", "update"],
    ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "custom"],
  ]);
  expect(selectHostRecipe({ ...request, action: "sign-in" }, facts)).toBeUndefined();
  expect(
    selectHostRecipe({ ...request, action: "sign-in" }, facts, {
      signIn: { debian: ["custom", "login"] },
    })?.steps,
  ).toEqual([["custom", "login"]]);
  expect(
    selectHostRecipe(
      { ...request, tool: "gh", action: "sign-in" },
      { ...facts, packageManager: "none" },
    )?.steps,
  ).toEqual([["gh", "auth", "login", "--web", "--git-protocol", "https", "--skip-ssh-key"]]);
});

test("macOS missing CLT requires an on-Mac fix instead of probing or installing git", () => {
  const mac = {
    distro: "darwin" as const,
    libc: "supported" as const,
    packageManager: "brew" as const,
    mac: { commandLineTools: false, staysAwake: false, protectedFolder: false },
  };
  expect(
    selectHostRecipe({ tool: "git", action: "install", distro: "darwin" }, mac),
  ).toBeUndefined();
});

test("recipe launches carry only the fixed selector and a bounded digest", () => {
  const selector = { tool: "git", action: "install", distro: "debian" };
  expect(recipeLaunch({ ...selector, digest: "a".repeat(64) })).toBe(true);
  for (const value of [
    null,
    [],
    {},
    selector,
    { ...selector, digest: "bad" },
    { ...selector, digest: 2 },
    { ...selector, digest: "a".repeat(64), argv: ["id"] },
    { tool: "git", action: "install", digest: "a".repeat(64), extra: true },
    { tool: "git", distro: "debian", digest: "a".repeat(64), extra: true },
    { action: "install", distro: "debian", digest: "a".repeat(64), extra: true },
    { ...selector, tool: "bad;id", digest: "a".repeat(64) },
  ])
    expect(recipeLaunch(value)).toBe(false);
});

test("RHEL gh repository preparation uses a fixed HTTPS URL and ignores curl configuration", () => {
  expect(
    selectHostRecipe(
      { tool: "gh", action: "install", distro: "rhel" },
      { distro: "rhel", libc: "supported", packageManager: "dnf" },
    )?.steps,
  ).toEqual([
    ["/usr/bin/sudo", "/usr/bin/dnf", "install", "-y", "curl"],
    [
      "/usr/bin/sudo",
      "/usr/bin/curl",
      "--disable",
      "--fail",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--output",
      "/etc/yum.repos.d/gh-cli.repo",
      "https://cli.github.com/packages/rpm/gh-cli.repo",
    ],
    ["/usr/bin/sudo", "/usr/bin/dnf", "install", "-y", "gh"],
  ]);
});

test("Debian refreshes apt lists before git and before gh repository preparation", () => {
  const update = ["/usr/bin/sudo", "/usr/bin/apt-get", "update"];
  expect(
    selectHostRecipe({ tool: "git", action: "install", distro: "debian" }, facts)?.steps,
  ).toEqual([update, ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "git"]]);
  expect(
    selectHostRecipe({ tool: "gh", action: "install", distro: "debian" }, facts)?.steps,
  ).toEqual([
    update,
    ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "extrepo"],
    ["/usr/bin/sudo", "/usr/bin/extrepo", "enable", "github-cli"],
    update,
    ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "gh"],
  ]);
});

test("manifest package installs refresh only Debian and preserve Arch argv", () => {
  for (const distro of ["debian", "arch"] as const) {
    const argv =
      distro === "debian"
        ? ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "custom"]
        : ["/usr/bin/sudo", "/usr/bin/pacman", "-S", "--noconfirm", "custom"];
    const original = [...argv];
    const recipe = selectHostRecipe(
      { tool: "custom", action: "install", distro },
      { distro, libc: "supported", packageManager: distro === "debian" ? "apt" : "pacman" },
      { install: { [distro]: argv } },
    );
    expect(recipe?.steps).toEqual(
      distro === "debian"
        ? [["/usr/bin/sudo", "/usr/bin/apt-get", "update"], original]
        : [["/usr/bin/sudo", "/usr/bin/pacman", "-S", "--noconfirm", "custom"]],
    );
    expect(argv).toEqual(original);
  }
});

test("only agy's explicit install-plugin selector can choose the fixed two-step recipe", () => {
  const request = { tool: "agy", action: "install-plugin", distro: "debian" } as const;
  expect(recipeRequest(request)).toBe(true);
  expect(recipeRequest({ ...request, tool: "other" })).toBe(false);
  expect(selectHostRecipe(request, facts)?.steps).toEqual([
    ["foom-host", "--stage-plugin", "agy"],
    ["agy", "plugin", "install", "{stagedPlugin}"],
  ]);
  expect(selectHostRecipe({ ...request, tool: "other" }, facts)).toBeUndefined();
});

test("vendor script recipes bind address, interpreter and arguments and need no package manager", () => {
  const request = { tool: "fixture", action: "install", distro: "darwin" } as const;
  const script = {
    url: "https://vendor.test/install",
    interpreter: "bash",
    arguments: ["stable"],
  } as const;
  const setup = { script, install: { darwin: ["brew", "install", "fixture"] } };
  expect(
    selectHostRecipe(
      request,
      { distro: "darwin", libc: "supported", packageManager: "brew" },
      setup,
    )?.steps,
  ).toEqual([["brew", "install", "fixture"]]);
  expect(
    selectHostRecipe(
      request,
      { distro: "darwin", libc: "supported", packageManager: "none" },
      setup,
    )?.steps,
  ).toEqual([["foom-host", "--vendor-script", script.url, "bash", "stable"]]);
  expect(selectHostRecipe({ ...request, distro: "debian" }, facts, setup)?.steps).toEqual([
    ["foom-host", "--vendor-script", script.url, "bash", "stable"],
  ]);
});

test("vendor recipe digest inputs include declared installer environment", () => {
  const request = { tool: "fixture", action: "install", distro: "debian" } as const;
  const script = {
    url: "https://vendor.test/install",
    interpreter: "sh",
    arguments: [],
    environment: [{ name: "VENDOR_MODE", value: "1" }],
  } as const;
  const steps = selectHostRecipe(request, facts, { script })?.steps;
  expect(steps?.[0]?.at(-1)).toBe(JSON.stringify(script.environment));
  expect(steps).not.toEqual(
    selectHostRecipe(request, facts, {
      script: { ...script, environment: [{ name: "VENDOR_MODE", value: "2" }] },
    })?.steps,
  );
});
