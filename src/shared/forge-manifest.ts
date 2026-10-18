import type {
  CheckConclusion,
  ForgeArgument,
  ForgeBatchPlan,
  ForgeCheckResult,
  ForgeCommand,
  ForgeGuard,
  ForgeManifest,
  ForgePlan,
  ForgeProjects,
  ForgeVariant,
} from "./forge-plugin";
import { validateForgeBatchQueries } from "./forge-batch-query";
import { manifestJson } from "./agent-manifest-json";
import {
  array,
  basename,
  defaulted,
  enumeration,
  fail,
  id,
  integer,
  literal,
  multiline,
  object,
  optional,
  pattern,
  text,
  unique,
} from "./agent-manifest-values";
import { commandSlots, validateForgeCommand, validateForgeQuery } from "./forge-command-validation";

const unsafe = ["constructor", "prototype", "__proto__"];
export function forgeHost(value: string): boolean {
  return (
    value.length <= 253 &&
    !/^\d+(?:\.\d+){3}$/u.test(value) &&
    value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  );
}
const pathValue = array((value, path): string | number => {
  if (typeof value === "number") return integer(value, path, 999);
  const key = text(value, path, 64);
  if (unsafe.includes(key)) fail(path, "unsafe-key");
  return key;
}, 12);
function table<T extends string>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): Record<string, T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path);
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 32) fail(path);
  return Object.fromEntries(
    entries.map(([key, item]) => {
      text(key, path, 64);
      if (unsafe.includes(key)) fail(path, "unsafe-key");
      return [key, parse(item, path)];
    }),
  );
}
const conclusion = enumeration("pending", "success", "failure", "none", "unknown");
function argument(value: unknown, path: string): ForgeArgument {
  if (typeof value === "string") return text(value, path);
  const data = object(value, path, ["parts"]);
  return {
    parts: array(
      (part, at) => {
        if (typeof part === "string") return text(part, at);
        const slot = object(part, at, ["slot", "encoding"]);
        const name = enumeration(
          "branch",
          "number",
          "project",
          "host",
          "nodeId",
          "query",
          "projectOwner",
          "projectName",
        )(slot["slot"], at);
        const encoding = enumeration("literal", "percent-component")(slot["encoding"], at);
        if (encoding === "percent-component" && name !== "project") fail(at, "invalid-encoding");
        return { slot: name, encoding };
      },
      16,
      1,
    )(data["parts"], path),
  };
}
const argvValue = array(argument, 64, 1);
function command(
  value: unknown,
  path: string,
  slots: readonly string[],
  checks = false,
): ForgeCommand {
  const data = object(value, path, ["argv", "jsonExitCodes"], ["bindNodeId", "emptyDiagnostics"]);
  const argv = argvValue(data["argv"], path);
  if (commandSlots(argv).some((slot) => !slots.includes(slot))) fail(path, "slot-scope");
  validateForgeCommand(argv);
  const diagnostics = defaulted(
    array(
      (value, at) => {
        const item = object(value, at, ["exitCode", "prefix", "suffix"]);
        return {
          exitCode: literal(1)(item["exitCode"], at),
          prefix: text(item["prefix"], at),
          suffix: text(item["suffix"], at),
        };
      },
      4,
      1,
    ),
    [],
  )(data["emptyDiagnostics"], path);
  if (
    diagnostics.length &&
    (!checks || !commandSlots(argv).includes("number") || argv[1] !== "checks")
  )
    fail(path, "invalid-diagnostic");
  const bindNodeId = optional(pathValue)(data["bindNodeId"], path);
  if (bindNodeId && !checks) fail(path, "slot-scope");
  return {
    argv,
    jsonExitCodes: unique(
      array((value, at) => integer(value, at, 255), 4, 1)(data["jsonExitCodes"], path),
      path,
    ),
    bindNodeId,
    emptyDiagnostics: diagnostics,
  };
}
function guard(value: unknown, path: string): ForgeGuard {
  const data = object(value, path, ["path"], ["absent", "binding", "length"]);
  if (["absent", "binding", "length"].filter((key) => Object.hasOwn(data, key)).length !== 1)
    fail(path);
  return {
    path: pathValue(data["path"], path),
    absent: data["absent"] === undefined ? false : data["absent"] === true ? true : fail(path),
    binding: optional(enumeration("headSha", "number"))(data["binding"], path),
    length: optional((value, at) => integer(value, at, 1000))(data["length"], path),
  };
}
function variant(value: unknown, path: string): ForgeVariant {
  const data = object(
    value,
    path,
    ["value", "table"],
    ["when", "status", "completed", "unfinished"],
  );
  const when =
    data["when"] === undefined ? undefined : object(data["when"], path, ["path", "equals"]);
  const status = optional(pathValue)(data["status"], path);
  const completed = optional(text)(data["completed"], path);
  const unfinished = defaulted(array(text, 16, 1), [])(data["unfinished"], path);
  if (
    status
      ? completed === undefined || unfinished.length === 0 || unfinished.includes(completed)
      : completed !== undefined || unfinished.length > 0
  )
    fail(path);
  return {
    when: when
      ? { path: pathValue(when["path"], path), equals: text(when["equals"], path) }
      : undefined,
    status,
    completed,
    unfinished,
    value: pathValue(data["value"], path),
    table: table<CheckConclusion>(data["table"], path, conclusion),
  };
}
function plan(value: unknown, path: string): ForgePlan {
  const data = object(value, path, ["commands", "result"], ["query"]);
  const query = optional(multiline)(data["query"], path);
  if (query !== undefined) validateForgeQuery(query);
  const commands = array(
    (value, at) => command(value, at, ["host", "project", "number", "nodeId", "query"], true),
    2,
    1,
  )(data["commands"], path);
  let bound = false;
  let usesQuery = false;
  for (const [index, item] of commands.entries()) {
    const slots = commandSlots(item.argv);
    if (slots.includes("nodeId") && !bound) fail(path, "unbound-node");
    if (slots.includes("query")) usesQuery = true;
    if (item.bindNodeId) {
      if (index !== 0 || commands.length !== 2) fail(path, "unused-node");
      bound = true;
    }
  }
  if (
    (query !== undefined) !== usesQuery ||
    (bound && !commandSlots(commands[1]?.argv ?? []).includes("nodeId"))
  )
    fail(path, "unused-binding");
  return { commands, query, result: checkResult(data["result"], path) };
}
function checkResult(value: unknown, path: string): ForgeCheckResult {
  const result = object(
    value,
    path,
    ["rows", "shape", "limit", "variants"],
    ["guards", "nullAt", "pageComplete", "required", "rowGuards"],
  );
  const shape = enumeration("array", "object")(result["shape"], path);
  const limit = integer(result["limit"], path, shape === "object" ? 1 : 1000, 1);
  return {
    guards: defaulted(array(guard, 16), [])(result["guards"], path),
    nullAt: optional(pathValue)(result["nullAt"], path),
    rows: pathValue(result["rows"], path),
    shape,
    limit,
    pageComplete: optional(pathValue)(result["pageComplete"], path),
    required: optional(pathValue)(result["required"], path),
    rowGuards: defaulted(array(guard, 16), [])(result["rowGuards"], path),
    variants: array(variant, 8, 1)(result["variants"], path),
  };
}
function batchPlan(value: unknown, path: string): ForgeBatchPlan {
  const data = object(value, path, [
    "command",
    "query",
    "discovery",
    "bound",
    "repository",
    "defaultBranch",
    "nodes",
    "pageComplete",
    "sourceProject",
    "crossProject",
    "checks",
    "webUrl",
  ]);
  const query = multiline(data["query"], path);
  const discovery = multiline(data["discovery"], path);
  const bound = multiline(data["bound"], path);
  validateForgeBatchQueries(query, discovery, bound);
  const parsed = command(data["command"], path, ["host", "query", "projectOwner", "projectName"]);
  if (parsed.jsonExitCodes.length !== 1 || parsed.jsonExitCodes[0] !== 0)
    fail(path, "invalid-batch-exit");
  const webUrl = argument(data["webUrl"], path);
  if (commandSlots([webUrl]).some((slot) => !["host", "project", "number"].includes(slot)))
    fail(path, "slot-scope");
  const result = checkResult(data["checks"], path);
  if (result.shape !== "array" || !result.required) fail(path, "invalid-batch-checks");
  return {
    command: parsed,
    query,
    discovery,
    bound,
    webUrl,
    repository: pathValue(data["repository"], path),
    defaultBranch: pathValue(data["defaultBranch"], path),
    nodes: pathValue(data["nodes"], path),
    pageComplete: pathValue(data["pageComplete"], path),
    sourceProject: pathValue(data["sourceProject"], path),
    crossProject: pathValue(data["crossProject"], path),
    checks: result,
  };
}
function projects(value: unknown, path: string): ForgeProjects {
  const tag = object(
    value,
    path,
    ["mode"],
    ["owner", "crossProject", "sourceName", "source", "target", "context"],
  )["mode"];
  if (tag === "owner-and-cross-flag") {
    const data = object(value, path, ["mode", "owner", "crossProject", "sourceName"]);
    return {
      mode: tag,
      owner: pathValue(data["owner"], path),
      crossProject: pathValue(data["crossProject"], path),
      sourceName: pathValue(data["sourceName"], path),
    };
  }
  const data = object(value, path, ["mode", "source", "target", "context"]);
  return {
    mode: literal("numeric-project-ids")(tag, path),
    source: pathValue(data["source"], path),
    target: pathValue(data["target"], path),
    context: pathValue(data["context"], path),
  };
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Offline parse only. A manifest cannot enable itself, assign a host or spawn a CLI. */
export function parseForgeManifest(
  source: string,
  origin: "bundled" | "config" = "config",
): ForgeManifest {
  const at = "$";
  const data = object(
    manifestJson(source),
    at,
    [
      "kind",
      "version",
      "id",
      "name",
      "badge",
      "executables",
      "remote",
      "auth",
      "operations",
      "mapping",
      "checks",
    ],
    ["environment", "minimumIntervalSeconds"],
  );
  const identifier = id(data["id"], at);
  if (unsafe.includes(identifier) || (origin === "config" && identifier === "github"))
    fail(at, "reserved-id");
  const remote = object(data["remote"], at, ["hosts", "namespace", "case"]);
  const auth = object(data["auth"], at, ["argv", "successExitCodes"], ["failureContains"]);
  const authArgv = argvValue(auth["argv"], at);
  validateForgeCommand(authArgv, true);
  const operations = object(
    data["operations"],
    at,
    ["lookupByBranch", "resolveNumber", "refresh"],
    ["display", "batchStatus"],
  );
  const lookup = object(operations["lookupByBranch"], at, ["open", "all"]);
  const mapping = object(
    data["mapping"],
    at,
    ["number", "branch", "headSha", "state", "states", "projects"],
    ["title", "webUrl"],
  );
  const checks = object(data["checks"], at, ["meaning", "primary"], ["fallback"]);
  const env =
    data["environment"] === undefined
      ? {}
      : object(data["environment"], at, [], ["GH_PROMPT_DISABLED", "GH_PAGER", "GITLAB_PAGER"]);
  const environment = Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (key === "GH_PROMPT_DISABLED" ? value !== "1" : value !== "cat" && value !== "")
        fail(at, "unsafe-environment");
      return [key, text(value, at, 128, 0)];
    }),
  );
  const host = (value: unknown, path: string) => {
    const result = text(value, path, 253);
    if (!forgeHost(result)) fail(path);
    return result;
  };
  const numberSlots = ["host", "project", "number"];
  const primary = plan(checks["primary"], at);
  const fallback = optional(plan)(checks["fallback"], at);
  const batchStatus = optional(batchPlan)(operations["batchStatus"], at);
  const queryText = [
    primary.query ?? "",
    fallback?.query ?? "",
    batchStatus?.query ?? "",
    batchStatus?.discovery ?? "",
    batchStatus?.bound ?? "",
  ].join("");
  if (new TextEncoder().encode(queryText).length > 32768) fail(at, "too-large");
  return freeze({
    kind: literal("forge")(data["kind"], at),
    version: literal(1)(data["version"], at),
    id: identifier,
    name: text(data["name"], at, 40),
    badge: pattern(data["badge"], at, /^[A-Z0-9]{1,4}$/u, 4),
    executables: unique(array(basename, 8, 1)(data["executables"], at), at),
    remote: {
      hosts: unique(array(host, 8, 1)(remote["hosts"], at), at),
      namespace: enumeration("pair", "nested")(remote["namespace"], at),
      case: enumeration("ascii-insensitive", "exact")(remote["case"], at),
    },
    auth: {
      argv: authArgv,
      successExitCodes: array(literal(0), 1, 1)(auth["successExitCodes"], at),
      failureContains: defaulted(
        array((v, p) => text(v, p, 128), 8, 1),
        [],
      )(auth["failureContains"], at),
    },
    environment,
    minimumIntervalSeconds:
      data["minimumIntervalSeconds"] === undefined
        ? 20
        : integer(data["minimumIntervalSeconds"], at, 86400, 20),
    operations: {
      lookupByBranch: {
        open: command(lookup["open"], at, ["host", "project", "branch"]),
        all: command(lookup["all"], at, ["host", "project", "branch"]),
      },
      resolveNumber: command(operations["resolveNumber"], at, numberSlots),
      refresh: command(operations["refresh"], at, numberSlots),
      batchStatus,
      display: optional((value, path) => command(value, path, numberSlots))(
        operations["display"],
        at,
      ),
    },
    mapping: {
      number: pathValue(mapping["number"], at),
      branch: pathValue(mapping["branch"], at),
      headSha: pathValue(mapping["headSha"], at),
      state: pathValue(mapping["state"], at),
      states: table(mapping["states"], at, enumeration("OPEN", "CLOSED", "MERGED")),
      title: optional(pathValue)(mapping["title"], at),
      webUrl: optional(pathValue)(mapping["webUrl"], at),
      projects: projects(mapping["projects"], at),
    },
    checks: {
      meaning: enumeration("required", "head-pipeline", "commit-status")(checks["meaning"], at),
      primary,
      fallback,
    },
  });
}
