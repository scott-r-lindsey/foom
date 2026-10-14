import type {
  AgentPluginManifest,
  ArgvTemplate,
  HookMapping,
  DetectionRule,
  DetectionMatcher,
} from "./agent-plugin";
import { boundedRegex } from "./providers/detection";
import { builtinAgent, validAgentId } from "./providers/catalog";

export class AgentManifestError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}
function fail(path: string, reason = "invalid-value"): never {
  throw new AgentManifestError(path, reason);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path);
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    fail(path, "unknown-key");
  if (required.some((key) => !Object.hasOwn(value, key))) fail(path, "missing-key");
  return value;
}
// The trusted dialog shows these strings verbatim. Format characters (bidi overrides,
// zero-width joiners), private-use and unpaired surrogates could disguise what it shows.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u;
function text(value: unknown, path: string, max = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > max || HIDDEN.test(value))
    fail(path);
  return value;
}
function list(value: unknown, path: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max) fail(path);
  return value.map((item: unknown) => text(item, path));
}
const VARIABLES = [
  "prompt",
  "conversationId",
  "hookCommand",
  "hookArgv",
  "mcpUrl",
  "mcpName",
  "allowedTools",
];
function template(value: unknown, path: string, variables: readonly string[]): ArgvTemplate {
  const result = list(value, path);
  for (const arg of result) {
    const placeholders = [...arg.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)];
    if (
      VARIABLES.some((variable) => arg.includes(`{${variable}`) && !arg.includes(`{${variable}}`))
    )
      fail(path, "unknown-placeholder");
    if (
      placeholders.some(
        (match) => !VARIABLES.includes(match[1] ?? "") || !variables.includes(match[1] ?? ""),
      )
    )
      fail(path, "unknown-placeholder");
  }
  return result;
}
function matcher(value: unknown, path: string): DetectionMatcher {
  const item = record(value, path, [], ["contains", "regex"]);
  const contains = item["contains"] === undefined ? [] : list(item["contains"], path, 8);
  const regex = item["regex"] === undefined ? [] : list(item["regex"], path, 8);
  if (!contains.length && !regex.length) fail(path);
  if (contains.some((part) => part.length > 128)) fail(path);
  for (const pattern of regex) {
    try {
      boundedRegex(pattern);
    } catch {
      fail(path, "unsafe-regex");
    }
  }
  return { contains, regex };
}
function rule(value: unknown): DetectionRule {
  const path = "$.attention.rules";
  const item = record(
    value,
    path,
    ["id", "state", "priority", "region", "match", "reason"],
    ["lines", "not", "comment"],
  );
  const id = text(item["id"], path, 40);
  if (!/^[a-z][a-z0-9-]*$/u.test(id)) fail(path);
  const state = item["state"];
  const region = item["region"];
  if (state !== "working" && state !== "blocked" && state !== "idle" && state !== "unknown")
    fail(path);
  if (region !== "title" && region !== "bottom" && region !== "after_horizontal_rule") fail(path);
  const priority = item["priority"];
  if (
    typeof priority !== "number" ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 1000
  )
    fail(path);
  const lines = item["lines"];
  if (
    lines !== undefined &&
    (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 40)
  )
    fail(path);
  const exclusions = item["not"];
  if (exclusions !== undefined && (!Array.isArray(exclusions) || exclusions.length > 8)) fail(path);
  return {
    id,
    state,
    region,
    priority,
    match: matcher(item["match"], path),
    reason: text(item["reason"], path, 128),
    comment:
      item["comment"] === undefined
        ? "Config-authored detection rule"
        : text(item["comment"], path, 256),
    ...(lines === undefined ? {} : { lines }),
    ...(exclusions === undefined
      ? {}
      : { not: exclusions.map((entry: unknown) => matcher(entry, path)) }),
  };
}
function hooks(value: unknown): HookMapping {
  const path = "$.attention.hook";
  const item = record(value, path, ["transport", "sessionField", "eventField", "events"]);
  const transport = item["transport"];
  if (transport !== "stdin" && transport !== "argv") fail(path);
  const sessionField = text(item["sessionField"], path, 64);
  const eventField = text(item["eventField"], path, 64);
  if (![sessionField, eventField].every((field) => /^[A-Za-z][A-Za-z0-9_-]*$/u.test(field)))
    fail(path);
  const raw = item["events"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(path);
  const entries = Object.entries(raw);
  if (!entries.length || entries.length > 16) fail(path);
  const events: Record<string, "classify" | "needs_input" | "working" | "ready" | "failed"> = {};
  for (const [event, action] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(event) ||
      (action !== "classify" &&
        action !== "needs_input" &&
        action !== "working" &&
        action !== "ready" &&
        action !== "failed")
    )
      fail(path);
    Object.defineProperty(events, event, { value: action, enumerable: true });
  }
  return { transport, sessionField, eventField, events };
}

