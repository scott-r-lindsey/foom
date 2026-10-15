import { PluginSetup } from "../../../../src/main/agents/plugin-setup";
import { afterEach, expect, it, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
import hookFixture from "../../../fixtures/agent-plugins-v2/claude.json";
import setupFixture from "../../../fixtures/agent-plugins-v2/agy.json";
import healthFixture from "../../../fixtures/agent-plugins-v2/codex.json";
import { AgyPlugin } from "../../../../src/main/agents/agy-plugin";
import fixture from "../../../fixtures/agent-plugin-v2.json";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { availableV2, v2Provider } from "../../../../src/main/agents/providers/v2";
import {
  boundedArguments,
  bypassEnvironment,
  collectMerge,
  discoveryFacts,
  expandV2,
  matchesArguments,
  selected,
} from "../../../../src/main/agents/providers/v2-values";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import {
  parseAgentArguments,
  parseAgentDefaults,
  hasBypassArgument,
  recoverAgentDefaults,
} from "../../../../src/main/agents/default-arguments";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { detectAgent } from "../../../../src/main/evaluator/agent-rules";
import { pluginDisclosure } from "../../../../src/main/agents/providers/disclosure";
import type { AgentManifestV2 } from "../../../../src/shared/agent-manifest-v2";
import type { AgentLaunch } from "../../../../src/shared/agents";
import type { ControlLaunch } from "../../../../src/main/control/types";
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => {
    dispose();
  });
  replaceConfigProviders([]);
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing test value");
  return value;
}
function model(data: unknown = fixture): AgentManifestV2 {
  const parsed = parseAgentManifest(JSON.stringify(data));
  if (parsed.version !== 2) throw Error("v2 fixture required");
  return parsed.model;
}
const request: AgentLaunch = {
  agent: fixture.id,
  repository: "/repo",
  worktree: "/repo/tree",
  cols: 80,
  rows: 24,
};
const control: ControlLaunch = {
  env: {
    FOOM_CONTROL_URL: "http://127.0.0.1:23456/control/v1",
    FOOM_CONTROL_TOKEN: "must-stay-private",
  },
  bind: () => undefined,
  dispose: () => undefined,
};
async function launch(
  m = model(),
  changes: Partial<AgentLaunch> = {},
  defaults: readonly string[] = [],
  grant?: ControlLaunch,
  config = false,
  version = "fixture 1.2.3",
  help = "--inline --prompt --mcp",
) {
  const provider = v2Provider(m, () => Promise.resolve());
  const install = provider.discover("/fake/fixture-v2", version, help);
  const prepared = await provider.prepareLaunch?.(
    install,
    { ...request, ...changes },
    defaults,
    grant,
    config,
    true,
  );
  if (!prepared) throw Error("Missing preparation");
  cleanup.push(() => {
    prepared.dispose();
  });
  return { provider, install, prepared };
}
it("uses stable numeric versions, complete option boundaries and earlier fact dependencies", () => {
  const m = model();
  const facts = (version: string, help = "--inline --prompt --mcp") =>
    discoveryFacts(m, version, help, {});
  expect(facts("fixture 1.2.3")).toMatchObject({
    inline: true,
    promptSupport: true,
    verified: true,
  });
  expect(facts("fixture 999.0.0 (fixture)")["verified"]).toBe(true);
  for (const version of [
    "fixture 1.2.2",
    "fixture 01.2.3",
    "fixture 1.2.3-beta",
    "fixture 9007199254740992.2.3",
    "other 1.2.3",
    "",
  ])
    expect(facts(version)["verified"]).toBe(false);
  expect(facts("fixture 1.2.3", "--inline-extra --promptish --mcpx")["verified"]).toBe(false);
  expect(facts("fixture 2.0.0", "  --inline=ARG,\n --prompt ARG\n --mcp, X")["verified"]).toBe(
    true,
  );
  m.discovery.version = undefined;
  expect(facts("anything")["inline"]).toBe(true);
  required(m.discovery.facts[0]).minimum = [1, 0, 0];
  expect(facts("1.2.3")["inline"]).toBe(false);
  required(m.discovery.facts[1]).enabled = false;
  expect(facts("anything")["promptSupport"]).toBe(false);
});
it("evaluates absent and missing facts fail-closed with all/any semantics", () => {
  const m = model();
  const condition = (
    op: "eq" | "in" | "exists" | "absent" | "lt" | "gte",
    value?: string | number | (string | number)[],
  ) => ({ all: [{ field: "v", op, value }], any: undefined });
  expect(selected(undefined, {})).toBe(true);
  expect(selected(condition("absent"), {})).toBe(true);
  expect(selected(condition("exists"), {})).toBe(false);
  expect(selected(condition("exists"), { v: false })).toBe(true);
  expect(selected(condition("eq", "yes"), { v: "yes" })).toBe(true);
  expect(selected(condition("eq", "yes"), {})).toBe(false);
  expect(selected(condition("in", ["yes", 1]), { v: "yes" })).toBe(true);
  expect(selected(condition("in", ["yes"]), { v: false })).toBe(false);
  expect(selected(condition("lt", 2), { v: 1 })).toBe(true);
  expect(selected(condition("gte", 2), { v: 2 })).toBe(true);
  expect(selected(condition("gte", 2), { v: "2" })).toBe(false);
  expect(
    selected(
      { all: [], any: [{ field: { source: "facts", path: ["inline"] }, op: "eq", value: true }] },
      discoveryFacts(m, "fixture 1.2.3", "--inline", {}),
    ),
  ).toBe(true);
});
it("matches every protected and bypass argv form without cancellation inference", () => {
  const m = model();
  const protectedArgs = [
    "--resume",
    "--resume=abc",
    "-rabc",
    "-c",
    "x.hooks.Stop=0",
    "--config='notify'=0",
    "-c=x.notify=0",
    "-c x",
  ];
  for (const args of [
    [required(protectedArgs[0])],
    [required(protectedArgs[1])],
    [required(protectedArgs[2])],
    ["-c", "x.hooks.Stop=0"],
    [required(protectedArgs[5])],
    [required(protectedArgs[6])],
  ])
    expect(matchesArguments(m.reservedArguments, args)).toBe(true);
  expect(matchesArguments(m.reservedArguments, ["--configuration=notify=0", "ordinary"])).toBe(
    false,
  );
  for (const args of [
    ["--yolo", "--safe"],
    ["--yolo=no"],
    ["--policy", "bypass"],
    ["--policy=bypass"],
  ])
    expect(matchesArguments(m.bypassArguments, args)).toBe(true);
  expect(matchesArguments(m.bypassArguments, ["--policy", "safe"])).toBe(false);
  const matcher = parseAgentManifest(
    JSON.stringify({
      ...fixture,
      bypassArguments: [
        { word: "unsafe" },
        { flag: "-s", forms: ["attached-short"], value: "danger" },
        { override: { flags: ["-c", "--config"], keys: ["sandbox_mode"], value: "danger" } },
      ],
    }),
  ).model;
  for (const args of [
    ["unsafe"],
    ["-sdanger"],
    ["-s=danger"],
    ["-c", 'x."sandbox_mode" = "danger"'],
    ["--config=x.sandbox_mode='danger'"],
    ["-cx.sandbox_mode=danger"],
  ])
    expect(matchesArguments(matcher.bypassArguments, args)).toBe(true);
  expect(matchesArguments(matcher.bypassArguments, ["--config=x.sandbox_mode='safe'", "-s"])).toBe(
    false,
  );
  replaceConfigProviders([v2Provider(m, () => Promise.resolve())]);
  expect(() => parseAgentArguments(m.id, ["--resume=abc"])).toThrow("reserved");
  expect(() => parseAgentDefaults({ claude: [], codex: [], agy: [], [m.id]: ["-rabc"] })).toThrow(
    "reserved",
  );
  expect(parseAgentArguments(m.id, ["ordinary"])).toEqual(["ordinary"]);
  expect(hasBypassArgument(m.id, ["--yolo"])).toBe(true);
  expect(hasBypassArgument(m.id, [])).toBe(false);
});
it("checks environment names and predicates without returning any values", () => {
  const m = model();
  expect(bypassEnvironment(m, { FIXTURE_BYPASS: "a-secret" })).toEqual([
    "FIXTURE_BYPASS: present-nonempty",
  ]);
  expect(bypassEnvironment(m, { fixture_bypass: "a-secret" }, false)).toEqual([]);
  expect(bypassEnvironment(m, { fixture_bypass: "a-secret" }, true)).toHaveLength(1);
  expect(bypassEnvironment(m, { FIXTURE_BYPASS: "" })).toEqual([]);
  expect(bypassEnvironment(m, { FIXTURE_BYPASS: false })).toEqual([]);
  m.bypassEnvironment = [
    { name: "FLAG", match: "values", values: ["TRUE"], caseInsensitive: true, trim: true },
  ];
  expect(bypassEnvironment(m, { FLAG: " true " })).toEqual(["FLAG: values"]);
  required(m.bypassEnvironment[0]).caseInsensitive = false;
  expect(bypassEnvironment(m, { FLAG: "true" })).toEqual([]);
});
it("expands once, quotes typed data and refuses missing substitutions and expanded limits", () => {
  expect(expandV2("{prompt}", { prompt: "{mcpName}" })).toBe("{mcpName}");
  expect(expandV2("{mcpUrl:json} {mcpName:toml}", { mcpUrl: 'a"b', mcpName: "server" })).toBe(
    '"a\\"b" "server"',
  );
  expect(() => expandV2("{file:no.json}", {})).toThrow("substitution");
  expect(boundedArguments(["a\nb\tc"])).toEqual(["a\nb\tc"]);
  for (const args of [
    Array<string>(257).fill("a"),
    ["x".repeat(20481)],
    Array<string>(4).fill("x".repeat(20000)),
    ["\u0000"],
  ])
    expect(() => boundedArguments(args)).toThrow("limits");
});
it("merges aliases, equals and variadic tools with balanced parentheses and literal prompt values", () => {
  const merge = required(required(model().launch.toolPermissions).merge);
  expect(
    collectMerge(
      ["--allowed=Bash(git status, git log),Read", "--allow", "Read", "Write", "--safe"],
      merge,
    ),
  ).toEqual({ args: ["--safe"], values: ["Bash(git status, git log)", "Read", "Read", "Write"] });
  for (const arg of ["--allow=Bad(", "--allow=Bad)"])
    expect(() => collectMerge([arg], merge)).toThrow("Unbalanced");
  expect(() => collectMerge(["--allow", "--safe"], merge)).toThrow("missing");
  expect(
    collectMerge(
      ["--prompt", "user prompt with spaces", "-i=other"],
      required(required(model().launch.guidance).merge),
      false,
    ).values,
  ).toEqual(["user prompt with spaces", "other"]);
  expect(
    collectMerge(["--prompt=a b"], required(required(model().launch.guidance).merge)).values,
  ).toEqual(["a", "b"]);
});
it("prepares ordered argv, UUID, display and prompt; resume adds no greeting or new ID", async () => {
  const fresh = await launch();
  expect(fresh.prepared.args).toEqual(["--session", expect.any(String), "--ordinary", "--inline"]);
  expect(fresh.prepared.conversationId).toMatch(/^[a-f0-9-]{36}$/u);
  const resumed = await launch(model(), { conversationId: "saved-1" }, ["--user"], undefined, true);
  expect(resumed.prepared.args).toEqual([
    "--resume",
    "saved-1",
    "--user",
    "--ordinary",
    "--inline",
  ]);
  expect(resumed.prepared.conversationId).toBeUndefined();
  expect(fresh.provider.resume("saved-1")).toEqual(["--resume", "saved-1"]);
  expect(() => fresh.provider.resume("invalid!")).toThrow("Invalid");
  await expect(fresh.provider.enrich(fresh.install, new AgyPlugin())).resolves.toEqual(
    fresh.install,
  );
  expect(fresh.provider.needsNotifier(fresh.install, undefined)).toBe(false);
  await expect(fresh.provider.prepareMcp("http://example.com")).rejects.toThrow("context");
  expect(() =>
    fresh.provider.arguments(fresh.install, request, [], [], undefined, undefined, false, false),
  ).toThrow("preparation");
  const greeting = await launch(model(), {}, [], undefined, true);
  expect(greeting.prepared.args.at(-1)).toContain("greet the user");
  const unsupported = await launch(model(), {}, [], undefined, true, "fixture 1.2.3", "--inline");
  expect(unsupported.prepared.args).not.toContain("--prompt");
  for (const prompt of ["", "-flag", "\u001b", "x".repeat(16385)])
    await expect(launch(model(), { prompt })).rejects.toThrow("Invalid");
  await expect(
    launch(model(), { prompt: "task" }, [], undefined, false, "fixture 0.0.0"),
  ).rejects.toThrow("cannot take");
  const m = model();
  m.launch.resume = undefined;
  m.conversation.newId = undefined;
  m.launch.display = undefined;
  m.launch.arguments = undefined;
  const minimal = await launch(m);
  expect(minimal.prepared.args).toEqual([]);
  expect(() => minimal.provider.resume("saved")).toThrow("cannot resume");
  await expect(launch(m, { conversationId: "saved" })).rejects.toThrow("cannot resume");
});
it("writes private MCP data, merges preview grants and cleans on disposal and failures", async () => {
  const { prepared } = await launch(
    model(),
    { prompt: "do {mcpName} safely" },
    [
      "--prompt",
      "human text",
      "-i=more",
      "--allow=Read,Bash(git status, git log)",
      "--allowed",
      "Read",
    ],
    control,
  );
  expect(prepared.mcp).toBe(true);
  const path = prepared.args[prepared.args.indexOf("--mcp") + 1];
  if (!path) throw Error("Missing MCP path");
  const data = await readFile(path, "utf8");
  expect(data).toContain("Bearer ${FOOM_CONTROL_TOKEN}");
  expect(data).not.toContain("must-stay-private");
  expect(prepared.args.join(" ")).not.toContain("must-stay-private");
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(prepared.args.at(-1)).toContain("human text\n\nmore\n\nTask from your Foom orchestrator");
  expect(prepared.args.at(-1)).toContain("do {mcpName} safely");
  expect(prepared.args.filter((arg) => arg === "Read")).toHaveLength(1);
  expect(
    prepared.args.filter((arg) =>
      /^mcp__foom_.*__(?:open_preview|list_previews|close_preview)$/u.test(arg),
    ),
  ).toHaveLength(3);
  prepared.dispose();
  await vi.waitFor(async () => {
    await expect(stat(path)).rejects.toThrow();
  });
  for (const url of [
    "https://127.0.0.1:3/control/v1",
    "http://localhost:3/control/v1",
    "http://127.0.0.1/control/v1",
    "http://127.0.0.1:3/other",
    "http://a:b@127.0.0.1:3/control/v1",
    "http://127.0.0.1:3/control/v1?q",
    "http://127.0.0.1:3/control/v1#q",
  ])
    await expect(
      launch(model(), {}, [], { ...control, env: { FOOM_CONTROL_URL: url } }),
    ).rejects.toThrow("endpoint");
  await expect(launch(model(), {}, ["--allow=Bad("], control)).rejects.toThrow("Unbalanced");
  const m = model();
  required(m.files[0]).content = "broken JSON";
  await expect(launch(m, {}, [], control)).rejects.toThrow("invalid-template");
});
it("supports file-free server-parentheses grants, conditional blocks and alternate order", async () => {
  const m = model();
  m.files = [];
  required(m.launch.mcp).arguments = ["--server", "{mcpName}", "{mcpUrl}"];
  required(m.launch.toolPermissions).merge = undefined;
  required(m.launch.toolPermissions).format = "server-parentheses";
  m.launch.guidance = undefined;
  m.launch.order = [
    "arguments",
    "resume",
    "defaults",
    "display",
    "guidance",
    "hooks",
    "mcp",
    "tools",
    "prompt",
  ];
  const result = await launch(m, { conversationId: "saved", prompt: "task" }, ["--user"], control);
  expect(result.prepared.args.slice(0, 5)).toEqual([
    "--ordinary",
    "--resume",
    "saved",
    "--user",
    "--inline",
  ]);
  expect(result.prepared.args.filter((arg) => /foom_.*\(open_preview\)/u.test(arg))).toHaveLength(
    1,
  );
  required(m.launch.arguments).when = {
    all: [{ field: "control", op: "eq", value: false }],
    any: undefined,
  };
  required(m.launch.resume).when = {
    all: [{ field: "control", op: "eq", value: false }],
    any: undefined,
  };
  await expect(launch(m, { conversationId: "saved" }, [], control)).rejects.toThrow(
    "cannot resume",
  );
  const noMcp = await launch(m, {}, ["--allow=Bad("], undefined);
  expect(noMcp.prepared.mcp).toBe(false);
  expect(noMcp.prepared.args).toContain("--allow=Bad(");
});
it("supports hooks, health and setup, reviews the whole surface, and applies approved attention rules", () => {
  const m = model();
  for (const source of [hookFixture, healthFixture])
    expect(() => {
      availableV2(model({ ...source, id: fixture.id }));
    }).not.toThrow();
  const setup = model({ ...setupFixture, id: fixture.id });
  expect(() => {
    availableV2(setup);
  }).toThrow("v2-observer-staging-unavailable");
  setup.files = setup.files.filter(
    (file) => file.scope !== "plugin" || !file.content.includes("{observer"),
  );
  expect(() => {
    availableV2(setup);
  }).not.toThrow();
  replaceConfigProviders([v2Provider(m, () => Promise.resolve())]);
  expect(detectAgent(m.id, { title: "Working", progress: null }, [])?.id).toBe("working");
  const disclosure = pluginDisclosure(m, {
    file: "agents/fixture-v2.json",
    digest: "byte-digest",
    text: "exact bytes",
    previous: "old bytes",
  });
  const text = JSON.stringify(disclosure);
  for (const section of [
    "byte-digest",
    "old bytes",
    "exact bytes",
    "bypassEnvironment",
    "reservedArguments",
    "resumePaste",
    "execution",
    "CLI",
    "setup",
    "prompt",
  ])
    expect(text).toContain(section);
  expect(pluginDisclosure(m).sections?.length).toBeGreaterThan(10);
  for (const section of disclosure.sections ?? [])
    expect(section.items.every((item) => typeof item === "string")).toBe(true);
});

