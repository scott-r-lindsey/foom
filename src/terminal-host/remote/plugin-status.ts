import { hostProbe } from "./agent-discovery";
import { record } from "../../shared/remote-agent-protocol";

/** CLI inventory only. Unknown ownership never grants a remote installation action. */
export async function remotePluginState(
  command: string,
  home: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<"present" | "not-installed" | "unavailable"> {
  try {
    const output = await hostProbe(
      command,
      ["plugin", "list", "--json"],
      home,
      env,
      false,
      5000,
      signal,
    );
    const inventory: unknown = JSON.parse(output);
    if (
      !Array.isArray(inventory) ||
      inventory.length > 64 ||
      !inventory.every(
        (entry: unknown) =>
          record(entry) &&
          typeof entry["name"] === "string" &&
          /^[^\p{C}\u2028\u2029]{1,64}$/u.test(entry["name"]) &&
          typeof entry["enabled"] === "boolean",
      )
    )
      return "unavailable";
    return inventory.some((entry: unknown) => record(entry) && entry["name"] === "foom")
      ? "present"
      : "not-installed";
  } catch {
    return "unavailable";
  }
}
