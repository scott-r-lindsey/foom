import { CONTROL_TOOL_CLASSES } from "./control-tool-classes";
import {
  object,
  text,
  pattern,
  id,
  localId,
  flag,
  basename,
  relative,
  integer,
  boolean,
  literal,
  enumeration,
  array,
  optional,
  defaulted,
  primitive,
  multiline,
  versionText,
  fail,
} from "./agent-manifest-values";
const shortText = (v: unknown, p: string) => text(v, p, 128);
const eventText = (v: unknown, p: string) => text(v, p, 64);
const comment = (v: unknown, p: string) => text(v, p, 256);
const name = (v: unknown, p: string) => text(v, p, 40);
const pasteSelector = (v: unknown, p: string) => pattern(v, p, /^[A-Za-z0-9_-]+$/u, 40);
const offerLabel = (v: unknown, p: string) => text(v, p, 80);
const badge = (v: unknown, p: string) => pattern(v, p, /^[A-Z0-9]{1,4}$/u, 4);
const eventToken = (v: unknown, p: string) => pattern(v, p, /^[A-Za-z][A-Za-z0-9_-]*$/u, 64);
const keySegment = (v: unknown, p: string) => pattern(v, p, /^[A-Za-z_][A-Za-z0-9_-]*$/u, 64);
const ruleId = (v: unknown, p: string) => pattern(v, p, /^[a-z][a-z0-9_-]*$/u, 40);
const envName = (v: unknown, p: string) => pattern(v, p, /^[A-Za-z_][A-Za-z0-9_]*$/u, 64);
const homeRelative = (v: unknown, p: string) => relative(v, p, true);
const abiInteger = (v: unknown, p: string) => integer(v, p, 100000, 1);
const timeout = (v: unknown, p: string) => integer(v, p, 3000, 1000);
const priority = (v: unknown, p: string) => integer(v, p, 2000);
const lines = (v: unknown, p: string) => integer(v, p, 40, 1);
const argv = array(text, 64);
function minimum(v: unknown, p: string) {
  return array(integer, 3, 3)(v, p);
}
function selectorKey(v: unknown, p: string) {
  return typeof v === "number" ? integer(v, p, 63) : text(v, p, 64);
}
function field(v: unknown, p: string) {
  return typeof v === "string" ? text(v, p, 64) : selector(v, p);
}
function testValue(v: unknown, p: string) {
  return Array.isArray(v) ? array(primitive, 16)(v, p) : primitive(v, p);
}
function abi(v: unknown, p: string) {
  if (typeof v === "number") return abiInteger(v, p);
  const d = object(v, p, ["posix", "win32"]);
  return {
    posix: abiInteger(d["posix"], `${p}.posix`),
    win32: abiInteger(d["win32"], `${p}.win32`),
  };
}
function aliases(v: unknown, p: string) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(p);
  const entries = Object.entries(v);
  if (entries.length > 8) fail(p);
  return Object.fromEntries(entries.map(([k, value]) => [text(k, p, 128), primitive(value, p)]));
}
function jsonValue(v: unknown, _p: string): unknown {
  return v;
}
function statusProbe(v: unknown, p: string) {
  return v === "observed-health" ? v : argv(v, p);
}
export function argumentMatcher(v: unknown, p: string) {
  const d = object(v, p, [], ["flag", "forms", "value", "word", "prefix", "override"]);
  if (d["flag"] !== undefined) {
    object(v, p, ["flag", "forms"], ["value"]);
    return {
      flag: flag(d["flag"], `${p}.flag`),
      forms: array(
        enumeration("exact", "equals", "separate", "attached-short"),
        4,
        1,
      )(d["forms"], `${p}.forms`),
      value: optional(shortText)(d["value"], `${p}.value`),
    };
  }
  if (d["word"] !== undefined) {
    object(v, p, ["word"]);
    return { word: eventText(d["word"], `${p}.word`) };
  }
  if (d["prefix"] !== undefined) {
    object(v, p, ["prefix"]);
    return { prefix: eventText(d["prefix"], `${p}.prefix`) };
  }
  object(v, p, ["override"]);
  return { override: override(d["override"], `${p}.override`) };
}
const versionPrefix = (v: unknown, p: string) => text(v, p, 4096, 0);
export function selector(v: unknown, p: string) {
  const d = object(v, p, ["source", "path"], []);
  return {
    source: enumeration(
      "payload",
      "header",
      "probe",
      "metadata",
      "facts",
    )(d["source"], `${p}.source`),
    path: array(selectorKey, 8, 1)(d["path"], `${p}.path`),
  };
}
export function test(v: unknown, p: string) {
  const d = object(v, p, ["field", "op"], ["value"]);
  return {
    field: field(d["field"], `${p}.field`),
    op: enumeration("eq", "in", "exists", "absent", "lt", "gte")(d["op"], `${p}.op`),
    value: optional(testValue)(d["value"], `${p}.value`),
  };
}
export function condition(v: unknown, p: string) {
  const d = object(v, p, [], ["all", "any"]);
  return {
    all: optional(array(test, 16))(d["all"], `${p}.all`),
    any: optional(array(test, 16))(d["any"], `${p}.any`),
  };
}
export function version(v: unknown, p: string) {
  const d = object(v, p, ["prefix", "suffixes"], ["minimum"]);
  return {
    prefix: versionPrefix(d["prefix"], `${p}.prefix`),
    suffixes: array(versionText, 4, 1)(d["suffixes"], `${p}.suffixes`),
    minimum: optional(minimum)(d["minimum"], `${p}.minimum`),
  };
}
export function fact(v: unknown, p: string) {
  const d = object(v, p, ["id"], ["enabled", "minimum", "helpTokens", "when"]);
  return {
    id: localId(d["id"], `${p}.id`),
    enabled: defaulted(boolean, true)(d["enabled"], `${p}.enabled`),
    minimum: optional(minimum)(d["minimum"], `${p}.minimum`),
    helpTokens: defaulted(array(shortText, 8), [])(d["helpTokens"], `${p}.helpTokens`),
    when: optional(condition)(d["when"], `${p}.when`),
  };
}
export function discovery(v: unknown, p: string) {
  const d = object(v, p, ["facts"], ["version"]);
  return {
    version: optional(version)(d["version"], `${p}.version`),
    facts: array(fact, 16)(d["facts"], `${p}.facts`),
  };
}
export function block(v: unknown, p: string) {
  const d = object(v, p, ["arguments"], ["when"]);
  return {
    arguments: argv(d["arguments"], `${p}.arguments`),
    when: optional(condition)(d["when"], `${p}.when`),
  };
}
export function prompt(v: unknown, p: string) {
  const d = object(v, p, ["arguments"], ["requires"]);
  return {
    arguments: argv(d["arguments"], `${p}.arguments`),
    requires: optional(localId)(d["requires"], `${p}.requires`),
  };
}
export function merge(v: unknown, p: string) {
  const d = object(v, p, ["flags", "output", "separators"], []);
  return {
    flags: array(flag, 8, 1)(d["flags"], `${p}.flags`),
    output: flag(d["output"], `${p}.output`),
    separators: enumeration(
      "whitespace",
      "whitespace-comma",
      "whitespace-comma-parentheses",
    )(d["separators"], `${p}.separators`),
  };
}
export function guidance(v: unknown, p: string) {
  const d = object(v, p, ["when"], ["merge"]);
  return {
    when: condition(d["when"], `${p}.when`),
    merge: optional(merge)(d["merge"], `${p}.merge`),
  };
}
export function tools(v: unknown, p: string) {
  const d = object(v, p, ["names", "format", "arguments"], ["merge", "fileRules"]);
  return {
    names: array(
      enumeration(...Object.keys(CONTROL_TOOL_CLASSES)),
      Object.keys(CONTROL_TOOL_CLASSES).length,
    )(d["names"], `${p}.names`),
    fileRules: optional(literal("action-resource"))(d["fileRules"], `${p}.fileRules`),
    format: enumeration(
      "mcp-double-underscore",
      "server-parentheses",
      "server-underscore",
    )(d["format"], `${p}.format`),
    arguments: argv(d["arguments"], `${p}.arguments`),
    merge: optional(merge)(d["merge"], `${p}.merge`),
  };
}
/** Manifest environment is data-only, never a route to runtime injection or credentials. */
export function launchEnvironment(v: unknown, p: string) {
  const d = object(v, p, ["name", "value"], ["when"]);
  const name = envName(d["name"], `${p}.name`);
  if (
    /^(?:LD_|DYLD_|NODE_|BUN_|DENO_|NPM_CONFIG_|YARN_|PNPM_|LUA_|PYTHON|PERL5|RUBY|GIT_|SSH_|AWS_|GITHUB_|GH_|FOOM_|ELECTRON_)/iu.test(
      name,
    ) ||
    /TOKEN|SECRET|KEY|PASSWORD|PROXY/iu.test(name) ||
    [
      "JAVA_TOOL_OPTIONS",
      "_JAVA_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "PATH",
      "HOME",
      "SHELL",
      "BASH_ENV",
      "ENV",
      "PS4",
      "IFS",
      "ZDOTDIR",
      "PROMPT_COMMAND",
      "EDITOR",
      "VISUAL",
      "PAGER",
      "BROWSER",
      "MANPAGER",
      "LESSOPEN",
      "LESSCLOSE",
      "PERLLIB",
      "GCONV_PATH",
      "LOCPATH",
      "HOSTALIASES",
      "RES_OPTIONS",
      "LOCALDOMAIN",
      "TMPDIR",
      "CLAUDECODE",
      "TERM",
      "COLORTERM",
      "TERM_PROGRAM",
      "CONSTRUCTOR",
      "PROTOTYPE",
      "__PROTO__",
    ].includes(name.toUpperCase())
  )
    fail(`${p}.name`, "reserved-environment");
  const value = text(d["value"], `${p}.value`, 128);
  if (/\$|%|`/u.test(value)) fail(`${p}.value`, "environment-reference");
  if (/[{}]/u.test(value) && !/^\{(?:file|fileContent):[^{}]+\}$/u.test(value))
    fail(`${p}.value`, "invalid-environment-value");
  return {
    name: envName(d["name"], `${p}.name`),
    value: text(d["value"], `${p}.value`, 128),
    when: optional(condition)(d["when"], `${p}.when`),
  };
}
/** Selects only application-owned executable bytes; manifests cannot supply code or paths. */
export function extension(v: unknown, p: string) {
  const d = object(v, p, ["api", "channel", "arguments", "when"]);
  return {
    api: literal("pi-v1")(d["api"], `${p}.api`),
    channel: id(d["channel"], `${p}.channel`),
    arguments: argv(d["arguments"], `${p}.arguments`),
    when: condition(d["when"], `${p}.when`),
  };
}

/** Narrow two-argument selections; callers never supply flags or config keys. */
export function launchSelection(v: unknown, p: string) {
  const d = object(v, p, ["flags", "arguments"], ["values"]);
  const flags = array(flag, 8, 1)(d["flags"], `${p}.flags`);
  const arguments_ = array(text, 2, 2)(d["arguments"], `${p}.arguments`);
  if (
    !flags.includes(arguments_[0] ?? "") ||
    !/^(?:\{value\}|[A-Za-z_][A-Za-z0-9_.]*="\{value\}")$/u.test(arguments_[1] ?? "")
  )
    fail(p, "invalid-selection-template");
  return {
    flags: array(flag, 8, 1)(d["flags"], `${p}.flags`),
    arguments: array(text, 2, 2)(d["arguments"], `${p}.arguments`),
    values: optional(array(selectionToken, 32, 1))(d["values"], `${p}.values`),
  };
}
const selectionToken = (v: unknown, p: string) =>
  pattern(v, p, /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,63}$/u, 64);
export function launch(v: unknown, p: string) {
  const d = object(
    v,
    p,
    ["order"],
    [
      "arguments",
      "display",
      "resume",
      "prompt",
      "guidance",
      "mcp",
      "toolPermissions",
      "environment",
      "extension",

      "model",
      "effort",
      "valueFlags",
    ],
  );
  if (d["effort"] !== undefined && launchSelection(d["effort"], `${p}.effort`).values === undefined)
    fail(`${p}.effort.values`);
  return {
    valueFlags: optional(array(flag, 64))(d["valueFlags"], `${p}.valueFlags`),
    model: optional(launchSelection)(d["model"], `${p}.model`),
    effort: optional(launchSelection)(d["effort"], `${p}.effort`),
    order: array(
      enumeration(
        "resume",
        "defaults",
        "arguments",
        "display",
        "guidance",
        "mcp",
        "hooks",
        "tools",
        "prompt",
      ),
      9,
      9,
    )(d["order"], `${p}.order`),
    arguments: optional(block)(d["arguments"], `${p}.arguments`),
    display: optional(block)(d["display"], `${p}.display`),
    resume: optional(block)(d["resume"], `${p}.resume`),
    prompt: optional(prompt)(d["prompt"], `${p}.prompt`),
    guidance: optional(guidance)(d["guidance"], `${p}.guidance`),
    mcp: optional(block)(d["mcp"], `${p}.mcp`),
    extension: optional(extension)(d["extension"], `${p}.extension`),
    environment: optional(array(launchEnvironment, 8))(d["environment"], `${p}.environment`),
    toolPermissions: optional(tools)(d["toolPermissions"], `${p}.toolPermissions`),
  };
}
export function file(v: unknown, p: string) {
  const d = object(v, p, ["name", "scope", "format", "content"], ["when"]);
  return {
    name: relative(d["name"], `${p}.name`),
    scope: enumeration("launch", "plugin")(d["scope"], `${p}.scope`),
    format: enumeration("json", "toml")(d["format"], `${p}.format`),
    content: multiline(d["content"], `${p}.content`),
    when: optional(condition)(d["when"], `${p}.when`),
  };
}
function moduleObserver(v: unknown, p: string) {
  const d = object(v, p, ["transport", "version"]);
  return {
    transport: literal("event-module")(d["transport"], `${p}.transport`),
    version: literal(1)(d["version"], `${p}.version`),
  };
}
function externalObserver(v: unknown, p: string) {
  const d = object(v, p, ["transport"]);
  return { transport: literal("external")(d["transport"], `${p}.transport`) };
}
export function observer(v: unknown, p: string) {
  if (typeof v === "object" && v !== null && "transport" in v && v.transport === "event-module") {
    return {
      ...generatedObserver(
        {
          transport: "stdin",
          placement: "launch",
          version: 1,
          response: "silent",
          delivery: "foreground",
          timeoutMs: 1000,
        },
        p,
      ),
      ...moduleObserver(v, p),
    };
  }
  if (typeof v === "object" && v !== null && "transport" in v && v.transport === "external") {
    return {
      ...generatedObserver(
        {
          transport: "stdin",
          placement: "launch",
          version: 1,
          response: "silent",
          delivery: "foreground",
          timeoutMs: 3000,
        },
        p,
      ),
      ...externalObserver(v, p),
    };
  }
  return generatedObserver(v, p);
}
function generatedObserver(v: unknown, p: string) {
  const d = object(
    v,
    p,
    ["transport", "placement", "version", "response", "delivery", "timeoutMs"],
    ["sequence", "basename", "commandArguments", "protocol"],
  );
  return {
    protocol: optional(literal("ordered-v2"))(d["protocol"], `${p}.protocol`),
    transport: enumeration("stdin", "argv-last")(d["transport"], `${p}.transport`),
    placement: enumeration("launch", "stable", "plugin")(d["placement"], `${p}.placement`),
    version: abi(d["version"], `${p}.version`),
    response: enumeration("silent", "empty-json-first")(d["response"], `${p}.response`),
    delivery: enumeration("foreground", "detached")(d["delivery"], `${p}.delivery`),
    timeoutMs: timeout(d["timeoutMs"], `${p}.timeoutMs`),
    sequence: defaulted(boolean, false)(d["sequence"], `${p}.sequence`),
    basename: defaulted(localId, "observer")(d["basename"], `${p}.basename`),
    commandArguments: defaulted(array(eventToken, 8), [])(
      d["commandArguments"],
      `${p}.commandArguments`,
    ),
  };
}
export function disclosure(v: unknown, p: string) {
  const d = object(v, p, ["id", "text", "acknowledgement"], []);
  return {
    id: id(d["id"], `${p}.id`),
    text: text(d["text"], `${p}.text`),
    acknowledgement: literal("profile")(d["acknowledgement"], `${p}.acknowledgement`),
  };
}
export function requirement(v: unknown, p: string) {
  const d = object(v, p, ["field", "type"], ["values"]);
  return {
    field: selector(d["field"], `${p}.field`),
    type: enumeration(
      "string",
      "boolean",
      "identifier",
      "conversation",
      "integer",
    )(d["type"], `${p}.type`),
    values: optional(array(primitive, 16))(d["values"], `${p}.values`),
  };
}
export function extractor(v: unknown, p: string) {
  const d = object(v, p, ["name", "field"], ["aliases"]);
  return {
    name: enumeration("terminationReason", "fullyIdle")(d["name"], `${p}.name`),
    field: selector(d["field"], `${p}.field`),
    aliases: optional(aliases)(d["aliases"], `${p}.aliases`),
  };
}
export function eventCase(v: unknown, p: string) {
  const d = object(
    v,
    p,
    ["id", "event", "action"],
    ["when", "require", "facts", "endsTurn", "recoverTurn"],
  );
  return {
    id: localId(d["id"], `${p}.id`),
    event: eventText(d["event"], `${p}.event`),
    when: optional(condition)(d["when"], `${p}.when`),
    require: defaulted(array(requirement, 16), [])(d["require"], `${p}.require`),
    action: enumeration(
      "ready",
      "working",
      "needs_input",
      "classify",
      "failed",
    )(d["action"], `${p}.action`),
    facts: defaulted(array(extractor, 8), [])(d["facts"], `${p}.facts`),
    endsTurn: optional(boolean)(d["endsTurn"], `${p}.endsTurn`),
    recoverTurn: defaulted(boolean, false)(d["recoverTurn"], `${p}.recoverTurn`),
  };
}
export function mapping(v: unknown, p: string) {
  const d = object(v, p, ["session", "event", "cases"], ["sequence", "dedupe", "sessionAliases"]);
  return {
    session: selector(d["session"], `${p}.session`),
    sessionAliases: optional(array(selector, 8))(d["sessionAliases"], `${p}.sessionAliases`),
    event: selector(d["event"], `${p}.event`),
    sequence: optional(selector)(d["sequence"], `${p}.sequence`),
    dedupe: optional(selector)(d["dedupe"], `${p}.dedupe`),
    cases: array(eventCase, 32, 1)(d["cases"], `${p}.cases`),
  };
}
export function channel(v: unknown, p: string) {
  const d = object(v, p, ["id", "when", "observer", "arguments", "mapping"], ["disclosure"]);
  return {
    id: id(d["id"], `${p}.id`),
    when: condition(d["when"], `${p}.when`),
    observer: observer(d["observer"], `${p}.observer`),
    arguments: argv(d["arguments"], `${p}.arguments`),
    mapping: mapping(d["mapping"], `${p}.mapping`),
    disclosure: optional(disclosure)(d["disclosure"], `${p}.disclosure`),
  };
}
export function hooks(v: unknown, p: string) {
  const d = object(v, p, ["channels"], []);
  return {
    channels: array(channel, 8, 1)(d["channels"], `${p}.channels`),
  };
}
export function override(v: unknown, p: string) {
  const d = object(v, p, ["flags", "keys"], ["value"]);
  return {
    flags: array(flag, 8, 1)(d["flags"], `${p}.flags`),
    keys: array(keySegment, 8, 1)(d["keys"], `${p}.keys`),
    value: optional(shortText)(d["value"], `${p}.value`),
  };
}
export function environment(v: unknown, p: string) {
  const d = object(v, p, ["name", "match"], ["values", "caseInsensitive", "trim"]);
  return {
    name: envName(d["name"], `${p}.name`),
    match: enumeration("present-nonempty", "values")(d["match"], `${p}.match`),
    values: optional(array(shortText, 16))(d["values"], `${p}.values`),
    caseInsensitive: defaulted(boolean, false)(d["caseInsensitive"], `${p}.caseInsensitive`),
    trim: defaulted(boolean, false)(d["trim"], `${p}.trim`),
  };
}
export function newId(v: unknown, p: string) {
  const d = object(v, p, ["format", "arguments"], ["prefix"]);
  return {
    prefix: optional(localId)(d["prefix"], `${p}.prefix`),
    format: literal("uuid")(d["format"], `${p}.format`),
    arguments: argv(d["arguments"], `${p}.arguments`),
  };
}
export function conversation(v: unknown, p: string) {
  const d = object(v, p, ["resumePin", "restoreControl"], ["newId"]);
  return {
    newId: optional(newId)(d["newId"], `${p}.newId`),
    resumePin: enumeration("first-event", "requested-on-paste")(d["resumePin"], `${p}.resumePin`),
    restoreControl: boolean(d["restoreControl"], `${p}.restoreControl`),
  };
}
export function paste(v: unknown, p: string) {
  const d = object(v, p, ["command", "selector"], []);
  return {
    command: basename(d["command"], `${p}.command`),
    selector: pasteSelector(d["selector"], `${p}.selector`),
  };
}
export function detectionMatcher(v: unknown, p: string) {
  const d = object(v, p, [], ["contains", "regex"]);
  return {
    contains: defaulted(array(shortText, 8), [])(d["contains"], `${p}.contains`),
    regex: defaulted(array(shortText, 8), [])(d["regex"], `${p}.regex`),
  };
}
export function rule(v: unknown, p: string) {
  const d = object(
    v,
    p,
    ["id", "state", "priority", "region", "match", "reason"],
    ["lines", "not", "comment"],
  );
  return {
    id: ruleId(d["id"], `${p}.id`),
    state: enumeration("working", "blocked", "idle", "unknown")(d["state"], `${p}.state`),
    priority: priority(d["priority"], `${p}.priority`),
    region: enumeration("title", "bottom", "after_horizontal_rule")(d["region"], `${p}.region`),
    match: detectionMatcher(d["match"], `${p}.match`),
    reason: shortText(d["reason"], `${p}.reason`),
    lines: optional(lines)(d["lines"], `${p}.lines`),
    not: defaulted(array(detectionMatcher, 8), [])(d["not"], `${p}.not`),
    comment: defaulted(comment, "Config-authored detection rule")(d["comment"], `${p}.comment`),
  };
}
export function provenance(v: unknown, p: string) {
  const d = object(v, p, ["source", "license", "modified"], []);
  return {
    source: comment(d["source"], `${p}.source`),
    license: comment(d["license"], `${p}.license`),
    modified: comment(d["modified"], `${p}.modified`),
  };
}
export function attention(v: unknown, p: string) {
  const d = object(v, p, ["minimumEngineVersion", "rules"], ["provenance", "sampleWhileActive"]);
  return {
    minimumEngineVersion: literal(1)(d["minimumEngineVersion"], `${p}.minimumEngineVersion`),
    rules: array(rule, 64)(d["rules"], `${p}.rules`),
    provenance: optional(provenance)(d["provenance"], `${p}.provenance`),
    // Omission stays absent so unrelated providers retain their parsed-model consent identity.
    sampleWhileActive: optional(boolean)(d["sampleWhileActive"], `${p}.sampleWhileActive`),
  };
}
export function execution(v: unknown, p: string) {
  const d = object(v, p, ["completion", "completionChannels"], ["providerRules"]);
  return {
    completion: enumeration("attached", "observed")(d["completion"], `${p}.completion`),
    completionChannels: array(id, 8)(d["completionChannels"], `${p}.completionChannels`),
    providerRules: defaulted(array(ruleId, 16), [])(d["providerRules"], `${p}.providerRules`),
  };
}
export function review(v: unknown, p: string) {
  const d = object(v, p, ["contains", "lines", "caseSensitive"], []);
  return {
    contains: array(shortText, 8, 1)(d["contains"], `${p}.contains`),
    lines: lines(d["lines"], `${p}.lines`),
    caseSensitive: boolean(d["caseSensitive"], `${p}.caseSensitive`),
  };
}
export function health(v: unknown, p: string) {
  const d = object(
    v,
    p,
    ["channel", "requiredEvents", "completionEvent", "promptEvent", "review", "instructions"],
    [],
  );
  return {
    channel: id(d["channel"], `${p}.channel`),
    requiredEvents: array(localId, 16)(d["requiredEvents"], `${p}.requiredEvents`),
    completionEvent: localId(d["completionEvent"], `${p}.completionEvent`),
    promptEvent: localId(d["promptEvent"], `${p}.promptEvent`),
    review: review(d["review"], `${p}.review`),
    instructions: text(d["instructions"], `${p}.instructions`),
  };
}
export function emptyProbe(v: unknown, p: string) {
  const d = object(v, p, ["text", "value"], []);
  return {
    text: shortText(d["text"], `${p}.text`),
    value: jsonValue(d["value"], `${p}.value`),
  };
}
export function probe(v: unknown, p: string) {
  const d = object(v, p, ["arguments", "format"], ["empty", "fallbackArguments"]);
  return {
    arguments: argv(d["arguments"], `${p}.arguments`),
    format: literal("json")(d["format"], `${p}.format`),
    fallbackArguments: optional(argv)(d["fallbackArguments"], `${p}.fallbackArguments`),
    empty: optional(emptyProbe)(d["empty"], `${p}.empty`),
  };
}
export function metadata(v: unknown, p: string) {
  const d = object(v, p, ["id", "path", "optional"], []);
  return {
    id: id(d["id"], `${p}.id`),
    path: homeRelative(d["path"], `${p}.path`),
    optional: boolean(d["optional"], `${p}.optional`),
  };
}
export function ownership(v: unknown, p: string) {
  const d = object(
    v,
    p,
    ["directory", "manifest", "require", "versionField", "currentVersion"],
    ["disabledField", "enabledField", "unfingerprintedVersion"],
  );
  return {
    directory: homeRelative(d["directory"], `${p}.directory`),
    manifest: id(d["manifest"], `${p}.manifest`),
    require: array(requirement, 16)(d["require"], `${p}.require`),
    versionField: selector(d["versionField"], `${p}.versionField`),
    unfingerprintedVersion: optional(abiInteger)(
      d["unfingerprintedVersion"],
      `${p}.unfingerprintedVersion`,
    ),
    currentVersion: abiInteger(d["currentVersion"], `${p}.currentVersion`),
    disabledField: optional(selector)(d["disabledField"], `${p}.disabledField`),
    enabledField: optional(selector)(d["enabledField"], `${p}.enabledField`),
  };
}
export function statusCase(v: unknown, p: string) {
  const d = object(v, p, ["when", "state"], []);
  return {
    when: condition(d["when"], `${p}.when`),
    state: enumeration(
      "not-installed",
      "installed",
      "outdated",
      "disabled",
      "unavailable",
    )(d["state"], `${p}.state`),
  };
}
export function status(v: unknown, p: string) {
  const d = object(v, p, ["cases", "default"], ["probe", "metadata", "ownership"]);
  return {
    probe: optional(probe)(d["probe"], `${p}.probe`),
    metadata: defaulted(array(metadata, 4), [])(d["metadata"], `${p}.metadata`),
    ownership: optional(ownership)(d["ownership"], `${p}.ownership`),
    cases: array(statusCase, 16)(d["cases"], `${p}.cases`),
    default: literal("unavailable")(d["default"], `${p}.default`),
  };
}
export function action(v: unknown, p: string) {
  const d = object(
    v,
    p,
    ["id", "label", "kind", "when", "disclosure", "statusProbe"],
    ["arguments", "instructions"],
  );
  return {
    id: id(d["id"], `${p}.id`),
    label: name(d["label"], `${p}.label`),
    kind: enumeration("command", "instructions")(d["kind"], `${p}.kind`),
    arguments: optional(argv)(d["arguments"], `${p}.arguments`),
    instructions: optional(text)(d["instructions"], `${p}.instructions`),
    when: condition(d["when"], `${p}.when`),
    disclosure: text(d["disclosure"], `${p}.disclosure`),
    statusProbe: statusProbe(d["statusProbe"], `${p}.statusProbe`),
  };
}
export function offer(v: unknown, p: string) {
  const d = object(v, p, ["unansweredLabel"], []);
  return {
    unansweredLabel: offerLabel(d["unansweredLabel"], `${p}.unansweredLabel`),
  };
}
export function setup(v: unknown, p: string) {
  const d = object(v, p, ["status", "actions"], ["offer"]);
  return {
    status: status(d["status"], `${p}.status`),
    actions: array(action, 8)(d["actions"], `${p}.actions`),
    offer: optional(offer)(d["offer"], `${p}.offer`),
  };
}
export function v2(v: unknown, p: string) {
  const d = object(
    v,
    p,
    [
      "kind",
      "version",
      "id",
      "name",
      "badge",
      "executables",
      "discovery",
      "launch",
      "reservedArguments",
      "bypassArguments",
      "bypassEnvironment",
      "conversation",
      "resumePaste",
      "attention",
      "execution",
    ],
    ["files", "hooks", "health", "setup"],
  );
  return {
    kind: literal("agent")(d["kind"], `${p}.kind`),
    version: literal(2)(d["version"], `${p}.version`),
    id: id(d["id"], `${p}.id`),
    name: name(d["name"], `${p}.name`),
    badge: badge(d["badge"], `${p}.badge`),
    executables: array(basename, 8, 1)(d["executables"], `${p}.executables`),
    discovery: discovery(d["discovery"], `${p}.discovery`),
    launch: launch(d["launch"], `${p}.launch`),
    files: defaulted(array(file, 16), [])(d["files"], `${p}.files`),
    hooks: optional(hooks)(d["hooks"], `${p}.hooks`),
    reservedArguments: array(argumentMatcher, 64)(d["reservedArguments"], `${p}.reservedArguments`),
    bypassArguments: array(argumentMatcher, 64)(d["bypassArguments"], `${p}.bypassArguments`),
    bypassEnvironment: array(environment, 16)(d["bypassEnvironment"], `${p}.bypassEnvironment`),
    conversation: conversation(d["conversation"], `${p}.conversation`),
    resumePaste: array(paste, 8)(d["resumePaste"], `${p}.resumePaste`),
    attention: attention(d["attention"], `${p}.attention`),
    execution: execution(d["execution"], `${p}.execution`),
    health: optional(health)(d["health"], `${p}.health`),
    setup: optional(setup)(d["setup"], `${p}.setup`),
  };
}
