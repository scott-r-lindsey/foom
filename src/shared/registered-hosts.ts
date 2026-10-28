import { record, keys, remotePath } from "./remote-agent-protocol";
import type { RegisteredHost, HostManagement, HostResult, HostsAction } from "./registered-hosts.d";

export const HOST_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
export function hostAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    !/\p{Cc}/u.test(value) &&
    /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(value)
  );
}
export function codeFolder(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    (value.startsWith("~/") ? remotePath(value.slice(1)) : remotePath(value)) &&
    !/[\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !value.endsWith("/") &&
    !value.includes("//")
  );
}
export function registeredHosts(value: unknown): value is RegisteredHost[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (entry: unknown) =>
        record(entry) &&
        keys(entry, ["host", "codeFolder"]) &&
        hostAlias(entry["host"]) &&
        codeFolder(entry["codeFolder"]) &&
        remotePath(entry["codeFolder"]),
    ) &&
    new Set(value.map((entry: RegisteredHost) => entry.host)).size === value.length
  );
}
export function gitOrigin(value: unknown): value is string {
  // No local paths, command protocols, URL credentials or control/shell syntax.
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    !/\p{Cc}/u.test(value) &&
    (/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?\/[a-zA-Z0-9_./~-]+$/u.test(value) ||
      (!value.includes("://") &&
        /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[a-zA-Z0-9_./~-]+$/u.test(
          value,
        )) ||
      /^ssh:\/\/(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?\/[a-zA-Z0-9_./~-]+$/u.test(
        value,
      ))
  );
}
export function hostBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\p{Cc}\p{Cf}\s]/u.test(value) &&
    !value.startsWith("-") &&
    !value.includes("@{")
  );
}
function agentId(value: unknown): value is string {
  return (
    typeof value === "string" && !/\p{Cc}/u.test(value) && /^[a-z][a-z0-9-]{0,63}$/u.test(value)
  );
}
export function hostManagement(value: unknown): value is HostManagement {
  if (!record(value) || value["type"] !== "manage" || !codeFolder(value["codeFolder"]))
    return false;
  if (
    value["agents"] !== undefined &&
    (!Array.isArray(value["agents"]) ||
      value["agents"].length > 100 ||
      !value["agents"].every(
        (agent: unknown) =>
          record(agent) &&
          keys(agent, ["id", "executables"]) &&
          agentId(agent["id"]) &&
          Array.isArray(agent["executables"]) &&
          agent["executables"].length >= 1 &&
          agent["executables"].length <= 8 &&
          agent["executables"].every(
            (name: unknown) =>
              typeof name === "string" &&
              !/\p{Cc}/u.test(name) &&
              /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(name),
          ),
      ))
  )
    return false;
  if (value["operation"] === "inspect")
    return keys(value, ["type", "operation", "codeFolder", "agents"]);
  if (
    value["operation"] === "create-worktree" ||
    value["operation"] === "inspect-worktree" ||
    value["operation"] === "remove-worktree"
  ) {
    const common = ["type", "operation", "codeFolder", "directory", "origin", "agents"];
    if (
      !hostManagement({
        type: "manage",
        operation: "repository",
        codeFolder: value["codeFolder"],
        directory: value["directory"],
        origin: value["origin"],
      })
    )
      return false;
    if (value["operation"] === "create-worktree")
      return (
        keys(value, [...common, "branch", "fromOrigin"]) &&
        hostBranch(value["branch"]) &&
        (value["fromOrigin"] === undefined || typeof value["fromOrigin"] === "boolean")
      );
    return (
      keys(value, [...common, "path", "identity", "changes"]) &&
      remotePath(value["path"]) &&
      typeof value["identity"] === "string" &&
      /^[a-f0-9]{64}$/u.test(value["identity"]) &&
      (value["changes"] === undefined ||
        (typeof value["changes"] === "string" && value["changes"].length <= 65536))
    );
  }
  return (
    (value["operation"] === "repository" || value["operation"] === "clone") &&
    keys(value, ["type", "operation", "codeFolder", "directory", "origin", "agents"]) &&
    typeof value["directory"] === "string" &&
    !/\p{Cc}/u.test(value["directory"]) &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(value["directory"]) &&
    gitOrigin(value["origin"])
  );
}
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export function hostResult(value: unknown): value is HostResult {
  if (!record(value)) return false;
  if (value["ok"] === false)
    return (
      keys(value, ["ok", "reason"]) &&
      typeof value["reason"] === "string" &&
      [
        "unreachable",
        "unsupported",
        "artifact-unavailable",
        "folder-refused",
        "unsafe-folder",
        "origin-unavailable",
        "clone-failed",
        "checkout-refused",
      ].includes(value["reason"])
    );
  const facts = value["facts"];
  const checkout = value["checkout"];
  return (
    value["ok"] === true &&
    keys(value, ["ok", "facts", "checkout", "worktree"]) &&
    (value["worktree"] === undefined ||
      (record(value["worktree"]) &&
        keys(value["worktree"], ["path", "branch", "identity", "changes"]) &&
        remotePath(value["worktree"]["path"]) &&
        hostBranch(value["worktree"]["branch"]) &&
        typeof value["worktree"]["identity"] === "string" &&
        /^[a-f0-9]{64}$/u.test(value["worktree"]["identity"]) &&
        typeof value["worktree"]["changes"] === "string" &&
        value["worktree"]["changes"].length <= 65536)) &&
    record(facts) &&
    keys(facts, [
      "codeFolder",
      "version",
      "sessions",
      "cores",
      "load",
      "memoryTotal",
      "memoryAvailable",
      "agents",
    ]) &&
    codeFolder(facts["codeFolder"]) &&
    remotePath(facts["codeFolder"]) &&
    typeof facts["version"] === "string" &&
    facts["version"].length <= 128 &&
    !/\p{Cc}/u.test(facts["version"]) &&
    /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(facts["version"]) &&
    number(facts["sessions"]) &&
    Number.isSafeInteger(facts["sessions"]) &&
    number(facts["cores"]) &&
    Number.isSafeInteger(facts["cores"]) &&
    Array.isArray(facts["load"]) &&
    facts["load"].length === 3 &&
    facts["load"].every(number) &&
    number(facts["memoryTotal"]) &&
    Number.isSafeInteger(facts["memoryTotal"]) &&
    number(facts["memoryAvailable"]) &&
    Number.isSafeInteger(facts["memoryAvailable"]) &&
    Number(facts["memoryAvailable"]) <= Number(facts["memoryTotal"]) &&
    Array.isArray(facts["agents"]) &&
    facts["agents"].length <= 100 &&
    facts["agents"].every(
      (agent: unknown) =>
        record(agent) &&
        keys(agent, ["id", "state"]) &&
        agentId(agent["id"]) &&
        typeof agent["state"] === "string" &&
        ["ready", "missing", "unable"].includes(agent["state"]),
    ) &&
    (checkout === undefined ||
      (record(checkout) &&
        keys(checkout, ["path", "state"]) &&
        remotePath(checkout["path"]) &&
        typeof checkout["state"] === "string" &&
        ["clean", "changed", "absent"].includes(checkout["state"])))
  );
}
export function hostsAction(value: unknown): value is HostsAction {
  if (!record(value)) return false;
  if (value["action"] === "list" || value["action"] === "locations") return keys(value, ["action"]);
  if (!hostAlias(value["host"])) return false;
  if (value["action"] === "refresh" || value["action"] === "remove")
    return keys(value, ["action", "host"]);
  if (value["action"] === "add" || value["action"] === "test")
    return keys(value, ["action", "host", "codeFolder"]) && codeFolder(value["codeFolder"]);
  return (
    value["action"] === "clone" &&
    keys(value, ["action", "host", "repository"]) &&
    typeof value["repository"] === "string" &&
    value["repository"].length <= 4096
  );
}
