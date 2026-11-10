import { ENABLED_AGENTS } from "../../../helpers/enabled-agents";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import manifest from "../../../fixtures/agent-plugin-v2.json";
import { ConfigService } from "../../../../src/main/config/service";
import { configPart } from "../../../../src/main/config/approval";
import {
  agentProviders,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import { Hosts } from "../../../../src/main/setup/hosts";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import type { Settings } from "../../../../src/shared/setup";
import type { HostManagement, HostResult } from "../../../../src/shared/registered-hosts.d";

let settings: Settings;
const execute = vi.fn<(host: string, request: HostManagement) => Promise<HostResult>>();
const facts = {
  codeFolder: "/remote/foom",
  version: "0.1.0",
  sessions: 0,
  cores: 8,
  load: [0, 0, 0],
  memoryTotal: 8000,
  memoryAvailable: 4000,
  agents: [],
};
let hosts: Hosts;
const roots: string[] = [];
const services: ConfigService[] = [];
beforeEach(() => {
  settings = {
    ...DEFAULT_SETTINGS,
    agents: ENABLED_AGENTS,
  };
  execute.mockReset().mockResolvedValue({ ok: true, facts });
  hosts = new Hosts(
    {
      get: () => settings,
      update: (patch: Partial<Settings>) => {
        settings = { ...settings, ...patch };
        return Promise.resolve(settings);
      },
    },
    () => [],
    "0.1.0",
    execute,
  );
});
afterEach(async () => {
  hosts.dispose();
  replaceConfigProviders([]);
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const check = () => hosts.action({ action: "test", host: "fixture", codeFolder: "~/foom" });
async function catalog() {
  const root = await mkdtemp(join(tmpdir(), "hosts-check-"));
  roots.push(root);
  const service = new ConfigService({
    root,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => undefined,
    baseline: { get: () => null, set: () => Promise.resolve() },
    themeBaseline: { get: () => null, set: () => Promise.resolve() },
    applyPlugins: replaceConfigProviders,
    watch: () => ({ close: () => undefined }),
  });
  services.push(service);
  await service.initialize();
  const file = join(root, "agents", `${manifest.id}.json`);
  await writeFile(file, JSON.stringify(manifest));
  await service.refresh();
  settings = { ...settings, agents: { ...settings.agents, [manifest.id]: true } };
  return { service, file };
}
test("real bundled and config providers succeed with enrollment and read-only inventory", async () => {
  const { service } = await catalog();
  execute.mockImplementation(async (_host, request) => {
    await service.refresh(); // An unchanged background scan must not invalidate the check.
    return {
      ok: true,
      facts: { ...facts, agents: request.agents?.map(({ id }) => ({ id, state: "ready" })) ?? [] },
    };
  });
  const result = (await check()).result;
  expect(result?.ok).toBe(true);
  expect(execute.mock.calls[0]?.[1]).toHaveProperty("readOnly", true);
  expect(execute.mock.calls[0]?.[1].agents?.map(({ id }) => id)).toEqual(
    agentProviders().map(({ id }) => id),
  );
  if (result?.ok)
    expect(result.facts.agents.find(({ id }) => id === manifest.id)?.state).toBe("unable");
  await hosts.action({ action: "add", host: "fixture", codeFolder: "~/foom" });
  await hosts.action({ action: "refresh", host: "fixture" });
  expect(execute.mock.lastCall?.[1]).toHaveProperty("readOnly", true);
});
test("a real config scan mid-check retries with the new provider, without a bogus unreachable", async () => {
  const { file, service } = await catalog();
  execute.mockImplementationOnce(async () => {
    await writeFile(file, JSON.stringify({ ...manifest, name: "Changed" }));
    await service.refresh();
    return { ok: true, facts };
  });
  expect((await check()).result?.ok).toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
});
test("changed provider bytes refuse before executing and log only a fixed reason and step", async () => {
  const { file } = await catalog();
  await writeFile(file, "{}");
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect((await check()).result).toEqual({ ok: false, reason: "provider-invalid" });
  expect(execute).not.toHaveBeenCalled();
  expect(log.mock.calls).toEqual([["Host check failed: reason=provider-invalid step=providers"]]);
});
test("enabled-agent changes retry once, then report configuration changed and log once", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  execute.mockImplementation(() => {
    settings = {
      ...settings,
      agents: { ...settings.agents, codex: !settings.agents["codex"] },
    };
    return Promise.resolve({ ok: true, facts });
  });
  expect((await check()).result).toEqual({ ok: false, reason: "configuration-changed" });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(log.mock.calls).toEqual([
    ["Host check failed: reason=configuration-changed step=configuration"],
  ]);
  expect(settings.registeredHosts).toBeUndefined();
});
test("cancellation before or during a check never becomes unreachable or enrolls a host", async () => {
  execute.mockImplementationOnce(() => {
    hosts.dispose();
    return Promise.resolve({ ok: true, facts });
  });
  expect((await check()).result).toEqual({ ok: false, reason: "cancelled" });
  expect((await check()).result).toEqual({ ok: false, reason: "cancelled" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(settings.registeredHosts).toBeUndefined();
});
test.each([
  "artifact-unavailable",
  "version-mismatch",
  "invalid-reply",
  "unreachable",
  "origin-auth",
  "origin-host-key",
  "origin-unreachable",
  "timed-out",
  "checkout-invalid",
] as const)("preserves %s and emits one bounded diagnostic", async (reason) => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  execute.mockResolvedValueOnce({ ok: false, reason });
  expect((await check()).result).toEqual({ ok: false, reason });
  expect(log.mock.calls).toEqual([[`Host check failed: reason=${reason} step=connection`]]);
});

test("a configuration change during provider validation retries before executing", async () => {
  const provider = agentProviders()[0];
  if (!provider) throw new Error("Missing bundled fixture provider");
  const validate = vi.spyOn(provider, "validate");
  validate.mockImplementationOnce(() => {
    settings = { ...settings, agents: { ...settings.agents, codex: false } };
    return Promise.resolve();
  });
  expect((await check()).result?.ok).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.lastCall?.[1].agents?.some(({ id }) => id === "codex")).toBe(false);
});
test("a provider replaced during validation retries the new catalog", async () => {
  const { file, service } = await catalog();
  const provider = agentProviders().find(({ id }) => id === manifest.id);
  if (!provider) throw new Error("Missing config fixture provider");
  vi.spyOn(provider, "validate").mockImplementationOnce(async () => {
    await writeFile(file, JSON.stringify({ ...manifest, name: "Replacement" }));
    await service.refresh();
    throw new Error("Raw provider output");
  });
  expect((await check()).result?.ok).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
});

function checkedHost() {
  const result: HostResult = {
    ok: true,
    facts: {
      ...facts,
      folder: { state: "pass" },
      requirements: {
        distro: "darwin",
        libc: "supported",
        packageManager: "brew",
        mac: { commandLineTools: false, staysAwake: false, protectedFolder: false },
      },
      tools: [
        { id: "git", state: "missing", signIn: "unknown" },
        { id: "gh", state: "ready", signIn: "signed-out" },
      ],
      agents: [{ id: "codex", state: "missing", signIn: "signed-out" }],
    },
  };
  settings = {
    ...settings,
    registeredHosts: [
      {
        host: "fixture",
        codeFolder: facts.codeFolder,
        observation: {
          checkedAt: 1234,
          preflight: {
            result,
            ssh: { state: "pass" },
            platform: { state: "pass" },
            artifact: { state: "pass" },
            repositories: [],
          },
        },
      },
    ],
  };
  return result;
}
test.each([
  { kind: "ssh" as const },
  { kind: "platform" as const },
  { kind: "artifact" as const },
  { kind: "folder" as const },
  { kind: "command-line-tools" as const },
  { kind: "power" as const },
  { kind: "tool" as const, tool: "git" },
  { kind: "sign-in" as const, tool: "gh" },
  { kind: "tool" as const, tool: "codex" },
  { kind: "sign-in" as const, tool: "codex" },
])("reload $kind selects one remote row and preserves full-check time", async (target) => {
  const original = checkedHost();
  execute.mockResolvedValue({
    ok: true,
    facts: {
      ...original.facts,
      folder: { state: "fail", reason: "folder-missing" },
      requirements: {
        distro: "darwin",
        libc: "supported",
        packageManager: "brew",
        mac: { commandLineTools: true, staysAwake: true, protectedFolder: true },
      },
      tools: [
        { id: "git", state: "ready", signIn: "unknown" },
        { id: "gh", state: "ready", signIn: "signed-in" },
      ],
      agents: [{ id: "codex", state: "ready", signIn: "signed-in" }],
    },
  });
  const state = await hosts.action({ action: "reload", host: "fixture", target });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.lastCall?.[1]).toMatchObject({ operation: "inspect", target });
  expect(settings.registeredHosts?.[0]?.observation?.checkedAt).toBe(1234);
  const updated = state.preflight;
  expect(updated?.repositories).toEqual([]);
  if (!updated?.result.ok) throw new Error("Expected facts");
  expect(updated.result.facts.cores).toBe(original.facts.cores);
  if (target.kind === "tool" && target.tool === "git") {
    expect(updated.result.facts.tools?.[0]?.state).toBe("ready");
    expect(updated.result.facts.tools?.[1]).toEqual(original.facts.tools?.[1]);
  }
  if (target.kind === "sign-in" && target.tool === "codex") {
    expect(updated.result.facts.agents.find((agent) => agent.id === "codex")).toEqual({
      id: "codex",
      state: "missing",
      signIn: "signed-in",
    });
  }
});
test.each(["git", "codex"])("failed reload of %s changes only its state", async (tool) => {
  checkedHost();
  execute.mockResolvedValue({ ok: false, reason: "unreachable" });
  const state = await hosts.action({
    action: "reload",
    host: "fixture",
    target: { kind: "tool", tool },
  });
  expect(state.preflight?.result.ok).toBe(true);
  expect(settings.registeredHosts?.[0]?.observation?.checkedAt).toBe(1234);
});
test("reload validates enabled tools and registered repositories before remote calls", async () => {
  checkedHost();
  await expect(
    hosts.action({
      action: "reload",
      host: "fixture",
      target: { kind: "tool", tool: "unregistered" },
    }),
  ).rejects.toThrow("Tool is not enabled");
  await expect(
    hosts.action({
      action: "reload",
      host: "fixture",
      target: { kind: "origin", repository: "/unregistered" },
    }),
  ).rejects.toThrow("Repository is not registered");
  expect(execute).not.toHaveBeenCalled();
});
test("scoped inspection without saved facts does not invent a full-check timestamp", async () => {
  settings = { ...settings, registeredHosts: [{ host: "fixture", codeFolder: facts.codeFolder }] };
  await expect(
    hosts.action({ action: "reload", host: "fixture", target: { kind: "ssh" } }),
  ).rejects.toThrow("Unable to display host row without a full check");
  expect(settings.registeredHosts?.[0]?.observation).toBeUndefined();
});
test("folder actions refresh from their reply, invalidate repositories and preserve other facts", async () => {
  const original = checkedHost();
  execute.mockResolvedValue({
    ok: true,
    facts: { ...facts, codeFolder: "/remote/new", folder: { state: "pass" } },
  });
  await hosts.action({ action: "change-folder", host: "fixture", codeFolder: "/remote/new" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.lastCall?.[1]).toMatchObject({ target: { kind: "folder" } });
  expect(settings.registeredHosts?.[0]?.codeFolder).toBe("/remote/new");
  expect(settings.registeredHosts?.[0]?.observation?.checkedAt).toBe(1234);
  const observed = settings.registeredHosts?.[0]?.observation?.preflight.result;
  if (!observed?.ok) throw new Error("fixture");
  expect(observed.facts.agents).toEqual(original.facts.agents);
  execute.mockClear().mockResolvedValue({ ok: false, reason: "unsafe-folder" });
  await hosts.action({ action: "create-folder", host: "fixture" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(settings.registeredHosts?.[0]?.observation?.preflight.result).toMatchObject({
    facts: { folder: { state: "fail", reason: "unsafe-folder" } },
  });
});

test.each(["power", "command-line-tools"] as const)(
  "failed %s reload preserves other observations",
  async (kind) => {
    checkedHost();
    execute.mockResolvedValue({ ok: false, reason: "unreachable" });
    const before = settings.registeredHosts?.[0]?.observation;
    await expect(
      hosts.action({ action: "reload", host: "fixture", target: { kind } }),
    ).rejects.toThrow("Unable to check host row");
    expect(settings.registeredHosts?.[0]?.observation).toEqual(before);
  },
);

test.each(["reload", "refresh"] as const)(
  "%s saved observations never become a launch inventory cache",
  async (action) => {
    checkedHost();
    await hosts.action(
      action === "reload"
        ? { action, host: "fixture", target: { kind: "tool", tool: "codex" } }
        : { action, host: "fixture" },
    );
    expect((await hosts.fleet(false))[0]?.result).toEqual({
      ok: false,
      reason: "facts-unavailable",
    });
    execute.mockClear();
    await hosts.inventory("fixture");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.lastCall?.[1]).toMatchObject({ operation: "inspect" });
    expect(execute.mock.lastCall?.[1]).not.toHaveProperty("target");
  },
);

test("scoped refresh preserves live inventory fields and never renews full-inventory freshness", async () => {
  checkedHost();
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  execute.mockResolvedValue({
    ok: true,
    facts: {
      ...facts,
      agents: [
        { id: "claude", state: "ready" },
        { id: "codex", state: "ready" },
      ],
    },
  });
  const original = await hosts.inventory("fixture");
  execute.mockClear();
  now = 59000;
  execute.mockResolvedValue({ ok: true, facts });
  await hosts.action({ action: "reload", host: "fixture", target: { kind: "tool", tool: "git" } });
  const cached = await hosts.inventory("fixture");
  expect(cached).toEqual(original);
  expect(execute).toHaveBeenCalledTimes(1);
  execute.mockClear();
  now = 60001;
  await hosts.inventory("fixture");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.lastCall?.[1]).not.toHaveProperty("target");
});

test("folder reload updates its Mac path warning while preserving the CLT and power rows", async () => {
  const original = checkedHost();
  execute.mockResolvedValue({
    ok: true,
    facts: {
      ...original.facts,
      requirements: {
        distro: "darwin",
        libc: "supported",
        packageManager: "none",
        mac: { commandLineTools: true, staysAwake: true, protectedFolder: true },
      },
    },
  });
  const updated = await hosts.action({
    action: "reload",
    host: "fixture",
    target: { kind: "folder" },
  });
  expect(updated.preflight?.result).toMatchObject({
    ok: true,
    facts: {
      requirements: {
        packageManager: "brew",
        mac: { commandLineTools: false, staysAwake: false, protectedFolder: true },
      },
    },
  });
});

test.each(["reload", "refresh"] as const)(
  "%s cannot discard a concurrent fresh launch inventory",
  async (action) => {
    checkedHost();
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    execute.mockResolvedValue({
      ok: true,
      facts: { ...facts, agents: [{ id: "codex", state: "ready" }] },
    });
    await hosts.inventory("fixture");
    now = 60001;
    let release: ((result: HostResult) => void) | undefined;
    const held = new Promise<HostResult>((resolve) => {
      release = resolve;
    });
    execute.mockImplementation((_host, request) =>
      request.operation === "inspect" && request.target
        ? Promise.resolve({ ok: true, facts: { ...facts, cores: 99 } })
        : held,
    );
    const pending = hosts.inventory("fixture");
    try {
      const updated = await hosts.action(
        action === "reload"
          ? { action, host: "fixture", target: { kind: "tool", tool: "git" } }
          : { action, host: "fixture" },
      );
      if (action === "refresh")
        expect(updated.hosts[0]?.result).toMatchObject({ ok: true, facts: { cores: 99 } });
    } finally {
      release?.({ ok: true, facts });
    }
    const refreshed = await pending;
    if (!refreshed.ok) throw new Error("Expected fresh inventory");
    expect(refreshed.facts.agents.find((agent) => agent.id === "codex")?.state).toBe("unable");
  },
);

test("resource refresh preserves an inventory that completed during its remote read", async () => {
  checkedHost();
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  execute.mockResolvedValue({
    ok: true,
    facts: { ...facts, agents: [{ id: "codex", state: "ready" }] },
  });
  await hosts.inventory("fixture");
  now = 60001;
  let release: ((result: HostResult) => void) | undefined;
  const held = new Promise<HostResult>((resolve) => {
    release = resolve;
  });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  execute.mockImplementation((_host, request) => {
    if (request.operation === "inspect" && request.target) {
      markStarted?.();
      return held;
    }
    return Promise.resolve({ ok: true, facts });
  });
  const refresh = hosts.action({ action: "refresh", host: "fixture" });
  try {
    await started;
    await hosts.inventory("fixture");
  } finally {
    release?.({ ok: true, facts: { ...facts, cores: 99 } });
  }
  expect((await refresh).hosts[0]?.result).toMatchObject({ ok: true, facts: { cores: 99 } });
  const cached = await hosts.inventory("fixture");
  if (!cached.ok) throw new Error("Expected fresh inventory");
  expect(cached.facts.agents.find((agent) => agent.id === "codex")?.state).toBe("unable");
});

test("row reload updates an enrolled live inventory without inventing a saved full check", async () => {
  const initialFacts = {
    ...facts,
    agents: [
      { id: "codex", state: "ready" as const, signIn: "signed-in" as const },
      { id: "claude", state: "ready" as const },
    ],
  };
  execute.mockResolvedValue({ ok: true, facts: initialFacts });
  await hosts.action({ action: "add", host: "fixture", codeFolder: facts.codeFolder });
  const original = await hosts.inventory("fixture");
  if (!original.ok) throw new Error("Expected live inventory");
  await hosts.action({ action: "refresh", host: "fixture" });
  execute.mockClear();
  execute.mockResolvedValue({
    ok: true,
    facts: { ...facts, agents: [{ id: "codex", state: "missing" }] },
  });
  const state = await hosts.action({
    action: "reload",
    host: "fixture",
    target: { kind: "tool", tool: "codex" },
  });
  const cached = await hosts.inventory("fixture");
  expect(cached).toEqual({
    ok: true,
    facts: {
      ...original.facts,
      agents: original.facts.agents.map((agent) =>
        agent.id === "codex" ? { ...agent, state: "missing" } : agent,
      ),
    },
  });
  expect(state.hosts[0]?.result).toEqual(original);
  expect(state.preflight?.result).toEqual(cached);
  expect(settings.registeredHosts?.[0]?.observation).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.lastCall?.[1]).toMatchObject({ target: { kind: "tool", tool: "codex" } });
});

test("a failed replacement folder preserves the saved and live registered folder observation", async () => {
  const original = checkedHost();
  execute.mockResolvedValue(original);
  const live = await hosts.inventory("fixture");
  const saved = settings.registeredHosts?.[0];
  execute.mockResolvedValue({ ok: false, reason: "facts-unavailable" });
  const reply = await hosts.action({
    action: "change-folder",
    host: "fixture",
    codeFolder: "/remote/other",
  });
  expect(reply.result).toEqual({ ok: false, reason: "facts-unavailable" });
  expect(settings.registeredHosts?.[0]).toEqual(saved);
  expect(await hosts.inventory("fixture")).toEqual(live);
});

test.each(["failed-check", "no-observation"])(
  "folder reload reports an explicit failure when its result cannot be displayed after %s",
  async (scenario) => {
    checkedHost();
    settings = {
      ...settings,
      registeredHosts: [
        {
          host: "fixture",
          codeFolder: facts.codeFolder,
          ...(scenario === "failed-check"
            ? {
                observation: {
                  checkedAt: 1234,
                  preflight: {
                    ssh: { state: "fail" as const, reason: "unreachable" as const },
                    platform: { state: "not-checked" as const },
                    artifact: { state: "not-checked" as const },
                    repositories: [],
                    result: { ok: false as const, reason: "unreachable" as const },
                  },
                },
              }
            : {}),
        },
      ],
    };
    const saved = settings.registeredHosts;
    await expect(
      hosts.action({ action: "reload", host: "fixture", target: { kind: "folder" } }),
    ).rejects.toThrow();
    expect(settings.registeredHosts).toEqual(saved);
    expect((await hosts.fleet(false))[0]?.result).toEqual({
      ok: false,
      reason: "facts-unavailable",
    });
  },
);

test.each(["missing-tool", "missing-mac"])(
  "reload fails explicitly when the selected row is absent from saved facts: %s",
  async (scenario) => {
    const original = checkedHost();
    execute.mockResolvedValue(original);
    if (scenario === "missing-mac") {
      const host = settings.registeredHosts?.[0];
      if (!host?.observation) throw new Error("Expected saved host");
      settings = {
        ...settings,
        registeredHosts: [
          {
            ...host,
            observation: {
              ...host.observation,
              preflight: {
                ...host.observation.preflight,
                result: {
                  ok: true,
                  facts: {
                    ...original.facts,
                    requirements: { distro: "debian", libc: "supported", packageManager: "apt" },
                  },
                },
              },
            },
          },
        ],
      };
    }
    await expect(
      hosts.action({
        action: "reload",
        host: "fixture",
        target: scenario === "missing-tool" ? { kind: "tool", tool: "claude" } : { kind: "power" },
      }),
    ).rejects.toThrow();
    expect(settings.registeredHosts?.[0]?.observation?.checkedAt).toBe(1234);
  },
);
