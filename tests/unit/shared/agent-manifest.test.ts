import { expect, it } from "vitest";
import fixture from "../../fixtures/agent-plugin.json";
import {
  AgentManifestError,
  expandArguments,
  parseAgentPlugin,
} from "../../../src/shared/agent-manifest";

function changed(path: string, value: unknown, remove = false): string {
  const draft: unknown = structuredClone(fixture);
  let parent: unknown = draft;
  const keys = path.split(".");
  const last = keys.pop();
  for (const key of keys) {
    if (typeof parent !== "object" || parent === null || !(key in parent))
      throw Error("Bad test path");
    parent = Reflect.get(parent, key);
  }
  if (typeof parent !== "object" || parent === null || last === undefined)
    throw Error("Bad test path");
  if (remove) Reflect.deleteProperty(parent, last);
  else Reflect.set(parent, last, value);
  return JSON.stringify(draft);
}
it("parses the manifest-only fixture and copies literal argv without shell evaluation or recursive expansion", () => {
  const manifest = parseAgentPlugin(JSON.stringify(fixture));
  expect(manifest.id).toBe("foom-test-agent");
  expect(manifest.attention.rules[0]?.comment).toBe("Config-authored detection rule");
  expect(manifest.attention.rules[1]?.lines).toBe(2);
  expect(
    expandArguments(["a {prompt} b", "$(unchanged)", "{mcpName}"], {
      prompt: "{mcpName} `literal`",
      mcpName: "server",
    }),
  ).toEqual(["a {mcpName} `literal` b", "$(unchanged)", "server"]);
  expect(() => expandArguments(["{prompt}"], {})).toThrow("missing-placeholder-value");
});
it("accepts optional-free manifests and every bounded rule region/state and extractor transport", () => {
  const minimal = {
    ...fixture,
    launch: { arguments: [] },
    attention: { minimumEngineVersion: 1, rules: [] },
  };
  Reflect.deleteProperty(minimal, "discovery");
  expect(parseAgentPlugin(JSON.stringify(minimal)).attention.hook).toBeUndefined();
  for (const state of ["working", "blocked", "idle", "unknown"])
    for (const region of ["title", "bottom", "after_horizontal_rule"]) {
      const value = {
        ...fixture,
        attention: {
          ...fixture.attention,
          rules: [
            {
              id: "rule",
              state,
              region,
              priority: 0,
              match: { regex: ["[a-z]\\s"] },
              reason: "Fixture",
              not: [],
            },
          ],
          hook: { ...fixture.attention.hook, transport: "stdin" },
        },
      };
      expect(parseAgentPlugin(JSON.stringify(value)).attention.rules[0]?.state).toBe(state);
    }
});
const invalid: readonly [string, unknown][] = [
  ["kind", "code"],
  ["version", 2],
  ["id", "claude"],
  ["id", "codex"],
  ["id", "agy"],
  ["id", "shell"],
  ["id", "../escape"],
  ["id", ""],
  ["id", "x".repeat(41)],
  ["name", ""],
  ["name", null],
  ["name", "line\n"],
  ["badge", "too-long"],
  ["badge", "bad"],
  ["executables", []],
  ["executables", "agent"],
  ["executables", ["/bin/agent"]],
  ["executables", ["agent.cmd"]],
  ["executables", ["agent.bat"]],
  ["executables", ["agent.ps1"]],
  ["executables", ["x".repeat(65)]],
  ["executables", Array(9).fill("agent")],
  ["launch", []],
  ["launch.arguments", [""]],
  ["launch.arguments", ["x".repeat(4097)]],
  ["launch.arguments", [12]],
  ["launch.arguments", Array(65).fill("x")],
  ["launch.arguments", ["{prompt}"]],
  ["launch.prompt", ["{unknown}"]],
  ["launch.prompt", ["{prompt"]],
  ["launch.resume", ["--resume"]],
  ["launch.prompt", ["--prompt"]],
  ["launch.hooks", []],
  ["launch.allowedTools", ["launch"]],
  ["attention", null],
  ["attention.minimumEngineVersion", 2],
  ["attention.rules", {}],
  ["attention.rules", Array(65).fill({})],
  ["attention.rules.0.id", "Invalid"],
  ["attention.rules.0.state", "done"],
  ["attention.rules.0.region", "all"],
  ["attention.rules.0.priority", -1],
  ["attention.rules.0.priority", 1001],
  ["attention.rules.0.priority", 0.5],
  ["attention.rules.0.priority", "1"],
  ["attention.rules.0.lines", 0],
  ["attention.rules.0.lines", 41],
  ["attention.rules.0.lines", "1"],
  ["attention.rules.0.lines", 1.5],
  ["attention.rules.0.not", {}],
  ["attention.rules.0.not", Array(9).fill({})],
  ["attention.rules.0.match", {}],
  ["attention.rules.0.match.contains", ["x".repeat(129)]],
  ["attention.rules.0.match.regex", ["(a+)+"]],
  ["attention.rules.0.match.regex", ["["]],
  ["attention.hook.transport", "script"],
  ["attention.hook.sessionField", "nested.id"],
  ["attention.hook.eventField", "../event"],
  ["attention.hook.events", []],
  ["attention.hook.events", {}],
  ["attention.hook.events", null],
  ["attention.hook.events", { bad: "execute" }],
  ["attention.hook.events", { "bad event": "working" }],
  [
    "attention.hook.events",
    Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`event${String(index)}`, "working"]),
    ),
  ],
  ["bypassArguments", ["positional"]],
  ["capabilities", ["codex-hooks"]],
  ["script", "run"],
  ["url", "https://untrusted.example/agent.json"],
  ["launch.code", "run"],
  ["discovery.version", ["--anything"]],
];
it.each(invalid)("rejects invalid %s (%j)", (path, value) => {
  expect(() => parseAgentPlugin(changed(path, value))).toThrow(AgentManifestError);
});
it("refuses characters that could disguise argv or names in the trusted dialog", () => {
  for (const hidden of ["\u202e", "\u200b", "\u2066", "\ue000", "\ud800", "\u2028", "\u0007"]) {
    expect(() => parseAgentPlugin(changed("launch.arguments", [`--y${hidden}olo`]))).toThrow(
      AgentManifestError,
    );
    expect(() => parseAgentPlugin(changed("name", `Agent${hidden}`))).toThrow(AgentManifestError);
  }
});
it("refuses malformed, oversized, non-object and incomplete JSON with stable reasons", () => {
  for (const text of ["{", "[]", "null", "0", "{}", " ".repeat(65537)])
    expect(() => parseAgentPlugin(text)).toThrow(AgentManifestError);
  expect(() => parseAgentPlugin(changed("name", undefined, true))).toThrow("missing-key");
  const duplicate = {
    ...fixture,
    attention: {
      ...fixture.attention,
      rules: [fixture.attention.rules[0], fixture.attention.rules[0]],
    },
  };
  expect(() => parseAgentPlugin(JSON.stringify(duplicate))).toThrow("duplicate-id");
  expect(() => parseAgentPlugin(changed("attention.hook", undefined, true))).toThrow(
    "hook-mapping-required",
  );
});
