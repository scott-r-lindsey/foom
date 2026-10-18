import { AgentManifestError, parseAgentPlugin } from "./agent-manifest";
import type { AgentPluginManifest } from "./agent-plugin";
import type { AgentManifestV2, ParsedAgentPlugin } from "./agent-manifest-v2";
import { manifestJson } from "./agent-manifest-json";
import { v2 } from "./agent-manifest-schema";
import { validateV2 } from "./agent-manifest-validation";
import { builtinAgent } from "./providers/catalog";
import { enumeration } from "./agent-manifest-values";

/** Compatibility semantics stay explicit; only the original v1 object may launch. */
export function adaptV1(manifest: AgentPluginManifest): AgentManifestV2 {
  const model = v2(
    {
      kind: "agent",
      version: 2,
      id: manifest.id,
      name: manifest.name,
      badge: manifest.badge,
      executables: manifest.executables,
      reservedArguments: [],
      bypassArguments: [],
      bypassEnvironment: [],
      resumePaste: [],
      discovery: { facts: [] },
      launch: {
        order: [
          "defaults",
          "arguments",
          "resume",
          "display",
          "guidance",
          "hooks",
          "mcp",
          "tools",
          "prompt",
        ],
      },
      conversation: { resumePin: "first-event", restoreControl: false },
      attention: { minimumEngineVersion: 1, rules: [] },
      execution: { completion: "observed", completionChannels: [] },
    },
    "$",
  );
  const block = (argumentsValue: readonly string[]) => ({
    arguments: [...argumentsValue],
    when: undefined,
  });
  model.launch.arguments = block(manifest.launch.arguments);
  if (manifest.launch.prompt.length)
    model.launch.prompt = { arguments: [...manifest.launch.prompt], requires: undefined };
  if (manifest.launch.resume.length) model.launch.resume = block(manifest.launch.resume);
  if (manifest.launch.mcp.length)
    model.launch.mcp = {
      arguments: [...manifest.launch.mcp],
      when: {
        all: [
          { field: "control", op: "eq", value: true },
          { field: "mcpSupport", op: "eq", value: true },
        ],
        any: undefined,
      },
    };
  model.bypassArguments = manifest.bypassArguments.map((flag) => ({
    flag,
    forms: ["exact"],
    value: undefined,
  }));
  model.attention.rules = manifest.attention.rules.map((rule) => ({
    ...rule,
    match: { contains: rule.match.contains ?? [], regex: rule.match.regex ?? [] },
    not: (rule.not ?? []).map((matcher) => ({
      contains: matcher.contains ?? [],
      regex: matcher.regex ?? [],
    })),
    lines: rule.lines,
  }));
  model.discovery.facts = [
    {
      id: "hookSupport",
      enabled: Boolean(manifest.attention.hook),
      minimum: undefined,
      helpTokens: [...manifest.discovery.hooksHelp],
      when: undefined,
    },
    {
      id: "mcpSupport",
      enabled: Boolean(manifest.launch.mcp.length),
      minimum: undefined,
      helpTokens: [...manifest.discovery.mcpHelp],
      when: undefined,
    },
  ];
  if (manifest.launch.allowedTools.length) {
    const tool = enumeration("open_preview", "list_previews", "close_preview");
    model.launch.toolPermissions = {
      names: manifest.launch.allowedTools.map((value) => tool(value, "$.launch.allowedTools")),
      format: "mcp-double-underscore",
      // The legacy scalar expands inside MCP argv; a separate tools stage would duplicate it.
      arguments: [],
      merge: undefined,
    };
  }
  if (manifest.attention.hook) {
    const hook = manifest.attention.hook;
    model.hooks = {
      channels: [
        {
          id: "legacy",
          when: {
            all: [
              { field: "hooksEnabled", op: "eq", value: true },
              { field: "hookSupport", op: "eq", value: true },
            ],
            any: undefined,
          },
          observer: {
            protocol: undefined,
            transport: hook.transport === "stdin" ? "stdin" : "argv-last",
            placement: "launch",
            version: 1,
            response: "silent",
            delivery: "foreground",
            timeoutMs: 3000,
            sequence: false,
            basename: "observer",
            commandArguments: [],
          },
          arguments: [...manifest.launch.hooks],
          disclosure: undefined,
          mapping: {
            session: { source: "payload", path: [hook.sessionField] },
            event: { source: "payload", path: [hook.eventField] },
            sequence: undefined,
            dedupe: undefined,
            cases: Object.entries(hook.events).map(([event, action], index) => ({
              id: `event-${String(index)}`,
              event,
              action,
              when: undefined,
              require: [],
              facts: [],
              endsTurn: action === "classify" || action === "failed",
              recoverTurn: false,
            })),
          },
        },
      ],
    };
    model.execution.completionChannels = ["legacy"];
  }
  return model;
}

/** Offline only. No discovery, preparation, setup or launch capabilities. */
export function parseAgentManifest(
  source: string,
  origin: "config" | "bundled" = "config",
): ParsedAgentPlugin {
  // Dispatch with the existing JSON parser first: v2's stricter syntax must not narrow v1 acceptance.
  if (new TextEncoder().encode(source).length > 65536)
    throw new AgentManifestError("$", "too-large");
  let version: unknown;
  try {
    const raw: unknown = JSON.parse(source);
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw))
      version = Reflect.get(raw, "version");
  } catch {
    throw new AgentManifestError("$", "malformed-json");
  }
  if (version !== 2) {
    const manifest = parseAgentPlugin(source);
    return {
      version: 1,
      manifest,
      model: adaptV1(manifest),
      templateDialect: "v1",
      helpMatching: "substring",
    };
  }
  const model = v2(manifestJson(source), "$");
  if (
    ["shell", "all", "constructor", "prototype", "__proto__"].includes(model.id) ||
    (origin === "config" && builtinAgent(model.id))
  )
    throw new AgentManifestError("$.id", "reserved-id");
  validateV2(model);
  return { version: 2, model, templateDialect: "v2", helpMatching: "option-boundary" };
}
