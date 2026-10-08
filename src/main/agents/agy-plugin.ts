import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type { AgyPluginAction, AgyPluginStatus } from "../../shared/agy-plugin";
import { AGY_PLUGIN_VERSION } from "./agy-observer";

const execute = promisify(execFile);
const options = { timeout: 5000, maxBuffer: 65536, encoding: "utf8" } as const;
export function agyPluginDirectory(): string {
  return join(__dirname, "../../observers/foom").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function json(path: string): Promise<unknown> {
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid plugin metadata");
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes);
    if (bytesRead > 65536) throw new Error("Invalid plugin metadata");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
  } catch (error) {
    if (record(error) && error["code"] === "ENOENT") return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

/** CLI owns all mutations. Read fixed metadata because plugin list omits version and enabled state. */
export class AgyPlugin {
  private busy = false;
  constructor(
    private readonly home = homedir(),
    private readonly run: (
      executable: string,
      args: readonly string[],
      options: { timeout: number; maxBuffer: number; encoding: "utf8" },
    ) => Promise<{ stdout: string }> = execute,
  ) {}

  async status(executable: string): Promise<AgyPluginStatus> {
    try {
      const { stdout } = await this.run(executable, ["plugin", "list"], options);
      const list: unknown =
        stdout.trim() === "No imported plugins." ? { imports: [] } : JSON.parse(stdout);
      if (!record(list) || !Array.isArray(list["imports"])) throw new Error("Invalid list");
      const directory = join(this.home, ".gemini/config/plugins/foom");
      const directoryInfo = await lstat(directory).catch((error: unknown) => {
        if (record(error) && error["code"] === "ENOENT") return undefined;
        throw error;
      });
      if (directoryInfo && !directoryInfo.isDirectory()) throw new Error("Unsafe plugin directory");
      const manifest = await json(join(directory, "plugin.json"));
      if (
        manifest === undefined &&
        directoryInfo === undefined &&
        !list["imports"].some((entry: unknown) => record(entry) && entry["name"] === "foom")
      )
        return { state: "not-installed" };
      if (
        !record(manifest) ||
        manifest["name"] !== "foom" ||
        typeof manifest["foomObserverVersion"] !== "number" ||
        !Number.isSafeInteger(manifest["foomObserverVersion"]) ||
        manifest["foomObserverVersion"] < 0
      )
        throw new Error("Unrecognized plugin; refusing to replace it");
      const version = manifest["foomObserverVersion"];
      const config = await json(join(this.home, ".gemini/config/config.json"));
      if (config !== undefined && !record(config)) throw new Error("Invalid config");
      const plugins = record(config) ? config["plugins"] : undefined;
      if (plugins !== undefined && !record(plugins)) throw new Error("Invalid plugin config");
      const plugin = record(plugins) ? plugins["foom"] : undefined;
      if (plugin !== undefined && (!record(plugin) || typeof plugin["enabled"] !== "boolean"))
        throw new Error("Invalid plugin switch");
      const disabled = record(plugin) ? plugin["enabled"] === false : manifest["disabled"] === true;
      return {
        state: disabled ? "disabled" : version < AGY_PLUGIN_VERSION ? "outdated" : "installed",
        version,
      };
    } catch {
      return { state: "unavailable" };
    }
  }

  async change(executable: string, action: AgyPluginAction): Promise<void> {
    if (this.busy) throw new Error("Antigravity plugin is busy");
    this.busy = true;
    try {
      const status = await this.status(executable);
      if (
        status.state === "unavailable" ||
        (action === "install" ? status.state !== "not-installed" : status.state === "not-installed")
      )
        throw new Error("Antigravity plugin changed. Scan again before continuing.");
      const args =
        action === "remove"
          ? ["plugin", "uninstall", "foom"]
          : action === "enable"
            ? ["plugin", "enable", "foom"]
            : ["plugin", "install", agyPluginDirectory()];
      try {
        await this.run(executable, args, options);
      } catch {
        throw new Error("Antigravity plugin command failed. Scan again to check its status.");
      }
    } finally {
      this.busy = false;
    }
  }
}
