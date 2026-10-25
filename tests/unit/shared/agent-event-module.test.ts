import { expect, it } from "vitest";
import data from "../../../src/shared/bundled-agents/opencode.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import { changed } from "../../fixtures/manifest-mutation";
const parse = (value: unknown) => parseAgentManifest(JSON.stringify(value), "bundled");
it("allows generated module paths and native tool grants but never manifest-authored executable data", () => {
  expect(parse(data).model.hooks?.channels[0]?.observer.transport).toBe("event-module");
  for (const [path, value] of [
    ["hooks.channels.0.observer.version", 2],
    ["hooks.channels.0.mapping.sessionAliases", [{ source: "header", path: ["X-Foom-Event"] }]],
    ["hooks.channels.0.observer.source", "export default {}"],
    ["hooks.channels.0.arguments", ["--plugin", "arbitrary"]],
    ["hooks.channels.0.mapping.event", { source: "header", path: ["X-Foom-Event"] }],
    ["files.0.content", '{"plugins":["/arbitrary/code"]}'],
    ["files.0.content", '{"plugins":["FOOM_GENERATED_0_SENTINEL"]}'],
    ["files.0.content", '{"plugins":["\\u0046OOM_GENERATED_0_SENTINEL"]}'],
    ["files.0.content", '{"plugins":[{observerModule:missing:json}]}'],
    ["files.0.content", '{"plugins":[{observerModule:lifecycle:toml}]}'],
    ["files.0.when", { all: [] }],
    ["files.0.content", '{"command":{observerModule:lifecycle:json}}'],
    ["launch.arguments.arguments", ["{observerModule:lifecycle:json}"]],
    ["launch.environment.0.value", "{fileContent:missing.json}"],
    ["launch.environment.0.value", "prefix{fileContent:hooks.json}"],
    ["launch.toolPermissions.format", "mcp-double-underscore"],
    ["launch.toolPermissions.arguments", ["{tool}"]],
    ["launch.toolPermissions.fileRules", "arbitrary"],
    [
      "launch.toolPermissions.merge",
      { flags: ["--tools"], output: "--tools", separators: "whitespace-comma-parentheses" },
    ],
    ["files.1.content", '{"permissions":[{"action":"*","resource":"*","effect":"allow"}]}'],
    [
      "files.1.content",
      '{"mcp":{"servers":{{mcpName:json}:{"type":"remote","url":{mcpUrl:json},"headers":{"Authorization":"Bearer {env:OTHER_SECRET}"}}}}}',
    ],
  ] as const)
    expect(() => parse(changed(data, path, value))).toThrow();
});
it("keeps client token references only in selected MCP Authorization data", () => {
  const valid = parse(data);
  expect(valid.model.files[1]?.content).toContain("{env:FOOM_CONTROL_TOKEN}");
  for (const content of [
    '{"plugins":["Bearer {env:FOOM_CONTROL_TOKEN}"]}',
    '{"Authorization":"Bearer {env:FOOM_CONTROL_TOKEN}"}',
    '{"name":"Bearer {env:FOOM_CONTROL_TOKEN}"}',
  ])
    expect(() => parse(changed(data, "files.0.content", content))).toThrow();
});
