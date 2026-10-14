import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import type { AgentProvider, PreparedLaunch } from "./provider";
import { conversationId } from "../../../shared/conversation";
import { AgentManifestError } from "../../../shared/agent-manifest";
import { dataContainer } from "../../../shared/agent-manifest-container";
import { privateDirectory, createPrivateFile, verifyPrivate } from "../../control/private-files";
import { CHILD_PROMPT, CONFIG_PROMPT, CLI_GUIDANCE } from "./cli-launch";
import { boundedArguments, collectMerge, discoveryFacts, expandV2, selected } from "./v2-values";

export function availableV2(model: AgentManifestV2): void {
  if (model.hooks) throw new AgentManifestError("$.hooks", "v2-hooks-unavailable");
  if (model.health) throw new AgentManifestError("$.health", "v2-health-unavailable");
  if (model.setup || model.files.some((file) => file.scope === "plugin"))
    throw new AgentManifestError("$.setup", "v2-setup-unavailable");
}

/** Immutable approved data; probes/facts and temporary files never reach board renderers. */
export function v2Provider(input: AgentManifestV2, validate: () => Promise<void>): AgentProvider {
  const model = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  };
  availableV2(model);
  freeze(model);
  const probes = new Map<string, { version: string; help: string }>();
  const provider: AgentProvider = {
    id: model.id,
    name: model.name,
    mark: model.badge,
    executableNames: model.executables,
    model,
    validate,
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
      return {
        id: model.id,
        path,
        version: version || null,
        hooks: false,
        mcp: mcpAvailable(false) || resumeMcp,
        restoreControl: model.conversation.restoreControl && resumeMcp,
        reason: "Config-authored agent; approved launch manifest.",
      };
    },
    enrich: (installation) => Promise.resolve(installation),
    needsNotifier: () => false,
    prepareMcp: () => Promise.reject(new Error("MCP requires launch context")),
    arguments: () => {
      throw new Error("v2 requires launch preparation");
    },
    async prepareLaunch(
      installation,
      request,
      defaults,
      control,
      configSession,
      hooksEnabled,
    ): Promise<PreparedLaunch> {
      await validate();
      const probe = probes.get(installation.path ?? "");
      const configGreeting = configSession && request.conversationId === undefined;
      const facts = discoveryFacts(model, probe?.version ?? "", probe?.help ?? "", {
        control: Boolean(control),
        hooksEnabled,
        configGreeting,
        hasPrompt: request.prompt !== undefined,
        resume: request.conversationId !== undefined,
        healthTrusted: false,
        setupState: "unavailable",
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
      const values: Record<string, string> = {
        ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        ...(newId === undefined ? {} : { newId }),
        ...(prompts.length ? { prompt: prompts.join("\n\n") } : {}),
      };
      const mcp = Boolean(control && model.launch.mcp && selected(model.launch.mcp.when, facts));
      let scratch: string | undefined;
      const dispose = () => {
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
          const files = model.files.filter((file) => selected(file.when, facts));
          if (files.length) {
            scratch = await mkdtemp(join(tmpdir(), "foom-v2-"));
            const directory = await privateDirectory(scratch);
            for (const file of files) values[`file:${file.name}`] = join(directory, file.name);
            for (const file of files) {
              const target = values[`file:${file.name}`];
              if (!target) throw new Error("Missing launch file");
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
        }
        const args: string[] = [];
        let grants: string[] = [];
        let toolIndex = 0;
        const tools = model.launch.toolPermissions;
        if (mcp && tools)
          grants = tools.names.map((tool) =>
            tools.format === "mcp-double-underscore"
              ? `mcp__${values["mcpName"] ?? ""}__${tool}`
              : `${values["mcpName"] ?? ""}(${tool})`,
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
            if (mcp && model.launch.mcp) args.push(...expand(model.launch.mcp.arguments));
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
          args: boundedArguments(finalArgs),
          mcp,
          ...(newId ? { conversationId: newId } : {}),
          dispose,
        };
      } catch (error) {
        if (scratch) {
          try {
            control?.dispose();
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
