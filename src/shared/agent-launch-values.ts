import type { AgentManifestV2 } from "./agent-manifest-v2";

export type Facts = Readonly<Record<string, unknown>>;
export { selected } from "./agent-conditions";
import { selected } from "./agent-conditions";

export function discoveryFacts(
  model: AgentManifestV2,
  version: string,
  help: string,
  engine: Facts,
): Facts {
  const grammar = model.discovery.version;
  let parsed: number[] | undefined;
  if (grammar && version.startsWith(grammar.prefix)) {
    const rest = version.slice(grammar.prefix.length);
    for (const suffix of grammar.suffixes) {
      if (!rest.endsWith(suffix)) continue;
      const numeric = suffix.length ? rest.slice(0, -suffix.length) : rest;
      if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(numeric)) continue;
      const components = numeric.split(".").map(Number);
      if (components.every(Number.isSafeInteger)) parsed = components;
    }
  }
  const minimum = (floor: number[] | undefined) => {
    if (!floor) return true;
    if (!parsed) return false;
    for (const [index, component] of floor.entries()) {
      const actual = parsed[index];
      if (actual === undefined) return false;
      if (actual !== component) return actual > component;
    }
    return true;
  };
  const facts: Record<string, unknown> = { ...engine };
  for (const fact of model.discovery.facts) {
    facts[fact.id] =
      fact.enabled &&
      minimum(fact.minimum ?? grammar?.minimum) &&
      fact.helpTokens.every((token) => {
        let offset = help.indexOf(token);
        while (offset >= 0) {
          const before = offset === 0 ? " " : help[offset - 1];
          const after = help[offset + token.length];
          if (
            before !== undefined &&
            /\s/u.test(before) &&
            (after === undefined || /[\s=,]/u.test(after))
          )
            return true;
          offset = help.indexOf(token, offset + 1);
        }
        return false;
      }) &&
      selected(fact.when, facts);
  }
  return facts;
}

/** Discovery reports capability across possible launch contexts; preparation selects one. */
export function hookCapability(
  model: AgentManifestV2,
  version: string,
  help: string,
  setupState = "unavailable",
): boolean {
  const names = ["control", "configGreeting", "hasPrompt", "resume", "healthTrusted"];
  for (let variant = 0; variant < 32; variant++) {
    const engine: Record<string, unknown> = { hooksEnabled: true, setupState };
    for (const [index, name] of names.entries()) engine[name] = Boolean(variant & (1 << index));
    const facts = { ...discoveryFacts(model, version, help, engine) };
    for (const channel of model.hooks?.channels ?? []) {
      const attached = selected(channel.when, facts);
      facts[`channelAttached:${channel.id}`] = attached;
      if (attached) return true;
    }
  }
  return false;
}

export { matchesArguments } from "./agent-argument-matchers";

export function bypassEnvironment(model: AgentManifestV2, env: Facts, windows = false): string[] {
  return model.bypassEnvironment
    .filter((rule) =>
      Object.entries(env).some(([name, raw]) => {
        if (
          (windows ? name.toUpperCase() !== rule.name.toUpperCase() : name !== rule.name) ||
          typeof raw !== "string"
        )
          return false;
        const value = rule.trim ? raw.trim() : raw;
        return rule.match === "present-nonempty"
          ? value.length > 0
          : (rule.values ?? []).some((candidate) =>
              rule.caseInsensitive
                ? candidate.toLowerCase() === value.toLowerCase()
                : candidate === value,
            );
      }),
    )
    .map((rule) => `${rule.name}: ${rule.match}`);
}

export function expandV2(
  template: string,
  values: Readonly<Record<string, string | string[] | number>>,
): string {
  return template.replace(
    /\{(extensionFile|prompt|conversationId|newId|mcpName|mcpUrl|toolRules|tool|hookDir|(?:file|fileContent|hookFile):[A-Za-z0-9_./-]+|(?:observerCommand|observerArgv|observerVersion|observerModule):[A-Za-z0-9_.-]+)(:json|:toml)?\}/gu,
    (_whole, key: string, format: string | undefined) => {
      const value = values[key];
      if (value === undefined) throw new Error("Unselected launch substitution");
      return format ? JSON.stringify(value) : String(value);
    },
  );
}
export function boundedArguments(args: string[]): string[] {
  if (
    args.length > 256 ||
    args.some(
      (arg) => new TextEncoder().encode(arg).length > 20480 || /[^\P{Cc}\n\t]/u.test(arg),
    ) ||
    args.reduce((total, arg) => total + new TextEncoder().encode(arg).length, 0) > 65536
  )
    throw new Error("Expanded launch arguments exceed limits");
  return args;
}

type Merge = NonNullable<NonNullable<AgentManifestV2["launch"]["guidance"]>["merge"]>;
/** Collect literal variadic/equals values; parentheses shield separators only for tool rules. */
export function collectMerge(
  args: readonly string[],
  merge: Merge,
  split = true,
): { args: string[]; values: string[] } {
  const result: string[] = [];
  const values: string[] = [];
  const add = (value: string) => {
    if (!split) {
      values.push(value);
      return;
    }
    let depth = 0;
    let word = "";
    for (const character of value) {
      if (merge.separators === "whitespace-comma-parentheses") {
        if (character === "(") depth++;
        if (character === ")" && --depth < 0) throw new Error("Unbalanced tool rule");
      }
      if (depth === 0 && (merge.separators === "whitespace" ? /\s/u : /[\s,]/u).test(character)) {
        if (word) values.push(word);
        word = "";
      } else word += character;
    }
    if (depth !== 0) throw new Error("Unbalanced tool rule");
    if (word) values.push(word);
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    const flag = merge.flags.find((entry) => arg === entry || arg.startsWith(`${entry}=`));
    if (!flag) result.push(arg);
    else if (arg !== flag) add(arg.slice(flag.length + 1));
    else if (!split) {
      const value = args[++index];
      if (value === undefined) throw new Error("Merge option is missing its value");
      add(value);
    } else {
      let found = false;
      while (args[index + 1] !== undefined && !args[index + 1]?.startsWith("-")) {
        add(args[++index] ?? "");
        found = true;
      }
      if (!found) throw new Error("Merge option is missing its value");
    }
  }
  return { args: result, values };
}
