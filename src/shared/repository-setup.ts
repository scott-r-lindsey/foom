import type {
  RepositorySetupList,
  RepositorySetupAction,
  SetupCheck,
  SetupSources,
  SetupAdmission,
  SetupRun,
  SetupRefusal,
  SetupDraft,
  SetupUnresolved,
  SetupDistro,
  SetupPackage,
  SetupRequirement,
  SetupToolchain,
} from "./repository-setup.d";

export const setupDistros: readonly SetupDistro[] = ["debian", "rhel", "arch", "darwin"];
const controls = /[\p{Cc}\u202a-\u202e\u2066-\u2069\ufffd\ud800-\udfff]/u;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}
export function setupSourcePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    !controls.test(value) &&
    !/[\\:]/u.test(value) &&
    value
      .split("/")
      .every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git")
  );
}
function paths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(setupSourcePath) &&
    new Set(value).size === value.length
  );
}
export function setupPackageName(value: unknown, distro: SetupDistro = "debian"): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  // Literal names only: no package-spec selectors, option prefixes or apt suffix actions.
  const grammar =
    distro === "debian"
      ? /^[a-z0-9](?:[a-z0-9+-]*[a-z0-9])?$/u
      : distro === "rhel"
        ? /^[a-z0-9](?:[a-z0-9+_.-]*[a-z0-9])?$/u
        : distro === "arch"
          ? /^[a-z0-9](?:[a-z0-9+_.-]*[a-z0-9])?$/u
          : /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?(?:@[0-9]+(?:\.[0-9]+)*)?$/u;
  return grammar.test(value);
}
export function setupVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:[1-9][0-9]{0,2}\.x|(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2}))$/u.test(
      value,
    )
  );
}
function requirement(
  value: unknown,
  packageName: (value: unknown, distro: SetupDistro) => value is string = setupPackageName,
): SetupPackage | SetupToolchain {
  if (
    !object(value) ||
    typeof value["id"] !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(value["id"]) ||
    typeof value["purpose"] !== "string" ||
    !value["purpose"].trim() ||
    value["purpose"].length > 500 ||
    controls.test(value["purpose"]) ||
    !paths(value["sources"])
  )
    throw new Error("Invalid setup requirement");
  const base: SetupRequirement = {
    id: value["id"],
    purpose: value["purpose"],
    sources: [...value["sources"]].sort(),
  };
  if (
    value["kind"] === "toolchain" &&
    keys(value, ["kind", "id", "purpose", "sources", "tool", "version"]) &&
    (value["tool"] === "node" || value["tool"] === "pnpm") &&
    setupVersion(value["version"])
  )
    return { ...base, kind: "toolchain", tool: value["tool"], version: value["version"] };
  const mappings = value["packages"];
  if (
    value["kind"] !== "package" ||
    !keys(value, ["kind", "id", "purpose", "sources", "packages"]) ||
    !object(mappings) ||
    !keys(mappings, setupDistros)
  )
    throw new Error("Invalid setup mapping");
  const read = (distro: SetupDistro): readonly string[] | "unsupported" => {
    const names = mappings[distro];
    if (names === "unsupported") return names;
    if (
      !Array.isArray(names) ||
      names.length > 128 ||
      !names.every((name: unknown) => packageName(name, distro)) ||
      new Set(names).size !== names.length
    )
      throw new Error("Invalid setup package");
    return [...names].sort();
  };
  return {
    ...base,
    kind: "package",
    packages: {
      debian: read("debian"),
      rhel: read("rhel"),
      arch: read("arch"),
      darwin: read("darwin"),
    },
  };
}
/** Canonical copies exclude unknown fields and executable authority. */
function setupJson(text: string): unknown {
  if (
    new TextEncoder().encode(text).length > 65536 ||
    text.includes("\0") ||
    /[\ud800-\udfff]/u.test(text)
  )
    throw new Error("Invalid setup input");
  const value: unknown = JSON.parse(text);
  const objects: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{") objects.push(new Set());
    else if (char === "[") objects.push(null);
    else if (char === "}" || char === "]") objects.pop();
    else if (char === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") end += 2;
        else if (text[end] === '"') break;
        else end++;
      }
      const decoded: unknown = JSON.parse(text.slice(index, end + 1));
      if (typeof decoded !== "string" || controls.test(decoded))
        throw new Error("Invalid setup text");
      if (
        text
          .slice(end + 1)
          .trimStart()
          .startsWith(":")
      ) {
        const keys = objects.at(-1);
        if (!keys || keys.has(decoded)) throw new Error("Duplicate setup field");
        keys.add(decoded);
      }
      index = end;
    }
  }
  return value;
}
function parseList(
  text: string,
  packageName: (value: unknown, distro: SetupDistro) => value is string,
): RepositorySetupList {
  const value = setupJson(text);
  if (
    !object(value) ||
    !keys(value, ["requirements", "evidence"]) ||
    !Array.isArray(value["requirements"]) ||
    value["requirements"].length > 128 ||
    !paths(value["evidence"])
  )
    throw new Error("Invalid setup list");
  const requirements = value["requirements"]
    .map((value: unknown) => requirement(value, packageName))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (
    new Set(requirements.map((item) => item.id)).size !== requirements.length ||
    new Set(requirements.filter((item) => item.kind === "toolchain").map((item) => item.tool))
      .size !== requirements.filter((item) => item.kind === "toolchain").length ||
    new Set([...value["evidence"], ...requirements.flatMap((item) => item.sources)]).size > 64
  )
    throw new Error("Duplicate or excessive setup requirements");
  for (const distro of setupDistros) {
    const names = requirements.flatMap((item) =>
      item.kind === "package" && item.packages[distro] !== "unsupported"
        ? item.packages[distro]
        : [],
    );
    if (new Set(names).size !== names.length) throw new Error("Duplicate setup package");
  }
  return { requirements, evidence: [...value["evidence"]].sort() };
}

