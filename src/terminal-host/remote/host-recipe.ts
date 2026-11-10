import { runVendorScript, installerEnvironment } from "../../node-common/vendor-install";
import { remotePluginState } from "./plugin-status";
import { stageRemotePlugin } from "./agent-launch";
import { originSshArgs } from "../../shared/registered-hosts";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { posix } from "node:path";
import { bundledAgentData } from "../../shared/bundled-agent-data";
import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import {
  recipeDigestInput,
  recipeRequest,
  selectHostRecipe,
} from "../../shared/registered-host-recipes";
import { hostDiscovery, hostLoginEnvironment } from "./agent-discovery";
import { executable, requirements } from "./host-facts";
import { remoteShell } from "./daemon";

/** Foom launches this from trusted Settings actions, never probes or control tools.
 * Direct same-user helper invocation is not an authorization boundary. */
export async function runHostRecipe(argv: readonly string[], home = homedir()): Promise<number> {
  const [tool, action, distro, digest] = argv;
  const request = { tool, action, distro };
  if (argv.length !== 4 || !recipeRequest(request)) return 2;
  const login = await hostLoginEnvironment(remoteShell(), home, undefined, true);
  if (["install", "install-sign-in"].includes(request.action) && !login["PATH"]) return 2;
  const env =
    request.action === "install" || request.action === "install-sign-in"
      ? installerEnvironment(home, login)
      : login;
  const facts = await requirements(process.platform, home, home, env);
  const model = bundledAgentData
    .map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)
    .find((model) => model.id === tool);
  const recipe = selectHostRecipe(request, facts, model?.hostSetup);
  if (!recipe || createHash("sha256").update(recipeDigestInput(recipe)).digest("hex") !== digest)
    return 2;
  if (request.action === "install-plugin") {
    const found = await hostDiscovery({ executables: ["agy"] }, remoteShell(), home);
    if ((await remotePluginState(found.command, home, env)) !== "not-installed") return 2;
  }
  if (recipe.steps[0]?.[1] === "--vendor-script" && model?.hostSetup?.script) {
    // Accidental-use guard only: same-user processes can set this, so it is not authorization.
    if (process.env["FOOM_SETTINGS_INSTALL"] !== "1") return 2;
    return runVendorScript(model.hostSetup.script, home, env);
  }
  let staged: string | undefined;
  for (const step of recipe.steps) {
    if (request.action === "install-plugin" && step[0] === "foom-host") {
      process.stdout.write("foom-host --stage-plugin agy\n");
      staged = await stageRemotePlugin("agy", home);
      process.stdout.write(`${staged}\n`);
      continue;
    }
    const argv = step.map((value) => (value === "{stagedPlugin}" && staged ? staged : value));
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
    const ghLogin =
      request.tool === "gh" &&
      ["sign-in", "install-sign-in"].includes(request.action) &&
      argv[0] === "gh";
    if (ghLogin && argv.includes("--expiring")) {
      // The digest binds both fixed variants; the only permitted downgrade removes
      // this one flag after a bounded version probe, never after an auth failure.
      let expiring = false;
      try {
        const { stdout } = await promisify(execFile)(command, ["--version"], {
          cwd: home,
          env: login,
          shell: false,
          timeout: 5000,
          maxBuffer: 4096,
          encoding: "utf8",
        });
        const version = /^gh version (\d+)\.(\d+)\.(\d+)(?:[ \r\n]|$)/u.exec(stdout);
        expiring =
          !!version &&
          (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 103));
      } catch {
        /* Unknown versions retain the compatible recipe. */
      }
      if (!expiring) argv.splice(argv.indexOf("--expiring"), 1);
    }
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command, argv.slice(1), {
        cwd: home,
        env: ghLogin ? login : env,
        shell: false,
        stdio: ghLogin ? ["ignore", "inherit", "inherit"] : "inherit",
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

/** Interactive only: the user verifies and accepts the fingerprint in this PTY. */
export async function runOriginTrust(argv: readonly string[], home = homedir()): Promise<number> {
  const args = argv.length === 1 ? originSshArgs(argv[0]) : undefined;
  if (!args) return 2;
  const env = await hostLoginEnvironment(remoteShell(), home, undefined, true);
  const found = await hostDiscovery({ executables: ["ssh"] }, remoteShell(), home);
  return new Promise<number>((resolve) => {
    const child = spawn(found.command, args, { cwd: home, env, shell: false, stdio: "inherit" });
    child.once("error", () => {
      resolve(1);
    });
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}