it("recovers only invalid provider defaults and keeps immutable approved launch data", async () => {
  const m = model();
  const provider = v2Provider(m, () => Promise.resolve());
  replaceConfigProviders([provider]);
  expect(
    recoverAgentDefaults({
      claude: ["--model", "safe"],
      codex: [],
      agy: [],
      [m.id]: ["--resume=reserved"],
      other: ["--ordinary"],
    }),
  ).toEqual({ claude: ["--model", "safe"], codex: [], agy: [], [m.id]: [], other: ["--ordinary"] });
  required(m.launch.arguments).arguments.push("--yolo");
  const installation = provider.discover("/fake/fixture-v2", "fixture 1.2.3", "--prompt");
  const prepared = await provider.prepareLaunch?.(
    installation,
    request,
    [],
    undefined,
    false,
    false,
  );
  expect(prepared?.args).not.toContain("--yolo");
  prepared?.dispose();
  expect(Object.isFrozen(provider.model?.launch)).toBe(true);
});

it("guidance merge emits its declared canonical flag and preserves literal prompt text", async () => {
  const m = model();
  required(m.launch.guidance).merge = {
    flags: ["--prompt", "-i"],
    output: "-i",
    separators: "whitespace",
  };
  const prepared = await launch(m, {}, ["--prompt=hello, literal text"], control);
  expect(prepared.prepared.args.at(-2)).toBe("-i");
  expect(prepared.prepared.args.at(-1)).toContain("hello, literal text\n\nFoom provides");
});

