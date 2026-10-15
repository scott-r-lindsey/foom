import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Two lanes maximum: lint, plus the original order of the other stages. Never
// overlap the unit/native tests with CI-policy tests or another test invocation.
export async function checkLocal(run) {
  const results = [];
  async function lane(stages) {
    for (const stage of stages) {
      try {
        results.push({ stage, code: await run(stage) });
      } catch {
        results.push({ stage, code: 1 });
      }
    }
  }
  await Promise.all([lane(["lint:local"]), lane(["format:check", "typecheck", "test", "test:ci"])]);
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.npm_execpath) throw new Error("Run with pnpm run check:local");
  const results = await checkLocal(
    (stage) =>
      new Promise((resolve, reject) => {
        const executable = process.env.npm_execpath;
        const isScript = /\.[cm]?js$/.test(executable);
        const child = spawn(
          isScript ? process.execPath : executable,
          [...(isScript ? [executable] : []), "run", stage],
          { stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      }),
  );
  for (const { stage, code } of results)
    console.info(`${stage}: ${code === 0 ? "passed" : `failed (${code})`}`);
  process.exitCode = results.some(({ code }) => code !== 0) ? 1 : 0;
}
