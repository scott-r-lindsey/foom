import { ControlError, identifier } from "../shared/control-validation";
import { boardPost, boardResolve, threadState } from "../shared/message-board-validation";
import { boundedText } from "./handoff";
import type { Command, ConsoleIo } from "./types";

export async function boardCommand(
  args: readonly string[],
  input: ConsoleIo["input"],
): Promise<Command> {
  const [name, ...words] = args;
  const params: Record<string, unknown> = {};
  if (name === "read" || name === "resolve") params["thread"] = identifier(words.shift());
  const flags = new Map<string, string>();
  const links: string[] = [];
  const to: string[] = [];
  let fresh = false;
  for (let i = 0; i < words.length; i += 2) {
    const flag = words[i];
    if (flag === "--new") {
      if (fresh) throw new ControlError("invalid_request");
      fresh = true;
      i--;
      continue;
    }
    const value = words[i + 1];
    if (!flag || value === undefined || !flag.startsWith("--"))
      throw new ControlError("invalid_request");
    if (flag === "--link") links.push(value);
    else if (flag === "--to") to.push(identifier(value));
    else {
      if (flags.has(flag)) throw new ControlError("invalid_request");
      flags.set(flag, value);
    }
  }
  const take = (key: string) => {
    const value = flags.get(key);
    flags.delete(key);
    return value;
  };
  const key = take("--idempotency-key");
  const path = take("--text-file");
  if (name === "threads") {
    const category = take("--category");
    if (category !== undefined) {
      if (category !== "topics" && category !== "children")
        throw new ControlError("invalid_request");
      params["category"] = category;
    }
    const state = take("--state");
    if (state !== undefined) params["state"] = threadState(state);
    const after = take("--after");
    if (after !== undefined) params["after"] = identifier(after);
  } else if (name === "read") {
    const after = take("--after");
    if (after !== undefined) params["after"] = identifier(after);
  } else if (name === "resolve")
    Object.assign(params, boardResolve({ ...params, idempotencyKey: key }));
  else if (name === "post") {
    if (!path || path.includes("\0")) throw new ControlError("invalid_request");
    const thread = take("--thread");
    const title = take("--title");
    const kind = take("--kind");
    if (fresh === (thread !== undefined)) throw new ControlError("invalid_request");
    const shape = {
      ...(thread === undefined ? {} : { thread }),
      ...(to.length ? { to } : {}),
      ...(title === undefined ? {} : { title }),
      kind,
      text: "validate",
      links,
      idempotencyKey: key,
    };
    boardPost(shape);
    if (flags.size) throw new ControlError("invalid_request");
    return {
      method: "board_post",
      params: { ...boardPost({ ...shape, text: await boundedText(path, input) }) },
    };
  } else throw new ControlError("invalid_request");
  if (
    flags.size ||
    links.length ||
    to.length ||
    fresh ||
    path !== undefined ||
    (key !== undefined && name !== "resolve")
  )
    throw new ControlError("invalid_request");
  return { method: `board_${name}`, params };
}
