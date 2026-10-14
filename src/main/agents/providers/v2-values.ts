import type { AgentManifestV2, ManifestCondition } from "../../../shared/agent-manifest-v2";

export type Facts = Readonly<Record<string, unknown>>;
export function selected(when: ManifestCondition | undefined, facts: Facts): boolean {
  const test = (entry: NonNullable<ManifestCondition["all"]>[number]) => {
    const key = typeof entry.field === "string" ? entry.field : String(entry.field.path[0]);
    const value = Object.hasOwn(facts, key) ? facts[key] : undefined;
    switch (entry.op) {
      case "exists":
        return value !== undefined;
      case "absent":
        return value === undefined;
      case "eq":
        return value !== undefined && value === entry.value;
      case "in":
        return (
          value !== undefined &&
          Array.isArray(entry.value) &&
          entry.value.some((candidate) => candidate === value)
        );
      case "lt":
        return (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          typeof entry.value === "number" &&
          value < entry.value
        );
      case "gte":
        return (
          typeof value === "number" &&
          Number.isSafeInteger(value) &&
          typeof entry.value === "number" &&
          value >= entry.value
        );
    }
  };
  return (
    !when || (when.all?.every(test) !== false && (when.any === undefined || when.any.some(test)))
  );
}

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

type Matcher = AgentManifestV2["reservedArguments"][number];
export function matchesArguments(matchers: readonly Matcher[], args: readonly string[]): boolean {
  return matchers.some((matcher) =>
    args.some((arg, index) => {
      if ("word" in matcher) return arg === matcher.word;
      if ("prefix" in matcher) return arg.startsWith(matcher.prefix);
      if ("override" in matcher) {
        const rule = matcher.override;
        let config: string | undefined;
        for (const flag of rule.flags) {
          if (arg === flag) config = args[index + 1];
          else if (arg.startsWith(`${flag}=`)) config = arg.slice(flag.length + 1);
          else if (/^-[A-Za-z]$/u.test(flag) && arg.startsWith(flag)) config = arg.slice(2);
        }
        if (config === undefined) return false;
        const equals = config.indexOf("=");
        const segments = (equals < 0 ? config : config.slice(0, equals))
          .replace(/[\s"']/gu, "")
          .split(".");
        const value =
          equals < 0
            ? ""
            : config
                .slice(equals + 1)
                .trim()
                .replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2");
        return rule.value === undefined
          ? segments.some((key) => rule.keys.includes(key))
          : rule.keys.includes(segments.at(-1) ?? "") && value === rule.value;
      }
      return matcher.forms.some((form) => {
        if (form === "exact") return arg === matcher.flag && matcher.value === undefined;
        let value: string | undefined;
        if (form === "separate" && arg === matcher.flag) value = args[index + 1];
        if (form === "equals" && arg.startsWith(`${matcher.flag}=`))
          value = arg.slice(matcher.flag.length + 1);
        if (
          form === "attached-short" &&
          arg.startsWith(matcher.flag) &&
          arg.length > matcher.flag.length
        )
          value = arg.slice(matcher.flag.length).replace(/^=/u, "");
        return value !== undefined && (matcher.value === undefined || value === matcher.value);
      });
    }),
  );
}

export function bypassEnvironment(
  model: AgentManifestV2,
  env: Facts,
  windows = process.platform === "win32",
): string[] {
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

export function expandV2(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(
    /\{(prompt|conversationId|newId|mcpName|mcpUrl|tool|file:[A-Za-z0-9_./-]+)(:json|:toml)?\}/gu,
    (_whole, key: string, format: string | undefined) => {
      const value = values[key];
      if (value === undefined) throw new Error("Unselected launch substitution");
      return format ? JSON.stringify(value) : value;
    },
  );
}
export function boundedArguments(args: string[]): string[] {
  if (
    args.length > 256 ||
    args.some((arg) => Buffer.byteLength(arg) > 20480 || /[^\P{Cc}\n\t]/u.test(arg)) ||
    args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 65536
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
    else {
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
