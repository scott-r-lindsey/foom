import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";

const tools = ["node", "pnpm", "brew"] as const;
type Tool = (typeof tools)[number];
type Invocation = { command: string; args: readonly string[] };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Bounded regular-file reads; never let a script choose an unchecked interpreter. */
async function shebang(path: string): Promise<readonly [string, string?] | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a probe executable");
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytes[0] !== 35 || bytes[1] !== 33) return undefined;
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0 && bytesRead > 4096) throw new Error("Oversized probe shebang");
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(2, newline < 0 ? bytesRead : newline))
      .trim();
    const match = /^(\S+)(?:[\t ]+(\S+))?$/u.exec(text);
    if (!match?.[1] || !isAbsolute(match[1]) || text.includes("\0"))
      throw new Error("Unsupported probe shebang");
    return match[2] ? [match[1], match[2]] : [match[1]];
  } finally {
    await file.close();
  }
}
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
  const envCommand = await realpath("/usr/bin/env");
  const chain = async (path: string, seen: readonly string[] = []): Promise<Invocation> => {
    const target = await realpath(path);
    if (!outside(target) || seen.includes(target) || seen.length > 4)
      throw new Error("Unsafe probe interpreter chain");
    await access(target, constants.X_OK);
    const header = await shebang(target);
    if (!header) return { command: target, args: [] };
    const interpreter = header[0];
    const canonical = await realpath(interpreter);
    if (!outside(canonical)) throw new Error("Excluded probe interpreter");
    let selected = canonical;
    let option = header[1];
    if (canonical === envCommand) {
      // Only the simple env NAME form is supported. No assignments, flags or -S.
      if (!option || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(option))
        throw new Error("Unsupported env probe shebang");
      if (await shebang(canonical)) throw new Error("Scripted env is unsupported");
      const tool = tools.find((tool) => tool === option);
      const pinned = tool ? targets.get(tool) : undefined;
      selected = pinned ?? "";
      if (!tool)
        for (const directory of system) {
          try {
            const candidate = await realpath(join(directory, option));
            if (!outside(candidate)) continue;
            await access(candidate, constants.X_OK);
            if (!(await stat(candidate)).isFile()) continue;
            selected = candidate;
            break;
          } catch {
            /* Missing system interpreters never grant a capability. */
          }
        }
      if (!selected) throw new Error("Missing env probe interpreter");
      option = undefined;
    }
    const parent = await chain(selected, [...seen, target]);
    return { command: parent.command, args: [...parent.args, ...(option ? [option] : []), target] };
  };
  const plans = new Map<string, Invocation>();
  for (const target of targets.values()) {
    try {
      plans.set(target, await chain(target));
    } catch {
      /* Keep the discovered tool blocked; never fall through to a different tool. */
    }
  }
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
      const plan = target ? plans.get(target) : undefined;
      if (plan && !plan.args.length) await symlink(plan.command, join(directory, tool));
      else
        await writeFile(
          join(directory, tool),
          `#!${shell}\n${plan ? `exec ${[plan.command, ...plan.args].map(quote).join(" ")} "$@"` : "exit 127"}\n`,
          {
            flag: "wx",
            mode: 0o700,
          },
        );
    }
    let closed = false;
    return {
      path: [directory, ...system].join(delimiter),
      resolve: (tool: Tool) => (closed ? undefined : targets.get(tool)),
      invocation: (command: string, args: readonly string[]): Invocation => {
        if (closed) throw new Error("Probe scope closed");
        const plan = plans.get(command);
        if (!plan && [...targets.values()].includes(command))
          throw new Error("Unsafe probe interpreter chain");
        return plan ? { command: plan.command, args: [...plan.args, ...args] } : { command, args };
      },
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
