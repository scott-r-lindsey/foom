import type { RemoteRequest, RemoteResponse } from "./remote-host";
import { hostRequest, hostResponse } from "./terminal-host-protocol";

export const REMOTE_PROTOCOL = 1;
export const MAX_REMOTE_FRAME = 8 * 1024 * 1024;
// Fragment offsets and totals count UTF-16 units, bounding string storage to 64 MiB.
export const MAX_REMOTE_MESSAGE = 32 * 1024 * 1024;
export const REMOTE_FRAGMENT_SIZE = 65536;
export function remoteId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/u.test(value);
}
export function remoteHost(value: unknown): value is string {
  // SSH aliases, DNS, IPv4 and user@host only. No options, whitespace, shell
  // metacharacters, URI syntax or config fragments; IPv6 can use an SSH alias.
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(value)
  );
}
function hello(value: object): boolean {
  return (
    "type" in value &&
    value.type === "hello" &&
    "build" in value &&
    typeof value.build === "string" &&
    /^[a-f0-9]{64}$/u.test(value.build)
  );
}
export function remoteRequest(value: unknown): value is RemoteRequest {
  if (typeof value !== "object" || value === null) return false;
  if (!("type" in value)) return false;
  if (hello(value)) return true;
  if (!("id" in value) || !remoteId(value.id)) return false;
  if (value.type === "open")
    return hostRequest({
      ...value,
      type: "create",
      spec: {
        command: "/bin/sh",
        args: [],
        cwd: "/",
        cols: "cols" in value ? value.cols : null,
        rows: "rows" in value ? value.rows : null,
      },
    });
  return (
    value.type !== "create" &&
    value.type !== "shutdown" &&
    value.type !== "child-input" &&
    hostRequest(value)
  );
}
export function remoteResponse(value: unknown): value is RemoteResponse {
  if (typeof value !== "object" || value === null) return false;
  if ("type" in value && value.type === "fragment")
    return (
      "id" in value &&
      remoteId(value.id) &&
      "total" in value &&
      typeof value.total === "number" &&
      Number.isSafeInteger(value.total) &&
      value.total > 0 &&
      value.total <= MAX_REMOTE_MESSAGE &&
      "offset" in value &&
      typeof value.offset === "number" &&
      Number.isSafeInteger(value.offset) &&
      value.offset >= 0 &&
      value.offset < value.total &&
      "data" in value &&
      typeof value.data === "string" &&
      value.data.length === Math.min(REMOTE_FRAGMENT_SIZE, value.total - value.offset)
    );
  return (
    hello(value) ||
    (hostResponse(value) &&
      (value.type === "activity"
        ? value.entries.length <= 32 && value.entries.every((entry) => remoteId(entry.id))
        : remoteId(value.id)))
  );
}
export function remoteFrame(message: RemoteRequest | RemoteResponse): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify({ version: REMOTE_PROTOCOL, message }));
  if (body.length > MAX_REMOTE_FRAME) throw new Error("Remote frame too large");
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length);
  bytes.set(body, 4);
  return bytes;
}
/** Bounded incremental reader: rejects oversized headers before allocating a body. */
export class RemoteFrames {
  private header = new Uint8Array(4);
  private used = 0;
  private body: Uint8Array | undefined;
  private bodyUsed = 0;
  push(bytes: Uint8Array, receive: (value: unknown) => void): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.body) {
        const count = Math.min(4 - this.used, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + count), this.used);
        this.used += count;
        offset += count;
        if (this.used < 4) continue;
        const size = new DataView(this.header.buffer).getUint32(0);
        if (size === 0 || size > MAX_REMOTE_FRAME) throw new Error("Invalid remote frame length");
        this.body = new Uint8Array(size);
      }
      const count = Math.min(this.body.length - this.bodyUsed, bytes.length - offset);
      this.body.set(bytes.subarray(offset, offset + count), this.bodyUsed);
      offset += count;
      this.bodyUsed += count;
      if (this.bodyUsed !== this.body.length) continue;
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(this.body),
      );
      this.body = undefined;
      this.used = this.bodyUsed = 0;
      if (
        typeof value !== "object" ||
        value === null ||
        !("version" in value) ||
        value.version !== REMOTE_PROTOCOL ||
        !("message" in value)
      )
        throw new Error("Invalid remote envelope");
      receive(value.message);
    }
  }
  end(): void {
    if (this.used || this.body) throw new Error("Truncated remote frame");
  }
}

/** Keep each frame small even when ANSI-rich retained screens exceed the frame cap. */
export function* remoteResponseFrames(
  message: Exclude<RemoteResponse, { type: "fragment" }>,
): Generator<Uint8Array, void, unknown> {
  const data = JSON.stringify(message);
  if (data.length > MAX_REMOTE_MESSAGE) throw new Error("Remote message too large");
  if (
    data.length <= REMOTE_FRAGMENT_SIZE ||
    message.type === "hello" ||
    message.type === "activity"
  ) {
    yield remoteFrame(message);
    return;
  }
  for (let offset = 0; offset < data.length; offset += REMOTE_FRAGMENT_SIZE)
    yield remoteFrame({
      type: "fragment",
      id: message.id,
      offset,
      total: data.length,
      data: data.slice(offset, offset + REMOTE_FRAGMENT_SIZE),
    });
}
/** One bounded, contiguous response per connection; partial responses never reach a view. */
export class RemoteMessages {
  private partial: { id: string; total: number; used: number; parts: string[] } | undefined;
  push(message: RemoteResponse): Exclude<RemoteResponse, { type: "fragment" }> | undefined {
    if (message.type !== "fragment") {
      if (this.partial) throw new Error("Interrupted remote message");
      return message;
    }
    if (!remoteResponse(message)) throw new Error("Invalid remote fragment");
    const partial = this.partial ?? { id: message.id, total: message.total, used: 0, parts: [] };
    if (
      message.id !== partial.id ||
      message.total !== partial.total ||
      message.offset !== partial.used
    )
      throw new Error("Noncontiguous remote message");
    partial.parts.push(message.data);
    partial.used += message.data.length;
    this.partial = partial;
    if (partial.used < partial.total) return;
    const value: unknown = JSON.parse(partial.parts.join(""));
    this.partial = undefined;
    if (!hostResponse(value) || value.type === "activity" || value.id !== partial.id)
      throw new Error("Invalid reassembled response");
    return value;
  }
}
