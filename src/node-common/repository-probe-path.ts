import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";

const tools = ["node", "pnpm", "brew"] as const;
type Tool = (typeof tools)[number];
/** Pin PATH lookups before any probe can await or execute a script. */
export async function repositoryProbePath(
  env: Record<string, string>,
  excluded: readonly string[],
) {
  const outside = (path: string) =>
    !excluded.some((root) => path === root || path.startsWith(`${root}${sep}`));
  const targets = new Map<Tool, string>();
  for (const tool of tools) {
    for (const directory of (env["PATH"] ?? "").split(delimiter)) {
      if (
        !isAbsolute(directory) ||
        (tool === "brew" && !["/opt/homebrew/bin", "/usr/local/bin"].includes(directory))
      )
        continue;
      try {
        const target = await realpath(join(directory, tool));
        if (!outside(target)) continue;
        await access(target, constants.X_OK);
        if ((await stat(target)).isFile()) {
          targets.set(tool, target);
          break;
        }
      } catch {
        /* Unknown targets do not become probe capabilities. */
      }
    }
  }
  const system: string[] = [];
  for (const path of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    try {
      const target = await realpath(path);
      const info = await stat(target);
      if (
        outside(target) &&
        info.isDirectory() &&
        info.uid === 0 &&
        !(info.mode & 0o022) &&
        !system.includes(target)
      )
        system.push(target);
    } catch {
      /* Unverified system directories never enter PATH. */
    }
  }
  const shell = await realpath("/bin/sh");
  const shellInfo = await stat(shell);
  if (!outside(shell) || !shellInfo.isFile() || shellInfo.uid !== 0 || shellInfo.mode & 0o022)
    throw new Error("Unsafe probe interpreter");
  const created = await mkdtemp(join(tmpdir(), "foom-setup-probes-"));
  try {
    const directory = await realpath(created);
    const info = await lstat(directory);
    if (
      !outside(directory) ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      throw new Error("Unsafe probe directory");
    for (const tool of tools) {
      const target = targets.get(tool);
      if (target) await symlink(target, join(directory, tool));
      else
        await writeFile(join(directory, tool), `#!${shell}\nexit 127\n`, {
          flag: "wx",
          mode: 0o700,
        });
    }
    let closed = false;
    return {
      path: [directory, ...system].join(delimiter),
      resolve: (tool: Tool) => (closed ? undefined : targets.get(tool)),
      assertOpen: () => {
        if (closed) throw new Error("Probe scope closed");
      },
      dispose: async () => {
        closed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(created, { recursive: true, force: true });
    throw error;
  }
}
