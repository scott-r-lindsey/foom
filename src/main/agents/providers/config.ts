import { randomUUID } from "node:crypto";
import type { AgentProvider } from "./provider";
import type { AgentPluginManifest } from "../../../shared/agent-plugin";
import type { AgentHooks, AgentInstallation } from "../../../shared/agents";
import { expandArguments } from "../../../shared/agent-manifest";
import { conversationId } from "../../../shared/conversation";
import { CHILD_PROMPT, CONFIG_PROMPT } from "./cli-launch";

/** Only the validated manifest supplies argv. Template values are never re-parsed as templates. */
export function configProvider(
  manifest: AgentPluginManifest,
  validate: () => Promise<void>,
): AgentProvider {
  const expand = (args: readonly string[], values: Readonly<Record<string, string>>) =>
    expandArguments(args, values);
  return {
    origin: "config",
    id: manifest.id,
    name: manifest.name,
    mark: manifest.badge,
    executableNames: manifest.executables,
    manifest,
    validate,
    resume: (id) => {
      if (!conversationId(id)) throw new Error("Invalid conversation ID");
      if (!manifest.launch.resume.length) throw new Error("This agent cannot resume conversations");
      return expand(manifest.launch.resume, { conversationId: id });
    },
    discover: (path, version, help): AgentInstallation => ({
      id: manifest.id,
      name: manifest.name,
      mark: manifest.badge,
      command: manifest.executables[0] ?? manifest.id,
      path,
      version,
      hooks:
        Boolean(manifest.attention.hook) &&
        manifest.discovery.hooksHelp.every((flag) => help.includes(flag)),
      mcp:
        Boolean(manifest.launch.mcp.length) &&
        manifest.discovery.mcpHelp.every((flag) => help.includes(flag)),
      reason: "Config-authored agent; validated launch manifest.",
    }),
    enrich: (installation) =>
      Promise.resolve({
        ...installation,
        name: manifest.name,
        mark: manifest.badge,
        command: manifest.executables[0] ?? manifest.id,
      }),
    needsNotifier: () => false,
    prepareMcp: (endpoint) => {
      const url = new URL(endpoint);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/control/v1" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new Error("Invalid control endpoint");
      url.pathname = "/mcp";
      const name = `foom_${randomUUID().replaceAll("-", "")}`;
      return Promise.resolve({
        args: expand(manifest.launch.mcp, {
          mcpUrl: url.href,
          mcpName: name,
          allowedTools: manifest.launch.allowedTools
            .map((tool) => `mcp__${name}__${tool}`)
            .join(","),
        }),
        dispose: () => undefined,
      });
    },
    arguments: (
      _installation,
      request,
      defaults,
      resume,
      binding: AgentHooks | undefined,
      mcp,
      _control,
      configSession,
    ) => {
      const configGreeting = configSession && request.conversationId === undefined;
      const prompt =
        request.prompt === undefined
          ? configGreeting
            ? CONFIG_PROMPT
            : undefined
          : `${CHILD_PROMPT}\n\n${request.prompt}`;
      if (
        request.prompt !== undefined &&
        (!request.prompt.length ||
          Buffer.byteLength(request.prompt) > 16384 ||
          request.prompt.trimStart().startsWith("-") ||
          /[^\P{Cc}\n\t]/u.test(request.prompt))
      )
        throw new Error("Invalid initial prompt");
      if (prompt !== undefined && !manifest.launch.prompt.length)
        throw new Error("This agent cannot take an initial prompt");
      return [
        ...defaults,
        ...expand(manifest.launch.arguments, {}),
        ...resume,
        ...(binding
          ? expand(manifest.launch.hooks, {
              hookCommand: binding.observerCommand,
              hookArgv: JSON.stringify(binding.observerArgv),
            })
          : []),
        ...(mcp?.args ?? []),
        ...(prompt === undefined ? [] : expand(manifest.launch.prompt, { prompt })),
      ];
    },
  };
}
