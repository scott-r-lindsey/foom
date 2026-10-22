import { expect, it } from "vitest";
import claude from "../../fixtures/agent-plugins-v2/claude.json";
import codex from "../../fixtures/agent-plugins-v2/codex.json";
import agy from "../../fixtures/agent-plugins-v2/agy.json";
import copilot from "../../fixtures/agent-plugins-v2/copilot.json";
import { parseAgentManifest } from "../../../src/shared/agent-plugin-parser";
import { AgentManifestError } from "../../../src/shared/agent-manifest";
function changed(fixture: unknown, path: string, value: unknown, remove = false): string {
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
const test = (field: unknown, op = "eq", value: unknown = true) => ({ field, op, value });
const when = (field: unknown, op = "eq", value: unknown = true) => ({
  all: [test(field, op, value)],
});
const payload = (key: string) => ({ source: "payload", path: [key] });
const invalid: readonly [unknown, string, unknown][] = [
  [claude, "id", "shell"],
  [claude, "id", "all"],
  [claude, "name", "\u200b"],
  [claude, "badge", "abc"],
  [claude, "executables", []],
  [claude, "discovery.facts", [{ id: "a", when: when("b") }, { id: "b" }]],
  [claude, "discovery.facts", [{ id: "a", when: when("a") }]],
  [claude, "discovery.facts", [{ id: "a" }, { id: "a" }]],
  [claude, "discovery.facts", [{ id: "hooksEnabled" }]],
  [claude, "discovery.facts", [{ id: "owned" }]],
  [claude, "discovery.facts", [{ id: "a", when: when("channelAttached:lifecycle") }]],
  [claude, "discovery.facts.0.when", {}],
  [claude, "discovery.facts.0.when", { any: [] }],
  [claude, "discovery.facts.0.when", { all: [], any: [] }],
  [
    claude,
    "discovery.facts.0.when",
    { all: Array(16).fill(test("control")), any: [test("control")] },
  ],
  [claude, "discovery.facts.0.when", when("control", "exists", true)],
  [claude, "discovery.facts.0.when", { all: [{ field: "control", op: "eq" }] }],
  [claude, "discovery.facts.0.when", when("control", "eq", [])],
  [claude, "discovery.facts.0.when", when("control", "in", true)],
  [claude, "discovery.facts.0.when", when("control", "gte", 1.5)],
  [claude, "discovery.facts.0.when", when(payload("evil"))],
  [claude, "discovery.facts.0.when", when({ source: "facts", path: ["control", "extra"] })],
  [claude, "discovery.facts.0.when", when({ source: "facts", path: [0] })],
  [claude, "launch.order", Array(9).fill("resume")],
  [claude, "launch.prompt.requires", "missing"],
  [claude, "launch.prompt.arguments", ["--", "literal"]],
  [claude, "launch.prompt.arguments", ["prefix{prompt}"]],
  [claude, "launch.prompt.arguments", ["{prompt}", "--"]],
  [claude, "launch.resume.arguments", ["--resume"]],
  [claude, "launch.arguments.arguments", ["{prompt}"]],
  [claude, "launch.arguments.arguments", ["{unknown}"]],
  [claude, "launch.arguments.arguments", ["{mcpName}"]],
  [claude, "launch.mcp.arguments", ["{file:missing}"]],
  [claude, "launch.mcp.arguments", ["{file:mcp.json:json}"]],
  [claude, "launch.mcp.arguments", ["{mcpUrl:unknown}"]],
  [claude, "launch.mcp.arguments", ["{mcpUrl:json:extra}"]],
  [claude, "launch.mcp.when", { all: [] }],
  [claude, "launch.toolPermissions.names", ["open_preview", "open_preview"]],
  [claude, "launch.toolPermissions.names", ["mcp__other__tool"]],
  [claude, "launch.toolPermissions.names", ["Bash"]],
  [claude, "launch.toolPermissions.names", ["*"]],
  [claude, "launch.toolPermissions.merge.output", "--other"],
  [claude, "launch.toolPermissions.merge.flags", ["--a", "--a"]],
  [claude, "launch.toolPermissions.merge.separators", "whitespace"],
  [claude, "launch.toolPermissions.arguments", ["--tool"]],
  [claude, "launch.guidance", { when: { all: [] } }], // removing prompt tested below
  [claude, "hooks.channels.0.id", "invalid_ID"],
  [claude, "hooks.channels.0.when", when("channelAttached:lifecycle")],
  [claude, "hooks.channels.0.mapping.session", { source: "header", path: ["X-Foom-Event"] }],
  [claude, "hooks.channels.0.mapping.event", { source: "header", path: ["Other"] }],
  [claude, "hooks.channels.0.mapping.event", { source: "header", path: ["X-Foom-Sequence"] }],
  [claude, "hooks.channels.0.mapping.event", { source: "header", path: ["X-Foom-Event", 0] }],
  [claude, "hooks.channels.0.mapping.session.path", ["constructor"]],
  [claude, "hooks.channels.0.mapping.session.path", []],
  [claude, "hooks.channels.0.mapping.session.path", [64]],
  [claude, "hooks.channels.0.mapping.session.path", Array(9).fill("x")],
  [claude, "hooks.channels.0.mapping.dedupe", { source: "metadata", path: ["none"] }],
  [claude, "hooks.channels.0.mapping.cases.1.id", "UserPromptSubmit"],
  [claude, "hooks.channels.0.mapping.cases.5.require", []],
  [
    claude,
    "hooks.channels.0.mapping.cases.0.require",
    [{ field: payload("a"), type: "integer", values: [-1] }],
  ],
  [
    claude,
    "hooks.channels.0.mapping.cases.0.require",
    [{ field: payload("a"), type: "boolean", values: ["true"] }],
  ],
  [
    claude,
    "hooks.channels.0.mapping.cases.0.require",
    [{ field: payload("a"), type: "string", values: [1] }],
  ],
  [
    claude,
    "hooks.channels.0.mapping.cases.0.require",
    [{ field: payload("a"), type: "identifier", values: ["has space"] }],
  ],
  [
    claude,
    "hooks.channels.0.mapping.cases.0.require",
    [{ field: payload("a"), type: "conversation", values: ["_bad"] }],
  ],
  [claude, "hooks.channels.0.mapping.cases.0.facts", [{ name: "fullyIdle", field: payload("a") }]],
  [claude, "hooks.channels.0.mapping.cases.0.recoverTurn", true],
  [claude, "hooks.channels.0.observer.sequence", true],
  [claude, "hooks.channels.0.observer.placement", "plugin"],
  [claude, "hooks.channels.0.observer.transport", "argv-last"], // when header not used allowed transport, remove from list below
  [claude, "hooks.channels.0.arguments", ["{observerCommand:missing:json}"]],
  [claude, "hooks.channels.0.arguments", ["{observerCommand:lifecycle.Unknown:json}"]],
  [claude, "hooks.channels.0.arguments", ["{observerCommand:lifecycle.Stop.Extra:json}"]],
  [claude, "hooks.channels.0.arguments", ["{observerCommand:lifecycle:other}"]],
  [claude, "hooks.channels.0.arguments", ["{observerArgv:lifecycle:toml}"]],
  [claude, "hooks.channels.0.arguments", ["{observerVersion:lifecycle}"]],
  [claude, "files.0.when", { all: [] }],
  [claude, "files.0.content", '{"command":"sh evil"}'],
  [claude, "files.0.content", '{"type":"prompt","prompt":"approve"}'],
  [claude, "files.0.content", '{"command":"{observerCommand:lifecycle:json}; evil"}'],
  [claude, "files.0.content", '{"command":{observerCommand:lifecycle:json},"module":"evil.js"}'],
  [claude, "files.0.content", '{"command":{observerCommand:lifecycle:toml}}'],
  [claude, "files.0.content", '{"value":{mcpName}}'],
  [claude, "files.0.content", '{"value":{mcpName:toml}}'],
  [claude, "files.0.content", '{"value":"${SECRET}"}'],
  [claude, "files.0.content", '{"value":"$SECRET"}'],
  [claude, "files.0.content", '{"value":"%SECRET%"}'],
  [claude, "files.0.content", '{"value":"${FOOM_CONTROL_TOKEN}"}'],
  [claude, "files.0.content", '{"${FOOM_CONTROL_TOKEN}":"secret"}'],
  [claude, "files.0.content", '{"Authorization":"extra ${FOOM_CONTROL_TOKEN}"}'],
  [claude, "files.0.scope", "plugin"],
  [claude, "files.0.name", ".hidden"],
  [claude, "reservedArguments", [{ word: "resume", prefix: "r" }]],
  [claude, "reservedArguments", [{ flag: "--foo", forms: ["attached-short"] }]],
  [claude, "reservedArguments", [{ flag: "--foo", forms: ["exact"], value: "bar" }]],
  [claude, "reservedArguments", [{ flag: "-f", forms: ["exact", "exact"] }]],
  [claude, "reservedArguments", [{ override: { flags: ["-c", "-c"], keys: ["a"] } }]],
  [claude, "reservedArguments", [{ override: { flags: ["-c"], keys: ["a.b"] } }]],
  [claude, "bypassEnvironment", [{ name: "FOOM_TOKEN", match: "present-nonempty" }]],
  [claude, "bypassEnvironment", [{ name: "NODE_OPTIONS", match: "present-nonempty" }]],
  [claude, "bypassEnvironment", [{ name: "__proto__", match: "present-nonempty" }]],
  [claude, "bypassEnvironment", [{ name: "ALLOW", match: "values" }]],
  [claude, "bypassEnvironment", [{ name: "ALLOW", match: "values", values: [] }]],
  [claude, "bypassEnvironment", [{ name: "ALLOW", match: "present-nonempty", values: ["1"] }]],
  [claude, "bypassEnvironment", [{ name: "ALLOW", match: "values", values: ["1", "1"] }]],
  [
    claude,
    "bypassEnvironment",
    [
      { name: "ALLOW", match: "present-nonempty" },
      { name: "allow", match: "present-nonempty" },
    ],
  ],
  [
    claude,
    "resumePaste",
    [
      { command: "claude", selector: "--resume" },
      { command: "claude", selector: "--resume" },
    ],
  ],
  [claude, "attention.rules.0.match", {}],
  [claude, "attention.rules.0.match.regex", ["a+"]],
  [claude, "attention.rules.1.id", claude.attention.rules[0]?.id],
  [claude, "attention.rules.0.priority", 2001],
  [claude, "execution.completionChannels", ["missing"]],
  [claude, "execution.completionChannels", []],
  [claude, "execution.providerRules", ["live_blocked_form", "live_blocked_form"]],
  [claude, "execution.providerRules", ["osc_title_idle"]],
  [codex, "health.channel", "missing"],
  [codex, "health.requiredEvents", ["missing"]],
  [codex, "health.requiredEvents", ["Stop", "Stop"]],
  [codex, "health.requiredEvents", ["Stop"]],
  [codex, "health.completionEvent", "UserPromptSubmit"],
  [codex, "health.promptEvent", "Stop"],
  [codex, "discovery.facts.0.when", when("healthTrusted")],
  [codex, "hooks.channels.1.observer.response", "empty-json-first"],
  [codex, "hooks.channels.1.observer.delivery", "detached"],
  [codex, "setup.actions.0.arguments", ["/hooks"]],
  [codex, "setup.actions.0.statusProbe", ["--help"]],
  [agy, "hooks.channels.0.mapping.sequence.path", ["X-Foom-Event"]],
  [agy, "hooks.channels.0.observer.transport", "argv-last"],
  [agy, "hooks.channels.0.mapping.cases.2.facts.0.aliases", { NO_TOOL_CALL: "success" }],
  [agy, "hooks.channels.0.mapping.cases.2.facts.0.aliases", { missing: "model_stop" }],
  [agy, "hooks.channels.0.mapping.cases.2.require.0.values", ["something"]],
  [
    agy,
    "hooks.channels.0.mapping.cases.2.facts",
    [
      agy.hooks.channels[0]?.mapping.cases[2]?.facts?.[0],
      agy.hooks.channels[0]?.mapping.cases[2]?.facts?.[0],
    ],
  ],
  [agy, "hooks.channels.0.mapping.cases.4.action", "working"],
  [agy, "setup.status.metadata.1.path", ".gemini/secrets.json"],
  [agy, "setup.status.metadata.1.id", "manifest"],
  [agy, "setup.status.ownership.manifest", "missing"],
  [
    agy,
    "setup.status.ownership.versionField",
    { source: "metadata", path: ["missing", "version"] },
  ],
  [agy, "setup.status.ownership.versionField", { source: "metadata", path: ["config", "version"] }],
  [agy, "setup.status.ownership.require", []],
  [agy, "setup.status.cases.0.when", when("setupState")],
  [agy, "setup.status.cases.0.when", when("hookSupport")],
  [agy, "setup.actions.1.id", "install"],
  [agy, "setup.actions.0.instructions", "run"],
  [agy, "setup.actions.0.arguments", []],
  [agy, "setup.actions.0.arguments", ["{prompt}"]],
  [agy, "setup.actions.0.statusProbe", "observed-health"],
  [agy, "setup.status.probe.arguments", ["{pluginDir}"]],
  [agy, "launch.guidance.merge.separators", "whitespace-comma-parentheses"],
  [copilot, "conversation.newId.arguments", ["--session-id"]],
];
// These changes are legal on their own; feature dependencies are tested separately.
const legal = ["launch.guidance", "hooks.channels.0.observer.transport"];
it.each(
  invalid
    .filter(([fixture, path]) => !(fixture === claude && legal.includes(path)))
    .map(([fixture, path, value], index) => ({ fixture, path, value, index })),
)("$index rejects $path", ({ fixture, path, value }) => {
  expect(() => parse(changed(fixture, path, value))).toThrow(AgentManifestError);
});

it("rejects incompatible optional feature removals", () => {
  for (const path of ["launch.mcp", "setup.status.ownership"]) {
    const fixture = path === "launch.mcp" ? claude : agy;
    expect(() => parse(changed(fixture, path, undefined, true))).toThrow();
  }
  const draft = {
    ...claude,
    launch: { ...claude.launch, prompt: undefined, guidance: { when: { all: [] } } },
  };
  expect(() => parse(JSON.stringify(draft))).toThrow("incompatible-combination");
});
it("rejects unknown keys at every schema object and preserves fixed diagnostics", () => {
  const paths: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value))
      value.forEach((entry: unknown, index) => {
        visit(entry, `${path}.${String(index)}`);
      });
    else if (typeof value === "object" && value !== null) {
      if (path.endsWith("empty.value")) return;
      if (!path.endsWith("aliases"))
        paths.push(path ? `${path}.unexpected-secret-name` : "unexpected-secret-name");
      for (const [key, entry] of Object.entries(value)) visit(entry, path ? `${path}.${key}` : key);
    }
  };
  for (const fixture of [claude, codex, agy, copilot]) {
    paths.length = 0;
    visit(fixture, "");
    for (const path of paths) {
      try {
        parse(changed(fixture, path, true));
        throw Error("Accepted unknown key");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentManifestError);
        if (error instanceof AgentManifestError)
          expect(error.message).not.toContain("unexpected-secret-name");
      }
    }
  }
});
it("accepts selectors, optional conditions and every argument matcher form", () => {
  const draft = {
    ...claude,
    id: "custom",
    bypassEnvironment: [
      { name: "ALLOW", match: "values", values: ["yes"], caseInsensitive: true, trim: true },
    ],
    reservedArguments: [
      { word: "resume" },
      { prefix: "-r" },
      { flag: "-s", forms: ["separate", "equals", "attached-short"], value: "danger" },
      { override: { flags: ["-c"], keys: ["sandbox_mode"], value: "danger" } },
    ],
    discovery: {
      facts: [
        {
          id: "a",
          when: { all: [{ field: { source: "facts", path: ["control"] }, op: "exists" }] },
        },
      ],
    },
    launch: { order: claude.launch.order },
    files: [],
    hooks: undefined,
    execution: { completion: "attached", completionChannels: [] },
    attention: { minimumEngineVersion: 1, rules: [] },
  };
  expect(parse(JSON.stringify(draft)).model.bypassEnvironment[0]?.trim).toBe(true);
  expect(
    parse(changed(draft, "discovery.facts.0.when", { all: [{ field: "control", op: "absent" }] }))
      .version,
  ).toBe(2);
  expect(parse(changed(draft, "discovery.facts.0.when", when("control", "gte", 0))).version).toBe(
    2,
  );
});

