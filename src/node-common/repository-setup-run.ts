import { setupSelectedTools } from "../shared/repository-setup-catalog";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
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
    const env = await repositorySetupEnvironment(
      source,
      value.host === "local" ? value.repository : undefined,
      prefix,
      setupSelectedTools(list),
      home,
    );
    const deps = await setupProbeDependencies(env, home, abort.signal);
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
        await installSetupToolchain(
          prefix,
          tool,
          plan.platform,
          AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
        );
      } else {
        const command = step[0] === "brew" ? await deps.resolve("brew") : step[0];
        if (!command) return 2;
        const code = await new Promise<number>((resolve) => {
          const child = spawn(command, step.slice(1), {
            cwd: home,
            env,
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
