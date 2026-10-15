import * as fs from "node:fs/promises";
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { execFile } from "node:child_process";
import lifecycle from "../../../fixtures/agent-plugins-v2/codex.json";
import stdin from "../../../fixtures/agent-plugins-v2/claude.json";
import ordered from "../../../fixtures/agent-plugins-v2/agy.json";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { prepareHookLaunch } from "../../../../src/main/agents/providers/hook-launch";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import {
  reduceV2,
  selectValue,
  eventCondition,
} from "../../../../src/main/agents/providers/v2-events";
import { V2Health, V2ExecutionHooks } from "../../../../src/main/agents/providers/v2-health";
import {
  observerAssets,
  observerInvocation,
  observerVersion,
} from "../../../../src/main/agents/providers/v2-observers";
import { prepareV2Hooks } from "../../../../src/main/agents/providers/v2-hook-launch";
import { privateDirectory } from "../../../../src/main/control/private-files";
import type { AgentManifestV2, ManifestChannel } from "../../../../src/shared/agent-manifest-v2";
import type { HookLaunch, HookSignal } from "../../../../src/shared/hooks";
import type { V2HookState } from "../../../../src/shared/v2-hooks";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  replaceConfigProviders([]);
});
function model(data: unknown = lifecycle): AgentManifestV2 {
  if (typeof data !== "object" || data === null) throw Error("Invalid fixture");
  const parsed = parseAgentManifest(JSON.stringify({ ...data, id: "fixture-hooks" }));
  parsed.model.setup = undefined;
  return parsed.model;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing fixture value");
  return value;
}
function channel(m = model(), index = 0): ManifestChannel {
  return required(m.hooks?.channels[index]);
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "v2-hooks-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function post(launch: HookLaunch, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      launch.env.FOOM_HOOK_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: launch.env.FOOM_TOKEN,
          "X-Foom-Session": launch.env.FOOM_SESSION,
          "X-Foom-Channel": "lifecycle",
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}
const start = { session_id: "conversation-1", hook_event_name: "SessionStart", source: "startup" };
const prompt = {
  session_id: "conversation-1",
  hook_event_name: "UserPromptSubmit",
  turn_id: "turn-1",
};
const stop = { ...prompt, hook_event_name: "Stop", stop_hook_active: false };
it("authenticates before parsing or validating, binds channels, and shares the conversation pin", async () => {
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((signal) => signals.push(signal));
  cleanup.push(() => receiver.close());
  const m = model();
  const state: V2HookState = {};
  const channels = new Map(required(m.hooks).channels.map((entry) => [entry.id, entry]));
  const launch = receiver.register("terminal", m.id, { channels, state });
  expect(await post(launch, "invalid-json", { Authorization: "bad" })).toBe(401);
  expect(await post(launch, "invalid-json")).toBe(400);
  expect(await post(launch, { ...start, source: "bad" })).toBe(400);
  expect(state).toEqual({});
  expect(await post(launch, start, { "X-Foom-Channel": "wrong" })).toBe(400);
  expect(await post(launch, start)).toBe(204);
  expect(signals[0]).toMatchObject({
    action: "ready",
    channel: "lifecycle",
    caseId: "SessionStart",
  });
  expect(
    await post(
      launch,
      { "thread-id": "other", type: "agent-turn-complete", "turn-id": "1" },
      { "X-Foom-Channel": "notify" },
    ),
  ).toBe(400);
  expect(await post(launch, { ...stop, prompt: "never retain me" })).toBe(204);
  expect(JSON.stringify(signals)).not.toContain("never retain me");
  launch.revoke();
  expect(await post(launch, stop)).toBe(401);
});
it("validates requirements and conditional facts before changing state; unknown events stay inert", () => {
  const c = channel();
  const state: V2HookState = {};
  const reduce = (payload: unknown) =>
    reduceV2(c, state, "t", "fixture", payload, undefined, undefined);
  for (const value of [
    null,
    {},
    { ...start, source: false },
    { ...prompt, turn_id: "bad!" },
    { ...stop, stop_hook_active: "false" },
    { ...prompt, hook_event_name: "PreToolUse", tool_name: "" },
  ])
    expect(() => reduce(value)).toThrow();
  expect(reduce({ ...start, hook_event_name: "Unknown" })).toBeUndefined();
  expect(state).toEqual({});
  expect(reduce(start)?.action).toBe("ready");
  expect(reduce(prompt)?.action).toBe("working");
  expect(() => reduce({ ...stop, session_id: "different" })).toThrow();
  const n = channel(model(), 1);
  const cache: V2HookState = {};
  for (let index = 0; index < 129; index++)
    expect(
      reduceV2(
        n,
        cache,
        "t",
        "fixture",
        { "thread-id": "id", type: "agent-turn-complete", "turn-id": String(index) },
        undefined,
        undefined,
      ),
    ).toBeDefined();
  expect(cache.channels?.get(n.id)?.completed?.size).toBe(128);
  expect(
    reduceV2(
      n,
      cache,
      "t",
      "fixture",
      { "thread-id": "id", type: "agent-turn-complete", "turn-id": "128" },
      undefined,
      undefined,
    ),
  ).toBeUndefined();
  expect(() =>
    reduceV2(
      n,
      cache,
      "t",
      "fixture",
      { "thread-id": "id", type: "agent-turn-complete", "turn-id": "!" },
      undefined,
      undefined,
    ),
  ).toThrow();
});
it("maps aliases and ordered Stop cases with monotonic sequence and failure/recovery", () => {
  const c = channel(model(ordered));
  const state: V2HookState = {};
  const reduce = (payload: unknown, event: unknown = "Stop", sequence: unknown = "2") =>
    reduceV2(c, state, "t", "fixture", payload, event, sequence);
  const payload = { conversationId: "id", terminationReason: "NO_TOOL_CALL", fullyIdle: true };
  for (const seq of [null, "0", "01", "2147483648", "-1", 2])
    expect(() => reduce(payload, "Stop", seq)).toThrow();
  for (const changes of [{ terminationReason: "unknown" }, { fullyIdle: "true" }])
    expect(() => reduce({ ...payload, ...changes })).toThrow();
  expect(state).toEqual({});
  expect(reduce(payload)).toMatchObject({
    action: "classify",
    terminationReason: "model_stop",
    fullyIdle: true,
    recoverTurn: true,
  });
  expect(reduce(payload, "Stop", "1")).toBeUndefined();
  expect(reduce(payload)).toBeUndefined();
  expect(reduce({ ...payload, terminationReason: "error" }, "Stop", "3")?.action).toBe("failed");
  expect(reduce({ ...payload, fullyIdle: false }, "Stop", "4")?.action).toBe("working");
  expect(reduce({ conversationId: "id" }, "PreInvocation", "5")?.action).toBe("working");
});
it("resolves only own literal selectors and evaluates all condition operators", () => {
  expect(
    selectValue({ source: "payload", path: ["a", 0, "b"] }, { payload: { a: [{ b: 3 }] } }),
  ).toBe(3);
  expect(selectValue({ source: "payload", path: ["toString"] }, { payload: {} })).toBeUndefined();
  expect(
    selectValue({ source: "payload", path: ["a", "x"] }, { payload: { a: null } }),
  ).toBeUndefined();
  expect(eventCondition(undefined, {}, {})).toBe(true);
  for (const [op, value, actual, expected] of [
    ["eq", 1, 1, true],
    ["eq", 1, undefined, false],
    ["in", [1, 2], 2, true],
    ["in", [1], 3, false],
    ["lt", 3, 2, true],
    ["gte", 3, 3, true],
    ["lt", 3, "2", false],
    ["exists", undefined, false, true],
    ["absent", undefined, undefined, true],
  ] as const) {
    expect(
      eventCondition(
        {
          all: [{ field: "x", op, value: typeof value === "object" ? [...value] : value }],
          any: undefined,
        },
        {},
        { x: actual },
      ),
    ).toBe(expected);
  }
  expect(
    eventCondition(
      { all: [], any: [{ field: { source: "payload", path: ["ok"] }, op: "eq", value: true }] },
      { payload: { ok: true } },
      {},
    ),
  ).toBe(true);
});
it("writes launch hook settings without MCP; revokes and cleans up after exit and preparation failure", async () => {
  const root = await directory();
  const m = model(stdin);
  const provider = v2Provider(m, () => Promise.resolve());
  replaceConfigProviders([provider]);
  const receiver = {
    register: vi.fn(() => ({
      env: { FOOM_SESSION: "s", FOOM_TOKEN: "secret", FOOM_HOOK_URL: "http://127.0.0.1:1/hooks" },
      revoke: vi.fn(),
    })),
  };
  const binding = await prepareHookLaunch(receiver, m.id, vi.fn(), "linux", root);
  cleanup.push(() => {
    binding.dispose();
  });
  const install = provider.discover("/fixture", "2.1.293 (Claude Code)", "--settings --mcp-config");
  if (!provider.prepareLaunch) throw Error("Missing launch preparation");
  const prepared = await provider.prepareLaunch(
    install,
    { agent: m.id, repository: "/r", worktree: "/r", cols: 80, rows: 24 },
    [],
    undefined,
    false,
    true,
    binding,
  );
  cleanup.push(() => {
    prepared.dispose();
  });
  expect(binding.v2?.channels.size).toBe(1);
  const file = required(prepared.args[prepared.args.indexOf("--settings") + 1]);
  const content = await readFile(file, "utf8");
  expect(content).toContain("sh '");
  expect(content).not.toContain("secret");
  expect(file.startsWith(String(binding.v2?.values["hookDir"]))).toBe(true);
  binding.bind?.("terminal");
  prepared.dispose();
  expect(receiver.register).toHaveBeenCalledOnce();
  await vi.waitFor(async () => {
    await expect(readFile(file)).rejects.toThrow();
  });
});
it("keeps stable commands and attachment timeouts identical across launches on both platforms", async () => {
  const root = await directory();
  const m = model();
  for (const windows of [false, true]) {
    const receiver = {
      register: () => ({
        env: { FOOM_SESSION: "s", FOOM_TOKEN: "token", FOOM_HOOK_URL: "u" },
        revoke: vi.fn(),
      }),
    };
    const first = await prepareV2Hooks(
      receiver,
      m,
      vi.fn(),
      windows,
      root,
      undefined,
      vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    );
    const second = await prepareV2Hooks(
      receiver,
      m,
      vi.fn(),
      windows,
      root,
      undefined,
      vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    );
    cleanup.push(
      () => {
        first.dispose();
      },
      () => {
        second.dispose();
      },
    );
    expect(first.v2?.values["observerCommand:lifecycle"]).toBe(
      second.v2?.values["observerCommand:lifecycle"],
    );
    expect(first.v2?.values["observerCommand:lifecycle"]).toContain(
      windows ? "-EncodedCommand" : "codex-v1.sh",
    );
    expect(first.v2?.values["observerArgv:notify"]).not.toEqual(
      second.v2?.values["observerArgv:notify"],
    );
  }
});
it("generates fixed native transport options and command serialization", () => {
  for (const windows of [false, true]) {
    const c = channel(model(ordered));
    expect(observerVersion(c, windows)).toBe(2);
    const assets = observerAssets(c, windows);
    expect(Object.values(assets).join(" ")).toContain("X-Foom-Channel");
    c.observer.sequence = false;
    c.observer.response = "silent";
    expect(Object.values(observerAssets(c, windows)).join(" ")).not.toContain(
      "Out.WriteLine('{}')",
    );
    c.observer.delivery = "foreground";
    c.observer.placement = "stable";
    expect(Object.keys(observerAssets(c, windows))).toHaveLength(1);
    c.observer.placement = "launch";
    c.observer.transport = "argv-last";
    c.observer.response = "empty-json-first";
    expect(Object.values(observerAssets(c, windows)).join(" ")).toContain("{}");
    expect(observerInvocation("/test'path", ["event"], windows, false).command).toContain(
      windows ? "powershell" : "sh",
    );
  }
});
it("persists health privately, invalidates definitions, and lets only the latest launch write", async () => {
  const root = await privateDirectory(await directory());
  const health = new V2Health(root, "fixture", "definition");
  await health.load();
  expect(health.get()).toBe("not-reviewed");
  const first = health.begin();
  const latest = health.begin();
  health.set("trusted", first);
  expect(health.get()).toBe("not-reviewed");
  health.set("trusted", latest);
  await health.flush();
  const same = new V2Health(root, "fixture", "definition");
  await same.load();
  expect(same.get()).toBe("trusted");
  const changed = new V2Health(root, "fixture", "new");
  await changed.load();
  expect(changed.get()).toBe("outdated");
  for (const data of ["broken", "null", "{}", '{"fingerprint":"definition","state":"bogus"}']) {
    await writeFile(join(root, "fixture-health.json"), data);
    const corrupt = new V2Health(root, "fixture", "definition");
    await corrupt.load();
    expect(corrupt.get()).toBe("not-reviewed");
  }
  expect(await readdir(root)).toEqual(["fixture-health.json"]);
});
it("observes valid turn completion, snapshots fallback and deduplicates completion groups", async () => {
  const root = await privateDirectory(await directory());
  const m = model();
  const health = new V2Health(root, "fixture", "definitions");
  const runtime = new V2ExecutionHooks(
    m,
    new Map(required(m.hooks).channels.map((entry) => [entry.id, entry])),
    health,
  );
  const signal = (caseId: string, action: HookSignal["action"], ch = "lifecycle"): HookSignal => ({
    terminalId: "t",
    signal: `plugin:fixture:${caseId}`,
    channel: ch,
    caseId,
    action,
    endsTurn: action === "classify",
  });
  expect(runtime.required()).toBe(false);
  expect(runtime.accept(signal("SessionStart", "ready"), 0)).toBe(false);
  expect(runtime.required()).toBe(false);
  runtime.accept(signal("UserPromptSubmit", "working"), 1);
  expect(runtime.required()).toBe(true);
  runtime.accept(signal("Stop", "classify"), 1);
  expect(health.get()).toBe("trusted");
  expect(runtime.accept(signal("complete", "classify", "notify"), 1)).toBe(false);
  expect(runtime.accept(signal("complete", "classify", "notify"), 2)).toBe(true);
  expect(health.get()).toBe("declined");
  runtime.review(["Hooks need review"]);
  expect(health.get()).toBe("not-reviewed");
  const newer = new V2ExecutionHooks(m, new Map(), health);
  newer.accept(signal("UserPromptSubmit", "working"), 3);
  newer.accept(signal("SessionStart", "ready"), 3);
  newer.accept(signal("Stop", "classify"), 3);
  expect(health.get()).toBe("trusted");
  newer.review(["Hooks need review"]);
  expect(health.get()).toBe("outdated");
  await health.flush();
});
it.skipIf(process.platform === "win32")(
  "delivers a native v2 stdin observer through the authenticated receiver",
  async () => {
    const root = await directory();
    const m = model(stdin);
    const signals: HookSignal[] = [];
    const receiver = await HookReceiver.listen((signal) => signals.push(signal));
    cleanup.push(() => receiver.close());
    const binding = await prepareV2Hooks(receiver, m, vi.fn(), false, root);
    cleanup.push(() => {
      binding.dispose();
    });
    const c = channel(m);
    binding.v2?.channels.set(c.id, c);
    const argv = required(binding.v2?.values[`observerArgv:${c.id}`]);
    if (!Array.isArray(argv)) throw Error("Missing observer argv");
    const child = execFile(required(argv[0]), argv.slice(1), {
      env: { ...binding.env, PATH: "/usr/bin:/bin" },
    });
    const done = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(Error("Observer failed"));
      });
    });
    child.stdin?.end(JSON.stringify({ session_id: "id", hook_event_name: "Stop" }));
    await done;
    expect(signals).toHaveLength(1);
    expect(signals[0]?.action).toBe("classify");
  },
);

