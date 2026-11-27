import { parse as parseToml } from "smol-toml";
import { isRecord } from "./agent-manifest-values";
import type { AgentManifestV2 } from "./agent-manifest-v2";

type Matcher = AgentManifestV2["reservedArguments"][number];
function overrideValueMatches(raw: string, expected: string): boolean {
  if (raw === expected) return true;
  if (!raw.startsWith('"') && !raw.startsWith("'")) return false;
  try {
    const parsed = parseToml(`value = ${raw}`, { maxDepth: 24, unsafeKeyBehaviour: "throw" });
    return isRecord(parsed) && parsed["value"] === expected;
  } catch {
    // Codex falls back to the literal value with boundary quotes removed.
    return raw.replace(/^["']+|["']+$/gu, "") === expected;
  }
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
        return (
          (overrideKeys === "any" || segments.length === 1) &&
          rule.keys.includes(segments.at(-1) ?? "") &&
          overrideValueMatches(equals < 0 ? "" : config.slice(equals + 1).trim(), rule.value)
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
