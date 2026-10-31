import { expect, it } from "vitest";
import claude from "../../fixtures/agent-plugins-v2/claude.json";
import codex from "../../fixtures/agent-plugins-v2/codex.json";
import agy from "../../fixtures/agent-plugins-v2/agy.json";
import copilot from "../../fixtures/agent-plugins-v2/copilot.json";
import * as schema from "../../../src/shared/agent-manifest-schema";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
const limits: readonly [unknown, (value: unknown, path: string) => unknown, string, number][] = [
  [claude, schema.v2, "executables", 8],
  [claude.discovery, schema.discovery, "facts", 16],
  [copilot.discovery.version, schema.version, "suffixes", 4],
  [claude.discovery.facts[0], schema.fact, "helpTokens", 8],
  [claude.launch.prompt, schema.prompt, "arguments", 64],
  [claude.launch.toolPermissions, schema.tools, "names", 20],
  [claude.launch.toolPermissions.merge, schema.merge, "flags", 8],
  [claude, schema.v2, "files", 16],
  [claude.hooks, schema.hooks, "channels", 8],
  [codex.hooks.channels[0]?.observer, schema.observer, "commandArguments", 8],
  [claude.hooks.channels[0]?.mapping, schema.mapping, "cases", 32],
  [claude.hooks.channels[0]?.mapping.cases[4], schema.eventCase, "require", 16],
  [agy.hooks.channels[0]?.mapping.cases[2], schema.eventCase, "facts", 8],
  [agy.hooks.channels[0]?.mapping.cases[2]?.require?.[0], schema.requirement, "values", 16],
  [claude, schema.v2, "reservedArguments", 64],
  [claude, schema.v2, "bypassArguments", 64],
  [copilot, schema.v2, "bypassEnvironment", 16],
  [claude, schema.v2, "resumePaste", 8],
  [claude.attention, schema.attention, "rules", 64],
  [claude.attention.rules[0], schema.rule, "not", 8],
  [claude.attention.rules[0]?.match, schema.detectionMatcher, "contains", 8],
  [claude.attention.rules[0]?.match, schema.detectionMatcher, "regex", 8],
  [codex.execution, schema.execution, "completionChannels", 8],
  [codex.execution, schema.execution, "providerRules", 16],
  [codex.health, schema.health, "requiredEvents", 16],
  [codex.health.review, schema.review, "contains", 8],
  [agy.setup.status, schema.status, "metadata", 4],
  [agy.setup.status, schema.status, "cases", 16],
  [agy.setup.status.ownership, schema.ownership, "require", 16],
  [agy.setup, schema.setup, "actions", 8],
];
it.each(limits.map(([original, parse, key, max], index) => ({ original, parse, key, max, index })))(
  "$index bounds schema array $key",
  ({ original, parse, key, max }) => {
    if (typeof original !== "object" || original === null) throw Error("Missing fixture");
    const list: unknown = Reflect.get(original, key);
    const first: unknown = Array.isArray(list) ? list[0] : undefined;
    const example =
      first ?? (key === "not" ? { contains: ["x"] } : key === "commandArguments" ? "event" : "x");
    const draft = {
      ...original,
      [key]: Array.from({ length: max }, () => structuredClone(example)),
    };
    expect(() => parse(draft, "$")).not.toThrow();
    expect(() =>
      parse(
        { ...draft, [key]: Array.from({ length: max + 1 }, () => structuredClone(example)) },
        "$",
      ),
    ).toThrow();
  },
);
it("bounds numeric, string, selector and matcher specializations", () => {
  for (const [field, min, max] of [
    ["priority", 0, 2000],
    ["lines", 1, 40],
  ] as const) {
    const rule = claude.attention.rules[0];
    expect(() => schema.rule({ ...rule, [field]: min }, "$")).not.toThrow();
    expect(() => schema.rule({ ...rule, [field]: max }, "$")).not.toThrow();
    for (const value of [min - 1, max + 1, 0.5])
      expect(() => schema.rule({ ...rule, [field]: value }, "$")).toThrow();
  }
  for (const value of [1, 100000, { posix: 1, win32: 100000 }])
    expect(() =>
      schema.observer({ ...claude.hooks.channels[0]?.observer, version: value }, "$"),
    ).not.toThrow();
  for (const value of [0, 100001, { posix: 1, win32: 0 }, { posix: 1, win32: 1, other: 1 }])
    expect(() =>
      schema.observer({ ...claude.hooks.channels[0]?.observer, version: value }, "$"),
    ).toThrow();
  for (const value of [1000, 3000])
    expect(() =>
      schema.observer({ ...claude.hooks.channels[0]?.observer, timeoutMs: value }, "$"),
    ).not.toThrow();
  for (const value of [999, 3001])
    expect(() =>
      schema.observer({ ...claude.hooks.channels[0]?.observer, timeoutMs: value }, "$"),
    ).toThrow();
  expect(() =>
    schema.selector(
      { source: "payload", path: ["x".repeat(64), 63, 0, "a", "b", "c", "d", "e"] },
      "$",
    ),
  ).not.toThrow();
  for (const path of [[], [64], [-1], [0.5], ["x".repeat(65)], Array(9).fill("x")])
    expect(() => schema.selector({ source: "payload", path }, "$")).toThrow();
  expect(() =>
    schema.version({ prefix: "", suffixes: [""], minimum: [0, Number.MAX_SAFE_INTEGER, 0] }, "$"),
  ).not.toThrow();
  for (const minimum of [
    [0, 0],
    [0, 0, 0, 0],
    [-1, 0, 0],
    [0, 1.5, 0],
  ])
    expect(() => schema.version({ prefix: "", suffixes: [""], minimum }, "$")).toThrow();
  expect(() =>
    schema.environment(
      { name: "ALLOW", match: "values", values: Array(16).fill("x".repeat(128)) },
      "$",
    ),
  ).not.toThrow();
  expect(() =>
    schema.environment({ name: "ALLOW", match: "values", values: Array(17).fill("x") }, "$"),
  ).toThrow();
  const flag = { flag: "-a", forms: ["exact", "equals", "separate", "attached-short"] };
  expect(() => schema.argumentMatcher(flag, "$")).not.toThrow();
  expect(() => schema.argumentMatcher({ ...flag, forms: [...flag.forms, "exact"] }, "$")).toThrow();
  expect(() =>
    schema.argumentMatcher(
      { override: { flags: Array(8).fill("-c"), keys: Array(8).fill("a") } },
      "$",
    ),
  ).not.toThrow();
  for (const key of ["flags", "keys"])
    expect(() =>
      schema.argumentMatcher(
        {
          override: {
            flags: ["-c"],
            keys: ["a"],
            [key]: Array(9).fill(key === "flags" ? "-c" : "a"),
          },
        },
        "$",
      ),
    ).toThrow();
  const extractor = {
    name: "fullyIdle",
    field: { source: "payload", path: ["idle"] },
    aliases: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`alias${String(i)}`, false])),
  };
  expect(() => schema.extractor(extractor, "$")).not.toThrow();
  expect(() =>
    schema.extractor({ ...extractor, aliases: { ...extractor.aliases, extra: false } }, "$"),
  ).toThrow();
  expect(() => schema.extractor({ ...extractor, aliases: [] }, "$")).toThrow();
});
it("bounds original bytes, per-template and aggregate bytes through the public parser", () => {
  const minimal = {
    ...claude,
    id: "custom",
    launch: { order: claude.launch.order },
    hooks: undefined,
    files: [],
    execution: { completion: "observed", completionChannels: [] },
    attention: { minimumEngineVersion: 1, rules: [] },
  };
  const source = JSON.stringify(minimal);
  expect(() =>
    parseAgentManifest(source + " ".repeat(65536 - Buffer.byteLength(source))),
  ).not.toThrow();
  expect(() => parseAgentManifest(source + " ".repeat(65537 - Buffer.byteLength(source)))).toThrow(
    "too-large",
  );
  const file = (name: string, bytes: number) => ({
    name,
    scope: "launch",
    format: "json",
    content: '{"matcher":"' + "x".repeat(bytes - 14) + '"}',
  });
  expect(() =>
    parseAgentManifest(JSON.stringify({ ...minimal, files: [file("a", 16384), file("b", 16384)] })),
  ).not.toThrow();
  expect(() =>
    parseAgentManifest(JSON.stringify({ ...minimal, files: [file("a", 16385)] })),
  ).toThrow();
  expect(() =>
    parseAgentManifest(
      JSON.stringify({ ...minimal, files: [file("a", 16384), file("b", 16384), file("c", 14)] }),
    ),
  ).toThrow("too-large");
});