/** Strict data only: no scripts, capability names, executable paths or remote references. */
export function parseAgentPlugin(textValue: string): AgentPluginManifest {
  if (new TextEncoder().encode(textValue).length > 65536) fail("$", "too-large");
  let value: unknown;
  try {
    value = JSON.parse(textValue);
  } catch {
    fail("$", "malformed-json");
  }
  const data = record(
    value,
    "$",
    [
      "kind",
      "version",
      "id",
      "name",
      "badge",
      "executables",
      "launch",
      "bypassArguments",
      "attention",
    ],
    ["discovery"],
  );
  if (data["kind"] !== "agent" || data["version"] !== 1) fail("$.version", "unsupported-version");
  const id = text(data["id"], "$.id", 40);
  if (!validAgentId(id) || builtinAgent(id)) fail("$.id", "reserved-id");
  const name = text(data["name"], "$.name", 40);
  const badge = text(data["badge"], "$.badge", 4);
  if (!/^[A-Z0-9]{1,4}$/u.test(badge)) fail("$.badge");
  const executables = list(data["executables"], "$.executables", 8);
  if (
    !executables.length ||
    executables.some(
      (file) =>
        file.length > 64 ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(file) ||
        /\.(?:cmd|bat|ps1)$/iu.test(file),
    )
  )
    fail("$.executables");
  const raw = record(
    data["launch"],
    "$.launch",
    ["arguments"],
    ["prompt", "resume", "hooks", "mcp", "allowedTools"],
  );
  const launch = {
    arguments: template(raw["arguments"], "$.launch.arguments", []),
    prompt: template(raw["prompt"] ?? [], "$.launch.prompt", ["prompt"]),
    resume: template(raw["resume"] ?? [], "$.launch.resume", ["conversationId"]),
    hooks: template(raw["hooks"] ?? [], "$.launch.hooks", ["hookCommand", "hookArgv"]),
    mcp: template(raw["mcp"] ?? [], "$.launch.mcp", ["mcpUrl", "mcpName", "allowedTools"]),
    allowedTools: list(raw["allowedTools"] ?? [], "$.launch.allowedTools", 16),
  };
  if (launch.prompt.length && !launch.prompt.some((arg) => arg.includes("{prompt}")))
    fail("$.launch.prompt", "missing-placeholder");
  if (launch.resume.length && !launch.resume.some((arg) => arg.includes("{conversationId}")))
    fail("$.launch.resume", "missing-placeholder");
  if (
    launch.allowedTools.some(
      (tool) => !["open_preview", "list_previews", "close_preview"].includes(tool),
    )
  )
    fail("$.launch.allowedTools");
  const attention = record(
    data["attention"],
    "$.attention",
    ["minimumEngineVersion", "rules"],
    ["hook"],
  );
  if (attention["minimumEngineVersion"] !== 1)
    fail("$.attention.minimumEngineVersion", "unsupported-version");
  const rules = attention["rules"];
  if (!Array.isArray(rules) || rules.length > 64) fail("$.attention.rules");
  const parsedRules = rules.map((entry: unknown) => rule(entry));
  if (new Set(parsedRules.map((entry) => entry.id)).size !== parsedRules.length)
    fail("$.attention.rules", "duplicate-id");
  const hook = attention["hook"] === undefined ? undefined : hooks(attention["hook"]);
  if (Boolean(hook) !== Boolean(launch.hooks.length))
    fail("$.launch.hooks", "hook-mapping-required");
  const discovery =
    data["discovery"] === undefined
      ? {}
      : record(data["discovery"], "$.discovery", [], ["hooksHelp", "mcpHelp"]);
  const bypassArguments = list(data["bypassArguments"], "$.bypassArguments");
  if (bypassArguments.some((arg) => !arg.startsWith("-"))) fail("$.bypassArguments");
  return {
    kind: "agent",
    version: 1,
    id,
    name,
    badge,
    executables,
    launch,
    bypassArguments,
    attention: { minimumEngineVersion: 1, rules: parsedRules, ...(hook ? { hook } : {}) },
    discovery: {
      hooksHelp: list(discovery["hooksHelp"] ?? [], "$.discovery.hooksHelp", 8),
      mcpHelp: list(discovery["mcpHelp"] ?? [], "$.discovery.mcpHelp", 8),
    },
  };
}

export function expandArguments(
  templateValue: ArgvTemplate,
  values: Readonly<Record<string, string>>,
): string[] {
  return templateValue.map((arg) =>
    arg.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match: string, key: string) => {
      const value = values[key];
      if (value === undefined) fail("$.launch", "missing-placeholder-value");
      return value;
    }),
  );
}
