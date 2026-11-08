import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HostManagement, HostResult } from "../../../../src/shared/registered-hosts.d";
import type { Settings } from "../../../../src/shared/setup";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
const mock = vi.hoisted(() => ({ supported: vi.fn(), trust: vi.fn() }));
vi.mock("../../../../src/main/setup/ssh-host-key", () => ({
  askpassSupported: mock.supported,
  trustHostKey: mock.trust,
}));
import { Hosts } from "../../../../src/main/setup/hosts";
let settings: Settings;
let hosts: Hosts;
const run = vi.fn<(host: string, request: HostManagement) => Promise<HostResult>>();
const unknownKey: HostResult = {
  ok: false,
  reason: "unreachable",
  connection: {
    ssh: { state: "fail", reason: "host-key-unknown" },
    platform: { state: "not-checked" },
    artifact: { state: "not-checked" },
  },
};
const good: HostResult = {
  ok: true,
  facts: {
    codeFolder: "/code",
    version: "0.1.0",
    sessions: 0,
    cores: 1,
    load: [0, 0, 0],
    memoryTotal: 1,
    memoryAvailable: 1,
    agents: [],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.supported.mockResolvedValue(true);
  mock.trust.mockResolvedValue(true);
  settings = { ...DEFAULT_SETTINGS };
  run.mockReset().mockResolvedValue(unknownKey);
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
    run,
  );
});
afterEach(() => {
  hosts.dispose();
});
const enroll = () => hosts.action({ action: "add", host: "box", codeFolder: "/code" });
const trust = (signal?: AbortSignal) =>
  hosts.action(
    { action: "trust-host-key", host: "box" },
    () => Promise.resolve(true),
    undefined,
    signal,
  );

test("unknown keys offer trust for registered hosts and accepted new hosts run their first check", async () => {
  expect((await enroll()).hosts[0]?.hostKeyTrust).toBe("askpass");
  run.mockResolvedValue(good);
  const state = await trust();
  expect(state.preflight?.result.ok).toBe(true);
  expect(mock.trust).toHaveBeenCalledWith("box", expect.any(Function), expect.any(AbortSignal));
  expect(settings.registeredHosts?.[0]?.observation?.preflight.result.ok).toBe(true);
  expect(state.output).toMatchObject({ running: false, failed: false });
  expect(hosts.copyValue({ kind: "copy-host-ssh-command", host: "box" })).toBe("ssh box");
});

test("decline, unsupported helpers and cancellation perform no recheck", async () => {
  await enroll();
  run.mockClear();
  mock.trust.mockResolvedValueOnce(false);
  await trust();
  expect(run).not.toHaveBeenCalled();
  mock.supported.mockResolvedValue(false);
  expect((await trust()).hosts[0]?.hostKeyTrust).toBe("manual");
  expect(mock.trust).toHaveBeenCalledTimes(1);
  mock.supported.mockResolvedValue(true);
  const abort = new AbortController();
  abort.abort();
  await trust(abort.signal);
  expect(mock.trust).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  expect((await hosts.action({ action: "cancel-trust" })).hosts).toHaveLength(1);
});

test("trust requires a registered host's latest unknown-key observation and a main confirmation", async () => {
  await expect(trust()).rejects.toThrow();
  await enroll();
  await hosts.action({ action: "trust-host-key", host: "box" });
  expect(mock.trust).not.toHaveBeenCalled();
  run.mockResolvedValue({
    ...unknownKey,
    connection: {
      platform: { state: "not-checked" },
      artifact: { state: "not-checked" },
      ssh: { state: "fail", reason: "host-key-changed" },
    },
  });
  await hosts.action({ action: "preflight", host: "box", codeFolder: "/code" });
  run.mockClear();
  await trust();
  expect(mock.trust).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

test("past success retained across failures prevents an automatic capability check", async () => {
  await enroll();
  run.mockResolvedValue(good);
  await hosts.action({ action: "preflight", host: "box", codeFolder: "/code" });
  run.mockResolvedValue(unknownKey);
  await hosts.action({ action: "preflight", host: "box", codeFolder: "/code" });
  expect(settings.registeredHosts?.[0]?.observation?.lastAgents?.result.ok).toBe(true);
  run.mockClear();
  await trust();
  expect(mock.trust).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});

test("quit cancels a waiting helper through the service lifetime", async () => {
  await enroll();
  const ready = Promise.withResolvers<undefined>();
  mock.trust.mockImplementationOnce(
    async (_host: string, _confirm: unknown, signal: AbortSignal) => {
      ready.resolve(undefined);
      return new Promise<boolean>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve(false);
          },
          { once: true },
        );
      });
    },
  );
  const work = trust();
  await ready.promise;
  hosts.dispose();
  expect((await work).hosts[0]?.result).toEqual(unknownKey);
});

test("a background SSH diagnostic without checklist fields retains the explicit trust action", async () => {
  await enroll();
  run.mockResolvedValue({ ok: false, reason: "host-key-unknown" });
  await hosts.inventory("box");
  run.mockResolvedValue(good);
  expect((await trust()).preflight?.result.ok).toBe(true);
});

test("an explicit SSH row reload offers trust while preserving the successful full-check history", async () => {
  await enroll();
  run.mockResolvedValue(good);
  await hosts.action({ action: "preflight", host: "box", codeFolder: "/code" });
  run.mockResolvedValue(unknownKey);
  const state = await hosts.action({ action: "reload", host: "box", target: { kind: "ssh" } });
  expect(state.hosts[0]?.hostKeyTrust).toBe("askpass");
  expect(settings.registeredHosts?.[0]?.observation?.preflight.result.ok).toBe(true);
  run.mockClear();
  await trust();
  expect(mock.trust).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});
