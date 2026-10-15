import type { AgentProvider } from "./provider";
import type { AgentHooks, AgentInstallation, AgentLaunch } from "../../../shared/agents";
import { meetsMinimum } from "../version";
import type { prepareMcpLaunch } from "../mcp-launch";
import { supportsMcp } from "../mcp-launch";
import { cliGuidance, CONFIG_PROMPT, initialPrompt } from "../cli-launch";
import { BUILTIN_POLICIES } from "../../../shared/providers/catalog";
import { conversationId } from "../../../shared/conversation";
import { prepareMcpLaunch as mcpLaunch } from "../mcp-launch";
import { codexHookArguments } from "../codex-hooks";

function discover(
  id: "codex" | "agy",
  executable: string,
  version: string,
  help: string,
): AgentInstallation {
  const hooks =
    id === "codex" &&
    meetsMinimum(version, /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, [0, 155, 1]) &&
    /(?:^|\s)-c(?:[ ,]|$)/mu.test(help);
  return {
    id,
    path: executable,
    version,
    hooks,
    cliGuidance: id === "agy" && /(?:^|\s)--prompt-interactive(?:[ =,]|$)/mu.test(help),
    mcp: supportsMcp(id, version, help),
    mcpReason: supportsMcp(id, version, help)
      ? "Per-launch MCP supported; managed policy may deny attachment."
      : "Per-launch MCP unavailable: requires a supported version and attachment flag.",
    ...(id === "codex" &&
    meetsMinimum(version, /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, [0, 161, 0])
      ? { codexLifecycle: true }
      : {}),
    inline: id === "codex" && /(?:^|\s)--no-alt-screen(?:[ =,]|$)/mu.test(help),
    reason: hooks
      ? "Per-launch hooks supported."
      : "Unverified hook support; using output evaluation.",
  };
}

function argumentsFor(
  agent: AgentInstallation,
  request: AgentLaunch,
  defaults: readonly string[],
  resume: readonly string[],
  binding: AgentHooks | undefined,
  mcp: Awaited<ReturnType<typeof prepareMcpLaunch>> | undefined,
  control: boolean,
  configSession: boolean,
): string[] {
  const notify =
    !agent.codexLifecycle || !binding?.lifecycleCommand || binding.notifyFallback !== false;
  const configGreeting = configSession && request.conversationId === undefined;
  const prompt = initialPrompt(agent, request.prompt);
  const args = [
    ...resume,
    ...((control || configGreeting) && agent.cliGuidance
      ? cliGuidance([...defaults, ...prompt.guidance], configGreeting)
      : [...defaults, ...prompt.guidance]),
    ...(agent.inline ? ["--no-alt-screen"] : []),
    ...(mcp?.args ?? []),
  ];
  if (binding) {
    if (agent.id === "codex") {
      if (agent.codexLifecycle && binding.lifecycleCommand)
        args.push(...codexHookArguments(binding.lifecycleCommand));
      if (notify) args.push("-c", `notify=${JSON.stringify(binding.observerArgv)}`);
    }
  }
  // A positional prompt goes last, after every option Foom adds.
  args.push(...(configGreeting && agent.id !== "agy" ? ["--", CONFIG_PROMPT] : prompt.positional));
  return args;
}

export function builtinProvider(id: "codex" | "agy"): AgentProvider {
  return {
    id,
    name: BUILTIN_POLICIES[id].name,
    mark: BUILTIN_POLICIES[id].mark,
    resume: (conversation) => {
      if (!conversationId(conversation)) throw new Error("Invalid conversation ID");
      return [BUILTIN_POLICIES[id].resume[0], conversation];
    },
    prepareMcp: (endpoint) => mcpLaunch(id, endpoint),
    executableNames: [id],
    discover: (executable, version, help) => discover(id, executable, version, help),
    enrich: async (agent, plugin) => {
      if (id !== "agy" || !agent.path) return agent;
      const agyPlugin = await plugin.status(agent.path);
      return {
        ...agent,
        agyPlugin,
        hooks: agyPlugin.state === "installed" || agyPlugin.state === "outdated",
        reason:
          agyPlugin.state === "installed" || agyPlugin.state === "outdated"
            ? "Opt-in Foom plugin installed."
            : "Plugin unavailable or disabled; using output evaluation.",
      };
    },
    needsNotifier: (agent, binding) =>
      id === "codex" &&
      (!agent.codexLifecycle || !binding?.lifecycleCommand || binding.notifyFallback !== false),
    arguments: argumentsFor,
  };
}