it("refuses native-slot confusion, unknown hook extensions, setup targets and unsafe recovery", () => {
  const mutations: readonly [unknown, string, unknown][] = [
    [claude, "files.0.content", '{"hooks":{"Stop":["sh evil"]}}'],
    [claude, "files.0.content", '{"hooks":{"Stop":[{"type":"command","custom-command":"evil"}]}}'],
    [claude, "files.0.content", '{"other-code-entry":"evil"}'],
    [claude, "hooks.channels.0.arguments", ["{observerCommand:lifecycle:json}; sh evil"]],
    [
      codex,
      "hooks.channels.0.arguments",
      [
        "-c",
        'hooks.Stop=[{type="command",command={observerCommand:lifecycle:toml}}]\nscript="evil"',
      ],
    ],
    [agy, "files.0.content", '{"foomObserverVersion":"{observerVersion:lifecycle}"}'],
    [agy, "setup.actions.2.arguments", ["plugin", "enable", "other"]],
    [agy, "setup.actions.2.when", when("setupState", "eq", "not-installed")],
    [agy, "setup.actions.0.statusProbe", ["plugin", "list", "--anything"]],
    [agy, "setup.status.ownership.directory", ".ssh"],
    [agy, "setup.status.ownership.require.0.values", ["other"]],
    [agy, "hooks.channels.0.mapping.cases.4.when", { all: [] }],
  ];
  for (const [fixture, path, value] of mutations)
    expect(() => parse(changed(fixture, path, value))).toThrow(AgentManifestError);
  const cases = agy.hooks.channels[0]?.mapping.cases.filter((entry) => entry.id !== "stop-failed");
  expect(() => parse(changed(agy, "hooks.channels.0.mapping.cases", cases))).toThrow(
    "incompatible-combination",
  );
});
it("validates arbitrary TOML hook containers and typed native observer metadata", () => {
  const content =
    '[hooks]\nStop=[{type="command",command={observerCommand:lifecycle:toml},timeout=3}]';
  const draft = {
    ...claude,
    files: claude.files.map((file, index) =>
      index === 0 ? { ...file, format: "toml", content } : file,
    ),
  };
  expect(parse(JSON.stringify(draft)).model.files[0]?.format).toBe("toml");
  expect(() =>
    parse(changed(claude, "hooks.channels.0.arguments", ["{observerCommand:lifecycle:json}"])),
  ).not.toThrow();
  expect(() =>
    parse(
      changed(agy, "files.0.content", '{"name":"foom","observerABI":{observerVersion:lifecycle}}'),
    ),
  ).not.toThrow();
  const reason = payload("terminationReason");
  const modified = agy.hooks.channels[0]?.mapping.cases
    .filter((entry) => entry.id !== "stop-failed")
    .map((entry) =>
      entry.id === "stop-idle"
        ? {
            ...entry,
            when: {
              all: [test(payload("fullyIdle")), test(reason, "in", ["model_stop", "NO_TOOL_CALL"])],
            },
          }
        : entry,
    );
  expect(() => parse(changed(agy, "hooks.channels.0.mapping.cases", modified))).not.toThrow();
});

