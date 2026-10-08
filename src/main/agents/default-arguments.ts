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

const AGENT_NAMES: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
};

/** Read only Codex's invocation overrides; argv itself remains untouched. */
function codexConfig(
  arg: string,
  next: string | undefined,
): { key: string; value: string } | undefined {
  const config =
    arg === "-c" || arg === "--config"
      ? next
      : arg.startsWith("--config=")
        ? arg.slice(9)
        : arg.startsWith("-c")
          ? arg.slice(2).replace(/^=/u, "")
          : undefined;
  if (config === undefined) return undefined;
  const equals = config.indexOf("=");
  return {
    key: (equals < 0 ? config : config.slice(0, equals)).replace(/[\s"']/gu, ""),
    value: equals < 0 ? "" : config.slice(equals + 1).trim(),
  };
}

function codexFullAccess(arg: string, next: string | undefined): boolean {
  if ((arg === "--sandbox" || arg === "-s") && next === "danger-full-access") return true;
  if (
    ["--sandbox=danger-full-access", "-s=danger-full-access", "-sdanger-full-access"].includes(arg)
  )
    return true;
  const config = codexConfig(arg, next);
  return (
    config !== undefined &&
    /(?:^|\.)sandbox_mode$/u.test(config.key) &&
    /^(?:danger-full-access|"danger-full-access"|'danger-full-access')$/u.test(config.value)
  );
}

export function hasBypassArgument(agent: AgentId, args: readonly string[]): boolean {
  return args.some(
    (arg, index) =>
      BYPASS[agent].includes(arg) ||
      (agent === "claude" &&
        arg === "--permission-mode" &&
        args[index + 1] === "bypassPermissions") ||
      (agent === "codex" && codexFullAccess(arg, args[index + 1])),
  );
}

function argumentError(agent: AgentId, index: number, message: string): Error {
  return new Error(`${AGENT_NAMES[agent]}, line ${String(index + 1)}: ${message}`);
}

/** Copy argv without trimming, splitting, quote interpretation, or shell expansion. */
export function parseAgentArguments(agent: AgentId, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error(`${AGENT_NAMES[agent]}: use a list of at most 64 default arguments.`);
  const args: string[] = [];
  for (const [index, arg] of value.entries()) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > 4096 || /\p{Cc}/u.test(arg))
      throw argumentError(
        agent,
        index,
        "Each argument must contain 1–4096 characters, with no control characters.",
      );
    args.push(arg);
  }
  for (const [index, arg] of args.entries()) {
    if (arg === "--")
      throw argumentError(
        agent,
        index,
        "The -- argument would prevent Foom from attaching its flags.",
      );
    if (arg === "--no-alt-screen" || arg.startsWith("--no-alt-screen="))
      throw argumentError(agent, index, "--no-alt-screen is reserved for Foom's terminal display.");
    if (agent === "claude" && /^(?:--settings|--safe-mode|--bare)(?:=|$)/u.test(arg))
      throw argumentError(
        agent,
        index,
        "--settings, --safe-mode and --bare are reserved to preserve Foom's hooks.",
      );
    if (agent === "codex" && /^--dangerously-bypass-hook-trust(?:=|$)/u.test(arg))
      throw argumentError(
        agent,
        index,
        "Hook trust must be granted in Codex, never bypassed by Foom.",
      );
    const conversationOption =
      agent === "claude"
        ? /^(?:--resume|--continue|--session-id|--fork-session)(?:=|$)|^-[rc]/u.test(arg)
        : agent === "codex"
          ? /^(?:--last|--fork)(?:=|$)/u.test(arg) || arg === "resume" || arg === "fork"
          : /^(?:--conversation|--continue)(?:=|$)|^-c/u.test(arg);
    if (conversationOption)
      throw argumentError(
        agent,
        index,
        "Conversation selection is reserved for Foom's session actions.",
      );
    if (agent !== "codex") continue;
    const config = codexConfig(arg, args[index + 1]);
    if (config !== undefined && /(?:^|\.)(?:notify|hooks)(?:\.|$)/u.test(config.key))
      throw argumentError(
        agent,
        index,
        "Codex notify and hooks configuration is reserved for Foom's attention detection.",
      );
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
