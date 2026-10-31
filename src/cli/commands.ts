import { hostAlias } from "../shared/registered-hosts";
import { selectionInput } from "../node-common/launch-selection";
import { reviewOptions } from "../shared/review-validation";
import { isChildInput } from "../shared/child-input";
import { readHandoffRequest } from "../shared/handoff-validation";
import { validAgentId } from "../shared/providers/catalog";
import { ControlError, identifier, object } from "../shared/control-validation";
import type { Command } from "./types";

export function command(args: readonly string[]): Command {
  if (args.length > 48 || args.some((arg) => Buffer.byteLength(arg) > 16384))
    throw new ControlError("invalid_request");
  const [name, ...words] = args;
  if (name === "read-handoff") {
    if (words.length !== 1 && !(words.length === 3 && words[1] === "--seq"))
      throw new ControlError("invalid_request");
    return {
      method: "read_handoff",
      params: readHandoffRequest({
        id: words[0],
        ...(words.length === 3 ? { seq: integer(words[2], Number.MAX_SAFE_INTEGER, 1) } : {}),
      }),
    };
  }
  if (name === "previews" && words.length === 0) return { method: "list_previews", params: {} };
  if (name === "open-preview" && words.length === 1) {
    const path = words[0];
    if (!path || Buffer.byteLength(path) > 1024 || /\p{Cc}/u.test(path))
      throw new ControlError("invalid_request");
    return { method: "open_preview", params: { path } };
  }
  if (name === "close-preview" && words.length === 1)
    return { method: "close_preview", params: { previewId: identifier(words[0]) } };
  if (name === "whoami" && words.length === 0) return { method: "whoami", params: {} };
  if (name === "session-state") {
    if (words.length !== 1 && !(words.length === 3 && words[1] === "--host" && hostAlias(words[2])))
      throw new ControlError("invalid_request");
    return {
      method: "session_state",
      params: { id: identifier(words[0]), ...(words.length === 3 ? { host: words[2] } : {}) },
    };
  }
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
      if (flag === "--host" && params["host"] === undefined && hostAlias(words[i + 1]))
        params["host"] = words[i + 1];
      else if (flag === "--cursor" && params["cursor"] === undefined)
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
  const positional =
    name === "review" ||
    name === "wait-for" ||
    (name === "create-worktree" && words[0]?.startsWith("--"))
      ? []
      : words.splice(0, 1);
  if (name === "wait-for") {
    while (words[0] !== undefined && !words[0].startsWith("--")) {
      positional.push(words[0]);
      words.shift();
    }
  }
  if (name === "wait-for" && words.includes("--until-event")) {
    if (words.filter((word) => word === "--until-event").length !== 1)
      throw new ControlError("invalid_request");
    words.splice(words.indexOf("--until-event"), 1);
    params["untilEvent"] = true;
  }
  if (name === "create-worktree" && words.includes("--review")) {
    if (words.filter((word) => word === "--review").length !== 1)
      throw new ControlError("invalid_request");
    words.splice(words.indexOf("--review"), 1);
    params["review"] = true;
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
  if (
    [
      "review",
      "create-worktree",
      "launch",
      "stop",
      "close",
      "remove-worktree",
      "prompt",
      "send-keys",
    ].includes(name ?? "")
  )
    params["idempotencyKey"] = identifier(take("--idempotency-key"));
  if (name === "create-worktree" || name === "launch") {
    const host = take("--host");
    if (host !== undefined) {
      if (!hostAlias(host)) throw new ControlError("invalid_request");
      params["host"] = host;
    }
  }
  switch (name) {
    case "create-worktree": {
      const number = take("--pull-request");
      if (number !== undefined) {
        if (positional.length > 0) throw new ControlError("invalid_request");
        params["pullRequest"] = integer(number, Number.MAX_SAFE_INTEGER, 1);
        break;
      }
      if (params["review"] !== undefined) throw new ControlError("invalid_request");
      const branch = text(positional[0], 200);
      if (/\s/u.test(branch)) throw new ControlError("invalid_request");
      params["branch"] = branch;
      break;
    }
    case "review": {
      params["pullRequest"] = integer(take("--pull-request"), Number.MAX_SAFE_INTEGER, 1);
      const since = take("--since");
      if (since !== undefined) {
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(since))
          throw new ControlError("invalid_request");
        params["since"] = since;
      }
      const focus = take("--focus");
      if (focus !== undefined) params["focus"] = text(focus, 4096);
      const post = take("--post-findings");
      if (post !== undefined) {
        if (post !== "true" && post !== "false") throw new ControlError("invalid_request");
        params["postFindings"] = post === "true";
      }
      break;
    }
    case "launch": {
      const number = take("--pull-request");
      if (number !== undefined) params["pullRequest"] = integer(number, Number.MAX_SAFE_INTEGER, 1);
      params["worktreeId"] = identifier(positional[0]);
      const agent = take("--agent");
      if (!validAgentId(agent)) throw new ControlError("invalid_request");
      params["agent"] = agent;
      const model = take("--model");
      const effort = take("--effort");
      Object.assign(params, selectionInput({ model, effort }));
      const reviewModel = take("--review-model");
      const reviewEffort = take("--review-effort");
      const rounds = take("--review-rounds");
      const reviewer = take("--review-agent");
      const post = take("--review-post-findings");
      const parentWait = take("--review-parent-wait-minutes");
      if (
        reviewModel !== undefined ||
        reviewEffort !== undefined ||
        rounds !== undefined ||
        reviewer !== undefined ||
        post !== undefined ||
        parentWait !== undefined
      ) {
        if (post !== undefined && post !== "true" && post !== "false")
          throw new ControlError("invalid_request");
        params["review"] = reviewOptions({
          ...(reviewModel === undefined ? {} : { model: reviewModel }),
          ...(reviewEffort === undefined ? {} : { effort: reviewEffort }),
          ...(rounds === undefined ? {} : { rounds: integer(rounds, 5, 1) }),
          ...(reviewer === undefined ? {} : { agent: reviewer }),
          ...(post === undefined ? {} : { postFindings: post === "true" }),
          ...(parentWait === undefined ? {} : { parentWaitMinutes: integer(parentWait, 1440, 1) }),
        });
      }
      const prompt = take("--prompt");
      if (prompt !== undefined) params["prompt"] = text(prompt, 16384);
      break;
    }
    case "prompt": {
      params["id"] = identifier(positional[0]);
      const input = { kind: "prompt", text: take("--text") };
      if (!isChildInput(input)) throw new ControlError("invalid_request");
      params["text"] = input.text;
      break;
    }
    case "send-keys": {
      params["id"] = identifier(positional[0]);
      const input = { kind: "keys", keys: take("--keys")?.split(",") };
      if (!isChildInput(input)) throw new ControlError("invalid_request");
      params["keys"] = input.keys;
      break;
    }
    case "close":
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
      if (
        (ids.length < 1 && !params["untilEvent"]) ||
        ids.length > 16 ||
        new Set(ids).size !== ids.length
      )
        throw new ControlError("invalid_request");
      if (ids.length) params["ids"] = ids;
      if (flags.has("--timeout")) {
        if (!params["untilEvent"] || flags.has("--timeout-ms"))
          throw new ControlError("invalid_request");
        params["timeoutMs"] = integer(take("--timeout"), 2147483) * 1000;
      }
      if (flags.has("--timeout-ms"))
        params["timeoutMs"] = integer(
          take("--timeout-ms"),
          params["untilEvent"] ? 2147483647 : 30000,
        );
      const cursor = take("--after");
      if (cursor !== undefined) {
        let after: Record<string, unknown>;
        try {
          after = object(JSON.parse(cursor));
        } catch {
          throw new ControlError("invalid_request");
        }
        for (const [id, revision] of Object.entries(after)) {
          if (ids.length && !ids.includes(id)) throw new ControlError("invalid_request");
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
