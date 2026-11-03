import { constants } from "node:fs";
import { open, access, stat, realpath, mkdtemp, rm } from "node:fs/promises";
import { join, isAbsolute, delimiter, sep, basename } from "node:path";
import type { HostBuildFact } from "../../shared/registered-hosts.d";
import { record } from "../../shared/remote-agent-protocol";
import { hostProbe } from "./agent-discovery";

/** Declared requirements only. Never run package scripts or install dependencies. */
export async function buildFacts(
  checkout: string,
  env: NodeJS.ProcessEnv,
  home: string,
  signal?: AbortSignal,
): Promise<HostBuildFact[]> {
  const facts: HostBuildFact[] = [];
  try {
    const file = await open(
      join(checkout, "package.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let manifest: unknown;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536) return facts;
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) return facts;
      manifest = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    } finally {
      await file.close();
    }
    if (!record(manifest)) return facts;
    const engines = manifest["engines"];
    const node = record(engines) ? engines["node"] : undefined;
    if (typeof node === "string" && /^[a-zA-Z0-9.*+^~|<>= .-]{1,128}$/u.test(node))
      facts.push({ tool: "node", required: node });
    const manager = manifest["packageManager"];
    const match =
      typeof manager === "string"
        ? /^(npm|pnpm|yarn|bun)@([0-9][a-zA-Z0-9.+-]{0,127})$/u.exec(manager)
        : null;
    const tool = match?.[1];
    if (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun")
      facts.push({ tool, required: match?.[2] ?? "" });
    if (!facts.length) return facts;
    const root = await realpath(checkout);
    const accountHome = await realpath(home);
    const inCheckout = (path: string) => path === root || path.startsWith(`${root}${sep}`);
    if (inCheckout(accountHome)) return facts;
    const directories: string[] = [];
    for (const path of (env["PATH"] ?? "").split(delimiter)) {
      if (!isAbsolute(path)) continue;
      try {
        const directory = await realpath(path);
        if (inCheckout(directory)) continue;
        const node = await realpath(join(directory, "node")).catch(() => undefined);
        if (!node || !inCheckout(node)) directories.push(directory);
      } catch {
        /* Missing PATH entries do not authorize a fallback lookup. */
      }
    }
    // A private empty cwd and HOME keep project config, plugins and preload files
    // out of observational probes. Never run a version probe inside a checkout.
    const cwd = await mkdtemp(join(accountHome, ".foom-build-probe-"));
    try {
      const probeEnv: NodeJS.ProcessEnv = {
        PATH: directories.join(delimiter),
        HOME: cwd,
        USERPROFILE: cwd,
        XDG_CONFIG_HOME: cwd,
        LANG: "C",
        LC_ALL: "C",
        COREPACK_ENABLE_NETWORK: "0",
        COREPACK_ENABLE_AUTO_PIN: "0",
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        COREPACK_ENABLE_ENV_FILE: "0",
        YARN_IGNORE_PATH: "1",
        YARN_RC_FILENAME: `${basename(cwd)}.yml`,
        npm_config_userconfig: join(cwd, "npm-user.rc"),
        npm_config_globalconfig: join(cwd, "npm-global.rc"),
        npm_config_ignore_scripts: "true",
        npm_config_ignore_pnpmfile: "true",
        npm_config_manage_package_manager_versions: "false",
        pnpm_config_pm_on_fail: "ignore",
        pnpm_config_ignore_pnpmfile: "true",
        pnpm_config_ignore_scripts: "true",
      };
      for (const fact of facts) {
        try {
          let command: string | undefined;
          for (const directory of directories) {
            try {
              const candidate = await realpath(join(directory, fact.tool));
              if (inCheckout(candidate)) continue;
              await access(candidate, constants.X_OK);
              if ((await stat(candidate)).isFile()) {
                command = candidate;
                break;
              }
            } catch {
              /* Try only the remaining approved absolute PATH entries. */
            }
          }
          if (!command) continue;
          const version = (
            await hostProbe(command, ["--version"], cwd, probeEnv, false, 5000, signal)
          )
            .trim()
            .replace(/^v/u, "");
          if (/^[0-9][a-zA-Z0-9.+-]{0,63}$/u.test(version)) fact.version = version;
        } catch {
          signal?.throwIfAborted();
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  } catch {
    signal?.throwIfAborted();
  }
  return facts;
}