it("bounds version prefix and validates setup probe selectors without executing probes", () => {
  expect(() => parse(changed(claude, "discovery.version.prefix", "\n"))).toThrow();
  expect(() => parse(changed(claude, "discovery.version.prefix", "x".repeat(4096)))).not.toThrow();
  expect(() => parse(changed(claude, "discovery.version.prefix", "x".repeat(4097)))).toThrow();
  const probe = { source: "probe", path: ["imports", 0, "name"] };
  expect(() =>
    parse(changed(agy, "setup.status.cases.0.when", when(probe, "eq", "foom"))),
  ).not.toThrow();
  expect(() =>
    parse(changed(agy, "setup.status.cases.0.when", when({ source: "probe", path: ["secret"] }))),
  ).toThrow("incompatible-selector");
  expect(() =>
    parse(
      changed(
        agy,
        "setup.status.cases.0.when",
        when({ source: "metadata", path: ["manifest", "name"] }, "eq", "foom"),
      ),
    ),
  ).not.toThrow();
  const noProbe = {
    ...agy,
    setup: {
      ...agy.setup,
      status: {
        ...agy.setup.status,
        probe: undefined,
        cases: [{ when: when(probe), state: "installed" }],
      },
    },
  };
  expect(() => parse(JSON.stringify(noProbe))).toThrow("incompatible-selector");
});
it("rejects remote or literal MCP credentials and incompatible turn endings", () => {
  for (const content of [
    '{"mcpServers":{{mcpName:json}:{"type":"http","url":"https://other.example","headers":{"Authorization":"Bearer ${FOOM_CONTROL_TOKEN}"}}}}',
    '{"mcpServers":{{mcpName:json}:{"type":"http","url":{mcpUrl:json},"headers":{"Authorization":"Bearer literal"}}}}',
  ])
    expect(() => parse(changed(claude, "files.1.content", content))).toThrow();
  expect(() =>
    parse(
      changed(codex, "launch.mcp.arguments", [
        "-c",
        'mcp_servers.{mcpName}={url={mcpUrl:toml},bearer_token_env_var="SECRET"}',
      ]),
    ),
  ).toThrow("environment-reference");
  expect(() => parse(changed(claude, "hooks.channels.0.mapping.cases.0.endsTurn", true))).toThrow(
    "incompatible-combination",
  );
  expect(() => parse(changed(agy, "hooks.channels.0.mapping.cases.4.endsTurn", false))).toThrow(
    "incompatible-combination",
  );
  expect(() =>
    parse(changed(codex, "health.requiredEvents", ["UserPromptSubmit", "Stop"])),
  ).toThrow("incompatible-combination");
});

