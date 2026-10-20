import { HookReceiver } from "./hook-receiver";
import { ProbeMcp } from "./probe-mcp";
import type { ProbeHookEvent } from "./probe-events";
import type { HookSignal } from "../../shared/hooks";
import { prepareV2Hooks } from "./providers/v2-hook-launch";

export interface PreparedProbe {
  spec: TerminalSpec;
  agentVersion?: string;
  conversationId?: string;
  events?(): {
    hooks: ProbeHookEvent[];
    mcp: { connected: boolean; listedTools: boolean; pinged: boolean };
  };
  hook?(): HookSignal | undefined;
  dispose(): void;
}
import { TERMINAL_ENVIRONMENT } from "../../shared/terminal-environment";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import type { TerminalSpec } from "../../shared/desktop";
import { agentProvider } from "./providers/registry";
import { v2Provider } from "./providers/v2";
import { readOwnedFile } from "./providers/v2-files";
import { bypassEnvironment, matchesArguments } from "./providers/v2-values";
import { inheritedEnvironment } from "../setup/environment";
import type { ProbeRequest } from "../../node-common/agent-probe";
import type { AgentProvider } from "./providers/provider";
import { readLoginShell } from "../login-shell";

const options = { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 } as const;
/** Fixed program, no caller text. Do not run agents through a login shell. */
export async function probeEnvironment(
  run: (
    file: string,
    args: readonly string[],
    options: { encoding: "utf8"; timeout: number; maxBuffer: number; cwd: string },
  ) => Promise<{ stdout: string }> = readLoginShell,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const scrub = (env: NodeJS.ProcessEnv) =>
    Object.fromEntries(
      Object.entries(inheritedEnvironment(env)).filter(
        ([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !/^GIT_/iu.test(name),
      ),
    );
  if (platform === "win32") return scrub(source);
  const shell = userInfo().shell;
  if (!shell || !isAbsolute(shell)) throw Error("Login shell unavailable");
  const { stdout } = await run(shell, ["-ilc", "printf '\\000FOOM_PROBE_ENV\\000'; env -0"], {
    ...options,
    cwd: homedir(),
  });
  const env: Record<string, string> = {};
  for (const entry of (stdout.split("\0FOOM_PROBE_ENV\0")[1] ?? "").split("\0")) {
    const equal = entry.indexOf("=");
    const name = entry.slice(0, equal);
    if (equal > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) env[name] = entry.slice(equal + 1);
  }
  if (!env["PATH"]) throw Error("Login shell environment unavailable");
  return scrub(env);
}
export function isolatedGitEnvironment(
  env: NodeJS.ProcessEnv,
  windows = process.platform === "win32",
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: windows ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
export async function scratchRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "foom-agent-probe-"));
  try {
    await readLoginShell("git", ["-c", "init.templateDir=", "init", "--quiet", "--", directory], {
      ...options,
      cwd: directory,
      env: isolatedGitEnvironment(process.env),
    });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function executable(provider: AgentProvider, env: Record<string, string>): Promise<string> {
  const path = env["PATH"] ?? env["Path"] ?? "";
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const name of provider.executableNames)
      for (const suffix of process.platform === "win32" ? [".exe", ".com", ""] : [""]) {
        const file = join(directory, name + suffix);
        try {
          await access(file, constants.X_OK);
          if ((await stat(file)).isFile()) return file;
        } catch {
          /* Continue searching explicit PATH entries. */
        }
      }
  }
  throw Error("Agent executable unavailable");
}
export async function probeProvider(
  request: Extract<ProbeRequest, { action: "start" }>,
  configRoot: string,
): Promise<AgentProvider> {
  if (!request.manifest) return agentProvider(request.agent);
  const path = resolve(configRoot, request.manifest);
  const text = await readOwnedFile(path, 65536, async (file) => {
    if (!(await lstat(file)).isFile()) throw Error("Unsafe manifest");
  });
  const parsed = parseAgentManifest(text);
  if (parsed.model.id !== request.agent) throw Error("Manifest agent mismatch");
  // Captured immutable manifest, never registered as an installed provider.
  return v2Provider(parsed.model, () => Promise.resolve());
}
export async function prepareProbe(
  provider: AgentProvider,
  request: Extract<ProbeRequest, { action: "start" }>,
  cwd: string,
  env: Record<string, string>,
): Promise<PreparedProbe> {
  await provider.validate?.();
  const launchEnvironment = { ...env, ...TERMINAL_ENVIRONMENT };
  if (bypassEnvironment(provider.model, launchEnvironment).length)
    throw Error("Probe bypass environment refused");
  const command = await executable(provider, launchEnvironment);
  const read = async (flag: string) => {
    try {
      return (await readLoginShell(command, [flag], { ...options, cwd, env: launchEnvironment }))
        .stdout;
    } catch {
      return "";
    }
  };
  // Clone only for this probe. Normal discovery and launches keep every gate intact.
  const verification = v2Provider(
    provider.model,
    async () => {
      await provider.validate?.();
    },
    true,
  );
  const installation = verification.discover(
    command,
    (await read("--version")).trim(),
    await read("--help"),
  );
  const hooks: ProbeHookEvent[] = [];
  let signal: HookSignal | undefined;
  let expected: string | undefined;
  const receiver = await HookReceiver.listen((value) => {
    signal = value;
  });
  let mcp: ProbeMcp | undefined;
  let binding: Awaited<ReturnType<typeof prepareV2Hooks>> | undefined;
  let prepared: Awaited<ReturnType<AgentProvider["prepareLaunch"]>> | undefined;
  try {
    mcp = await ProbeMcp.listen();
    binding = await prepareV2Hooks(
      {
        register: (key, agent, v2) =>
          receiver.register(
            key,
            agent,
            v2
              ? {
                  ...v2,
                  observe: {
                    expected: () => expected,
                    receive: (event) => {
                      if (hooks.length < 128) hooks.push(event);
                    },
                  },
                }
              : undefined,
          ),
      },
      verification.model,
      () => {},
      process.platform === "win32",
      cwd,
      cwd,
    );
    prepared = await verification.prepareLaunch(
      installation,
      {
        agent: request.agent,
        repository: cwd,
        worktree: cwd,
        cols: 80,
        rows: 24,
        ...(request.resume === undefined ? {} : { conversationId: request.resume }),
      },
      [],
      {
        env: { FOOM_CONTROL_URL: mcp.url, FOOM_CONTROL_TOKEN: mcp.token },
        bind: () => {},
        dispose: () => {},
      },
      false,
      true,
      binding,
    );
    expected = prepared.conversationId;
    if (matchesArguments(provider.model.bypassArguments, prepared.args))
      throw Error("Probe bypass arguments refused");
    await provider.validate?.();
    const launch = prepared;
    const attached = binding;
    const endpoint = mcp;
    return {
      agentVersion: installation.version ?? "",
      spec: {
        command,
        args: prepared.args,
        cwd,
        cols: 80,
        rows: 24,
        env: { ...launchEnvironment, ...binding.env, FOOM_CONTROL_TOKEN: mcp.token },
        replaceEnvironment: true,
      },
      ...(prepared.conversationId === undefined ? {} : { conversationId: prepared.conversationId }),
      events: () => ({ hooks: structuredClone(hooks), mcp: endpoint.snapshot() }),
      hook: () => signal,
      dispose: () => {
        launch.dispose();
        attached.dispose();
        endpoint.close();
        void receiver.close();
      },
    };
  } catch (error) {
    prepared?.dispose();
    binding?.dispose();
    mcp?.close();
    await receiver.close();
    throw error;
  }
}
