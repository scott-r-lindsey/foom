import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020";
import {
  OWNED_FILES,
  OWNED_HISTORY,
  digest,
  refreshable,
} from "../../../../src/main/config/layout";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import generated from "../../../../src/shared/agent-plugin.schema.json";
import example from "../../../../src/shared/agent-plugin.example.json";
import guides from "../../../fixtures/config/guide-digests.json";
import { agentSchema } from "../../../helpers/agent-schema";

test("agent schema is generated from the parser's fields, enums and bounds", () => {
  expect(generated).toEqual(agentSchema());
  expect(JSON.parse(OWNED_FILES["schemas/agent.schema.json"] ?? "")).toEqual(generated);
  const parser = readFileSync("src/shared/agent-manifest-schema.ts", "utf8");
  expect(
    agentSchema(
      parser.replace('"first-event", "requested-on-paste"', '"first-event", "new-value"'),
    ),
  ).not.toEqual(generated);
  expect(agentSchema(parser.replace('"badge",', '"newField", "badge",'))).not.toEqual(generated);
});

test("the strict JSON starter validates after only its identity changes", () => {
  const source = OWNED_FILES["examples/agent.json"] ?? "";
  expect(parseAgentManifest(source).model.id).toBe("example-agent");
  const changed = {
    ...example,
    id: "another-agent",
    name: "Another agent",
    executables: ["another-cli"],
  };
  const parsed = parseAgentManifest(JSON.stringify(changed));
  expect(parsed.model.discovery.facts.find((fact) => fact.id === "hookVerified")?.enabled).toBe(
    false,
  );
  const validate = new Ajv2020().compile(generated);
  expect(validate(changed), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...changed, version: 1 })).toBe(false);
  expect(validate({ ...changed, extra: true })).toBe(false);
  expect(
    validate({ ...changed, conversation: { ...changed.conversation, resumePin: "invalid" } }),
  ).toBe(false);
});

test("each guide revision is appended to the digest ledger and all older revisions stay refreshable", () => {
  for (const file of ["README.md", "AGENTS.md", "CLAUDE.md"]) {
    const current = OWNED_FILES[file] ?? "";
    // On edits append the new digest; move the previous digest to OWNED_HISTORY.
    expect(digest(current)).toBe(guides.at(-1));
    for (const previous of guides.slice(0, -1)) expect(OWNED_HISTORY[file]).toContain(previous);
    expect(refreshable(file, new TextEncoder().encode(current))).toBe(false);
    expect(refreshable(file, new TextEncoder().encode(`${current}\nUser notes`))).toBe(false);
    expect(refreshable(file, null)).toBe(true);
    expect(refreshable(file, readFileSync("tests/fixtures/config/guide-2026-10-14.md"))).toBe(true);
  }
  expect(refreshable("user-notes.md", new Uint8Array())).toBe(false);
});

test("schema accepts complete v2 manifests with files, MCP, health and setup", () => {
  const validate = new Ajv2020().compile(generated);
  for (const name of ["claude", "codex", "agy"]) {
    const source = readFileSync(`tests/fixtures/agent-plugins-v2/${name}.json`, "utf8");
    expect(() => parseAgentManifest(source, "bundled")).not.toThrow();
    expect(validate(JSON.parse(source)), JSON.stringify(validate.errors)).toBe(true);
  }
  const docs = readFileSync("docs/agent-plugins.md", "utf8");
  const copilot =
    docs.split("### GitHub Copilot CLI 1.0.95")[1]?.split("```json\n")[1]?.split("```")[0] ?? "";
  expect(() => parseAgentManifest(copilot)).not.toThrow();
  expect(validate(JSON.parse(copilot)), JSON.stringify(validate.errors)).toBe(true);
});
