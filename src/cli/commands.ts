import { ControlError, identifier, object } from "../node-common/control-validation";
import type { Command } from "./types";

export function command(args: readonly string[]): Command {
  if (args.length > 16 || args.some((arg) => Buffer.byteLength(arg) > 16384))
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
  return orchestration(name, words);
}

function integer(value: string | undefined, max: number, min = 0): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/u.test(value))
    throw new ControlError("invalid_request");
  const result = Number(value);
  if (result < min || result > max) throw new ControlError("invalid_request");
  return result;
}

function text(value: string | undefined, bytes: number): string {
  if (
    !value ||
    Buffer.byteLength(value) > bytes ||
    /[^\P{Cc}\n\t]|\p{Cf}/u.test(value) ||
    value.trimStart().startsWith("-")
  )
    throw new ControlError("invalid_request");
  return value;
}

function orchestration(name: string | undefined, words: string[]): Command {
  const params: Record<string, unknown> = {};
  const positional = name === "wait-for" ? [] : words.splice(0, 1);
  if (name === "wait-for") {
    while (words[0] !== undefined && !words[0].startsWith("--")) {
      positional.push(words[0]);
      words.shift();
    }
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < words.length; i += 2) {
    const flag = words[i];
    const value = words[i + 1];
    if (!flag || value === undefined || flags.has(flag)) throw new ControlError("invalid_request");
    flags.set(flag, value);
  }
  const take = (flag: string): string | undefined => {
    const value = flags.get(flag);
    flags.delete(flag);
    return value;
  };
  if (["create-worktree", "launch", "stop", "remove-worktree", "reply"].includes(name ?? ""))
    params["idempotencyKey"] = identifier(take("--idempotency-key"));
  switch (name) {
    case "create-worktree": {
      const branch = text(positional[0], 200);
      if (/\s/u.test(branch)) throw new ControlError("invalid_request");
      params["branch"] = branch;
      break;
    }
    case "launch": {
      params["worktreeId"] = identifier(positional[0]);
      const agent = take("--agent");
      if (agent !== "claude" && agent !== "codex" && agent !== "agy")
        throw new ControlError("invalid_request");
      params["agent"] = agent;
      const prompt = take("--prompt");
      if (prompt !== undefined) params["prompt"] = text(prompt, 16384);
      break;
    }
    case "reply": {
      params["id"] = identifier(positional[0]);
      params["revision"] = identifier(take("--revision"));
      params["verdictId"] = identifier(take("--verdict-id"));
      const reply = text(take("--text"), 4096);
      if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(reply) || reply.trimStart().startsWith("/"))
        throw new ControlError("invalid_request");
      params["text"] = reply;
      break;
    }
    case "stop":
    case "remove-worktree":
    case "tail": {
      params[name === "remove-worktree" ? "worktreeId" : "id"] = identifier(positional[0]);
      if (name === "tail" && flags.has("--lines"))
        params["lines"] = integer(take("--lines"), 40, 1);
      break;
    }
    case "wait-for": {
      const ids = positional.map(identifier);
      if (ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length)
        throw new ControlError("invalid_request");
      params["ids"] = ids;
      if (flags.has("--timeout-ms")) params["timeoutMs"] = integer(take("--timeout-ms"), 30000);
      const cursor = take("--after");
      if (cursor !== undefined) {
        let after: Record<string, unknown>;
        try {
          after = object(JSON.parse(cursor));
        } catch {
          throw new ControlError("invalid_request");
        }
        for (const [id, revision] of Object.entries(after)) {
          if (!ids.includes(id)) throw new ControlError("invalid_request");
          identifier(revision);
        }
        params["after"] = after;
      }
      break;
    }
    default:
      throw new ControlError("invalid_request");
  }
  if (flags.size) throw new ControlError("invalid_request");
  return { method: name.replaceAll("-", "_"), params };
}
