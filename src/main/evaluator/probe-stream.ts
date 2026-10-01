import type { InferenceConfig } from "../../shared/inference";
import type { StreamDelta } from "./probe.d";
import { ProbeError } from "./probe-errors";
import { record } from "./probe-response";

const STREAM_LIMIT = 1_048_576;

/** Server-sent events, bounded in total size. */
export async function* events(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  // A stalled stream must end on timeout or cancel even if the body ignores the signal.
  const abort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > STREAM_LIMIT) throw new ProbeError("bad-reply", "The reply is too large");
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("data:")) yield line.slice(5).trim();
    }
    signal.throwIfAborted();
    if (buffer.startsWith("data:")) yield buffer.slice(5).trim();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
}

/** One streamed chunk, reduced to what Foom needs. Unknown shapes are ignored. */
export function streamDelta(kind: InferenceConfig["kind"], data: unknown): StreamDelta {
  if (!record(data)) return {};
  if (kind === "anthropic") {
    const delta = record(data["delta"]) ? data["delta"] : {};
    if (data["type"] === "error") return { error: true };
    if (data["type"] === "content_block_delta") {
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string")
        return { text: delta["text"] };
      if (delta["type"] === "thinking_delta") return { thinking: true };
    }
    if (data["type"] === "message_delta" && typeof delta["stop_reason"] === "string") {
      const reason = delta["stop_reason"];
      return {
        finish: reason === "max_tokens" ? "length" : reason === "refusal" ? "refusal" : "stop",
      };
    }
    return {};
  }
  if (kind === "google") {
    const candidates: unknown[] = Array.isArray(data["candidates"]) ? data["candidates"] : [];
    const candidate = candidates[0];
    if (!record(candidate)) return {};
    const content = record(candidate["content"]) ? candidate["content"] : {};
    const parts: unknown[] = Array.isArray(content["parts"]) ? content["parts"] : [];
    const result: StreamDelta = {};
    for (const part of parts) {
      if (!record(part)) continue;
      if (part["thought"] === true) result.thinking = true;
      else if (typeof part["text"] === "string") result.text = (result.text ?? "") + part["text"];
    }
    const reason = candidate["finishReason"];
    if (typeof reason === "string")
      result.finish = reason === "STOP" ? "stop" : reason === "MAX_TOKENS" ? "length" : "refusal";
    return result;
  }
  const choices: unknown[] = Array.isArray(data["choices"]) ? data["choices"] : [];
  const choice = choices[0];
  if (!record(choice)) return {};
  const delta = record(choice["delta"]) ? choice["delta"] : {};
  const result: StreamDelta = {};
  if (typeof delta["content"] === "string" && delta["content"]) result.text = delta["content"];
  for (const key of ["reasoning", "reasoning_content"])
    if (typeof delta[key] === "string" && delta[key]) result.thinking = true;
  if (delta["refusal"] || delta["tool_calls"]) result.finish = "refusal";
  const reason = choice["finish_reason"];
  if (typeof reason === "string")
    result.finish = reason === "stop" ? "stop" : reason === "length" ? "length" : "refusal";
  return result;
}
