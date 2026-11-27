import { parse as parseToml } from "smol-toml";
import { isRecord } from "./agent-manifest-values";
import type { AgentManifestV2 } from "./agent-manifest-v2";

type Matcher = AgentManifestV2["reservedArguments"][number];
type Override = Extract<Matcher, { override: object }>["override"];

function overrideValueMatches(
  path: readonly string[],
  raw: string,
  rule: Override,
  expected: string,
  rootOnly: boolean,
): boolean {
  const keyMatches = rule.keys.includes(path.at(-1) ?? "");
  if (keyMatches && raw === expected) return true;
  const failClosed = path.some((key) => rule.failClosedKeys?.includes(key));
  if (!keyMatches && !failClosed && (rootOnly || !raw.startsWith("{"))) return false;
  let value: unknown;
  try {
    const parsed = parseToml(`value = ${raw}`, { maxDepth: 24, unsafeKeyBehaviour: "throw" });
    if (!isRecord(parsed) || !Object.hasOwn(parsed, "value")) return failClosed;
    value = parsed["value"];
  } catch {
    // Codex falls back to the literal value with boundary quotes removed.
    return (keyMatches && raw.replace(/^["']+|["']+$/gu, "") === expected) || failClosed;
  }
  return (
    (keyMatches && value === expected) ||
    (!rootOnly && tableValueMatches(value, rule.keys, expected))
  );
}

function tableValueMatches(value: unknown, keys: readonly string[], expected: string): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const table = pending.pop();
    if (!isRecord(table)) continue;
    for (const [key, entry] of Object.entries(table)) {
      if (keys.includes(key) && entry === expected) return true;
      if (isRecord(entry)) pending.push(entry);
    }
  }
  return false;
}

export function matchesArguments(
  matchers: readonly Matcher[],
  args: readonly string[],
  overrideKeys: "any" | "root" = "any",
): boolean {
  return argumentMatchIndex(matchers, args, overrideKeys) >= 0;
}

export function argumentMatchIndex(
  matchers: readonly Matcher[],
  args: readonly string[],
  overrideKeys: "any" | "root" = "any",
): number {
  return args.findIndex((arg, index) =>
    matchers.some((matcher) => {
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
        if (rule.value === undefined)
          return (overrideKeys === "root" ? segments.slice(0, 1) : segments).some((key) =>
            rule.keys.includes(key),
          );
        if (equals < 0 || (overrideKeys === "root" && segments.length !== 1)) return false;
        return overrideValueMatches(
          segments,
          config.slice(equals + 1).trim(),
          rule,
          rule.value,
          overrideKeys === "root",
        );
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
