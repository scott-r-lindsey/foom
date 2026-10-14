import { expect, it } from "vitest";
import claude from "../../fixtures/agent-plugins-v2/claude.json";
import codex from "../../fixtures/agent-plugins-v2/codex.json";
import agy from "../../fixtures/agent-plugins-v2/agy.json";
import copilot from "../../fixtures/agent-plugins-v2/copilot.json";
import legacy from "../../fixtures/agent-plugin.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import { parseAgentPlugin, AgentManifestError } from "../../../src/shared/agent-manifest";

export function changed(fixture: unknown, path: string, value: unknown, remove = false): string {
  const draft: unknown = structuredClone(fixture);
  let parent: unknown = draft;
  const keys = path.split(".");
  const last = keys.pop();
  for (const key of keys) {
    if (typeof parent !== "object" || parent === null) throw Error("Bad test path");
    parent = Reflect.get(parent, key);
  }
  if (typeof parent !== "object" || parent === null || last === undefined)
    throw Error("Bad test path");
  if (remove) Reflect.deleteProperty(parent, last);
  else Reflect.set(parent, last, value);
  return JSON.stringify(draft);
}
const parse = (source: string) => parseAgentManifest(source, "bundled");
it.each([claude, codex, agy, copilot])(
  "parses the complete $id draft into data only",
  (fixture) => {
    const parsed = parse(JSON.stringify(fixture));
    expect(parsed.version).toBe(2);
    expect(parsed.model.id).toBe(fixture.id);
    expect(parsed.templateDialect).toBe("v2");
    expect(parsed.model.launch.order).toHaveLength(9);
    expect(parsed.model.hooks?.channels[0]?.mapping.cases.at(-1)?.endsTurn).toBeTypeOf("boolean");
  },
);
it("keeps Copilot verification gates false and reserves config identities", () => {
  expect(
    parse(JSON.stringify(copilot))
      .model.discovery.facts.filter((fact) => !fact.enabled)
      .map((fact) => fact.id),
  ).toEqual(["mcpVerified", "hookVerified"]);
  for (const fixture of [claude, codex, agy])
    expect(() => parseAgentManifest(JSON.stringify(fixture))).toThrow("reserved-id");
  expect(parseAgentManifest(changed(claude, "id", "claude-custom")).version).toBe(2);
});
it("adapts v1 without altering acceptance or semantics", () => {
  const source = JSON.stringify(legacy);
  const parsed = parseAgentManifest(source);
  expect(parsed.version).toBe(1);
  if (parsed.version !== 1) throw Error("Expected v1");
  expect(parsed.manifest).toEqual(parseAgentPlugin(source));
  expect(parsed.helpMatching).toBe("substring");
  expect(parsed.model.launch.toolPermissions?.arguments).toEqual([]);
  expect(parsed.model.launch.mcp?.when?.all?.map((test) => test.field)).toEqual([
    "control",
    "mcpSupport",
  ]);
  expect(parsed.model.hooks?.channels[0]?.when.all?.map((test) => test.field)).toEqual([
    "hooksEnabled",
    "hookSupport",
  ]);
  expect(parsed.model.launch.order).toEqual([
    "defaults",
    "arguments",
    "resume",
    "display",
    "guidance",
    "hooks",
    "mcp",
    "tools",
    "prompt",
  ]);
  expect(parsed.model.hooks?.channels[0]?.arguments).toEqual(parsed.manifest.launch.hooks);
  expect(parsed.model.bypassArguments.map((matcher) => matcher.flag)).toEqual(
    legacy.bypassArguments,
  );
  const minimal = {
    ...legacy,
    launch: { arguments: [] },
    attention: { minimumEngineVersion: 1, rules: [] },
  };
  const adaptedMinimal = parseAgentManifest(JSON.stringify(minimal)).model;
  expect(adaptedMinimal.hooks).toBeUndefined();
  expect(adaptedMinimal.discovery.facts.every((fact) => !fact.enabled)).toBe(true);
  // v1 historically accepts duplicate members and unsafe event keys; keep that boundary unchanged.
  expect(parseAgentManifest(source.replace('"version":1', '"version":1,"version":1')).version).toBe(
    1,
  );
});
it("rejects unsupported and malformed versions with fixed errors", () => {
  for (const source of ["{", "null", "[]", "{}", changed(claude, "version", 3)])
    expect(() => parse(source)).toThrow(AgentManifestError);
});
