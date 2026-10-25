import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import {
  extensionAsset,
  assertExtensionIntegrity,
} from "../../../../src/main/agents/providers/extension-assets";
import { prepareV2Hooks } from "../../../../src/main/agents/providers/v2-hook-launch";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import data from "../../../../src/shared/bundled-agents/pi.json";
import { reduceV2 } from "../../../../src/main/agents/providers/v2-events";

const conversationId = "12345678-1234-4567-8910-123456789abc";
const env = {
  FOOM_HOOK_PROTOCOL: "1",
  FOOM_HOOK_CHANNELS: '["lifecycle"]',
  FOOM_TOKEN: "a".repeat(64),
  FOOM_SESSION: conversationId,
  FOOM_HOOK_URL: "http://127.0.0.1:1234/hooks",
  FOOM_CONTROL_TOKEN: "b".repeat(64),
};
const mcp = {
  name: `foom_${"c".repeat(32)}`,
  url: "http://127.0.0.1:1234/mcp",
  tools: ["manual", "handoff"],
};
const ctx = { sessionManager: { getSessionId: () => conversationId }, isIdle: () => false };
type Handler = (event: Record<string, unknown>, context: typeof ctx) => unknown;
interface FakePi {
  on(name: string, handler: Handler): void;
  registerMcpServer: ReturnType<typeof vi.fn>;
  unregisterMcpServer: ReturnType<typeof vi.fn>;
}
function factory(value: unknown): value is (pi: FakePi) => void {
  return typeof value === "function";
}
function runtime(
  environment: Record<string, string> = env,
  config: unknown = { channel: "lifecycle", mcp },
  fail = false,
  capabilities: unknown = ["manual"],
  hang = false,
) {
  const handlers = new Map<string, Handler>();
  const registered = vi.fn();
  const unregistered = vi.fn();
  const readFileSync = vi.fn(() => JSON.stringify(config));
  const bodies: Record<string, unknown>[] = [];
  const request = vi.fn(
    (_url: URL, _options: unknown, reply: (value: { destroy(): void }) => void) => {
      const req = Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: (body: string) => {
          const parsed: unknown = JSON.parse(body);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
            bodies.push({ ...parsed });
          if (hang) return;
          if (fail) req.emit("error", new Error("receiver gone"));
          else if (_url.pathname === "/control/v1") {
            const response = Object.assign(new EventEmitter(), {
              destroy: vi.fn(),
              statusCode: 200,
            });
            reply(response);
            response.emit("data", Buffer.from(JSON.stringify({ result: { capabilities } })));
            response.emit("end");
          } else reply({ destroy: vi.fn() });
        },
      });
      return req;
    },
  );
  const source = extensionAsset("pi-v1")
    .source.replace(/^import .*;$/gmu, "")
    .replace("import.meta.url", JSON.stringify("file:///private/pi-v1.mjs"))
    .replace("export default function", "capture(function");
  runInNewContext(`${source});`, {
    process: { env: environment },
    readFileSync,
    request,
    URL,
    Buffer,
    setTimeout,
    clearTimeout,
    capture(value: unknown) {
      if (!factory(value)) throw new Error("Invalid fixture factory");
      value({
        on: (name, handler) => {
          const previous = handlers.get(name);
          handlers.set(
            name,
            previous
              ? async (event, context) => {
                  await previous(event, context);
                  return handler(event, context);
                }
              : handler,
          );
        },
        registerMcpServer: registered,
        unregisterMcpServer: unregistered,
      });
    },
  });
  return { handlers, registered, unregistered, readFileSync, request, bodies };
}
afterEach(() => {
  vi.useRealTimers();
});

