import { ControlError, exact, identifier } from "./control-validation";
import { isChildInput } from "./child-input";
import { boardText } from "./message-board-validation";
import { validAgentId } from "./providers/catalog";
import { hostAlias } from "./registered-hosts";
import type { DispatcherLaunch } from "./dispatcher";

/** The dispatcher accepts one portable directory name, without aliases or separators. */
export function sourceRepositoryName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 255 ||
    value.startsWith(".") ||
    /[ .]$/u.test(value) ||
    /[\\/:\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  )
    throw new ControlError("invalid_request");
  return value;
}

export function dispatcherLaunch(input: Record<string, unknown>): DispatcherLaunch {
  exact(input, ["repo", "agent", "host", "prompt", "reason", "idempotencyKey"]);
  const agent = input["agent"];
  const host = input["host"];
  const prompt = { kind: "prompt", text: input["prompt"] };
  if (
    !validAgentId(agent) ||
    agent === "shell" ||
    (host !== undefined && !hostAlias(host)) ||
    !isChildInput(prompt)
  )
    throw new ControlError("invalid_request");
  return {
    repo: sourceRepositoryName(input["repo"]),
    agent,
    prompt: prompt.text,
    idempotencyKey: identifier(input["idempotencyKey"]),
    ...(host === undefined ? {} : { host }),
    ...(input["reason"] === undefined ? {} : { reason: boardText(input["reason"], 2000) }),
  };
}
