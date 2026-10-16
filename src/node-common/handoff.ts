import type { Handoff } from "../shared/handoff";
import { ControlError, exact, identifier, object } from "./control-validation";

export function handoffContent(value: unknown): Pick<Handoff, "status" | "summary" | "links"> {
  const data = object(value);
  const { status, summary } = data;
  const links = data["links"] ?? [];
  if (
    (status !== "done" && status !== "blocked" && status !== "failed") ||
    typeof summary !== "string" ||
    !summary.length ||
    Buffer.byteLength(summary) > 8192 ||
    /[^\P{Cc}\n\t]/u.test(summary) ||
    !Array.isArray(links) ||
    links.length > 10
  )
    throw new ControlError("invalid_request");
  const urls = links.map((link: unknown) => {
    if (typeof link !== "string" || Buffer.byteLength(link) > 2048 || /\p{Cc}/u.test(link))
      throw new ControlError("invalid_request");
    try {
      if (new URL(link).protocol !== "https:") throw new Error();
    } catch {
      throw new ControlError("invalid_request");
    }
    return link;
  });
  return { status, summary, links: urls };
}

export function handoffRequest(value: unknown) {
  const data = object(value);
  exact(data, ["status", "summary", "links", "idempotencyKey"]);
  return { ...handoffContent(data), idempotencyKey: identifier(data["idempotencyKey"]) };
}

export function readHandoffRequest(value: unknown): { id: string; seq?: number } {
  const data = object(value);
  exact(data, ["id", "seq"]);
  const seq = data["seq"];
  if (seq !== undefined && (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1))
    throw new ControlError("invalid_request");
  return { id: identifier(data["id"]), ...(seq === undefined ? {} : { seq }) };
}

export function storedHandoffs(value: unknown): Handoff[] {
  if (!Array.isArray(value) || value.length > 20) throw new ControlError("invalid_request");
  let previous = 0;
  return value.map((entry: unknown) => {
    const data = object(entry);
    exact(data, ["seq", "status", "summary", "links", "timestamp"]);
    const { seq, timestamp } = data;
    if (
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq <= previous ||
      typeof timestamp !== "string" ||
      !Number.isFinite(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp
    )
      throw new ControlError("invalid_request");
    previous = seq;
    return { ...handoffContent(data), seq, timestamp };
  });
}
