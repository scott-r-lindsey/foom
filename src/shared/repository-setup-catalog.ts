import { setupPackageName } from "./repository-setup";
import type {
  RepositorySetupList,
  SetupCheck,
  SetupPlan,
  SetupPlatform,
  SetupArtifact,
} from "./repository-setup.d";
/** Official release checksums, fixed on 2026-11-15. No moving/latest addresses. */
export const setupCatalog = {
  version: 3,
  node: {
    version: "24.17.0",
    abi: { linuxKernel: "4.18", glibc: "2.28", glibcxx: "3.4.25", macOS: "13.5" },
    artifacts: {
      "linux-x64": "e0472427aa791ad80bdc426ff7cc73cdd28ed0f616d1ff9689a23a7f47f1265f",
      "linux-arm64": "faa0d59ba7fe7045c950ed09b190578fb8eee73e4358686d38fcc99ca58c1480",
      "darwin-x64": "80da552fe037290cb130e9dea590f5eeeb7aa450636f0c89ab41415511c1ec27",
      "darwin-arm64": "4fc3266a3702eebc39cc37661cf4eeceeade307e242ab64e4d7ce7949197e11f",
    },
  },
  pnpm: {
    version: "10.34.7",
    url: "https://registry.npmjs.org/pnpm/-/pnpm-10.34.7.tgz",
    integrity:
      "upirxYVTmTM3W1lx9LxtbHOhtLftxKh559EC/lQj0eAjCdZ8YKEfBJVQk6luUhrZw7E4zdZUylvlY/N4s65IvQ==",
  },
} as const;
export function setupArtifact(
  tool: "node" | "pnpm",
  platform: SetupPlatform,
): SetupArtifact | undefined {
  if (tool === "pnpm")
    return {
      url: setupCatalog.pnpm.url,
      algorithm: "sha512" as const,
      digest: setupCatalog.pnpm.integrity,
      encoding: "base64" as const,
    };
  const key = `${platform.os}-${platform.arch}`;
  const artifact = Object.entries(setupCatalog.node.artifacts).find(([name]) => name === key);
  return artifact
    ? {
        url: `https://nodejs.org/dist/v${setupCatalog.node.version}/node-v${setupCatalog.node.version}-${key}.tar.gz`,
        algorithm: "sha256" as const,
        digest: artifact[1],
        encoding: "hex" as const,
      }
    : undefined;
}
export function setupVersionMatches(actual: string, required: string): boolean {
  return required.endsWith(".x")
    ? actual.split(".")[0] === required.split(".")[0]
    : actual === required;
}
/** A plan can contain only fixed templates and validated literal package operands. */
export function setupPlan(list: RepositorySetupList, check: SetupCheck): SetupPlan | undefined {
  if (
    check.platform.distro === "unsupported" ||
    check.items.length !== list.requirements.length ||
    check.items.some((item) => item.state === "unable" || item.state === "manual")
  )
    return undefined;
  const packages: string[] = [];
  const toolchains: { tool: "node" | "pnpm"; version: string }[] = [];
  for (const item of list.requirements) {
    const result = check.items.find((value) => value.id === item.id);
    if (!result) return undefined;
    if (result.state === "met") continue;
    if (item.kind === "package") {
      const names = item.packages[check.platform.distro];
      if (
        names === "unsupported" ||
        !names.every((name) =>
          setupPackageName(
            name,
            check.platform.distro === "unsupported" ? "debian" : check.platform.distro,
          ),
        )
      )
        return undefined;
      // These bundled backends cannot enforce an atomic no-removal transaction.
      if ((check.platform.distro === "arch" || check.platform.distro === "rhel") && names.length)
        return undefined;
      packages.push(...names);
    } else {
      const version = setupCatalog[item.tool].version;
      if (
        !setupVersionMatches(version, item.version) ||
        !check.platform.nodeAbi ||
        !setupArtifact(item.tool, check.platform)
      )
        return undefined;
      toolchains.push({ tool: item.tool, version });
    }
  }
  const steps: string[][] = [];
  if (packages.length) {
    if (check.platform.distro === "debian")
      steps.push(
        ["/usr/bin/sudo", "/usr/bin/apt-get", "update"],
        ["/usr/bin/sudo", "/usr/bin/apt-get", "install", "-y", "--no-remove", "--", ...packages],
      );
    if (check.platform.distro === "darwin")
      steps.push(["brew", "install", "--formula", "--", ...packages]);
  }
  for (const item of toolchains)
    steps.push(["foom-host", "--repository-toolchain", item.tool, item.version]);
  return { platform: check.platform, packages, toolchains, steps };
}

/** A mismatching private catalog version must never shadow a matching system tool. */
export function setupSelectedTools(list: RepositorySetupList): ("node" | "pnpm")[] {
  return list.requirements.flatMap((item) =>
    item.kind === "toolchain" && setupVersionMatches(setupCatalog[item.tool].version, item.version)
      ? [item.tool]
      : [],
  );
}
