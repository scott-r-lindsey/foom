import type { RemoteRequest, RemoteResponse } from "./remote-host";
import { hostRequest, hostResponse } from "./terminal-host-protocol";

export const REMOTE_PROTOCOL = 1;
export const MAX_REMOTE_FRAME = 8 * 1024 * 1024;
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
