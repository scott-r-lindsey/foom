import { mkdir } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { configPart } from "../../../../src/main/config/approval";
import { digest } from "../../../../src/main/config/layout";
import { ConfigService } from "../../../../src/main/config/service";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { services, fixture } from "./service-fixture";

test("all file argument edits hold; Keep restores and Settings writes apply directly", async () => {
  const f = await fixture({ confirmArguments: () => Promise.resolve(true) });
  await f.service.initialize();
  const argumentsA = { claude: [], codex: ["--model", "a model"], agy: [] };
  await f.settings({ agentArguments: argumentsA });
  expect((await f.service.refresh()).pending?.detail).toBe("agentArguments.codex");
  expect(f.applied.at(-1)?.agentArguments).toBeUndefined();
  await f.decide("keep");
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
  await f.service.write({ agentArguments: argumentsA });
  expect(f.service.status().pending).toBeNull();
  expect(f.applied.at(-1)?.agentArguments).toEqual(argumentsA);
  expect((await f.service.refresh()).pending).toBeNull();
  await f.settings({});
  expect((await f.service.refresh()).pending?.detail).toBe("agentArguments.codex");
  await f.decide("allow");
  expect(f.applied.at(-1)?.agentArguments).toBeUndefined();
  expect((await f.service.refresh()).pending).toBeNull();
});

test("Allow discloses and acknowledges bypass, cancellation leaves it held", async () => {
  const confirm = vi.fn().mockResolvedValue(false);
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const f = await fixture({ confirmArguments: confirm, acknowledgeBypass: acknowledge });
  await f.service.initialize();
  const args = {
    claude: ["--dangerously-skip-permissions"],
    codex: ["--dangerously-bypass-approvals-and-sandbox"],
    agy: [],
  };
  await f.settings({ agentArguments: args, hooks: false });
  const held = await f.service.refresh();
  expect(held.pending?.detail).toBe("hooks: on → off, agentArguments.claude, agentArguments.codex");
  expect(held.pending).not.toHaveProperty("agentArguments");
  await f.decide("allow");
  expect(f.service.status().pending).toEqual(held.pending);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(confirm.mock.calls[0]?.[0]).toMatchObject({
    title: "Allow agent launch arguments?",
    accept: "Allow",
  });
  confirm.mockResolvedValue(true);
  await f.decide("allow");
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(["claude", "codex"]);
  expect(f.applied.at(-1)).toEqual({ agentArguments: args, hooks: false });
});

test("Allow rechecks bytes after the trusted dialog and never acknowledges a replaced proposal", async () => {
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const f = await fixture({ acknowledgeBypass: acknowledge });
  await f.service.initialize();
  await f.settings({
    agentArguments: { claude: [], codex: ["--dangerously-bypass-approvals-and-sandbox"], agy: [] },
  });
  await f.service.refresh();
  // Without a trusted confirmation capability Allow fails closed.
  await f.decide("allow");
  expect(f.service.status().pending).not.toBeNull();
  await f.service.dispose();
  const next = new ConfigService({
    root: f.folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => {},
    baseline: { get: f.baseline, set: async () => {} },
    themeBaseline: { get: () => null, set: async () => {} },
    watch: () => ({ close() {} }),
    acknowledgeBypass: acknowledge,
    confirmArguments: async () => {
      await f.settings({
        agentArguments: { claude: [], codex: ["--model", "replacement"], agy: [] },
      });
      return true;
    },
  });
  services.push(next);
  await next.initialize();
  const id = next.status().pending?.id;
  await expect(next.decide("allow", id)).rejects.toThrow("file changed");
  expect(next.status().pending?.id).not.toBe(id);
  expect(acknowledge).not.toHaveBeenCalled();
});

