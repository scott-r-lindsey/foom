import type { AgentId } from "../../shared/agents";

export const EMPTY_AGENT_ARGUMENTS: Readonly<Record<AgentId, readonly string[]>> = Object.freeze({
  claude: Object.freeze([]),
  codex: Object.freeze([]),
  agy: Object.freeze([]),
});

/** A fixed disclosure table, not an attempt to infer effective policy from arbitrary flags. */
const BYPASS: Record<AgentId, readonly string[]> = {
  claude: ["--dangerously-skip-permissions", "--permission-mode=bypassPermissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  agy: ["--dangerously-skip-permissions"],
};

export function hasBypassArgument(agent: AgentId, args: readonly string[]): boolean {
  return args.some(
    (arg, index) =>
      BYPASS[agent].includes(arg) ||
      (agent === "claude" &&
        arg === "--permission-mode" &&
        args[index + 1] === "bypassPermissions"),
  );
}

/** Copy argv without trimming, splitting, quote interpretation, or shell expansion. */
export function parseAgentArguments(agent: AgentId, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("Use at most 64 default arguments per agent.");
  const args: string[] = [];
  for (const arg of value) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > 4096 || /\p{Cc}/u.test(arg))
      throw new Error("Each argument must contain 1–4096 characters, with no control characters.");
    args.push(arg);
  }
  for (const [index, arg] of args.entries()) {
    if (arg === "--")
      throw new Error("The -- argument would prevent Foom from attaching its flags.");
    if (arg === "--no-alt-screen" || arg.startsWith("--no-alt-screen="))
      throw new Error("--no-alt-screen is reserved for Foom's terminal display.");
    if (agent === "claude" && /^(?:--settings|--safe-mode)(?:=|$)/u.test(arg))
      throw new Error("Claude --settings and --safe-mode are reserved to preserve Foom's hooks.");
    if (agent !== "codex") continue;
    const config =
      arg === "-c" || arg === "--config"
        ? args[index + 1]
        : arg.startsWith("--config=")
          ? arg.slice(9)
          : arg.startsWith("-c")
            ? arg.slice(2).replace(/^=/u, "")
            : undefined;
    if (config !== undefined) {
      const key = config.split("=")[0]?.replace(/[\s"']/gu, "") ?? "";
      if (/(?:^|\.)(?:notify|hooks)(?:\.|$)/u.test(key))
        throw new Error(
          "Codex notify and hooks configuration is reserved for Foom's attention detection.",
        );
    }
  }
  return Object.freeze(args);
}

export function parseAgentDefaults(value: unknown): Readonly<Record<AgentId, readonly string[]>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("claude" in value) ||
    !("codex" in value) ||
    !("agy" in value)
  )
    throw new Error("Default arguments must name Claude Code, Codex and Antigravity.");
  return Object.freeze({
    claude: parseAgentArguments("claude", value.claude),
    codex: parseAgentArguments("codex", value.codex),
    agy: parseAgentArguments("agy", value.agy),
  });
}
