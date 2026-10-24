import { mcpTools } from "../../control/mcp-tools";
import { PluginSetup } from "../plugin-setup";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import type { AgentProvider, PreparedLaunch } from "./provider";
import { conversationId } from "../../../shared/conversation";
import { dataContainer } from "../../../shared/agent-manifest-container";
import {
  privateDirectory,
  createPrivateFile,
  verifyPrivate,
} from "../../../node-common/private-files";
import { CHILD_PROMPT, CONFIG_PROMPT, CLI_GUIDANCE } from "./cli-launch";
import {
  boundedArguments,
  collectMerge,
  discoveryFacts,
  expandV2,
  hookCapability,
  selected,
} from "./v2-values";

/** Immutable validated manifest data; probes/facts and temporary files never reach board renderers. */
export function v2Provider(
  input: AgentManifestV2,
  validate: () => Promise<void>,
  verification = false,
): AgentProvider {
  const model = structuredClone(input);
  if (verification) for (const fact of model.discovery.facts) fact.enabled = true;
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  };
  freeze(model);
  const setup = new PluginSetup();
  const probes = new Map<string, { version: string; help: string }>();
  const provider: AgentProvider = {
    origin: "config",
    id: model.id,
    name: model.name,
    mark: model.badge,
    executableNames: model.executables,
    model,
    validate,
    setupFacts(path, engine) {
      const probe = probes.get(path);
      return discoveryFacts(model, probe?.version ?? "", probe?.help ?? "", engine);
    },
    resume(id) {
      if (!conversationId(id)) throw new Error("Invalid conversation ID");
      if (!model.launch.resume) throw new Error("This agent cannot resume conversations");
      return model.launch.resume.arguments.map((arg) => expandV2(arg, { conversationId: id }));
    },
    discover(path, version, help) {
      probes.set(path, { version, help });
      const mcpAvailable = (resume: boolean) => {
        const facts = discoveryFacts(model, version, help, {
          control: true,
          hooksEnabled: true,
          configGreeting: false,
          hasPrompt: false,
          resume,
          healthTrusted: false,
          setupState: "unavailable",
        });
        return Boolean(model.launch.mcp && selected(model.launch.mcp.when, facts));
      };
      const resumeMcp = mcpAvailable(true);
      const facts = discoveryFacts(model, version, help, {
        hooksEnabled: true,
        healthTrusted: false,
      });
      const healthChannel = model.hooks?.channels.find(
        (channel) => channel.id === model.health?.channel,
      );
      return {
        id: model.id,
        path,
        version: version || null,
        hooks: hookCapability(model, version, help),
        inline: Boolean(model.launch.display && selected(model.launch.display.when, facts)),
        healthSupported: Boolean(healthChannel && selected(healthChannel.when, facts)),
        ...(model.health ? { healthInstructions: model.health.instructions } : {}),
        mcp: mcpAvailable(false) || resumeMcp,
        restoreControl: model.conversation.restoreControl && resumeMcp,
        reason: hookCapability(model, version, help)
          ? "Per-launch hooks supported."
          : "Unverified hook support; using output evaluation.",
        mcpReason:
          mcpAvailable(false) || resumeMcp
            ? "Per-launch MCP supported; managed policy may deny attachment."
            : "Per-launch MCP unavailable: requires a supported version and attachment flag.",
      };
    },
    async enrich(installation) {
      if (!model.setup || !installation.path) return installation;
      await validate();
      const probe = probes.get(installation.path);
      const facts = discoveryFacts(model, probe?.version ?? "", probe?.help ?? "", {
        setupState: "unavailable",
        healthTrusted: false,
      });
      const status = await setup.status(
        model,
        installation.path,
        facts,
        (state) =>
          provider.setupFacts?.(installation.path ?? "", {
            setupState: state,
            healthTrusted: false,
          }) ?? {},
      );
      await validate();
      const mcpAvailable = (resume: boolean) => {
        const enrichedFacts = discoveryFacts(model, probe?.version ?? "", probe?.help ?? "", {
          control: true,
          hooksEnabled: true,
          configGreeting: false,
          hasPrompt: false,
          resume,
          healthTrusted: false,
          setupState: status.state,
        });
        return Boolean(model.launch.mcp && selected(model.launch.mcp.when, enrichedFacts));
      };
      return {
        ...installation,
        setup: status,
        hooks: hookCapability(model, probe?.version ?? "", probe?.help ?? "", status.state),
        mcp: mcpAvailable(false) || mcpAvailable(true),
        restoreControl: model.conversation.restoreControl && mcpAvailable(true),
      };
    },
    needsNotifier: (installation, binding, healthTrusted) => {
      const probe = probes.get(installation.path ?? "");
      const facts = {
        ...discoveryFacts(model, installation.version ?? "", probe?.help ?? "", {
          hooksEnabled: true,
          healthTrusted: healthTrusted ?? binding?.v2?.runtime?.health.get() === "trusted",
        }),
      };
      let replacement = false;
      for (const channel of model.hooks?.channels ?? []) {
        const attached = selected(channel.when, facts);
        facts[`channelAttached:${channel.id}`] = attached;
        if (attached && channel.observer.transport === "argv-last") replacement = true;
      }
      return replacement;
    },
    async prepareLaunch(
      installation,
      request,
      defaults,
      control,
      configSession,
      hooksEnabled,
      binding,
    ): Promise<PreparedLaunch> {
      await validate();
      const probe = probes.get(installation.path ?? "");
      const configGreeting = configSession && request.conversationId === undefined;
      const setupStatus =
        model.setup && installation.path
          ? await setup.status(
              model,
              installation.path,
              provider.setupFacts?.(installation.path, { healthTrusted: false }) ?? {},
            )
          : undefined;
      const facts = discoveryFacts(model, probe?.version ?? "", probe?.help ?? "", {
        control: Boolean(control),
        hooksEnabled,
        configGreeting,
        hasPrompt: request.prompt !== undefined,
        resume: request.conversationId !== undefined,
        healthTrusted: binding?.v2?.runtime?.health.get() === "trusted",
        setupState: setupStatus?.state ?? "unavailable",
      });
      if (
        request.prompt !== undefined &&
        (!request.prompt.length ||
          Buffer.byteLength(request.prompt) > 16384 ||
          request.prompt.trimStart().startsWith("-") ||
          /[^\P{Cc}\n\t]/u.test(request.prompt))
      )
        throw new Error("Invalid initial prompt");
      const promptSupported =
        model.launch.prompt !== undefined &&
        (!model.launch.prompt.requires || facts[model.launch.prompt.requires] === true);
      if (request.prompt !== undefined && !promptSupported)
        throw new Error("This agent cannot take an initial prompt");
      const guidance =
        model.launch.guidance && selected(model.launch.guidance.when, facts) && promptSupported;
      let userDefaults = [...defaults];
      const prompts: string[] = [];
      if (guidance && model.launch.guidance?.merge) {
        const collected = collectMerge(userDefaults, model.launch.guidance.merge, false);
        userDefaults = collected.args;
        prompts.push(...collected.values);
      }
      if (request.prompt !== undefined) prompts.push(`${CHILD_PROMPT}\n\n${request.prompt}`);
      if (configGreeting && promptSupported) prompts.push(CONFIG_PROMPT);
      else if (guidance) prompts.push(CLI_GUIDANCE);
      const newId =
        request.conversationId === undefined && model.conversation.newId ? randomUUID() : undefined;
      const values: Record<string, string | string[] | number> = {
        ...binding?.v2?.values,
        ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        ...(newId === undefined ? {} : { newId }),
        ...(prompts.length ? { prompt: prompts.join("\n\n") } : {}),
      };
      binding?.v2?.channels.clear();
      for (const channel of model.hooks?.channels ?? []) {
        const attached = Boolean(binding?.v2 && selected(channel.when, facts));
        if (attached) binding?.v2?.channels.set(channel.id, channel);
        Object.assign(facts, { [`channelAttached:${channel.id}`]: attached });
      }
      if (binding?.v2) binding.v2.state.launchFacts = Object.freeze({ ...facts });
      if (
        binding?.v2 &&
        (newId ||
          (request.pinConversation && model.conversation.resumePin === "requested-on-paste"))
      ) {
        const pin = newId ?? request.conversationId;
        if (pin) binding.v2.state.conversation = pin;
      }
      const mcp = Boolean(control && model.launch.mcp && selected(model.launch.mcp.when, facts));
      let scratch: string | undefined;
      const dispose = () => {
        binding?.dispose();
        if (scratch) void rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      };
      try {
        if (mcp) {
          const url = new URL(control?.env["FOOM_CONTROL_URL"] ?? "");
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
          values["mcpUrl"] = url.href;
          values["mcpName"] = `foom_${randomUUID().replaceAll("-", "")}`;
        }
        const environment = (model.launch.environment ?? []).filter((entry) =>
          selected(entry.when, facts),
        );
        // Plugin-scope files are staged by setup actions (#433), never written per launch.
        const files = model.files.filter(
          (file) =>
            file.scope === "launch" &&
            selected(file.when, facts) &&
            (mcp ||
              environment.some((entry) => entry.value === `{file:${file.name}}`) ||
              !model.launch.mcp?.arguments.some((arg) => arg.includes(`{file:${file.name}}`))),
        );
        if (files.length) {
          const hookDirectory = binding?.v2?.values["hookDir"];
          if (typeof hookDirectory !== "string")
            scratch = await mkdtemp(join(tmpdir(), "foom-v2-"));
          const directory =
            typeof hookDirectory === "string"
              ? hookDirectory
              : await privateDirectory(scratch ?? "");
          for (const file of files) {
            values[`file:${file.name}`] = join(directory, file.name);
            values[`hookFile:${file.name}`] = join(directory, file.name);
          }
          for (const file of files) {
            const target = values[`file:${file.name}`];
            if (typeof target !== "string") throw new Error("Missing launch file");
            const content = expandV2(file.content, values);
            dataContainer(content, file.format, "$.files", true);
            // Every directory is new, beneath the private launch root.
            let parent = directory;
            for (const component of file.name.split("/").slice(0, -1))
              parent = await privateDirectory(parent, component);
            const handle = await createPrivateFile(target);
            try {
              await handle.writeFile(content);
              await handle.sync();
            } finally {
              await handle.close();
            }
            await verifyPrivate(target, false);
          }
        }
        const args: string[] = [];
        let mcpArguments: string[] = [];
        let grants: string[] = [];
        let toolIndex = 0;
        const tools = model.launch.toolPermissions;
        if (mcp && tools)
          grants = (
            verification
              ? [{ name: "ping" }]
              : mcpTools(1, []).filter(
                  (tool) =>
                    tools.names.includes(tool.name) &&
                    (control?.toolNames === undefined || control.toolNames.includes(tool.name)),
                )
          ).map(({ name: tool }) =>
            tools.format === "mcp-double-underscore"
              ? `mcp__${String(values["mcpName"] ?? "")}__${tool}`
              : `${String(values["mcpName"] ?? "")}(${tool})`,
          );
        const expand = (templates: readonly string[]) =>
          templates.map((arg) => expandV2(arg, values));
        for (const stage of model.launch.order) {
          if (stage === "defaults") args.push(...userDefaults);
          else if (stage === "arguments") {
            if (newId && model.conversation.newId)
              args.push(...expand(model.conversation.newId.arguments));
            if (model.launch.arguments && selected(model.launch.arguments.when, facts))
              args.push(...expand(model.launch.arguments.arguments));
          } else if (stage === "resume") {
            if (request.conversationId !== undefined) {
              if (!model.launch.resume || !selected(model.launch.resume.when, facts))
                throw new Error("This agent cannot resume conversations");
              args.push(...expand(model.launch.resume.arguments));
            }
          } else if (stage === "display") {
            if (model.launch.display && selected(model.launch.display.when, facts))
              args.push(...expand(model.launch.display.arguments));
          } else if (stage === "mcp") {
            if (mcp && model.launch.mcp) {
              mcpArguments = expand(model.launch.mcp.arguments);
              args.push(...mcpArguments);
            }
          } else if (stage === "hooks") {
            for (const channel of binding?.v2?.channels.values() ?? [])
              args.push(...expand(channel.arguments));
          } else if (stage === "tools") {
            toolIndex = args.length;
            if (tools?.merge && mcp && grants.length) args.push(tools.merge.output, ...grants);
            else if (tools)
              for (const tool of grants)
                args.push(...tools.arguments.map((arg) => expandV2(arg, { ...values, tool })));
          } else if (stage === "prompt" && prompts.length && model.launch.prompt) {
            const merge = guidance ? model.launch.guidance?.merge : undefined;
            args.push(
              ...expand(merge ? [merge.output, "{prompt}"] : model.launch.prompt.arguments),
            );
          }
        }
        let finalArgs = args;
        if (mcp && tools?.merge) {
          const merged = collectMerge(args, tools.merge);
          const insertion = collectMerge(args.slice(0, toolIndex), tools.merge).args.length;
          finalArgs = [...merged.args];
          const permissions = [...new Set(merged.values)];
          if (permissions.length)
            finalArgs.splice(insertion, 0, tools.merge.output, ...permissions);
        }
        return {
          environment: environment.map(({ name, value }) => ({
            name,
            value: expandV2(value, values),
          })),
          args: boundedArguments(finalArgs),
          mcp,
          mcpArguments,
          ...(newId ? { conversationId: newId } : {}),
          dispose,
        };
      } catch (error) {
        binding?.dispose();
        if (scratch) {
          try {
            control?.dispose();
            binding?.dispose();
          } finally {
            await rm(scratch, { recursive: true, force: true });
          }
        }
        throw error;
      }
    },
  };
  return provider;
}