test("approved argument changes acknowledge bundled IDs outside the original three agents", async () => {
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  const f = await fixture({
    confirmArguments: () => Promise.resolve(true),
    acknowledgeBypass: acknowledge,
  });
  await f.service.initialize();
  await f.settings({
    agentArguments: { ...DEFAULT_SETTINGS.agentArguments, opencode: ["--auto"] },
  });
  await f.service.refresh();
  await f.decide("allow");
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith(["opencode"]);
});

test("migration inserts arguments without approving other file edits, preserving a recoverable baseline", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.service.dispose();
  const approved = f.baseline();
  await f.settings({ hooks: false });
  const args = { claude: [], codex: ["--ask-for-approval", "never"], agy: [] };
  let baseline = approved;
  let copy = f.copy();
  const apply = vi.fn();
  const create = () => {
    const service = new ConfigService({
      root: f.folder,
      defaults: configPart(DEFAULT_SETTINGS),
      apply,
      baseline: {
        get: () => baseline,
        set: (value) => {
          baseline = value;
          return Promise.resolve();
        },
      },
      appliedText: {
        get: () => copy,
        set: (text) => {
          copy = text;
          return Promise.resolve();
        },
      },
      themeBaseline: { get: () => null, set: async () => {} },
      watch: () => ({ close() {} }),
    });
    services.push(service);
    return service;
  };
  const migrated = create();
  expect(await migrated.initialize({ agentArguments: args })).toEqual({ agentArguments: args });
  expect(migrated.status().pending?.detail).toBe("hooks: on → off");
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    agentArguments: args,
    hooks: false,
  });
  await migrated.dispose();
  const reopened = create();
  expect(await reopened.initialize()).toEqual({ agentArguments: args });
  await reopened.decide("keep", reopened.status().pending?.id);
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    agentArguments: args,
  });
  expect((await reopened.refresh()).pending).toBeNull();
});

test("a preexisting argument proposal is held against migrated profile arguments", async () => {
  const f = await fixture({ confirmArguments: () => Promise.resolve(true) });
  await mkdir(f.folder, { recursive: true });
  const args = { claude: ["--model", "profile"], codex: [], agy: [] };
  const proposal = { claude: [], codex: ["--model", "file"], agy: [] };
  await f.settings({ agentArguments: proposal });
  expect(await f.service.initialize({ agentArguments: args })).toEqual({ agentArguments: args });
  expect(f.service.status().pending?.detail).toBe("agentArguments.claude, agentArguments.codex");
  await f.decide("allow");
  expect(f.applied.at(-1)?.agentArguments).toEqual(proposal);
});

test("migration refuses an invalid existing file so profile arguments can be retried", async () => {
  const f = await fixture();
  await mkdir(f.folder, { recursive: true });
  await f.write("settings.json", "{");
  await expect(
    f.service.initialize({ agentArguments: { claude: ["--verbose"], codex: [], agy: [] } }),
  ).rejects.toThrow();
  expect(f.applied).toEqual([]);
  expect(await f.read("settings.json")).toBe("{");
});

test.each([false, true])(
  "oversized profile arguments cannot be silently dropped during migration (file exists: %s)",
  async (existing) => {
    const f = await fixture();
    if (existing) {
      await mkdir(f.folder, { recursive: true });
      await f.settings({});
    }
    const agentArguments = {
      claude: [],
      codex: Array.from({ length: 20 }, () => "x".repeat(4096)),
      agy: [],
    };
    await expect(f.service.initialize({ agentArguments })).rejects.toThrow();
    expect(f.applied).toEqual([]);
    if (existing) expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
    else await expect(f.read("settings.json")).rejects.toThrow();
  },
);

test("a new file migrates profile arguments as its own approved write", async () => {
  const f = await fixture();
  const agentArguments = { claude: ["--model", "unchanged literal 'value'"], codex: [], agy: [] };
  expect(await f.service.initialize({ agentArguments })).toEqual({ agentArguments });
  expect(f.service.status().pending).toBeNull();
  expect(f.baseline()).toBe(digest(await f.read("settings.json")));
});
