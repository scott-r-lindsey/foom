import { expect, it } from "vitest";
import fixture from "../../fixtures/agent-plugin-v2.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";

const parse = (environment: unknown, files: unknown = fixture.files) =>
  parseAgentManifest(
    JSON.stringify({ ...fixture, files, launch: { ...fixture.launch, environment } }),
  );

it.each([
  "LD_PRELOAD",
  "LD_ANY",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "PATH",
  "HOME",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "PS4",
  "IFS",
  "ZDOTDIR",
  "GIT_CONFIG",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "NO_PROXY",
  "ACCESS_TOKEN",
  "CLIENT_SECRET",
  "API_KEY",
  "PASSWORD",
  "AWS_PROFILE",
  "GITHUB_HOST",
  "GH_HOST",
  "FOOM_CONTROL_URL",
  "ELECTRON_RUN_AS_NODE",
  "PROMPT_COMMAND",
  "CLAUDECODE",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "CONSTRUCTOR",
  "PROTOTYPE",
  "__PROTO__",
])("rejects reserved manifest environment %s in any case", (name) => {
  for (const spelling of [name, name.toLowerCase(), name.toUpperCase()])
    expect(() => parse([{ name: spelling, value: "fixed" }])).toThrow(
      "$.launch.environment[0].name: reserved-environment",
    );
});
it.each(["1BAD", "A-B", "A=B", "", "A".repeat(65), "A\nB"])("rejects malformed name %j", (name) => {
  expect(() => parse([{ name, value: "fixed" }])).toThrow("$.launch.environment[0].name");
});
it.each([
  null,
  1,
  "",
  "x".repeat(129),
  "a\nb",
  "a\0b",
  "$HOME",
  "${HOME}",
  "%HOME%",
  "`pwd`",
  "{prompt}",
  "prefix{file:config/mcp.json}",
  "{file:config/mcp.json}/..",
  "{file:config/mcp.json:json}",
  "{file:}",
  "{file:missing}",
])("rejects malformed or expanded value %j", (value) => {
  expect(() => parse([{ name: "AGENT_CONFIG", value }])).toThrow("$.launch.environment[0].value");
});
it("rejects malformed entries, duplicates, excessive counts and invalid conditions with their path", () => {
  for (const environment of [
    {},
    [null],
    [{ name: "OK" }],
    [{ name: "OK", value: "1", extra: true }],
    Array.from({ length: 9 }, (_, n) => ({ name: `AGENT_${String(n)}`, value: "1" })),
  ])
    expect(() => parse(environment)).toThrow("$.launch.environment");
  expect(() =>
    parse([
      { name: "AGENT_MODE", value: "1" },
      { name: "agent_mode", value: "2" },
    ]),
  ).toThrow("$.launch.environment[1].name: duplicate-environment");
  expect(() =>
    parse([
      {
        name: "AGENT_MODE",
        value: "1",
        when: { all: [{ field: "missing", op: "eq", value: true }] },
      },
    ]),
  ).toThrow("$.launch.environment[0].when: dangling-reference");
});
it("requires a selected launch file for every environment reference", () => {
  const entry = { name: "AGENT_CONFIG", value: "{file:config/mcp.json}" };
  expect(() => parse([entry])).toThrow("unselected-attachment");
  expect(() => parse([{ ...entry, when: fixture.files[0]?.when }], [])).toThrow(
    "dangling-reference",
  );
  expect(() =>
    parse(
      [{ ...entry, when: fixture.files[0]?.when }],
      fixture.files.map((file) => ({ ...file, scope: "plugin" })),
    ),
  ).toThrow("dangling-reference");
  expect(parse([{ ...entry, when: fixture.files[0]?.when }]).model.launch.environment).toHaveLength(
    1,
  );
  expect(
    parse([{ name: "AGENT_MODE", value: "fixed literal" }]).model.launch.environment?.[0]?.value,
  ).toBe("fixed literal");
});

it("keeps MCP data limited to selected MCP attachments, including environment-only references", () => {
  const environment = [
    { name: "AGENT_CONFIG", value: "{file:config/mcp.json}", when: fixture.files[0]?.when },
  ];
  const mcp = { ...fixture.launch.mcp, arguments: [] };
  const parseMcp = (entries: unknown, files: unknown = fixture.files) =>
    parseAgentManifest(
      JSON.stringify({
        ...fixture,
        files,
        launch: { ...fixture.launch, mcp, environment: entries },
      }),
    );
  expect(parseMcp(environment).model.launch.mcp?.arguments).toEqual([]);
  expect(() => parseMcp([])).toThrow("incompatible-combination");
  expect(() =>
    parseMcp(
      environment,
      fixture.files.map((file) => ({ ...file, when: undefined })),
    ),
  ).toThrow("incompatible-combination");
  expect(
    parse(
      [{ name: "AGENT_CONFIG", value: "{file:data.json}" }],
      [
        ...fixture.files,
        { name: "data.json", scope: "launch", format: "json", content: '{"name":"fixed"}' },
      ],
    ).model.launch.environment,
  ).toHaveLength(1);
});
