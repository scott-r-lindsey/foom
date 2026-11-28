import { ControlError, exact, identifier } from "./control-validation";
import { isChildInput } from "./child-input";
import { boardText } from "./message-board-validation";
import { validAgentId } from "./providers/catalog";
import { hostAlias } from "./registered-hosts";
import type { DispatcherLaunch } from "./dispatcher";

/** The registry performs the exact, platform-specific path match in main. */
export function dispatcherRepositoryPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(value) ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.replace(/\p{Join_Control}/gu, ""))
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
    repo: dispatcherRepositoryPath(input["repo"]),
    agent,
    prompt: prompt.text,
    idempotencyKey: identifier(input["idempotencyKey"]),
    ...(host === undefined ? {} : { host }),
    ...(input["reason"] === undefined ? {} : { reason: boardText(input["reason"], 2000) }),
  };
}
