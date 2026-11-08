import type {
  HostRequirements,
  HostRecipe,
  HostRecipeRequest,
  HostRecipeLaunch,
} from "./registered-hosts.d";

/** Checked-in argv only. Bundled vendor scripts use an explicit download step; staged paths are host-owned. */
const sudo = (...argv: string[]) => ["/usr/bin/sudo", ...argv];
const git = {
  debian: [sudo("/usr/bin/apt-get", "install", "-y", "git")],
  rhel: [sudo("/usr/bin/dnf", "install", "-y", "git")],
  arch: [sudo("/usr/bin/pacman", "-S", "--noconfirm", "git")],
  darwin: [["brew", "install", "git"]],
};
const gh = {
  // extrepo enables GitHub's signed apt repository without generating shell source.
  debian: [
    sudo("/usr/bin/apt-get", "install", "-y", "extrepo"),
    sudo("/usr/bin/extrepo", "enable", "github-cli"),
    sudo("/usr/bin/apt-get", "update"),
    sudo("/usr/bin/apt-get", "install", "-y", "gh"),
  ],
  rhel: [
    sudo("/usr/bin/dnf", "install", "-y", "curl"),
    sudo(
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
    ),
    sudo("/usr/bin/dnf", "install", "-y", "gh"),
  ],
  arch: [sudo("/usr/bin/pacman", "-S", "--noconfirm", "github-cli")],
  darwin: [["brew", "install", "gh"]],
};
export function recipeRequest(value: unknown): value is HostRecipeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === 3 &&
    "tool" in value &&
    "action" in value &&
    "distro" in value &&
    typeof value.tool === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(value.tool) &&
    (value.action === "install" ||
      value.action === "sign-in" ||
      (value.action === "install-plugin" && value.tool === "agy")) &&
    typeof value.distro === "string" &&
    ["debian", "rhel", "arch", "darwin"].includes(value.distro)
  );
}
export function selectHostRecipe(
  request: HostRecipeRequest,
  facts: HostRequirements,
  setup?: {
    script?: { url: string; interpreter: "sh" | "bash"; arguments: readonly string[] } | undefined;
    install?:
      | Partial<Record<"debian" | "rhel" | "arch" | "darwin", readonly string[] | undefined>>
      | undefined;
    signIn?:
      | Partial<Record<"debian" | "rhel" | "arch" | "darwin", readonly string[] | undefined>>
      | undefined;
  },
): HostRecipe | undefined {
  if (facts.libc !== "supported" || facts.distro === "unknown" || request.distro !== facts.distro)
    return undefined;
  const distro = request.distro;
  if (request.action === "install-plugin")
    return request.tool === "agy"
      ? {
          ...request,
          steps: [
            ["foom-host", "--stage-plugin", "agy"],
            ["agy", "plugin", "install", "{stagedPlugin}"],
          ],
        }
      : undefined;
  if (request.action === "sign-in") {
    const argv =
      request.tool === "gh"
        ? ["gh", "auth", "login", "--web", "--git-protocol", "https", "--skip-ssh-key"]
        : setup?.signIn?.[distro];
    return argv ? { ...request, steps: [argv] } : undefined;
  }
  if (request.tool === "git" && facts.mac?.commandLineTools === false) return undefined;
  const manager = { debian: "apt", rhel: "dnf", arch: "pacman", darwin: "brew" };
  const packageManagerAvailable = facts.packageManager === manager[distro];
  const argv = packageManagerAvailable ? setup?.install?.[distro] : undefined;
  if (!argv && setup?.script && request.tool !== "git" && request.tool !== "gh")
    return {
      ...request,
      steps: [
        [
          "foom-host",
          "--vendor-script",
          setup.script.url,
          setup.script.interpreter,
          ...setup.script.arguments,
        ],
      ],
    };
  if (!packageManagerAvailable) return undefined;
  const steps =
    request.tool === "git"
      ? git[distro]
      : request.tool === "gh"
        ? gh[distro]
        : argv
          ? [argv]
          : undefined;
  if (!steps) return undefined;
  // Refresh empty apt lists before any install, including manifest-provided recipes.
  return {
    ...request,
    steps: distro === "debian" ? [sudo("/usr/bin/apt-get", "update"), ...steps] : steps,
  };
}

/** Bind a main-selected command sequence across compatible daemon builds. */
export function recipeLaunch(value: unknown): value is HostRecipeLaunch {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    "tool" in value &&
    "action" in value &&
    "distro" in value &&
    "digest" in value &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/u.test(value.digest) &&
    recipeRequest({ tool: value.tool, action: value.action, distro: value.distro })
  );
}