it("refuses oversized, linked and changed observer assets and revokes failed preparations", async () => {
  const root = await directory();
  const m = model();
  const revoke = vi.fn();
  const bind = vi.fn();
  const receiver = {
    register: () => ({ env: { FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "u" }, revoke }),
  };
  const first = await prepareV2Hooks(receiver, m, bind, false, root);
  cleanup.push(() => {
    first.dispose();
  });
  const invocation = required(first.v2?.values["observerArgv:lifecycle"]);
  if (!Array.isArray(invocation)) throw Error("Missing argv");
  const script = required(invocation[1]);
  await writeFile(script, "changed executable bytes");
  await expect(prepareV2Hooks(receiver, m, bind, false, root)).rejects.toThrow();
  expect(revoke).not.toHaveBeenCalled();
  const { readOwnedFile } = await import("../../../../src/main/agents/providers/v2-files");
  await expect(readOwnedFile(script, 2)).rejects.toThrow("Invalid owned file");
  const { symlink } = await import("node:fs/promises");
  const link = join(root, "linked");
  if (process.platform !== "win32") {
    await symlink(script, link);
    await expect(readOwnedFile(link, 100)).rejects.toThrow();
  }
});
it("does not infer health from initial readiness, idle time, missing callbacks or old definitions", async () => {
  const root = await privateDirectory(await directory());
  const m = model();
  const old = new V2Health(root, "fixture", "old");
  const oldLaunch = old.begin();
  const health = new V2Health(root, "fixture", "new");
  const next = health.begin();
  old.set("trusted", oldLaunch);
  expect(old.get()).toBe("not-reviewed");
  health.set("trusted", next);
  await health.flush();
  const runtime = new V2ExecutionHooks(m, new Map([["lifecycle", true]]), health);
  runtime.idle(1);
  expect(health.get()).toBe("declined");
  runtime.review(["hooks need review"]);
  expect(health.get()).toBe("declined");
  const noHealth = model(stdin);
  const ordinary = new V2ExecutionHooks(noHealth, new Map([["lifecycle", true]]), health);
  expect(ordinary.required()).toBe(true);
  ordinary.accept(
    { terminalId: "t", signal: "plugin:fixture", action: "working", channel: "lifecycle" },
    1,
  );
  ordinary.review([]);
  ordinary.idle(1);
  m.health = undefined;
  m.execution.completion = "observed";
  const observed = new V2ExecutionHooks(m, new Map([["lifecycle", true]]), health);
  expect(observed.required()).toBe(false);
  observed.accept(
    { terminalId: "t", signal: "plugin:fixture", action: "working", channel: "lifecycle" },
    1,
  );
  expect(observed.required()).toBe(true);
  await health.flush();
});
it("pins pasted and assigned IDs while manual resume permits a new first event", async () => {
  const root = await directory();
  const m = model();
  const provider = v2Provider(m, () => Promise.resolve());
  const install = provider.discover("/fixture", "codex-cli 0.161.0", "-c");
  const receiver = {
    register: () => ({
      env: { FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "u" },
      revoke: vi.fn(),
    }),
  };
  for (const pinConversation of [false, true]) {
    const binding = await prepareV2Hooks(receiver, m, vi.fn(), false, root);
    cleanup.push(() => {
      binding.dispose();
    });
    if (!provider.prepareLaunch) throw Error("Missing preparation");
    const prepared = await provider.prepareLaunch(
      install,
      {
        agent: m.id,
        repository: "/r",
        worktree: "/r",
        cols: 80,
        rows: 24,
        conversationId: "requested",
        pinConversation,
      },
      [],
      undefined,
      false,
      true,
      binding,
    );
    cleanup.push(() => {
      prepared.dispose();
    });
    expect(binding.v2?.state.conversation).toBe(pinConversation ? "requested" : undefined);
    expect(binding.v2?.state.launchFacts?.["resume"]).toBe(true);
    expect(Object.isFrozen(binding.v2?.state.launchFacts)).toBe(true);
    expect(binding.v2?.channels.has("notify")).toBe(true);
  }
});
it("acknowledges selected channel disclosures in the exact-byte trusted plugin review", async () => {
  const { pluginDisclosure } = await import("../../../../src/main/agents/providers/disclosure");
  const review = pluginDisclosure(model());
  expect(
    review.sections?.some(
      (section) => section.label === "Channel acknowledgement: notifier-replacement",
    ),
  ).toBe(true);
  expect(JSON.stringify(review)).toContain("these exact manifest bytes");
});
it("rejects file replacement during an owned read and tolerates cleanup failure after revocation", async () => {
  const { readOwnedFile, writeOwnedFile } = await import(
    "../../../../src/main/agents/providers/v2-files"
  );
  const root = await directory();
  const file = join(root, "owned");
  await writeOwnedFile(file, "data");
  const original = await fs.lstat(file);
  const changed = await fs.lstat(file);
  changed.ino++;
  const inspect = vi
    .spyOn(fs, "lstat")
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(changed);
  await expect(readOwnedFile(file, 100)).rejects.toThrow("Invalid owned file");
  inspect.mockRestore();
  const revoke = vi.fn();
  const binding = await prepareV2Hooks(
    {
      register: () => ({ env: { FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "u" }, revoke }),
    },
    model(),
    vi.fn(),
    false,
    root,
  );
  const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(Error("cleanup unavailable"));
  binding.dispose();
  expect(revoke).toHaveBeenCalledOnce();
  await vi.waitFor(() => {
    expect(remove).toHaveBeenCalledOnce();
  });
  remove.mockRestore();
});
it("allocates independent sequence state and observers for multiple ordered channels", async () => {
  const root = await directory();
  const m = model(ordered);
  const c = channel(m);
  c.observer.placement = "launch";
  const other = structuredClone(c);
  other.id = "second";
  required(m.hooks).channels.push(other);
  const binding = await prepareV2Hooks(
    {
      register: () => ({
        env: { FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "u" },
        revoke: vi.fn(),
      }),
    },
    m,
    vi.fn(),
    true,
    root,
    root,
    vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  );
  cleanup.push(() => {
    binding.dispose();
  });
  binding.bind?.("terminal");
  expect(binding.env["FOOM_ORDER_second"]).not.toBe(binding.env[`FOOM_ORDER_${c.id}`]);
  const state: V2HookState = {};
  for (const entry of [c, other])
    expect(
      reduceV2(entry, state, "t", "fixture", { conversationId: "id" }, "PreInvocation", "1"),
    ).toBeDefined();
});
it("flushes health after terminal removal and declines completion without a prompt callback", async () => {
  const { flushV2Health } = await import("../../../../src/main/agents/providers/v2-health");
  const root = await privateDirectory(await directory());
  const m = model();
  const health = new V2Health(root, "fixture", "definition");
  const runtime = new V2ExecutionHooks(m, new Map([["lifecycle", true]]), health);
  runtime.accept(
    {
      terminalId: "t",
      signal: "plugin:fixture:Stop",
      channel: "lifecycle",
      caseId: "Stop",
      action: "classify",
      endsTurn: true,
    },
    1,
  );
  expect(health.get()).toBe("declined");
  await flushV2Health();
  expect(await readFile(join(root, "fixture-health.json"), "utf8")).toContain('"declined"');
});
it("discovers hooks for resume/prompt/control contexts while preserving hard verification gates", async () => {
  const { hookCapability } = await import("../../../../src/main/agents/providers/v2-values");
  const m = model(stdin);
  const c = channel(m);
  c.when = {
    all: [
      { field: "resume", op: "eq", value: true },
      { field: "hasPrompt", op: "eq", value: true },
      { field: "control", op: "eq", value: false },
    ],
    any: undefined,
  };
  expect(hookCapability(m, "", "")).toBe(true);
  c.when.all?.push({ field: "hookSupport", op: "eq", value: true });
  expect(hookCapability(m, "", "")).toBe(false);
  m.hooks = undefined;
  expect(hookCapability(m, "", "")).toBe(false);
});
it("excludes launch paths from health fingerprints when channel IDs share a prefix", async () => {
  const root = await directory();
  const m = model();
  channel(m).id = "life";
  channel(m, 1).id = "lifecycle";
  const health = required(m.health);
  health.channel = "life";
  m.execution.completionChannels = ["life", "lifecycle"];
  for (const test of channel(m, 1).when.any ?? [])
    if (test.field === "channelAttached:lifecycle") test.field = "channelAttached:life";
  const receiver = {
    register: () => ({
      env: { FOOM_SESSION: "s", FOOM_TOKEN: "t", FOOM_HOOK_URL: "u" },
      revoke: vi.fn(),
    }),
  };
  const first = await prepareV2Hooks(receiver, m, vi.fn(), false, root);
  cleanup.push(() => {
    first.dispose();
  });
  const second = await prepareV2Hooks(receiver, m, vi.fn(), false, root);
  cleanup.push(() => {
    second.dispose();
  });
  expect(first.v2?.values["observerCommand:lifecycle"]).not.toBe(
    second.v2?.values["observerCommand:lifecycle"],
  );
  expect(first.v2?.runtime?.health).toBe(second.v2?.runtime?.health);
});
it("preserves PowerShell dollar/quote syntax when inserting the fixed event validator", () => {
  const c = channel(model(ordered));
  const script = required(observerAssets(c, true)["observer.ps1"]);
  expect(script).toContain("if ($event -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,63}$') { exit 0 }");
  expect(script).toContain("$event, $sequence, $payload)");
  expect(script.match(/public static class FoomObserverTransport/gu)).toHaveLength(1);
});
it("evaluates event predicates against immutable launch facts without promoting them to payload evidence", () => {
  const c = channel(model(stdin));
  const stop = required(c.mapping.cases.find((entry) => entry.id === "Stop"));
  stop.when = {
    all: [
      { field: "resume", op: "eq", value: true },
      { field: { source: "facts", path: ["hookSupport"] }, op: "eq", value: true },
    ],
    any: undefined,
  };
  const state: V2HookState = {};
  const payload = { session_id: "conversation", hook_event_name: "Stop" };
  expect(reduceV2(c, state, "t", "fixture", payload, undefined, undefined)).toBeUndefined();
  expect(state).toEqual({});
  state.launchFacts = Object.freeze({
    resume: true,
    hookSupport: true,
    fullyIdle: true,
    terminationReason: "error",
  });
  const signal = reduceV2(c, state, "t", "fixture", payload, undefined, undefined);
  expect(signal?.action).toBe("classify");
  expect(signal?.fullyIdle).toBeUndefined();
  expect(signal?.terminationReason).toBeUndefined();
});
