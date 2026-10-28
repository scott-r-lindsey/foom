import { ControlError, object as controlObject, exact as controlExact } from "./control-validation";
import { handoffRequest } from "./handoff-validation";
import type { RemoteAgentReady, RemoteAgentSpec, RemoteControlResult } from "./remote-agent";
import type { HookSignal } from "./hooks";
import { conversationId } from "./conversation";

export const REMOTE_PHASE_2_REASON =
  "Remote phase 2 permits only handoff, manual and sanitized identity; filesystem preview and fleet/repository tools require #756.";
export const REMOTE_AGENT_BYTES = 65536;
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !/[^\P{Cc}\n\t]/u.test(value);
}
export function remotePath(value: unknown): value is string {
  return (
    text(value, 4096) &&
    value.startsWith("/") &&
    !/\p{Cc}/u.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}
export function remoteAgentSpec(value: unknown): value is RemoteAgentSpec {
  return (
    record(value) &&
    keys(value, [
      "agent",
      "repository",
      "worktree",
      "defaults",
      "prompt",
      "conversationId",
      "hooks",
    ]) &&
    typeof value["agent"] === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(value["agent"]) &&
    remotePath(value["repository"]) &&
    remotePath(value["worktree"]) &&
    Array.isArray(value["defaults"]) &&
    value["defaults"].length <= 256 &&
    value["defaults"].every((arg: unknown) => text(arg, 20480)) &&
    (value["prompt"] === undefined ||
      (text(value["prompt"], 16384) &&
        value["prompt"].length > 0 &&
        !value["prompt"].trimStart().startsWith("-"))) &&
    (value["conversationId"] === undefined || conversationId(value["conversationId"])) &&
    typeof value["hooks"] === "boolean" &&
    new TextEncoder().encode(JSON.stringify(value)).length <= REMOTE_AGENT_BYTES
  );
}
export function remoteAgentReady(value: unknown): value is RemoteAgentReady {
  return (
    record(value) &&
    keys(value, ["hooks", "mcp", "conversationId", "channels"]) &&
    typeof value["hooks"] === "boolean" &&
    typeof value["mcp"] === "boolean" &&
    (value["channels"] === undefined ||
      (Array.isArray(value["channels"]) &&
        value["channels"].length <= 16 &&
        value["channels"].every(
          (id: unknown) => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(id),
        ))) &&
    (value["conversationId"] === undefined || conversationId(value["conversationId"]))
  );
}
export function remoteHook(value: unknown): value is HookSignal {
  return (
    record(value) &&
    keys(value, [
      "terminalId",
      "action",
      "signal",
      "conversationId",
      "channel",
      "caseId",
      "endsTurn",
      "recoverTurn",
      "terminationReason",
      "fullyIdle",
    ]) &&
    typeof value["terminalId"] === "string" &&
    /^[A-Za-z0-9_-]{1,200}$/u.test(value["terminalId"]) &&
    ["classify", "needs_input", "working", "ready", "failed"].includes(String(value["action"])) &&
    typeof value["signal"] === "string" &&
    /^plugin:[a-z][a-z0-9-]{0,63}:[A-Za-z0-9_-]{1,64}$/u.test(value["signal"]) &&
    conversationId(value["conversationId"]) &&
    typeof value["channel"] === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(value["channel"]) &&
    typeof value["caseId"] === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(value["caseId"]) &&
    ["endsTurn", "recoverTurn", "fullyIdle"].every(
      (key) => value[key] === undefined || typeof value[key] === "boolean",
    ) &&
    (value["terminationReason"] === undefined ||
      (typeof value["terminationReason"] === "string" &&
        ["model_stop", "max_steps_exceeded", "error"].includes(value["terminationReason"])))
  );
}
function manual(value: unknown): boolean {
  if (!record(value)) return false;
  if ("sections" in value)
    return (
      keys(value, ["sections"]) &&
      Array.isArray(value["sections"]) &&
      value["sections"].length <= 100 &&
      value["sections"].every(
        (entry: unknown) =>
          record(entry) &&
          keys(entry, ["id", "title", "summary"]) &&
          text(entry["id"], 200) &&
          text(entry["title"], 200) &&
          text(entry["summary"], 160),
      )
    );
  return (
    keys(value, ["id", "title", "text", "page", "nextPage"]) &&
    text(value["id"], 200) &&
    text(value["title"], 200) &&
    text(value["text"], 4096) &&
    typeof value["page"] === "number" &&
    Number.isSafeInteger(value["page"]) &&
    value["page"] >= 0 &&
    (value["nextPage"] === undefined ||
      (typeof value["nextPage"] === "number" &&
        Number.isSafeInteger(value["nextPage"]) &&
        value["nextPage"] > value["page"]))
  );
}
export function remoteControlResult(value: unknown): value is RemoteControlResult {
  if (!record(value) || new TextEncoder().encode(JSON.stringify(value)).length > REMOTE_AGENT_BYTES)
    return false;
  switch (value["type"]) {
    case "identity":
      return (
        keys(value, ["type", "alias", "role", "capabilities"]) &&
        typeof value["alias"] === "string" &&
        /^[a-f0-9-]{36}$/u.test(value["alias"]) &&
        value["role"] === "child" &&
        Array.isArray(value["capabilities"]) &&
        value["capabilities"].length === 3 &&
        value["capabilities"].every(
          (method: unknown) =>
            typeof method === "string" && ["whoami", "manual", "handoff"].includes(method),
        ) &&
        new Set(value["capabilities"]).size === 3
      );
    case "handoff":
      return (
        keys(value, ["type", "seq", "status", "timestamp"]) &&
        typeof value["seq"] === "number" &&
        Number.isSafeInteger(value["seq"]) &&
        value["seq"] > 0 &&
        ["done", "blocked", "failed"].includes(String(value["status"])) &&
        typeof value["timestamp"] === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value["timestamp"])
      );
    case "manual":
      return keys(value, ["type", "value"]) && manual(value["value"]);
    case "error":
      return (
        keys(value, ["type", "error"]) &&
        [
          "phase_2_restricted",
          "invalid_request",
          "unavailable",
          "no_parent",
          "unauthorized",
        ].includes(String(value["error"]))
      );
    default:
      return false;
  }
}
/** Result projections are finite and contain no transport/session metadata. */
export function remotePublicResult(result: RemoteControlResult): unknown {
  if (result.type === "manual") return result.value;
  if (result.type === "identity")
    return { alias: result.alias, role: result.role, capabilities: result.capabilities };
  if (result.type === "handoff")
    return { seq: result.seq, status: result.status, timestamp: result.timestamp };
  return {
    error: result.error,
    ...(result.error === "phase_2_restricted" ? { reason: REMOTE_PHASE_2_REASON } : {}),
  };
}

/** Validate and normalize allowed tool payloads on the host before SSH relay. */
export function remoteControlParams(method: string, input: unknown): Record<string, unknown> {
  const params = controlObject(input);
  if (method === "handoff") return handoffRequest(params);
  if (method === "whoami" || method === "mcp_connected") controlExact(params, []);
  if (method === "manual") {
    controlExact(params, ["section", "page"]);
    const section = params["section"];
    const page = params["page"];
    if (
      (section !== undefined &&
        (typeof section !== "string" || section.length < 1 || section.length > 200)) ||
      (page !== undefined &&
        (section === undefined ||
          typeof page !== "number" ||
          !Number.isSafeInteger(page) ||
          page < 0))
    )
      throw new ControlError("invalid_request");
  }
  return params;
}
