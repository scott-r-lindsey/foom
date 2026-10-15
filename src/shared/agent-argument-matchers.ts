import type { AgentManifestV2 } from "./agent-manifest-v2";

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