it("validates boolean alias keys and proves recovered idle after normalization", () => {
  const cases = agy.hooks.channels[0]?.mapping.cases.map((entry) =>
    entry.facts
      ? {
          ...entry,
          facts: entry.facts.map((fact) =>
            fact.name === "fullyIdle" ? { ...fact, aliases: { true: true, false: false } } : fact,
          ),
        }
      : entry,
  );
  expect(() => parse(changed(agy, "hooks.channels.0.mapping.cases", cases))).not.toThrow();
  const inverted = cases?.map((entry) =>
    entry.facts
      ? {
          ...entry,
          facts: entry.facts.map((fact) =>
            fact.name === "fullyIdle" ? { ...fact, aliases: { true: false, false: true } } : fact,
          ),
        }
      : entry,
  );
  expect(() => parse(changed(agy, "hooks.channels.0.mapping.cases", inverted))).toThrow(
    "incompatible-combination",
  );
});

it("distinguishes TOML file documents from inline attachment values and accepts JSON array containers", () => {
  const draft = {
    ...claude,
    files: claude.files.map((file, index) =>
      index === 0
        ? {
            ...file,
            format: "toml",
            content: '[[hooks.Stop]]\ntype="command"\ncommand={observerCommand:lifecycle:toml}',
          }
        : file,
    ),
  };
  expect(() => parse(JSON.stringify(draft))).not.toThrow();
  expect(() =>
    parse(changed(draft, "files.0.content", "{command={observerCommand:lifecycle:toml}}")),
  ).toThrow("invalid-template");
  expect(() =>
    parse(
      changed(claude, "hooks.channels.0.arguments", [
        '[{"type":"command","command":{observerCommand:lifecycle:json}}]',
      ]),
    ),
  ).not.toThrow();
});

