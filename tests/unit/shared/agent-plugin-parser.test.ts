import bundledCodex from "../../../src/shared/bundled-agents/codex.json";
import {
  applyPermissionArguments,
  checkPermissionConflicts,
} from "../../../src/shared/agent-permission-arguments";
import { permissionLevelSupported } from "../../../src/shared/agent-launch-values";
import { matchesArguments } from "../../../src/shared/agent-argument-matchers";
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

it("refuses permission arguments placed after a terminator or declared without their bypass classification", () => {
  const { model } = parse(JSON.stringify(bundledCodex));
  const facts = { [permissionLevelSupported]: true };
  expect(() => applyPermissionArguments(model, "workspace", ["--", "prompt"], 2, facts)).toThrow(
    "agent-permission-conflict",
  );
  const policy = model.permissionLevels;
  const workspace = policy?.workspace;
  if (!policy || !workspace) throw new Error("Missing Codex Workspace declaration");
  expect(() =>
    applyPermissionArguments(
      { ...model, permissionLevels: { ...policy, workspace: undefined } },
      "workspace",
      [],
      0,
      facts,
    ),
  ).toThrow("agent-permission-unavailable");
  const invalid = { ...model, permissionLevels: { ...policy, full: workspace } };
  expect(() => applyPermissionArguments(invalid, "full", [], 0, facts)).toThrow(
    "Invalid agent permission declaration",
  );
  expect(() =>
    applyPermissionArguments(
      { ...model, permissionLevels: { ...policy, workspace: policy.full } },
      "workspace",
      [],
      0,
      facts,
    ),
  ).toThrow("Invalid agent permission declaration");
  expect(() =>
    applyPermissionArguments(
      { ...model, permissionLevels: { ...policy, ask: workspace } },
      "ask",
      [],
      0,
      facts,
    ),
  ).toThrow("Invalid agent permission declaration");
});

it("classifies generated Workspace and Full access arguments as bypass outside managed launches", () => {
  const { model } = parse(JSON.stringify(bundledCodex));
  expect(matchesArguments(model.bypassArguments, bundledCodex.permissionLevels.ask)).toBe(false);
  for (const args of [bundledCodex.permissionLevels.workspace, bundledCodex.permissionLevels.full])
    expect(matchesArguments(model.bypassArguments, args)).toBe(true);
});

it("decodes quoted TOML approval values while keeping root-only override matching", () => {
  const { model } = parse(JSON.stringify(bundledCodex));
  expect(
    matchesArguments(
      model.bypassArguments,
      ["-c", String.raw`approval_policy="n\u0065ver"`],
      "root",
    ),
  ).toBe(true);
  expect(
    matchesArguments(
      model.bypassArguments,
      ["-c", 'profiles.team.approval_policy="never"'],
      "root",
    ),
  ).toBe(false);
});

it.each(["-Check the README", "-s is broken", "-add tests", "-profile x"])(
  "accepts the Codex prompt %s after the option terminator",
  (prompt) => {
    const { model } = parse(JSON.stringify(bundledCodex));
    const facts = { [permissionLevelSupported]: true };
    expect(applyPermissionArguments(model, "workspace", ["--", prompt], 0, facts)).toEqual([
      ...bundledCodex.permissionLevels.workspace,
      "--",
      prompt,
    ]);
  },
);

it("still refuses a Codex permission flag before the option terminator", () => {
  const { model } = parse(JSON.stringify(bundledCodex));
  const facts = { [permissionLevelSupported]: true };
  expect(() =>
    applyPermissionArguments(model, "workspace", ["-sread-only", "--", "-s is broken"], 0, facts),
  ).toThrow("agent-permission-conflict");
});

it.each([
  { args: ["--profile", "team"] },
  { args: ["-c", 'profile="team"'] },
  { args: ["--config=profile=team"] },
  { args: ["--yolo"] },
  { args: ["--not-so-yolo"] },
  { args: ["-anever"] },
  { args: ["-c", String.raw`approval_policy="n\u0065ver"`] },
])("refuses Codex permission override $args with managed permissions", ({ args }) => {
  const { model } = parse(JSON.stringify(bundledCodex));
  const facts = { [permissionLevelSupported]: true };
  expect
    .soft(() => {
      checkPermissionConflicts(model, args);
    })
    .toThrow("agent-permission-conflict");
  expect(() => applyPermissionArguments(model, "ask", args, 0, facts)).toThrow(
    "agent-permission-conflict",
  );
});