it("approved provider attention remains human-only metadata", () => {
  const m = model();
  m.attention.rules.push({
    id: "capacity",
    state: "blocked",
    priority: 500,
    region: "title",
    match: { contains: ["Capacity"], regex: [] },
    reason: "Provider unavailable",
    lines: undefined,
    not: [],
    comment: "Fixture",
  });
  m.execution.providerRules = ["capacity"];
  replaceConfigProviders([v2Provider(m, () => Promise.resolve())]);
  expect(
    evaluateRules({
      terminalId: "fixture",
      agent: m.id,
      evidence: { title: "Capacity", progress: null },
      tail: [],
    }),
  ).toMatchObject({ state: "needs_input", attentionKind: "provider" });
});

it("restoration evaluates MCP capability for a resume invocation", async () => {
  const m = model();
  required(m.launch.mcp).when?.all?.push({ field: "resume", op: "eq", value: true });
  const fresh = await launch(m, {}, [], control);
  expect(fresh.install.mcp).toBe(true);
  expect(fresh.install.restoreControl).toBe(true);
  expect(fresh.prepared.mcp).toBe(false);
  const resume = await launch(m, { conversationId: "saved" }, [], control);
  expect(resume.prepared.mcp).toBe(true);
  required(m.launch.mcp).when?.all?.pop();
  required(m.launch.mcp).when?.all?.push({ field: "resume", op: "eq", value: false });
  const freshOnly = await launch(m, {}, [], control);
  expect(freshOnly.install.mcp).toBe(true);
  expect(freshOnly.install.restoreControl).toBe(false);
});

