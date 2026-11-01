import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { posix } from "node:path";
import { bundledAgentData } from "../../shared/bundled-agent-data";
import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import { recipeRequest, selectHostRecipe } from "../../shared/registered-host-recipes";
import { hostDiscovery, hostLoginEnvironment } from "./agent-discovery";
import { executable, requirements } from "./host-facts";
import { remoteShell } from "./daemon";

/** Runs inside a user-clicked PTY only; the daemon never invokes it as a probe. */
export async function runHostRecipe(argv: readonly string[], home = homedir()): Promise<number> {
  const [tool, action, distro, digest] = argv;
  const request = { tool, action, distro };
  if (argv.length !== 4 || !recipeRequest(request)) return 2;
  const env = await hostLoginEnvironment(remoteShell(), home, undefined, true);
  const facts = await requirements(process.platform, home, home, env);
  const model = bundledAgentData
    .map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)
    .find((model) => model.id === tool);
  const recipe = selectHostRecipe(request, facts, model?.hostSetup);
  if (!recipe || createHash("sha256").update(JSON.stringify(recipe.steps)).digest("hex") !== digest)
    return 2;
  for (const argv of recipe.steps) {
    let command = argv[0];
    if (!command) return 2;
    if (command === "brew") {
      command = undefined;
      for (const directory of (env["PATH"] ?? "").split(":")) {
        if (
          ["/opt/homebrew/bin", "/usr/local/bin"].includes(directory) &&
          (await executable(posix.join(directory, "brew")))
        ) {
          command = posix.join(directory, "brew");
          break;
        }
      }
    } else if (!command.startsWith("/")) {
      if (command !== tool) return 2;
      command = (
        await hostDiscovery({ executables: model?.executables ?? [command] }, remoteShell(), home)
      ).command;
    }
    if (!command) return 2;
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command, argv.slice(1), {
        cwd: home,
        env,
        shell: false,
        stdio: "inherit",
      });
      child.once("error", () => {
        resolve(1);
      });
      child.once("exit", (code) => {
        resolve(code ?? 1);
      });
    });
    if (code !== 0) return code;
  }
  return 0;
}
