import { expect, it } from "vitest";
import claude from "../../fixtures/agent-plugins-v2/claude.json";
import codex from "../../fixtures/agent-plugins-v2/codex.json";
import agy from "../../fixtures/agent-plugins-v2/agy.json";
import copilot from "../../fixtures/agent-plugins-v2/copilot.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import { AgentManifestError } from "../../../src/shared/agent-manifest";

import { changed } from "../../fixtures/manifest-mutation";

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
it("rejects unsupported and malformed versions with fixed errors", () => {
  for (const source of ["{", "null", "[]", "{}", changed(claude, "version", 3)])
    expect(() => parse(source)).toThrow(AgentManifestError);
});

it.each([1, 0, 3, 99, "2", null, undefined])(
  "rejects agent version %s whole with a fixed diagnostic",
  (version) => {
    const reason =
      version === 1
        ? "Agent manifest version 1 is no longer supported; use version 2 (see README.md)"
        : "Agent manifest version must be 2 (see README.md)";
    for (const value of [
      { kind: "agent", version },
      { ...claude, version, launch: "invalid", legacy: true },
    ]) {
      expect(() => parse(JSON.stringify(value))).toThrow(
        new AgentManifestError("$.version", reason),
      );
    }
  },
);