it("requires explicit required list fields and defaults only optional lists", () => {
  const required: readonly [unknown, (value: unknown, path: string) => unknown, string][] = [
    [claude, schema.v2, "reservedArguments"],
    [claude, schema.v2, "bypassArguments"],
    [claude, schema.v2, "bypassEnvironment"],
    [claude, schema.v2, "resumePaste"],
    [claude.discovery, schema.discovery, "facts"],
    [claude.launch.prompt, schema.prompt, "arguments"],
    [claude.launch.arguments, schema.block, "arguments"],
    [claude.launch.toolPermissions, schema.tools, "names"],
    [claude.launch.toolPermissions, schema.tools, "arguments"],
    [claude.hooks.channels[0], schema.channel, "arguments"],
    [claude.attention, schema.attention, "rules"],
    [claude.execution, schema.execution, "completionChannels"],
    [codex.health, schema.health, "requiredEvents"],
    [agy.setup.status.ownership, schema.ownership, "require"],
    [agy.setup.status, schema.status, "cases"],
    [agy.setup, schema.setup, "actions"],
  ];
  for (const [original, parse, key] of required) {
    if (typeof original !== "object" || original === null) throw Error("Missing fixture");
    const draft = { ...original };
    Reflect.deleteProperty(draft, key);
    expect(() => parse(draft, "$")).toThrow("missing-key");
  }
  const parsed = schema.v2({ ...claude, files: undefined }, "$");
  expect(parsed.files).toEqual([]);
  expect(schema.fact({ id: "helpOnly" }, "$").helpTokens).toEqual([]);
});
