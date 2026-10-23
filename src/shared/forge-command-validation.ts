import { Kind, OperationTypeNode, parse } from "graphql/language";
import type { ForgeArgument, ForgeSlot } from "./forge-plugin";
import { fail } from "./agent-manifest-values";

/** A closed command grammar, applied equally to bundled and config data. */
export function validateForgeCommand(argv: readonly ForgeArgument[], auth = false): void {
  // Literal text cannot impersonate a typed slot or hide extra tokens in the grammar.
  for (const arg of argv) {
    const parts = typeof arg === "string" ? [arg] : arg.parts;
    for (const part of parts) {
      if (typeof part === "string" && /[{}\s]/u.test(part)) fail("$.argv", "unsafe-command");
      if (typeof part !== "string") {
        const endpointProject =
          argv[0] === "api" && typeof argv[1] !== "string" && part.slot === "project";
        if (part.encoding !== (endpointProject ? "percent-component" : "literal"))
          fail("$.argv", "invalid-encoding");
      }
    }
  }
  const signature = argv.map((arg) =>
    typeof arg === "string"
      ? arg
      : arg.parts.map((part) => (typeof part === "string" ? part : `{${part.slot}}`)).join(""),
  );
  const first = signature[0];
  const second = signature[1];
  if (auth) {
    if (signature.join(" ") !== "auth status --hostname {host}") fail("$.auth", "unsafe-command");
    return;
  }
  // Every value position is explicit. No aliases, shell, file loading, arbitrary flags or writes.
  if (first === "pr") {
    const values = signature.slice(2);
    const fields = values.at(-1);
    const jsonFields = typeof fields === "string" && /^[A-Za-z][A-Za-z0-9,]*$/u.test(fields);
    const prefix = values.slice(0, -1).join(" ");
    const allowed =
      second === "list"
        ? [
            "--repo {host}/{project} --head {branch} --state open --limit 2 --json",
            "--repo {host}/{project} --head {branch} --state all --limit 2 --json",
          ].includes(prefix)
        : second === "view"
          ? prefix === "{number} --repo {host}/{project} --json"
          : second === "checks" &&
            prefix === "{number} --repo {host}/{project} --required --json" &&
            fields === "bucket";
    if (!jsonFields || !allowed) fail("$.argv", "unsafe-command");
    return;
  }
  if (signature.join(" ") === "api graphql --hostname {host} -f query={query} -f id={nodeId}")
    return;
  if (
    signature.join(" ") ===
    "api graphql --hostname {host} -f query={query} -f owner={projectOwner} -f name={projectName}"
  )
    return;
  if (signature.join(" ") === "api graphql --hostname {host} -f query={query} -f project={project}")
    return;
  // GET endpoints are fixed or assembled from a validated percent-encoded project/number.
  if (
    first === "api" &&
    signature[2] === "--hostname" &&
    signature[3] === "{host}" &&
    signature[4] === "--method" &&
    signature[5] === "GET" &&
    (signature.length === 6 ||
      (second === "projects/{project}/merge_requests" &&
        [
          "--raw-field scope=all --raw-field state=opened --raw-field source_branch={branch} --raw-field per_page=2 --raw-field page=1",
          "--raw-field scope=all --raw-field state=all --raw-field source_branch={branch} --raw-field per_page=2 --raw-field page=1",
        ].includes(signature.slice(6).join(" ")))) &&
    /^projects\/\{project\}\/merge_requests(?:\/\{number\})?$/u.test(second ?? "")
  )
    return;
  fail("$.argv", "unsafe-command");
}

export function validateForgeQuery(query: string): void {
  try {
    const document = parse(query, { maxTokens: 4096 });
    const operations = document.definitions.filter(
      (node) => node.kind === Kind.OPERATION_DEFINITION,
    );
    if (
      operations.length !== 1 ||
      operations[0]?.operation !== OperationTypeNode.QUERY ||
      document.definitions.some(
        (node) => node.kind !== Kind.OPERATION_DEFINITION && node.kind !== Kind.FRAGMENT_DEFINITION,
      )
    )
      fail("$.query", "unsafe-query");
  } catch {
    fail("$.query", "unsafe-query");
  }
}

export function commandSlots(argv: readonly ForgeArgument[]): ForgeSlot[] {
  return argv.flatMap((arg) =>
    typeof arg === "string"
      ? []
      : arg.parts.flatMap((part) => (typeof part === "string" ? [] : [part.slot])),
  );
}
