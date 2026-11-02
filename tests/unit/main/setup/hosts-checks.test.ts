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
  settings = { ...DEFAULT_SETTINGS };
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
  expect(execute.mock.calls[0]?.[1]).not.toHaveProperty("readOnly");
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
      agents: { ...settings.agents, codex: !settings.agents.codex },
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