it("preserves literal equals in containers and supports file attachment equals forms", () => {
  expect(() =>
    parse(changed(claude, "hooks.channels.0.arguments", ["--settings={hookFile:hooks.json}"])),
  ).not.toThrow();
  for (const arg of [
    '[{"matcher":"a=b","type":"command","command":{observerCommand:lifecycle:json}}]',
    '[{matcher="a=b",type="command",command={observerCommand:lifecycle:toml}}]',
  ])
    expect(() => parse(changed(claude, "hooks.channels.0.arguments", [arg]))).not.toThrow();
  expect(() =>
    parse(
      changed(claude, "hooks.channels.0.arguments", [
        "constructor=[{command={observerCommand:lifecycle:toml}}]",
      ]),
    ),
  ).toThrow("unsafe-key");
});

it("keeps positional prompts after every other argv stage", () => {
  const order = ["prompt", ...claude.launch.order.filter((stage) => stage !== "prompt")];
  expect(() => parse(changed(claude, "launch.order", order))).toThrow("incompatible-combination");
  // A flag consumes its own prompt value, independently of later argv stages.
  expect(() => parse(changed(agy, "launch.order", order))).not.toThrow();
});

it("refuses forged generated slots and binds staged plugin identity to its ownership target", () => {
  for (const content of [
    '{"command":"FOOM_OBSERVER_0_SENTINEL"}',
    '{"command":"\\u0046OOM_OBSERVER_0_SENTINEL"}',
    '{"url":"FOOM_MCP_URL_SENTINEL"}',
  ])
    expect(() => parse(changed(claude, "files.0.content", content))).toThrow("invalid-template");
  const continuation = '[hooks]\ncommand="""FOOM_\\\n  OBSERVER_0_SENTINEL"""';
  const toml = {
    ...claude,
    files: claude.files.map((file, index) =>
      index === 0 ? { ...file, format: "toml", content: continuation } : file,
    ),
  };
  expect(() => parse(JSON.stringify(toml))).toThrow("invalid-template");
  expect(() =>
    parse(
      changed(
        agy,
        "files.0.content",
        '{"name":"other","foomObserverVersion":{observerVersion:lifecycle}}',
      ),
    ),
  ).toThrow("incompatible-combination");
  expect(() => parse(changed(agy, "files", agy.files.slice(1)))).toThrow(
    "incompatible-combination",
  );
});

