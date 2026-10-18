import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import github from "../../../src/shared/bundled-forges/github.json";
import { parseForgeManifest, forgeHost } from "../../../src/shared/forge-manifest";
import { parsePluginManifest } from "../../../src/shared/plugin-parser";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import {
  validateForgeCommand,
  validateForgeQuery,
} from "../../../src/shared/forge-command-validation";
import { bundledForge } from "../../../src/main/control/forge-manifests";
import type { ForgeArgument } from "../../../src/shared/forge-plugin";
import { readFileSync } from "node:fs";

function parse(value: unknown) {
  return parseForgeManifest(JSON.stringify(value));
}
const copy = { ...github, id: "custom-github" };
const primary = github.checks.primary;
const checkCommand = primary.commands[0];
if (!checkCommand) throw new Error("Missing check command");
const commandWith = (patch: object) => ({ ...primary, commands: [{ ...checkCommand, ...patch }] });
const checksWith = (primaryValue: unknown) => ({
  ...copy,
  checks: { ...copy.checks, primary: primaryValue },
});
const rootWithResult = (patch: object) =>
  checksWith({ ...primary, result: { ...primary.result, ...patch } });

it("dispatches both kinds without changing agent v1/v2 bytes or semantics", () => {
  const sources = [
    readFileSync("tests/fixtures/agent-plugin.json", "utf8"),
    readFileSync("src/shared/bundled-agents/claude.json", "utf8"),
  ];
  for (const source of sources)
    expect(parsePluginManifest(source, "bundled")).toEqual({
      kind: "agent",
      plugin: parseAgentManifest(source, "bundled"),
    });
  expect(parsePluginManifest(JSON.stringify(copy)).kind).toBe("forge");
  for (const source of [
    "bad",
    "null",
    "[]",
    "{}",
    '{"kind":"alien","version":1}',
    JSON.stringify({ ...copy, version: 2 }),
    JSON.stringify({ kind: "agent", version: 99 }),
  ])
    expect(() => parsePluginManifest(source)).toThrow();
});
it("parses immutable config copies with separate namespaces and no implied enablement", () => {
  const manifest = parse(copy);
  expect(manifest).toMatchObject({
    id: "custom-github",
    minimumIntervalSeconds: 20,
    remote: { hosts: ["github.com"] },
  });
  expect(Object.isFrozen(manifest.operations.lookupByBranch.open.argv)).toBe(true);
  expect(manifest).not.toHaveProperty("enabled");
  expect(parse({ ...copy, minimumIntervalSeconds: undefined }).minimumIntervalSeconds).toBe(20);
  expect(parse({ ...copy, environment: undefined }).environment).toEqual({});
  expect(() => parse(github)).toThrow("reserved-id");
  expect(parse({ ...copy, id: "claude" }).id).toBe("claude");
  const digest = createHash("sha256").update(JSON.stringify(copy)).digest("hex");
  expect(() => bundledForge(copy, "wrong", digest)).toThrow("identity");
  const agent = JSON.parse(
    readFileSync("src/shared/bundled-agents/claude.json", "utf8"),
  ) as unknown;
  expect(() =>
    bundledForge(agent, "claude", createHash("sha256").update(JSON.stringify(agent)).digest("hex")),
  ).toThrow("identity");
});
it("rejects malformed, duplicate/unsafe JSON, oversized/deep data, unknown fields and versions", () => {
  for (const source of [
    '{"kind":"forge","kind":"agent"}',
    '{"__proto__":{}}',
    '{"x":{"constructor":1}}',
    "\ufeff{}",
    '"\ud800"',
    "x".repeat(65537),
    "[".repeat(26) + "]".repeat(26),
  ])
    expect(() => parseForgeManifest(source)).toThrow();
  for (const value of [
    { ...copy, kind: "agent" },
    { ...copy, version: 2 },
    { ...copy, id: "constructor" },
    { ...copy, id: "prototype" },
    { ...copy, trusted: true },
    { ...copy, enabled: true },
    { ...copy, name: "hidden\u202e" },
    { ...copy, badge: "bad" },
    { ...copy, executables: ["../gh"] },
    { ...copy, executables: ["gh.cmd"] },
    { ...copy, executables: ["gh", "gh"] },
    { ...copy, auth: { ...copy.auth, successExitCodes: [1] } },
    { ...copy, auth: { ...copy.auth, failureContains: [] } },
    { ...copy, minimumIntervalSeconds: 19 },
    { ...copy, minimumIntervalSeconds: 86401 },
    { ...copy, minimumIntervalSeconds: null },
    { ...copy, mapping: { ...copy.mapping, sameRepository: true } },
    { ...copy, mapping: { ...copy.mapping, state: ["constructor"] } },
    { ...copy, mapping: { ...copy.mapping, branch: [1000] } },
    { ...copy, mapping: { ...copy.mapping, number: Array<string>(13).fill("a") } },
    { ...copy, mapping: { ...copy.mapping, states: {} } },
    { ...copy, mapping: { ...copy.mapping, states: { OPEN: "unknown" } } },
    { ...copy, checks: { ...copy.checks, meaning: "green" } },
    { ...copy, operations: { ...copy.operations, batchStatus: {} } },
  ])
    expect(() => parse(value)).toThrow();
});
it("validates exact DNS hosts, namespace/case and fixed nonsecret prompt/pager environment", () => {
  for (const host of ["github.com", "git.example.org", "localhost"])
    expect(forgeHost(host)).toBe(true);
  for (const host of [
    "",
    "UPPER.com",
    "*.github.com",
    "github.com.",
    "github..com",
    "-github.com",
    "github-.com",
    "127.0.0.1",
    "[::1]",
    "github.com:443",
    "a".repeat(254),
  ])
    expect(forgeHost(host)).toBe(false);
  for (const value of [
    { ...copy, remote: { ...copy.remote, hosts: ["UPPER.com"] } },
    { ...copy, remote: { ...copy.remote, hosts: ["github.com", "github.com"] } },
    { ...copy, remote: { ...copy.remote, namespace: "regex" } },
    { ...copy, environment: { PATH: "/tmp" } },
    { ...copy, environment: { GH_TOKEN: "secret" } },
    { ...copy, environment: { GH_PAGER: "sh" } },
    { ...copy, environment: { GH_PROMPT_DISABLED: "0" } },
  ])
    expect(() => parse(value)).toThrow();
  expect(
    parse({ ...copy, environment: { GITLAB_PAGER: "", GH_PROMPT_DISABLED: "1" } }).environment,
  ).toEqual({ GITLAB_PAGER: "", GH_PROMPT_DISABLED: "1" });
});
it("rejects writes, auth changes, file expansion, option injection and shell entry points for every origin", () => {
  const commands: ForgeArgument[][] = [
    ["pr", "merge"],
    ["pr", "list", "--jq", "."],
    ["auth", "login"],
    ["config", "set"],
    ["alias", "set"],
    ["extension", "install"],
    ["sh", "-c", "echo"],
    ["api", "graphql", "--input", "@file"],
    ["api", "repos/o/r", "--method", "POST"],
    ["pr", "view", "@file", "--repo", "github.com/o/r", "--json", "number"],
  ];
  for (const argv of commands) {
    expect(() => {
      validateForgeCommand(argv);
    }).toThrow("unsafe-command");
    for (const origin of ["config", "bundled"] as const)
      expect(() =>
        parseForgeManifest(JSON.stringify(checksWith(commandWith({ argv }))), origin),
      ).toThrow();
  }
  expect(() => {
    validateForgeCommand(["auth", "status", "--hostname", "evil"], true);
  }).toThrow();
  validateForgeCommand([
    "api",
    {
      parts: [
        "projects/",
        { slot: "project", encoding: "percent-component" },
        "/merge_requests/",
        { slot: "number", encoding: "literal" },
      ],
    },
    "--hostname",
    { parts: [{ slot: "host", encoding: "literal" }] },
    "--method",
    "GET",
  ]);
});
it("rejects out-of-scope placeholders, incompatible encodings, arbitrary output bindings and unused queries", () => {
  const slot = (name: string, encoding = "literal") => [{ parts: [{ slot: name, encoding }] }];
  for (const argv of [
    slot("branches", "json"),
    slot("number", "percent-component"),
    slot("branch", "json"),
    slot("unknown"),
    [{ parts: [{ parts: ["x"] }] }],
    [{ parts: [] }],
    [],
  ])
    expect(() => parse(checksWith(commandWith({ argv })))).toThrow();
  for (const value of [
    {
      ...copy,
      operations: {
        ...copy.operations,
        refresh: { ...copy.operations.refresh, argv: github.operations.lookupByBranch.open.argv },
      },
    },
    {
      ...copy,
      operations: {
        ...copy.operations,
        refresh: { ...copy.operations.refresh, bindNodeId: ["id"] },
      },
    },
    {
      ...copy,
      operations: {
        ...copy.operations,
        refresh: {
          ...copy.operations.refresh,
          emptyDiagnostics: [{ exitCode: 1, prefix: "a", suffix: "b" }],
        },
      },
    },
    checksWith({ ...primary, query: "query { viewer { login } }" }),
    checksWith({ ...github.checks.fallback, commands: [github.checks.fallback.commands[1]] }),
    checksWith({ ...github.checks.fallback, query: undefined }),
    checksWith({ ...primary, commands: [{ ...checkCommand, bindNodeId: ["id"] }] }),
    checksWith({ ...primary, commands: [{ ...checkCommand, bindNodeId: ["id"] }, checkCommand] }),
  ])
    expect(() => parse(value)).toThrow();
});
it("parses GraphQL grammar including fragments, rejecting non-query operations and extra definitions", () => {
  validateForgeQuery("query Q { viewer { ...Login } } fragment Login on User { login }");
  validateForgeQuery("{ viewer { login } } # mutation is a comment");
  for (const query of [
    "mutation { deleteRepository { clientMutationId } }",
    "subscription { x }",
    "query A { x } query B { y }",
    "type X { x: String } query Q { x }",
    "query {",
    "fragment X on User { login }",
  ])
    expect(() => {
      validateForgeQuery(query);
    }).toThrow("unsafe-query");
});
it("validates result shapes, guards, variant combinations and numeric project evidence", () => {
  for (const patch of [
    { shape: "object", limit: 2 },
    { guards: [{ path: [], absent: false }] },
    { guards: [{ path: [] }] },
    { guards: [{ path: [], absent: true, length: 1 }] },
    { variants: [{ value: [], table: { x: "success" }, status: [] }] },
    { variants: [{ value: [], table: { x: "success" }, completed: "DONE" }] },
    {
      variants: [
        { value: [], table: { x: "success" }, status: [], completed: "DONE", unfinished: ["DONE"] },
      ],
    },
    { variants: [{ value: [], table: [] }] },
    {
      variants: [
        {
          value: [],
          table: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), "success"])),
        },
      ],
    },
  ])
    expect(() => parse(rootWithResult(patch))).toThrow();
  const result = parse(
    rootWithResult({
      guards: [{ path: ["number"], binding: "number" }],
      rowGuards: [{ path: ["items"], length: 1 }],
      variants: [
        {
          value: ["state"],
          table: { passed: "success" },
          when: { path: ["type"], equals: "pipeline" },
        },
      ],
    }),
  );
  expect(result.checks.primary.result.guards[0]?.binding).toBe("number");
  const numeric = parse({
    ...copy,
    mapping: {
      ...copy.mapping,
      projects: {
        mode: "numeric-project-ids",
        source: ["source"],
        target: ["target"],
        context: ["context"],
      },
    },
  });
  expect(numeric.mapping.projects.mode).toBe("numeric-project-ids");
  for (const projects of [
    { mode: "numeric-project-ids", source: [], target: [], context: [], owner: [] },
    { mode: "owner-and-cross-flag", owner: [], crossProject: [], sourceName: [], context: [] },
    { mode: "boolean", source: [], target: [], context: [] },
  ])
    expect(() => parse({ ...copy, mapping: { ...copy.mapping, projects } })).toThrow();
});
