import { homedir, release } from "node:os";
import { isAbsolute, join, delimiter, sep } from "node:path";
import { access, stat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { setupProbe, SetupProbeExit } from "./repository-setup-probe";
import { hostDistro, hostLibc } from "../shared/host-system";
import { open } from "node:fs/promises";
import { selectedToolchainBins } from "./repository-toolchain";
import { setupVersionMatches } from "../shared/repository-setup-catalog";
import type { RepositorySetupList, SetupCheck, SetupPlatform } from "../shared/repository-setup.d";

const setupExcludedRoots = async (
  roots: string | readonly string[] | undefined,
): Promise<string[]> =>
  Promise.all(
    (typeof roots === "string" ? [roots] : (roots ?? [])).map((root) =>
      realpath(root).catch(() => root),
    ),
  );

/** A small complete environment, with no model/control credentials or checkout PATH entries. */
export async function repositorySetupEnvironment(
  source: NodeJS.ProcessEnv,
  checkout: string | readonly string[] | undefined,
  prefix: string,
  tools: readonly ("node" | "pnpm")[],
  home = homedir(),
): Promise<Record<string, string>> {
  const excluded = await setupExcludedRoots(checkout);
  const paths = [
    ...(await selectedToolchainBins(prefix, tools)),
    ...(source["PATH"] ?? "").split(delimiter),
  ];
  const safe: string[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    const canonical = await realpath(path).catch(() => undefined);
    if (
      !canonical ||
      excluded.some((root) => canonical === root || canonical.startsWith(`${root}${sep}`))
    )
      continue;
    if (excluded.length) {
      const targets = await Promise.all(
        ["node", "pnpm", "brew"].map((tool) =>
          realpath(join(canonical, tool)).catch(() => undefined),
        ),
      );
      if (
        targets.some(
          (target) =>
            target &&
            excluded.some((root) => target === root || target.startsWith(`${root}${sep}`)),
        )
      )
        continue;
    }
    if (!safe.includes(canonical)) safe.push(canonical);
  }
  return { HOME: home, PATH: safe.join(delimiter), LANG: "C", LC_ALL: "C", TERM: "xterm-256color" };
}
export interface SetupProbeDependencies {
  platform: SetupPlatform;
  home: string;
  env: Record<string, string>;
  probe: (command: string, args: readonly string[]) => Promise<string>;
  resolve: (tool: "node" | "pnpm" | "brew") => Promise<string | undefined>;
}
export async function setupProbeDependencies(
  env: Record<string, string>,
  home = homedir(),
  signal?: AbortSignal,
  excludedRoot?: string | readonly string[],
): Promise<SetupProbeDependencies> {
  const excluded = await setupExcludedRoots(excludedRoot);
  const probeEnvironment = {
    ...env,
    COREPACK_ENABLE_NETWORK: "0",
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_NO_ANALYTICS: "1",
  };
  const probe = (command: string, args: readonly string[]) =>
    setupProbe(command, args, home, probeEnvironment, signal);
  const libstdcpp = async (): Promise<boolean> => {
    const machine = process.arch === "arm64" ? "aarch64" : "x86_64";
    for (const path of [
      `/usr/lib/${machine}-linux-gnu/libstdc++.so.6`,
      `/lib/${machine}-linux-gnu/libstdc++.so.6`,
      "/usr/lib64/libstdc++.so.6",
      "/lib64/libstdc++.so.6",
      "/usr/lib/libstdc++.so.6",
    ]) {
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 16 * 1024 * 1024) continue;
          const bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (
            bytesRead <= 16 * 1024 * 1024 &&
            bytes.subarray(0, bytesRead).includes(Buffer.from("GLIBCXX_3.4.25\0"))
          )
            return true;
        } finally {
          await file.close();
        }
      } catch {
        /* Unknown/absent runtime libraries never establish ABI compatibility. */
      }
    }
    return false;
  };
  let nodeAbi = false;
  let distro: SetupPlatform["distro"] = process.platform === "darwin" ? "darwin" : "unsupported";
  if (process.platform === "linux") {
    const file = await open("/etc/os-release", constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const bytes = Buffer.alloc(65537);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const observed =
        bytesRead <= 65536
          ? hostDistro(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)),
            )
          : "unknown";
      distro = observed === "unknown" ? "unsupported" : observed;
    } finally {
      await file.close();
    }
  }
  if (process.platform === "linux") {
    const kernel = /^(\d+)\.(\d+)/u.exec(release());
    nodeAbi =
      hostLibc(await probe("/usr/bin/getconf", ["GNU_LIBC_VERSION"]).catch(() => "")) ===
        "supported" &&
      !!kernel &&
      (Number(kernel[1]) > 4 || (Number(kernel[1]) === 4 && Number(kernel[2]) >= 18)) &&
      (await libstdcpp());
  } else if (process.platform === "darwin") {
    const version = /^(\d+)\.(\d+)/u.exec(
      await probe("/usr/bin/sw_vers", ["-productVersion"]).catch(() => ""),
    );
    nodeAbi =
      !!version &&
      (Number(version[1]) > 13 || (Number(version[1]) === 13 && Number(version[2]) >= 5));
  }
  const platform: SetupPlatform = {
    os: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
    arch: process.arch === "x64" || process.arch === "arm64" ? process.arch : "unsupported",
    distro,
    nodeAbi,
  };
  return {
    platform,
    home,
    env: probeEnvironment,
    probe,
    resolve: async (tool) => {
      for (const directory of (env["PATH"] ?? "").split(delimiter)) {
        if (
          !isAbsolute(directory) ||
          (tool === "brew" && !["/opt/homebrew/bin", "/usr/local/bin"].includes(directory))
        )
          continue;
        const command = join(directory, tool);
        try {
          await access(command, constants.X_OK);
          const canonical = await realpath(command);
          if (excluded.some((root) => canonical === root || canonical.startsWith(`${root}${sep}`)))
            continue;
          if ((await stat(canonical)).isFile()) return canonical;
        } catch {
          /* Continue to the next safe login directory. */
        }
      }
      return undefined;
    },
  };
}
/** Checks only package databases and bundled version arguments, always outside a checkout. */
export async function checkSetupList(
  list: RepositorySetupList,
  deps: SetupProbeDependencies,
): Promise<SetupCheck> {
  const items: SetupCheck["items"][number][] = [];
  for (const item of list.requirements) {
    let state: SetupCheck["items"][number]["state"] = "met";
    if (deps.platform.distro === "unsupported") state = "manual";
    else if (item.kind === "toolchain") {
      try {
        const command = await deps.resolve(item.tool);
        if (!command) state = "missing";
        else {
          const output = (await deps.probe(command, ["--version"])).trim();
          const version = /^(?:v)?(\d+\.\d+\.\d+)$/u.exec(output)?.[1];
          state = version
            ? setupVersionMatches(version, item.version)
              ? "met"
              : "missing"
            : "unable";
        }
      } catch {
        state = "unable";
      }
    } else {
      const names = item.packages[deps.platform.distro];
      if (names === "unsupported") state = "manual";
      else
        for (const name of names) {
          try {
            let output: string;
            if (deps.platform.distro === "debian") {
              output = await deps.probe("/usr/bin/dpkg-query", [
                "--show",
                "--showformat=${db:Status-Status}",
                "--",
                name,
              ]);
              if (output.trim() !== "installed") state = "missing";
            } else if (deps.platform.distro === "rhel")
              await deps.probe("/usr/bin/rpm", ["--query", "--", name]);
            else if (deps.platform.distro === "arch")
              await deps.probe("/usr/bin/pacman", ["-Q", "--", name]);
            else {
              const brew = await deps.resolve("brew");
              if (!brew) {
                state = "manual";
                break;
              }
              output = await deps.probe(brew, ["list", "--versions", name]);
              if (!output.trim()) state = "missing";
            }
          } catch (error) {
            if (error instanceof SetupProbeExit && error.code === 1) {
              state = "missing";
            } else state = "unable";
          }
          if (state === "unable") break;
        }
    }
    items.push({ id: item.id, state });
  }
  return { platform: deps.platform, items };
}