it("rejects shell punctuation in header event names and fixed observer command suffixes", () => {
  expect(() => parse(changed(agy, "hooks.channels.0.mapping.cases.0.event", "Stop;exec"))).toThrow(
    "incompatible-combination",
  );
  const draft = structuredClone(claude);
  const c = draft.hooks.channels[0];
  if (!c) throw Error("Missing channel");
  c.mapping.cases.push({ id: "Unsafe", event: "Stop;exec", action: "classify" });
  const file = draft.files[0];
  if (!file) throw Error("Missing file");
  file.content =
    '{"hooks":{"Stop":[{"type":"command","command":{observerCommand:lifecycle.Stop;exec:json}}]}}';
  expect(() => parse(JSON.stringify(draft))).toThrow("dangling-reference");
});

it.each([
  ["{file:plugin.json}/..", "placeholder-path-arithmetic"],
  ["{hookDir}/sub", "placeholder-path-arithmetic"],
  ["{x}/..", "placeholder-path-arithmetic"],
  ["{x}/sub", "placeholder-path-arithmetic"],
  ["{hookDir}\\sub", "placeholder-path-arithmetic"],
  ["{file:plugin.json}", "placeholder-not-allowed-here"],
  ["{prompt}", "placeholder-not-allowed-here"],
])("explains misplaced hook attachment %s without dropping hooks", (argument, reason) => {
  const source = changed(copilot, "hooks.channels.0.arguments", ["--plugin-dir", argument]);
  try {
    parse(source);
    throw Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentManifestError);
    expect(error).toMatchObject({ path: "$.hooks.channels[0].arguments[1]", reason });
    expect(error).toHaveProperty("detail", expect.stringContaining("{hookDir}"));
    expect(error).toHaveProperty("detail", expect.stringContaining("{hookFile:NAME}"));
  }
});

it("detects path suffixes after an earlier authorization substitution", () => {
  const source = changed(
    claude,
    "files.1.content",
    '{"Authorization":"Bearer ${FOOM_CONTROL_TOKEN}","path":{mcpUrl:json}/sub}',
  );
  expect(() => parse(source)).toThrow("placeholder-path-arithmetic");
});

it.each([
  ["setup.status.probe.fallbackArguments", ["plugin", "install", "foom"]],
  ["setup.status.probe.fallbackArguments", ["plugin", "list", "--all"]],
  ["setup.status.probe.arguments", ["plugin", "list", "--all"]],
])("rejects unsafe setup compatibility argv at %s", (path, args) => {
  expect(() => parse(changed(agy, path, args))).toThrow();
});
