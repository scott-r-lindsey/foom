import { record, keys, remotePath } from "./remote-agent-protocol";
import type { RegisteredHost, HostManagement, HostResult, HostsAction } from "./registered-hosts.d";
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
          typeof agent["id"] === "string" &&
          /^[a-z][a-z0-9-]{0,63}$/u.test(agent["id"]) &&
          Array.isArray(agent["executables"]) &&
          agent["executables"].length >= 1 &&
          agent["executables"].length <= 8 &&
          agent["executables"].every(
            (name: unknown) =>
              typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(name),
          ),
      ))
  )
    return false;
  if (value["operation"] === "inspect")
    return keys(value, ["type", "operation", "codeFolder", "agents"]);
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
      [
        "unreachable",
        "unsupported",
        "artifact-unavailable",
        "folder-refused",
        "unsafe-folder",
        "origin-unavailable",
        "clone-failed",
        "checkout-refused",
      ].includes(String(value["reason"]))
    );
  const facts = value["facts"];
  const checkout = value["checkout"];
  return (
    value["ok"] === true &&
    keys(value, ["ok", "facts", "checkout"]) &&
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
    number(facts["memoryAvailable"]) &&
    Number(facts["memoryAvailable"]) <= Number(facts["memoryTotal"]) &&
    Array.isArray(facts["agents"]) &&
    facts["agents"].length <= 100 &&
    facts["agents"].every(
      (agent: unknown) =>
        record(agent) &&
        keys(agent, ["id", "state"]) &&
        typeof agent["id"] === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/u.test(agent["id"]) &&
        ["ready", "missing", "unable"].includes(String(agent["state"])),
    ) &&
    (checkout === undefined ||
      (record(checkout) &&
        keys(checkout, ["path", "state"]) &&
        remotePath(checkout["path"]) &&
        ["clean", "changed", "absent"].includes(String(checkout["state"]))))
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
