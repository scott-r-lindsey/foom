import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { HomeShellFacts } from "../../shared/panel";

export const homeDirectory = homedir();
export function shellPath(): string {
  return process.platform === "win32" ? "powershell.exe" : process.env["SHELL"] || "/bin/bash";
}
/** Fixed probe only, never a renderer-supplied executable or program. */
export async function homeShellFacts(): Promise<HomeShellFacts> {
  const path = shellPath();
  try {
    const { stdout } = await promisify(execFile)(
      path,
      process.platform === "win32"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$PSVersionTable.PSVersion.ToString()",
          ]
        : ["--version"],
      { timeout: 3000, maxBuffer: 16_384, encoding: "utf8" },
    );
    return {
      directory: homeDirectory,
      path,
      version: stdout.trim().split("\n")[0]?.slice(0, 256) || null,
    };
  } catch {
    return { directory: homeDirectory, path, version: null };
  }
}
