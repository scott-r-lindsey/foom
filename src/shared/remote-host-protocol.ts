import { recipeLaunch } from "./registered-host-recipes";
import { imagePut, imagePutResult, imageNonce } from "./image-paste";
import { hostAlias, hostManagement, hostResult } from "./registered-hosts";
import { isLaunchReason } from "./launch-failure";
import {
  remotePath,
  remoteAgentSpec,
  remoteAgentReady,
  remoteHook,
  remoteControlResult,
  record,
  keys,
} from "./remote-agent-protocol";
import type { RemoteRequest, RemoteResponse } from "./remote-host";
import { hostRequest, hostResponse } from "./terminal-host-protocol";

export const REMOTE_PROTOCOL = 3;
export const REMOTE_GONE_EXIT_CODE = -1;
export const MAX_REMOTE_FRAME = 8 * 1024 * 1024;
// Fragment offsets and totals count UTF-16 units, bounding string storage to 64 MiB.
export const MAX_REMOTE_MESSAGE = 32 * 1024 * 1024;
export const REMOTE_FRAGMENT_SIZE = 65536;
export function remoteId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/u.test(value);
}
export function remoteHost(value: unknown): value is string {
  return hostAlias(value);
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
function foreignSession(value: unknown): value is { id: string; generation: string } {
  return (
    record(value) &&
    keys(value, ["id", "generation", "count"]) &&
    (value["count"] === undefined ||
      (typeof value["count"] === "number" &&
        Number.isInteger(value["count"]) &&
        value["count"] > 0 &&
        value["count"] <= 32)) &&
    remoteId(value["id"]) &&
    profileTag(value["generation"])
  );
}
export function profileTag(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}
export function sessionContext(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ["repository", "worktree", "branch", "agent"]) &&
    remotePath(value["repository"]) &&
    remotePath(value["worktree"]) &&
    (value["branch"] === null ||
      (typeof value["branch"] === "string" &&
        value["branch"].length <= 200 &&
        !/\p{Cc}/u.test(value["branch"]))) &&
    typeof value["agent"] === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(value["agent"])
  );
}
export function remoteRequest(value: unknown): value is RemoteRequest {
  if (!record(value)) return false;
  if (typeof value["type"] !== "string") return false;
  if (hello(value)) return true;
  if (value["type"] === "inventory")
    return (
      keys(value, ["type", "profile", "codeFolder"]) &&
      (value["codeFolder"] === undefined || remotePath(value["codeFolder"])) &&
      profileTag(value["profile"])
    );
  if (value["type"] === "end-sessions")
    return (
      keys(value, ["type", "profile", "ids"]) &&
      profileTag(value["profile"]) &&
      Array.isArray(value["ids"]) &&
      value["ids"].length <= 33 &&
      value["ids"].every(foreignSession) &&
      new Set(value["ids"].map((entry: { id: string }) => entry.id)).size === value["ids"].length
    );
  if (
    (value["profile"] !== undefined && !profileTag(value["profile"])) ||
    (value["context"] !== undefined && !sessionContext(value["context"]))
  )
    return false;
  if (value["type"] === "image-put") return imagePut(value);
  if (value["type"] === "manage") return hostManagement(value);
  if (!remoteId(value["id"])) return false;
  if (value["type"] === "session-close")
    return (
      keys(value, ["type", "id", "request", "profile"]) &&
      profileTag(value["profile"]) &&
      hostRequest({ ...value, type: "kill" })
    );
  if (value["type"] === "agent-close")
    return keys(value, ["type", "id", "request"]) && hostRequest({ ...value, type: "kill" });
  if (value["type"] === "agent-activate" || value["type"] === "agent-start")
    return keys(value, ["type", "id"]);
  if (value["type"] === "agent-reply")
    return (
      record(value) &&
      keys(value, ["type", "id", "call", "result"]) &&
      typeof value["call"] === "number" &&
      Number.isSafeInteger(value["call"]) &&
      value["call"] > 0 &&
      remoteControlResult(value["result"])
    );
  if (value["type"] === "agent-open")
    return (
      record(value) &&
      keys(value, ["type", "id", "request", "cols", "rows", "spec", "profile", "context"]) &&
      remoteAgentSpec(value["spec"]) &&
      remoteRequest({ ...value, type: "open", reattach: false })
    );
  if (value["type"] === "open")
    return (
      (value["recipe"] === undefined ||
        (recipeLaunch(value["recipe"]) &&
          value["checkout"] === undefined &&
          value["context"] === undefined)) &&
      (value["checkout"] === undefined ||
        (record(value["checkout"]) &&
          keys(value["checkout"], ["repository", "path", "identity"]) &&
          remotePath(value["checkout"]["repository"]) &&
          remotePath(value["checkout"]["path"]) &&
          typeof value["checkout"]["identity"] === "string" &&
          /^[a-f0-9]{64}$/u.test(value["checkout"]["identity"]))) &&
      (value["human"] === undefined || typeof value["human"] === "boolean") &&
      "reattach" in value &&
      typeof value["reattach"] === "boolean" &&
      hostRequest({
        ...value,
        type: "create",
        spec: {
          command: "/bin/sh",
          args: [],
          cwd: "/",
          cols: "cols" in value ? value["cols"] : null,
          rows: "rows" in value ? value["rows"] : null,
        },
      })
    );
  return value["type"] !== "create" && value["type"] !== "shutdown" && hostRequest(value);
}
export function remoteResponse(value: unknown): value is RemoteResponse {
  if (typeof value !== "object" || value === null) return false;
  if (record(value) && value["type"] === "inventory-result")
    return (
      keys(value, ["type", "own", "foreign"]) &&
      Array.isArray(value["own"]) &&
      Array.isArray(value["foreign"]) &&
      value["own"].length + value["foreign"].length <= 33 &&
      value["own"].every(
        (entry: unknown) =>
          record(entry) &&
          keys(entry, ["id", "context", "checkout"]) &&
          remoteId(entry["id"]) &&
          (entry["context"] === undefined || sessionContext(entry["context"])) &&
          (entry["checkout"] === undefined ||
            (record(entry["checkout"]) &&
              keys(entry["checkout"], ["repository", "path", "identity"]) &&
              remotePath(entry["checkout"]["repository"]) &&
              remotePath(entry["checkout"]["path"]) &&
              typeof entry["checkout"]["identity"] === "string" &&
              /^[a-f0-9]{64}$/u.test(entry["checkout"]["identity"]))),
      ) &&
      value["foreign"].every(foreignSession) &&
      new Set([
        ...value["own"].map((entry: { id: string }) => entry.id),
        ...value["foreign"].map((entry: { id: string }) => entry.id),
      ]).size ===
        value["own"].length + value["foreign"].length
    );
  if (record(value) && value["type"] === "upgrade") return hello({ ...value, type: "hello" });
  if (
    record(value) &&
    value["type"] === "hello" &&
    value["compatible"] !== undefined &&
    value["compatible"] !== 2
  )
    return false;
  if (record(value) && value["type"] === "image-result") return imagePutResult(value);
  if (record(value) && value["type"] === "managed")
    return keys(value, ["type", "result"]) && hostResult(value["result"]);
  if (record(value) && remoteId(value["id"])) {
    if (value["type"] === "agent-failed")
      return keys(value, ["type", "id", "reason"]) && isLaunchReason(value["reason"]);
    if (value["type"] === "agent-prepared") return keys(value, ["type", "id"]);
    if (value["type"] === "agent-ready")
      return (
        keys(value, ["type", "id", "ready", "imageOwner"]) &&
        (value["imageOwner"] === undefined || imageNonce(value["imageOwner"])) &&
        remoteAgentReady(value["ready"])
      );
    if (value["type"] === "agent-hook")
      return (
        keys(value, ["type", "id", "signal"]) &&
        remoteHook(value["signal"]) &&
        value["signal"].terminalId === value["id"]
      );
    if (value["type"] === "agent-call")
      return (
        keys(value, ["type", "id", "call", "method", "params"]) &&
        typeof value["call"] === "number" &&
        Number.isSafeInteger(value["call"]) &&
        value["call"] > 0 &&
        typeof value["method"] === "string" &&
        value["method"].length <= 64 &&
        record(value["params"]) &&
        new TextEncoder().encode(JSON.stringify(value["params"])).length <= 65536
      );
  }
  if ("type" in value && value.type === "open-result")
    return (
      "id" in value &&
      remoteId(value.id) &&
      "request" in value &&
      hostResponse({ type: "error", id: value.id, request: value.request }) &&
      "state" in value &&
      (((value.state === "live" || value.state === "gone") && !("code" in value)) ||
        (value.state === "exited" &&
          "code" in value &&
          hostResponse({ type: "exit", id: value.id, code: value.code })))
    );
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
    message.type === "upgrade" ||
    message.type === "inventory-result" ||
    message.type === "activity" ||
    message.type === "managed"
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
    if (
      !remoteResponse(value) ||
      value.type === "hello" ||
      value.type === "upgrade" ||
      value.type === "inventory-result" ||
      value.type === "fragment" ||
      value.type === "managed" ||
      value.type === "activity" ||
      value.id !== partial.id
    )
      throw new Error("Invalid reassembled response");
    return value;
  }
}