it("materializes a validated private TOML MCP file with environment-only authentication", async () => {
  const data = structuredClone(fixture);
  required(data.files[0]).name = "config/mcp.toml";
  required(data.files[0]).format = "toml";
  required(data.files[0]).content =
    '[mcp_servers.{mcpName:toml}]\nurl = {mcpUrl:toml}\nbearer_token_env_var = "FOOM_CONTROL_TOKEN"';
  data.launch.mcp.arguments = ["--mcp", "{file:config/mcp.toml}"];
  const result = await launch(model(data), {}, [], control);
  const file = result.prepared.args[result.prepared.args.indexOf("--mcp") + 1];
  if (!file) throw Error("Missing TOML attachment");
  const text = await readFile(file, "utf8");
  expect(text).toContain('bearer_token_env_var = "FOOM_CONTROL_TOKEN"');
  expect(text).toContain('url = "http://127.0.0.1:23456/mcp"');
  expect(text).not.toContain("must-stay-private");
});

it("an empty preview-grant subset emits no empty permission option and still preserves user rules", async () => {
  const m = model();
  required(m.launch.toolPermissions).names = [];
  const empty = await launch(m, {}, [], control);
  expect(empty.prepared.mcp).toBe(true);
  expect(empty.prepared.args).not.toContain("--allow");
  const user = await launch(m, {}, ["--allowed=Read"], control);
  expect(
    user.prepared.args.slice(
      user.prepared.args.indexOf("--allow"),
      user.prepared.args.indexOf("--allow") + 2,
    ),
  ).toEqual(["--allow", "Read"]);
  expect(user.prepared.args.some((arg) => arg.startsWith("mcp__foom_"))).toBe(false);
});

