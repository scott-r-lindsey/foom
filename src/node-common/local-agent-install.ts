import { bundledAgentData } from "../shared/bundled-agent-data";
import { parseAgentManifest } from "../shared/agent-plugin-parser";
import { runVendorScript } from "./vendor-install";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

/** Internal Settings helper. No discovery, pairing, agent configuration or control grant. */
export async function installLocalAgent(id: string | undefined): Promise<number> {
  // Accidental-use guard only: same-user processes can set this, so it is not authorization.
  if (process.env["FOOM_SETTINGS_INSTALL"] !== "1") return 2;
  if (process.platform !== "linux" && process.platform !== "darwin") return 2;
  const model = bundledAgentData
    .map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)
    .find((model) => model.id === id);
  const setup = model?.hostSetup;
  if (!setup?.script) return 2;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("FOOM_")),
  );
  const argv = process.platform === "darwin" ? setup.install?.darwin : undefined;
  if (argv) {
    for (const directory of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!(env["PATH"] ?? "").split(":").includes(directory)) continue;
      const command = `${directory}/brew`;
      try {
        await access(command, constants.X_OK);
      } catch {
        continue;
      }
      process.stdout.write(`${argv.join(" ")}\n`);
      return new Promise<number>((resolve) => {
        const child = spawn(command, argv.slice(1), {
          cwd: homedir(),
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
    }
  }
  return runVendorScript(setup.script, homedir(), env);
}
