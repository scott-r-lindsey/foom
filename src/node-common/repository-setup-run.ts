import { setupSelectedTools } from "../shared/repository-setup-catalog";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, relative, sep, isAbsolute } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { inspectSetupSources } from "./repository-setup-sources";
import { privateDirectory } from "./private-files";
import {
  checkSetupList,
  repositorySetupEnvironment,
  setupProbeDependencies,
} from "./repository-setup-check";
import { setupCatalogDigest, setupDigest } from "./repository-setup-digest";
import { installSetupToolchain } from "./repository-toolchain";
import { setupPlan } from "../shared/repository-setup-catalog";
import { parseSetupList, setupRun } from "../shared/repository-setup";
import type { SetupRun } from "../shared/repository-setup.d";

export function setupRunDigest(run: Omit<SetupRun, "digest">): string {
  return setupDigest({ ...run, steps: setupPlan(run.list, run.check)?.steps });
}
/** Same-user helper, reachable only from Settings PTYs. Never a control API. */
export async function runRepositorySetup(
  text: string | undefined,
  prefix: string | undefined,
  source: NodeJS.ProcessEnv,
  home = homedir(),
): Promise<number> {
  if (text === undefined || prefix === undefined || Buffer.byteLength(text) > 128 * 1024) return 2;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 2;
  }
  if (!setupRun(value) || value.catalog !== setupCatalogDigest) return 2;
  const { digest, ...binding } = value;
  const list = parseSetupList(JSON.stringify(value.list));
  if (setupRunDigest({ ...binding, list }) !== digest) return 2;
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
  };
  process.once("SIGHUP", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const contained = (root: string, path: string) => {
      const child = relative(root, path);
      return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    };
    if (!contained(resolve(value.location.root), resolve(value.location.path))) return 2;
    const root = await realpath(value.location.root).catch(() => resolve(value.location.root));
    if (value.location.present) {
      const checkout = await realpath(value.location.path).catch(() => undefined);
      if (!checkout || !contained(root, checkout)) return 2;
    }
    const evidence = [
      ...new Set([...list.evidence, ...list.requirements.flatMap((item) => item.sources)]),
    ];
    const matchingSources = async () => {
      try {
        if (value.location.present)
          return (
            (await inspectSetupSources(value.location.path, evidence)).fingerprint === value.sources
          );
        await lstat(value.location.path);
        return false;
      } catch (error) {
        return (
          !value.location.present &&
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        );
      }
    };
    if (!(await matchingSources())) return 2;
    const excluded = [root, value.location.path];
    const env = await repositorySetupEnvironment(
      source,
      excluded,
      prefix,
      setupSelectedTools(list),
      home,
    );
    const deps = await setupProbeDependencies(env, home, abort.signal, excluded);
    const checked = await checkSetupList(list, deps);
    const plan = setupPlan(list, checked);
    if (!plan || setupDigest(plan) !== setupDigest(setupPlan(list, value.check))) return 2;
    for (const [index, step] of plan.steps.entries()) {
      abort.signal.throwIfAborted();
      process.stdout.write(
        `Step ${String(index + 1)} of ${String(plan.steps.length)}: ${JSON.stringify(step)}\n`,
      );
      if (step[0] === "foom-host") {
        const tool = step[2];
        if (tool !== "node" && tool !== "pnpm") return 2;
        if (prefix === remoteToolchainPrefix(home))
          await privateDirectory(home, ".foom-repository-setup");
        if (!(await matchingSources())) return 2;
        await installSetupToolchain(
          prefix,
          tool,
          plan.platform,
          AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
        );
      } else {
        const command = step[0] === "brew" ? await deps.resolve("brew") : step[0];
        if (!command || !(await matchingSources())) return 2;
        const code = await new Promise<number>((resolve) => {
          const child = spawn(command, step.slice(1), {
            cwd: home,
            env: {
              ...env,
              HOMEBREW_NO_AUTO_UPDATE: "1",
              HOMEBREW_NO_ANALYTICS: "1",
              HOMEBREW_NO_INSTALL_CLEANUP: "1",
              HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: "1",
            },
            shell: false,
            stdio: "inherit",
            signal: abort.signal,
          });
          child.once("error", () => {
            resolve(1);
          });
          child.once("exit", (code) => {
            resolve(code ?? 1);
          });
        });
        if (code !== 0) {
          process.stdout.write(`Failed · step ${String(index + 1)} · exit ${String(code)}\n`);
          return code;
        }
      }
    }
    process.stdout.write("Done\n");
    return 0;
  } finally {
    process.removeListener("SIGHUP", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
export const remoteToolchainPrefix = (home: string) =>
  join(home, ".foom-repository-setup", "toolchains");
