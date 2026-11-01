import { record, keys, remotePath, remoteReviewEvidence } from "./remote-agent-protocol";
import type {
  RegisteredHost,
  HostManagement,
  HostResult,
  HostsAction,
  HostRequirements,
} from "./registered-hosts.d";

export const HOST_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
export const HOST_NETWORK_GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const HOST_MANAGEMENT_TIMEOUT_MS = 7 * 60 * 1000;
export const HOST_PREPARATION_TIMEOUT_MS = 120000;
export const HOST_HANDSHAKE_TIMEOUT_MS = 10000;
export function hostProfile(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}
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
  if (value["operation"] === "list-worktrees")
    return (
      keys(value, ["type", "operation", "codeFolder", "agents", "profile"]) &&
      hostProfile(value["profile"])
    );
  if (value["operation"] === "inspect")
    return (
      keys(value, ["type", "operation", "codeFolder", "agents", "readOnly"]) &&
      (value["readOnly"] === undefined || value["readOnly"] === true)
    );
  if (
    value["operation"] === "create-worktree" ||
    value["operation"] === "inspect-worktree" ||
    value["operation"] === "snapshot-worktree" ||
    value["operation"] === "remove-worktree"
  ) {
    const common = ["type", "operation", "codeFolder", "directory", "origin", "agents", "profile"];
    if (!hostProfile(value["profile"])) return false;
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
function closed(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}
export function hostRequirements(value: unknown): value is HostRequirements {
  return (
    record(value) &&
    keys(value, ["distro", "libc", "packageManager", "mac"]) &&
    closed(value["distro"], ["debian", "rhel", "arch", "darwin", "unknown"]) &&
    closed(value["libc"], ["supported", "too-old", "unsupported"]) &&
    closed(value["packageManager"], ["apt", "dnf", "pacman", "brew", "none"]) &&
    (value["mac"] === undefined ||
      (record(value["mac"]) &&
        keys(value["mac"], ["commandLineTools", "staysAwake", "protectedFolder"]) &&
        typeof value["mac"]["commandLineTools"] === "boolean" &&
        typeof value["mac"]["staysAwake"] === "boolean" &&
        typeof value["mac"]["protectedFolder"] === "boolean"))
  );
}
function hostSignIn(value: unknown): boolean {
  return value === "signed-in" || value === "signed-out" || value === "unknown";
}
export function hostResult(value: unknown): value is HostResult {
  if (!record(value)) return false;
  if (value["ok"] === false)
    return (
      keys(value, ["ok", "reason"]) &&
      typeof value["reason"] === "string" &&
      [
        "unreachable",
        "unsupported",
        "libc-too-old",
        "libc-unsupported",
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
    keys(value, ["ok", "facts", "checkout", "worktree", "inventory"]) &&
    (value["inventory"] === undefined ||
      (record(value["inventory"]) &&
        keys(value["inventory"], ["own", "other"]) &&
        Number.isSafeInteger(value["inventory"]["other"]) &&
        Number(value["inventory"]["other"]) >= 0 &&
        Array.isArray(value["inventory"]["own"]) &&
        value["inventory"]["own"].length <= 128 &&
        value["inventory"]["own"].every(
          (tree: unknown) =>
            record(tree) &&
            keys(tree, ["repository", "path", "branch", "identity", "origin"]) &&
            remotePath(tree["repository"]) &&
            remotePath(tree["path"]) &&
            hostBranch(tree["branch"]) &&
            typeof tree["identity"] === "string" &&
            /^[a-f0-9]{64}$/u.test(tree["identity"]) &&
            gitOrigin(tree["origin"]),
        ))) &&
    (value["worktree"] === undefined ||
      (record(value["worktree"]) &&
        keys(value["worktree"], [
          "path",
          "branch",
          "identity",
          "changes",
          "head",
          "origin",
          "snapshot",
        ]) &&
        remotePath(value["worktree"]["path"]) &&
        (value["worktree"]["snapshot"] === undefined ||
          remoteReviewEvidence(value["worktree"]["snapshot"])) &&
        (value["worktree"]["head"] === undefined ||
          (typeof value["worktree"]["head"] === "string" &&
            /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value["worktree"]["head"]))) &&
        (value["worktree"]["origin"] === undefined || gitOrigin(value["worktree"]["origin"])) &&
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
      "requirements",
      "tools",
    ]) &&
    (facts["requirements"] === undefined || hostRequirements(facts["requirements"])) &&
    (facts["tools"] === undefined ||
      (Array.isArray(facts["tools"]) &&
        facts["tools"].length <= 2 &&
        facts["tools"].every(
          (tool: unknown) =>
            record(tool) &&
            keys(tool, ["id", "state", "signIn"]) &&
            closed(tool["id"], ["git", "gh"]) &&
            closed(tool["state"], ["ready", "missing", "unable"]) &&
            hostSignIn(tool["signIn"]),
        ))) &&
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
        keys(agent, ["id", "state", "signIn"]) &&
        (agent["signIn"] === undefined || hostSignIn(agent["signIn"])) &&
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
  if (value["action"] === "recipe")
    return (
      keys(value, ["action", "host", "tool", "operation"]) &&
      agentId(value["tool"]) &&
      (value["operation"] === "install" || value["operation"] === "sign-in")
    );
  if (value["action"] === "refresh" || value["action"] === "remove" || value["action"] === "end")
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