it("locks the versioned extension bytes and rejects unknown executable ABIs", () => {
  expect(extensionAsset("pi-v1").name).toBe("pi-v1.mjs");
  expect(() => {
    assertExtensionIntegrity("tampered");
  }).toThrow("integrity");
  expect(() => extensionAsset("arbitrary-module")).toThrow("Unknown");
});
it("is inert before reading files when launch credentials are absent or malformed", () => {
  for (const environment of [{}, { FOOM_TOKEN: "wrong", FOOM_CONTROL_TOKEN: "wrong" }]) {
    const r = runtime(environment);
    expect(r.readFileSync).not.toHaveBeenCalled();
    expect(r.handlers.size).toBe(0);
    expect(r.registered).not.toHaveBeenCalled();
  }
});
it("registers only the configured tool names without approval or output hooks", () => {
  const r = runtime();
  expect(r.registered).toHaveBeenCalledExactlyOnceWith(mcp.name, {
    url: mcp.url,
    headers: { Authorization: `Bearer ${env.FOOM_CONTROL_TOKEN}` },
    exposure: "hidden",
    toolExposure: { manual: "direct", handoff: "direct" },
  });
  expect(r.handlers.has("tool_call")).toBe(false);
  expect(r.handlers.has("project_trust")).toBe(false);
  expect(r.handlers.has("agent_end")).toBe(false);
});
it("reduces lifecycle callbacks to bounded fields and never returns a permission or continuation decision", async () => {
  const r = runtime();
  for (const name of [
    "session_start",
    "agent_start",
    "turn_start",
    "turn_end",
    "tool_execution_start",
    "ui_prompt_start",
    "ui_prompt_end",
  ])
    expect(
      await r.handlers.get(name)?.(
        { prompt: "secret", title: "secret", messages: ["secret"] },
        ctx,
      ),
    ).toBeUndefined();
  expect(
    r.handlers.get("agent_before_settle")?.({ outcome: "completed", entries: ["secret"] }, ctx),
  ).toBeUndefined();
  expect(await r.handlers.get("agent_settled")?.({ aborted: false }, ctx)).toBeUndefined();
  expect(r.bodies.at(-1)).toEqual({ event: "agent_settled", conversationId, outcome: "completed" });
  expect(JSON.stringify(r.bodies)).not.toContain("secret");
  expect(r.bodies.every((body) => JSON.stringify(body).length < 512)).toBe(true);
  expect(r.request.mock.calls[0]?.[1]).toMatchObject({
    headers: {
      Authorization: env.FOOM_TOKEN,
      "X-Foom-Session": conversationId,
      "X-Foom-Channel": "lifecycle",
    },
  });
  await r.handlers.get("agent_settled")?.({ aborted: true }, ctx);
  expect(r.bodies.at(-1)?.["outcome"]).toBe("aborted");
  r.handlers.get("agent_before_settle")?.({ outcome: "error" }, ctx);
  await r.handlers.get("agent_settled")?.({ aborted: false }, ctx);
  expect(r.bodies.at(-1)?.["outcome"]).toBe("error");
  r.handlers.get("agent_before_settle")?.({ outcome: "unknown" }, ctx);
  const count = r.bodies.length;
  await r.handlers.get("agent_settled")?.({ aborted: false }, ctx);
  await r.handlers.get("agent_start")?.(
    {},
    { ...ctx, sessionManager: { getSessionId: () => "../invalid" } },
  );
  expect(r.bodies).toHaveLength(count);
});
it("fails open on receiver errors and malformed configuration", async () => {
  const r = runtime(env, { channel: "lifecycle" }, true);
  await expect(r.handlers.get("turn_start")?.({}, ctx)).resolves.toBeUndefined();
  expect(runtime(env, null).handlers.size).toBe(0);
  expect(runtime(env, "x".repeat(17000)).handlers.size).toBe(0);
  expect(
    runtime({ ...env, FOOM_HOOK_URL: "http://example.com/hooks" }, { channel: "lifecycle" })
      .handlers.size,
  ).toBe(0);
  expect(runtime({ ...env, FOOM_HOOK_PROTOCOL: "2" }, { channel: "lifecycle" }).handlers.size).toBe(
    0,
  );
  expect(runtime(env, { channel: "foreign" }).handlers.size).toBe(0);
  expect(runtime(env, { mcp: { ...mcp, tools: ["*"] } }).registered).not.toHaveBeenCalled();
  expect(
    runtime(env, { mcp: { ...mcp, url: "http://127.0.0.1:1234/mcp?secret" } }).registered,
  ).not.toHaveBeenCalled();
});

const provider = agentProvider("pi");
const launchRequest = { agent: "pi", repository: "/repo", worktree: "/repo", cols: 80, rows: 24 };
const installation = () =>
  provider.discover("/fixture/pi", "1.4.0", "--extension --session-id --session");