export function setupAction(value: unknown): value is RepositorySetupAction {
  if (!object(value)) return false;
  const repository =
    typeof value["repository"] === "string" &&
    value["repository"].length > 0 &&
    value["repository"].length <= 4096 &&
    !controls.test(value["repository"]);
  switch (value["action"]) {
    case "list":
    case "copy-brief":
      return keys(value, ["action"]);
    case "cancel-review":
      return keys(value, ["action", "keepDraft"]) && typeof value["keepDraft"] === "boolean";
    case "review":
      return (
        repository &&
        (keys(value, ["action", "repository"]) ||
          (keys(value, ["action", "repository", "draft"]) &&
            typeof value["draft"] === "string" &&
            new TextEncoder().encode(value["draft"]).length <= 65536))
      );
    case "approve":
    case "run":
      return (
        keys(value, ["action", "token"]) &&
        typeof value["token"] === "string" &&
        /^[a-f0-9]{32}$/u.test(value["token"])
      );
    case "remove":
      return repository && keys(value, ["action", "repository"]);
    case "check":
      return (
        repository &&
        keys(value, ["action", "repository", "host"]) &&
        (value["host"] === null ||
          (typeof value["host"] === "string" && /^[A-Za-z0-9_.@-]{1,253}$/u.test(value["host"])))
      );
    default:
      return false;
  }
}
export function setupCheck(value: unknown): value is SetupCheck {
  if (
    !object(value) ||
    !keys(value, ["platform", "items"]) ||
    !object(value["platform"]) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > 128
  )
    return false;
  const platform = value["platform"];
  return (
    keys(platform, ["distro", "os", "arch", "nodeAbi"]) &&
    typeof platform["nodeAbi"] === "boolean" &&
    ["debian", "rhel", "arch", "darwin", "unsupported"].includes(String(platform["distro"])) &&
    ["linux", "darwin", "win32"].includes(String(platform["os"])) &&
    ["x64", "arm64", "unsupported"].includes(String(platform["arch"])) &&
    value["items"].every(
      (item: unknown) =>
        object(item) &&
        keys(item, ["id", "state"]) &&
        typeof item["id"] === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/u.test(item["id"]) &&
        ["met", "missing", "unable", "manual"].includes(String(item["state"])),
    )
  );
}
export function setupSources(value: unknown): value is SetupSources {
  return (
    object(value) &&
    keys(value, ["fingerprint", "files"]) &&
    typeof value["fingerprint"] === "string" &&
    /^[a-f0-9]{64}$/u.test(value["fingerprint"]) &&
    Array.isArray(value["files"]) &&
    value["files"].length <= 64 &&
    value["files"].every(
      (file: unknown) =>
        object(file) &&
        keys(file, ["path", "digest"]) &&
        setupSourcePath(file["path"]) &&
        typeof file["digest"] === "string" &&
        /^[a-f0-9]{64}$/u.test(file["digest"]),
    )
  );
}
export function validSetupList(value: unknown): value is RepositorySetupList {
  try {
    parseSetupList(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function setupAbsolutePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 4096 &&
    !controls.test(path) &&
    /^(?:\/|[A-Za-z]:[/\\])/u.test(path) &&
    !path.split(/[/\\]/u).some((part) => part === "." || part === "..")
  );
}
export function setupAdmission(value: unknown): value is SetupAdmission {
  return (
    object(value) &&
    keys(value, ["list", "catalog", "revision", "sources", "codeRoot"]) &&
    setupAbsolutePath(value["codeRoot"]) &&
    validSetupList(value["list"]) &&
    typeof value["catalog"] === "string" &&
    /^[a-f0-9]{64}$/u.test(value["catalog"]) &&
    typeof value["sources"] === "string" &&
    /^[a-f0-9]{64}$/u.test(value["sources"]) &&
    typeof value["revision"] === "number" &&
    Number.isSafeInteger(value["revision"]) &&
    value["revision"] > 0
  );
}
export function setupRun(value: unknown): value is SetupRun {
  return (
    object(value) &&
    keys(value, [
      "list",
      "catalog",
      "revision",
      "sources",
      "repository",
      "registration",
      "host",
      "check",
      "digest",
      "location",
    ]) &&
    object(value["location"]) &&
    keys(value["location"], ["root", "path", "present"]) &&
    [value["location"]["root"], value["location"]["path"]].every(setupAbsolutePath) &&
    typeof value["location"]["present"] === "boolean" &&
    setupAdmission({
      list: value["list"],
      catalog: value["catalog"],
      revision: value["revision"],
      sources: value["sources"],
      codeRoot: value["location"]["root"],
    }) &&
    typeof value["repository"] === "string" &&
    value["repository"].length <= 4096 &&
    typeof value["registration"] === "string" &&
    value["registration"].length <= 4096 &&
    typeof value["host"] === "string" &&
    value["host"].length <= 253 &&
    typeof value["digest"] === "string" &&
    /^[a-f0-9]{64}$/u.test(value["digest"]) &&
    setupCheck(value["check"])
  );
}
export function setupRefusal(value: unknown): value is SetupRefusal {
  return (
    object(value) &&
    keys(value, ["repository", "host", "missing"]) &&
    typeof value["repository"] === "string" &&
    value["repository"].length > 0 &&
    value["repository"].length <= 4096 &&
    !controls.test(value["repository"]) &&
    (value["host"] === null ||
      (typeof value["host"] === "string" && /^[A-Za-z0-9_.@-]{1,253}$/u.test(value["host"]))) &&
    Array.isArray(value["missing"]) &&
    value["missing"].length <= 128 &&
    value["missing"].every(
      (item: unknown) =>
        object(item) &&
        (keys(item, ["id"]) || keys(item, ["id", "version"])) &&
        typeof item["id"] === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/u.test(item["id"]) &&
        (item["version"] === undefined || setupVersion(item["version"])),
    )
  );
}

/** Current executable schema, including all operand restrictions. */
export const parseSetupList = (text: string): RepositorySetupList =>
  parseList(text, setupPackageName);
/** Read-only catalog-v1 compatibility. Never use for new approvals or execution. */
export const parseSetupListV1 = (text: string): RepositorySetupList =>
  parseList(
    text,
    (name: unknown): name is string =>
      typeof name === "string" && /^[a-z0-9][a-z0-9+_.-]{0,79}$/u.test(name),
  );

/** Unsupported tool names remain explicit unresolved data and cannot be approved. */
export function parseSetupDraft(text: string): SetupDraft {
  const value = setupJson(text);
  if (
    !object(value) ||
    !keys(value, ["requirements", "evidence"]) ||
    !Array.isArray(value["requirements"]) ||
    value["requirements"].length > 128 ||
    !paths(value["evidence"])
  )
    throw new Error("Invalid setup draft");
  const unresolved: SetupUnresolved[] = [];
  const known: unknown[] = [];
  const ids: string[] = [];
  for (const item of value["requirements"]) {
    const candidate: unknown = item;
    if (
      object(candidate) &&
      candidate["kind"] === "toolchain" &&
      candidate["tool"] !== "node" &&
      candidate["tool"] !== "pnpm"
    ) {
      const tool = candidate["tool"];
      if (typeof tool !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(tool))
        throw new Error("Invalid unresolved tool");
      const checked = requirement({ ...candidate, tool: "node" });
      if (checked.kind !== "toolchain") throw new Error("Invalid unresolved requirement");
      unresolved.push({ ...checked, tool });
      ids.push(checked.id);
    } else {
      const checked = requirement(candidate);
      known.push(checked);
      ids.push(checked.id);
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate setup requirement");
  const list = parseSetupList(JSON.stringify({ requirements: known, evidence: value["evidence"] }));
  if (
    new Set([
      ...list.evidence,
      ...list.requirements.flatMap((item) => item.sources),
      ...unresolved.flatMap((item) => item.sources),
    ]).size > 64
  )
    throw new Error("Excessive setup sources");
  return { list, unresolved };
}
