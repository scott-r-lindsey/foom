import { ControlError, identifier } from "../node-common/control-validation";
import type { Command } from "./types";

export function command(args: readonly string[]): Command {
  if (args.length > 16 || args.some((arg) => arg.length > 4096))
    throw new ControlError("invalid_request");
  const [name, ...words] = args;
  if (name === "whoami" && words.length === 0) return { method: "whoami", params: {} };
  if (name === "session-state" && words.length === 1)
    return { method: "session_state", params: { id: identifier(words[0]) } };
  if (
    name === "operation-status" &&
    words.length === 2 &&
    (words[0] === "--operation-id" || words[0] === "--idempotency-key")
  )
    return {
      method: "operation_status",
      params: {
        [words[0] === "--operation-id" ? "operationId" : "idempotencyKey"]: identifier(words[1]),
      },
    };
  if (name === "sessions") {
    const params: Record<string, unknown> = {};
    for (let i = 0; i < words.length; i += 2) {
      const flag = words[i];
      if (flag === "--cursor" && params["cursor"] === undefined)
        params["cursor"] = identifier(words[i + 1]);
      else if (
        flag === "--limit" &&
        params["limit"] === undefined &&
        /^[1-9][0-9]?0?$/u.test(words[i + 1] ?? "")
      ) {
        const limit = Number(words[i + 1]);
        if (limit > 100) throw new ControlError("invalid_request");
        params["limit"] = limit;
      } else throw new ControlError("invalid_request");
    }
    return { method: "sessions", params };
  }
  throw new ControlError("invalid_request");
}
