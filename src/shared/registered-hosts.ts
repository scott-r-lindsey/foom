import { record, keys, remotePath, remoteReviewEvidence } from "./remote-agent-protocol";
import type {
  RegisteredHost,
  HostManagement,
  HostResult,
  HostsAction,
  HostRequirements,
  HostCheck,
  HostObservation,
  HostCheckTarget,
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
/** Names are literal display data, bounded like interface theme names. */
export function hostNickname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 40 &&
    value === value.trim() &&
    /^[\p{L}\p{N} ._-]+$/u.test(value)
  );
}
export function hostDisplayName(entry: Pick<RegisteredHost, "host" | "nickname">): string {
  const hostname = entry.host.slice(entry.host.lastIndexOf("@") + 1);
  return (
    entry.nickname ??
    (/^\d+(?:\.\d+){3}$/u.test(hostname) ? hostname : (hostname.split(".")[0] ?? hostname))
  );
}
export function hostNicknameError(
  hosts: readonly RegisteredHost[],
  host: string,
  nickname: string,
): string | undefined {
  if (nickname !== "" && !hostNickname(nickname))
    return "Use 1–40 letters, numbers, spaces, dots, hyphens or underscores";
  const name = nickname || hostDisplayName({ host });
  if (
    hosts.some(
      (entry) =>
        entry.host !== host &&
        (nickname !== "" || entry.nickname !== undefined) &&
        hostDisplayName(entry).toLowerCase() === name.toLowerCase(),
    )
  )
    return "Name already used";
  return undefined;
}
export function registeredHosts(value: unknown): value is RegisteredHost[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (entry: unknown) =>
        record(entry) &&
        keys(entry, ["host", "codeFolder", "nickname", "observation"]) &&
        (entry["observation"] === undefined || hostObservation(entry["observation"])) &&
        (entry["nickname"] === undefined || hostNickname(entry["nickname"])) &&
        hostAlias(entry["host"]) &&
        codeFolder(entry["codeFolder"]),
    ) &&
    new Set(value.map((entry: RegisteredHost) => entry.host)).size === value.length &&
    value.every(
      (entry: RegisteredHost) => !hostNicknameError(value, entry.host, entry.nickname ?? ""),
    )
  );
}
/** Persist only closed, bounded observations, never session identities or terminal output. */
export function hostObservation(value: unknown): value is HostObservation {
  if (
    !record(value) ||
    !keys(value, ["checkedAt", "preflight", "foreignSessions", "foreignWorktrees"])
  )
    return false;
  const preflight = value["preflight"];
  const displayResult = (result: unknown) =>
    hostResult(result) &&
    (!result.ok || (result.inventory === undefined && result.worktree === undefined));
  return (
    Number.isSafeInteger(value["checkedAt"]) &&
    Number(value["checkedAt"]) >= 0 &&
    Number(value["checkedAt"]) <= 8640000000000000 &&
    [value["foreignSessions"], value["foreignWorktrees"]].every(
      (count) => count === undefined || (Number.isSafeInteger(count) && Number(count) >= 0),
    ) &&
    record(preflight) &&
    keys(preflight, ["ssh", "platform", "artifact", "result", "repositories"]) &&
    hostCheck(preflight["ssh"]) &&
    hostCheck(preflight["platform"]) &&
    hostCheck(preflight["artifact"]) &&
    displayResult(preflight["result"]) &&
    Array.isArray(preflight["repositories"]) &&
    preflight["repositories"].length <= 1000 &&
    preflight["repositories"].every(
      (repo: unknown) =>
        record(repo) &&
        keys(repo, ["repository", "origin", "checkout"]) &&
        typeof repo["repository"] === "string" &&
        repo["repository"].length <= 4096 &&
        !/\p{Cc}/u.test(repo["repository"]) &&
        hostCheck(repo["origin"]) &&
        displayResult(repo["checkout"]),
    )
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
/** Only validated SSH origins can select this human-owned command. */
export function originSshArgs(origin: unknown): string[] | undefined {
  if (!gitOrigin(origin) || origin.startsWith("https://")) return undefined;
  const flags = [
    "-T",
    "-o",
    "StrictHostKeyChecking=ask",
    "-o",
    "BatchMode=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
  ];
  if (origin.startsWith("ssh://")) {
    try {
      const url = new URL(origin);
      return [
        ...flags,
        ...(url.port ? ["-p", url.port] : []),
        "--",
        `${url.username ? `${url.username}@` : ""}${url.hostname}`,
      ];
    } catch {
      return undefined;
    }
  }
  return [...flags, "--", origin.split(":")[0] ?? ""];
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
/** A closed row selector; executable names and remote paths remain main-owned. */
export function hostCheckTarget(value: unknown): value is HostCheckTarget {
  if (!record(value)) return false;
  if (value["kind"] === "tool" || value["kind"] === "sign-in")
    return keys(value, ["kind", "tool"]) && agentId(value["tool"]);
  if (value["kind"] === "origin" || value["kind"] === "checkout")
    return (
      keys(value, ["kind", "repository"]) &&
      typeof value["repository"] === "string" &&
      value["repository"].length <= 4096 &&
      !/\p{Cc}/u.test(value["repository"])
    );
  return (
    keys(value, ["kind"]) &&
    typeof value["kind"] === "string" &&
    ["ssh", "platform", "artifact", "folder", "command-line-tools", "power"].includes(value["kind"])
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
  if (value["operation"] === "create-folder")
    return keys(value, ["type", "operation", "codeFolder", "agents"]);
  if (value["operation"] === "inspect")
    return (
      keys(value, ["type", "operation", "codeFolder", "agents", "readOnly", "partial", "target"]) &&
      (value["target"] === undefined ||
        (((hostCheckTarget(value["target"]) && !("repository" in value["target"])) ||
          (record(value["target"]) &&
            keys(value["target"], ["kind"]) &&
            value["target"]["kind"] === "facts")) &&
          value["readOnly"] === true &&
          value["partial"] === true)) &&
      (value["readOnly"] === undefined || value["readOnly"] === true) &&
      (value["partial"] === undefined || (value["partial"] === true && value["readOnly"] === true))
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
    (value["operation"] === "repository" ||
      value["operation"] === "clone" ||
      value["operation"] === "origin") &&
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
export function hostCheck(value: unknown): value is HostCheck {
  return (
    record(value) &&
    (((value["state"] === "pass" || value["state"] === "not-checked") && keys(value, ["state"])) ||
      (value["state"] === "fail" &&
        keys(value, ["state", "reason"]) &&
        hostResult({ ok: false, reason: value["reason"] })))
  );
}
export function hostResult(value: unknown): value is HostResult {
  if (!record(value)) return false;
  if (value["connection"] !== undefined) {
    const connection = value["connection"];
    if (
      !record(connection) ||
      !keys(connection, ["ssh", "platform", "artifact"]) ||
      !hostCheck(connection["ssh"]) ||
      !hostCheck(connection["platform"]) ||
      !hostCheck(connection["artifact"])
    )
      return false;
  }
  if (value["ok"] === false)
    return (
      keys(value, ["ok", "reason", "connection"]) &&
      typeof value["reason"] === "string" &&
      [
        "unreachable",
        "version-mismatch",
        "provider-invalid",
        "configuration-changed",
        "invalid-reply",
        "cancelled",
        "unsupported",
        "facts-unavailable",
        "libc-too-old",
        "libc-unsupported",
        "artifact-unavailable",
        "folder-missing",
        "folder-refused",
        "unsafe-folder",
        "origin-unavailable",
        "origin-auth",
        "origin-host-key",
        "origin-unreachable",
        "timed-out",
        "checkout-invalid",
        "clone-failed",
        "checkout-refused",
      ].includes(value["reason"])
    );
  const facts = value["facts"];
  const checkout = value["checkout"];
  return (
    value["ok"] === true &&
    keys(value, ["ok", "facts", "checkout", "worktree", "inventory", "connection"]) &&
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
      "folder",
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
    (facts["folder"] === undefined || hostCheck(facts["folder"])) &&
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
  if (
    value["action"] === "list" ||
    value["action"] === "locations" ||
    value["action"] === "progress"
  )
    return keys(value, ["action"]);
  if (!hostAlias(value["host"])) return false;
  if (value["action"] === "reload")
    return keys(value, ["action", "host", "target"]) && hostCheckTarget(value["target"]);
  if (value["action"] === "rename")
    return (
      keys(value, ["action", "host", "nickname"]) &&
      (value["nickname"] === "" || hostNickname(value["nickname"]))
    );
  if (value["action"] === "recipe")
    return (
      keys(value, ["action", "host", "tool", "operation"]) &&
      agentId(value["tool"]) &&
      (value["operation"] === "install" || value["operation"] === "sign-in")
    );
  if (
    value["action"] === "refresh" ||
    value["action"] === "remove" ||
    value["action"] === "end" ||
    value["action"] === "create-folder"
  )
    return keys(value, ["action", "host"]);
  if (
    value["action"] === "add" ||
    value["action"] === "test" ||
    value["action"] === "preflight" ||
    value["action"] === "change-folder"
  )
    return keys(value, ["action", "host", "codeFolder"]) && codeFolder(value["codeFolder"]);
  return (
    (value["action"] === "clone" || value["action"] === "trust-origin") &&
    keys(value, ["action", "host", "repository"]) &&
    typeof value["repository"] === "string" &&
    value["repository"].length <= 4096
  );
}
