import { expect, test } from "vitest";
import base from "../../fixtures/agent-plugin-v2.json";
import copilot from "../../fixtures/agent-plugins-v2/copilot.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import { agentCapabilities, formatAgentCapabilities } from "../../../src/shared/agent-capabilities";

const report = (value: unknown) => agentCapabilities(parseAgentManifest(JSON.stringify(value)));
const empty = {
  ...base,
  discovery: { facts: [] },
  attention: { minimumEngineVersion: 1, rules: [] },
  conversation: { resumePin: "first-event", restoreControl: false },
  launch: { order: base.launch.order },
  files: [],
};

test("classifies missing attention, completion, resume, MCP and bypass offline", () => {
  const result = report(empty);
  expect(result).toMatchObject({
    attention: { rules: 0, channels: [] },
    completion: "attached",
    resume: "none",
    mcp: "off",
    foomTools: "off",
    bypass: { argumentMatchers: 2, environmentVariables: 1 },
    warnings: ["No attention signal"],
  });
  expect(formatAgentCapabilities(result)).toContain("Attention: none");
  expect(formatAgentCapabilities(report(base))).toContain("screen rules (1)");
  expect(report(base).resume).toBe("Foom-assigned ID");
  const paste = report({ ...empty, launch: { ...empty.launch, resume: base.launch.resume } });
  expect(paste.resume).toBe("paste only");
  expect(paste.warnings).toContain("Resume declared with no ID source; paste a conversation ID");
});

test("reports disabled direct and transitive fact gates without mistaking unknown probes for disabled", () => {
  const result = report({
    ...copilot,
    attention: empty.attention,
    conversation: empty.conversation,
  });
  expect(result).toMatchObject({
    attention: { channels: ["off"] },
    mcp: "off",
    resume: "paste only",
  });
  expect(result.warnings).toContain("Hooks gated by an always-disabled fact");
  expect(result.warnings).toContain("MCP gated by an always-disabled fact");
  expect(formatAgentCapabilities(result)).toContain("Attention: none");
  const gated = report({
    ...copilot,
    discovery: {
      ...copilot.discovery,
      facts: copilot.discovery.facts.map((fact) => ({ ...fact, enabled: true })),
    },
  });
  expect(gated.attention.channels).toEqual(["gated by facts"]);
  expect(gated.mcp).toBe("gated by facts");
  expect(gated.warnings).toEqual([]);
  expect(formatAgentCapabilities(gated)).toContain("gated by facts) + screen rules (13)");
});

test("reports default hooks, hook-reported sessions and enabled MCP without copying manifest strings", () => {
  const value = {
    ...copilot,
    discovery: { facts: [] },
    conversation: empty.conversation,
    hooks: {
      channels: copilot.hooks.channels.map((channel) => ({ ...channel, when: { all: [] } })),
    },
    files: [],
    launch: {
      order: copilot.launch.order,
      resume: copilot.launch.resume,
      mcp: { arguments: [] },
      toolPermissions: copilot.launch.toolPermissions,
    },
  };
  const result = report(value);
  expect(result).toMatchObject({
    resume: "hook-reported session",
    mcp: "on",
    foomTools: "on",
    completion: "observed",
  });
  expect(formatAgentCapabilities(result)).toContain("hooks (1; enabled-by-default)");
  const text = JSON.stringify(result) + formatAgentCapabilities(result);
  for (const secret of [copilot.name, "COPILOT_ALLOW_ALL", "--yolo", "lifecycle", "session_id"])
    expect(text).not.toContain(secret);
  expect(report({ ...value, attention: empty.attention }).warnings).toEqual([]);
  expect(formatAgentCapabilities(report({ ...value, attention: empty.attention }))).not.toContain(
    "+ screen",
  );
});

test("combines all/any gates, selector facts and channel dependencies conservatively", () => {
  const value = {
    ...empty,
    discovery: {
      facts: [
        { id: "disabledFact", enabled: false },
        { id: "chained", when: { all: [{ field: "disabledFact", op: "eq", value: true }] } },
        {
          id: "enabled",
          when: {
            any: [
              { field: "disabledFact", op: "eq", value: false },
              { field: "control", op: "eq", value: true },
            ],
          },
        },
      ],
    },
    launch: {
      ...empty.launch,
      mcp: {
        arguments: [],
        when: { all: [{ field: { source: "facts", path: ["chained"] }, op: "eq", value: true }] },
      },
    },
  };
  expect(report(value).mcp).toBe("off");
  expect(
    report({
      ...value,
      launch: {
        ...value.launch,
        mcp: { arguments: [], when: { any: [{ field: "enabled", op: "eq", value: true }] } },
      },
    }).mcp,
  ).toBe("on");
});