it("attaches private fixed bytes, both with hooks and MCP and with either capability alone, and removes them on release", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "foom-pi-extension-"));
  const revoke = vi.fn();
  const receiver = { register: () => ({ env, revoke }) };
  try {
    for (const [hooks, control] of [
      [true, true],
      [false, true],
      [true, false],
    ]) {
      const binding = hooks
        ? await prepareV2Hooks(receiver, provider.model, vi.fn(), false, scratch)
        : undefined;
      const prepared = await provider.prepareLaunch(
        installation(),
        launchRequest,
        [],
        control
          ? {
              env: {
                FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
                FOOM_CONTROL_TOKEN: env.FOOM_CONTROL_TOKEN,
              },
              toolNames: ["manual"],
              dispose: vi.fn(),
            }
          : undefined,
        false,
        Boolean(hooks),
        binding,
      );
      try {
        const path = prepared.args[prepared.args.indexOf("--extension") + 1];
        if (!path) throw new Error("Missing extension path");
        expect(prepared.args.filter((arg) => arg === "--extension")).toHaveLength(1);
        expect(await readFile(path, "utf8")).toBe(extensionAsset("pi-v1").source);
        const config = await readFile(join(dirname(path), "launch.json"), "utf8");
        expect(config).not.toContain(env.FOOM_TOKEN);
        expect(config).not.toContain(env.FOOM_CONTROL_TOKEN);
        expect(JSON.parse(config)).toMatchObject(
          control ? { mcp: { tools: ["manual"] } } : { channel: "lifecycle" },
        );
        expect(prepared.mcp).toBe(control);
        if (hooks) expect(binding?.v2?.channels.has("lifecycle")).toBe(true);
        if (process.platform !== "win32") {
          expect((await stat(path)).mode & 0o777).toBe(0o600);
          expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
        }
        prepared.dispose();
        expect(existsSync(path)).toBe(false);
      } finally {
        prepared.dispose();
      }
    }
    expect(revoke).toHaveBeenCalledTimes(2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
it("supports restore discovery only on the measured version and complete extension flag", () => {
  expect(installation()).toMatchObject({ hooks: true, mcp: true, restoreControl: true });
  expect(provider.discover("/fixture/pi", "1.4.0-beta", "--extension")).toMatchObject({
    hooks: false,
    mcp: false,
  });
  expect(provider.discover("/fixture/pi", "1.4.0", "--extension-other")).toMatchObject({
    hooks: false,
    mcp: false,
  });
});
it("uses only ping tools in isolated verification providers", async () => {
  const verification = v2Provider(provider.model, () => Promise.resolve(), true);
  const found = verification.discover("/fixture/pi", "1.4.0", "--extension");
  const prepared = await verification.prepareLaunch(
    found,
    launchRequest,
    [],
    { env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" }, dispose: vi.fn() },
    false,
    false,
  );
  try {
    const path = prepared.args.at(-1);
    if (!path) throw new Error("Missing extension");
    expect(JSON.parse(await readFile(join(dirname(path), "launch.json"), "utf8"))).toMatchObject({
      mcp: { tools: ["ping"] },
    });
  } finally {
    prepared.dispose();
  }
});
it.each([
  { source: "evil" },
  { path: "/evil" },
  { api: "arbitrary" },
  { channel: "missing" },
  { arguments: ["--extension", "{extensionFile}/evil"] },
  { arguments: ["--extension", "{file:evil}"] },
  { arguments: ["--extension"] },
  { when: { all: [{ field: "missing", op: "eq", value: true }] } },
])("rejects manifest-supplied code and invalid extension references: %j", (change) => {
  expect(() =>
    parseAgentManifest(
      JSON.stringify({
        ...data,
        id: "pi-copy",
        launch: { ...data.launch, extension: { ...data.launch.extension, ...change } },
      }),
    ),
  ).toThrow();
});

it("validates lifecycle payloads and pins identity through the existing reducer", () => {
  const channel = provider.model.hooks?.channels[0];
  if (!channel) throw new Error("Missing lifecycle channel");
  const state = {};
  const reduce = (payload: unknown) =>
    reduceV2(channel, state, "terminal", "pi", payload, undefined, undefined);
  expect(reduce({ event: "session_start", conversationId, prompt: "discard" })).toMatchObject({
    action: "ready",
    conversationId,
  });
  expect(reduce({ event: "turn_end", conversationId })).toMatchObject({
    action: "working",
    endsTurn: false,
  });
  expect(reduce({ event: "agent_end", conversationId })).toBeUndefined();
  expect(reduce({ event: "ui_prompt_start", conversationId })).toMatchObject({
    action: "needs_input",
  });
  expect(reduce({ event: "ui_prompt_end", conversationId, fullyIdle: false })).toMatchObject({
    action: "working",
  });
  expect(reduce({ event: "ui_prompt_end", conversationId, fullyIdle: true })).toMatchObject({
    action: "classify",
    endsTurn: false,
  });
  expect(reduce({ event: "agent_settled", conversationId, outcome: "completed" })).toMatchObject({
    action: "classify",
    endsTurn: true,
  });
  for (const outcome of ["aborted", "error"])
    expect(reduce({ event: "agent_settled", conversationId, outcome })).toMatchObject({
      action: "failed",
      endsTurn: true,
    });
  expect(() => reduce({ event: "agent_settled", conversationId, outcome: "unknown" })).toThrow(
    "required",
  );
  expect(() => reduce({ event: "agent_start", conversationId: "foreign" })).toThrow("conversation");
});

it("filters MCP exposure by authenticated current capabilities and refreshes role changes before work", async () => {
  const capabilities = ["manual"];
  const r = runtime(
    env,
    { channel: "lifecycle", mcp: { ...mcp, roleAware: true } },
    false,
    capabilities,
  );
  expect(r.registered).not.toHaveBeenCalled();
  await r.handlers.get("session_start")?.({}, ctx);
  expect(r.registered.mock.calls.at(-1)?.[1]).toMatchObject({ toolExposure: { manual: "direct" } });
  capabilities.push("handoff", "unregistered_tool");
  await r.handlers.get("before_agent_start")?.({}, ctx);
  expect(r.registered.mock.calls.at(-1)?.[1]).toMatchObject({
    toolExposure: { manual: "direct", handoff: "direct" },
  });
  await r.handlers.get("before_agent_start")?.({}, ctx);
  expect(r.registered).toHaveBeenCalledTimes(2);
  capabilities.splice(1);
  await r.handlers.get("before_agent_start")?.({}, ctx);
  expect(r.registered.mock.calls.at(-1)?.[1]).toMatchObject({ toolExposure: { manual: "direct" } });
});
it("withdraws tools if current authority cannot be established while retaining observers", async () => {
  for (const [fail, capabilities] of [
    [true, []],
    [false, [123]],
    [false, null],
  ]) {
    const r = runtime(
      env,
      { channel: "lifecycle", mcp: { ...mcp, roleAware: true } },
      Boolean(fail),
      capabilities,
    );
    await r.handlers.get("session_start")?.({}, ctx);
    expect(r.registered).not.toHaveBeenCalled();
    expect(r.unregistered).toHaveBeenCalledWith(mcp.name);
    expect(r.handlers.has("turn_start")).toBe(true);
  }
});

it("keeps hook-only and MCP-only credentials independent", () => {
  const hooks = runtime({ ...env, FOOM_CONTROL_TOKEN: "" });
  expect(hooks.registered).not.toHaveBeenCalled();
  expect(hooks.handlers.has("turn_start")).toBe(true);
  const tools = runtime({ FOOM_CONTROL_TOKEN: env.FOOM_CONTROL_TOKEN });
  expect(tools.registered).toHaveBeenCalledOnce();
  expect(tools.handlers.size).toBe(0);
});
it("bounds stalled delivery to one second and leaves no timer running", async () => {
  vi.useFakeTimers();
  const r = runtime(env, { channel: "lifecycle" }, false, [], true);
  const pending = r.handlers.get("turn_start")?.({}, ctx);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toBeUndefined();
  const result = r.request.mock.results[0];
  if (result?.type !== "return") throw new Error("Missing request");
  expect(result.value.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("revokes and removes the complete launch directory when generated files collide", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "foom-pi-failed-"));
  const revoke = vi.fn();
  const binding = await prepareV2Hooks(
    { register: () => ({ env, revoke }) },
    provider.model,
    vi.fn(),
    false,
    scratch,
  );
  const path = binding.v2?.values["hookDir"];
  const collision = parseAgentManifest(
    JSON.stringify({
      ...data,
      id: "pi-copy",
      files: [{ name: "extension/pi-v1.mjs", scope: "launch", format: "json", content: "{}" }],
    }),
  ).model;
  const copy = v2Provider(collision, () => Promise.resolve());
  const found = copy.discover("/fixture/pi", "1.4.0", "--extension");
  try {
    await expect(
      copy.prepareLaunch(
        found,
        { ...launchRequest, agent: "pi-copy" },
        [],
        undefined,
        false,
        true,
        binding,
      ),
    ).rejects.toThrow();
    expect(revoke).toHaveBeenCalledOnce();
    expect(typeof path === "string" && existsSync(path)).toBe(false);
  } finally {
    binding.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
});

it("marks ordinary control attachments for current-role discovery without putting credentials in files", async () => {
  const prepared = await provider.prepareLaunch(
    installation(),
    launchRequest,
    [],
    {
      env: {
        FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
        FOOM_CONTROL_TOKEN: env.FOOM_CONTROL_TOKEN,
      },
      dispose: vi.fn(),
    },
    false,
    false,
  );
  try {
    const file = prepared.args.at(-1);
    if (!file) throw new Error("Missing extension file");
    expect(JSON.parse(await readFile(join(dirname(file), "launch.json"), "utf8"))).toMatchObject({
      mcp: { roleAware: true },
    });
    expect(prepared.mcpArguments).toEqual(["--extension", file]);
    expect(prepared.args.join(" ")).not.toContain(env.FOOM_CONTROL_TOKEN);
  } finally {
    prepared.dispose();
  }
});
it("rejects extension placeholders outside their attachment and conditions that do not select the adapter", () => {
  const manifest = () => structuredClone({ ...data, id: "pi-copy" });
  const outside = manifest();
  outside.launch.resume.arguments = ["--session", "{conversationId}", "{extensionFile}"];
  expect(() => parseAgentManifest(JSON.stringify(outside))).toThrow("placeholder-not-allowed");
  const unselected = manifest();
  unselected.launch.extension.when.all.push({ field: "control", op: "eq", value: true });
  expect(() => parseAgentManifest(JSON.stringify(unselected))).toThrow("incompatible-combination");
});