it("revokes credentials before deleting files when preparation fails", async () => {
  let revoked = false;
  const remove = fs.rm;
  const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    expect(revoked).toBe(true);
    await remove(...args);
  });
  await expect(
    launch(model(), {}, ["--allow=Broken("], {
      ...control,
      dispose: () => {
        revoked = true;
      },
    }),
  ).rejects.toThrow("Unbalanced");
  expect(cleanup).toHaveBeenCalledOnce();
});

it("derives setup facts after status enrichment and re-probes before launch", async () => {
  const m = model();
  m.setup = model({ ...setupFixture, id: fixture.id }).setup;
  m.discovery.facts.push({
    id: "pluginReady",
    enabled: true,
    minimum: undefined,
    helpTokens: [],
    when: { all: [{ field: "setupState", op: "eq", value: "installed" }], any: undefined },
  });
  required(m.launch.mcp).when = {
    all: [{ field: "pluginReady", op: "eq", value: true }],
    any: undefined,
  };
  const status = vi
    .spyOn(PluginSetup.prototype, "status")
    .mockResolvedValue({ state: "installed", actions: [] });
  try {
    const provider = v2Provider(m, () => Promise.resolve());
    const initial = provider.discover("/fixture/cli", "fixture 1.2.3", "--inline --prompt --mcp");
    expect(initial.mcp).toBe(false);
    const enriched = await provider.enrich(initial, new AgyPlugin());
    expect(enriched.mcp).toBe(true);
    expect(provider.setupFacts?.("/missing", {})).toHaveProperty("pluginReady", false);
    const prepared = await provider.prepareLaunch?.(enriched, request, [], control, false, true);
    expect(prepared?.mcp).toBe(true);
    prepared?.dispose();
    expect(status).toHaveBeenCalledTimes(2);
    await provider.enrich({ ...initial, path: null }, new AgyPlugin());
  } finally {
    status.mockRestore();
  }
});
