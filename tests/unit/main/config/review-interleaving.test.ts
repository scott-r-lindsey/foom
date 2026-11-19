import { rename, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "vitest";
import { ConfigFiles } from "../../../../src/main/config/files";
import { configPart } from "../../../../src/main/config/approval";
import { DEFAULT_SETTINGS, SettingsStore } from "../../../../src/main/setup/settings";
import { fixture } from "./service-fixture";
const defaults = configPart(DEFAULT_SETTINGS);
const preferences = {
  concurrentChildren: 16,
  interfaceScale: 150,
  agents: { claude: true, codex: true, agy: true },
};
test("concurrent profile save fails closed at rename contention and retries against fresh bytes", async () => {
  const first = await fixture({ defaults });
  await first.service.initialize();
  let armed = false;
  const { promise: atRename, resolve: entered } = Promise.withResolvers<undefined>();
  const { promise: resume, resolve: release } = Promise.withResolvers<undefined>();
  const second = await fixture({
    defaults,
    root: first.folder,
    rename: async (from, to) => {
      if (armed && to === join(first.folder, "settings.json")) {
        entered(undefined);
        await resume;
      }
      await rename(from, to);
    },
  });
  await second.service.initialize();
  armed = true;
  const save = second.service.write({ agents: preferences.agents });
  await atRename;
  try {
    await expect(first.service.write(preferences)).rejects.toThrow();
  } finally {
    release(undefined);
  }
  await save;
  await first.service.write(preferences);
  const result: unknown = JSON.parse(await first.read("settings.json"));
  expect(result).toEqual({ kind: "settings", ...preferences });
});
test("rejected profile baseline cannot overwrite held shared preferences", async () => {
  const f = await fixture({ defaults });
  await mkdir(f.folder);
  await f.settings({ ...preferences, agentArguments: { codex: ["--model", "fixture-model"] } });
  const profile = join(f.root, "profile");
  await mkdir(profile);
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({
      version: 2,
      settings: { setupComplete: true, agentBypassAcknowledged: { codex: "invalid" } },
    }),
  );
  const store = await SettingsStore.open(profile);
  expect(store.get().setupComplete).toBe(false);
  const values = await f.service.initialize(store.legacyConfig());
  expect(values).toEqual({});
  expect(f.service.status().pending).not.toBeNull();
  await store.attachConfig((patch) => f.service.write(patch), values, f.baseline());
  const original = await f.read("settings.json");
  await expect(store.update({ agents: preferences.agents })).rejects.toThrow();
  expect(await f.read("settings.json")).toBe(original);
  expect(store.get()).toMatchObject({ concurrentChildren: 4, interfaceScale: 100 });
});

test("the read-only startup review still holds unsafe settings while another profile owns the lock", async () => {
  const f = await fixture({ defaults });
  await mkdir(f.folder);
  await f.settings({ hooks: false });
  const original = await f.read("settings.json");
  const files = new ConfigFiles({ root: f.folder });
  await files.withSettingsLock(async () => {
    expect(await f.service.initialize()).toEqual({});
    expect(f.service.status().pending?.detail).toBe("hooks: on → off");
    expect(await f.read("settings.json")).toBe(original);
  });
});

test("a stale lock refuses saves and removal permits retry without losing current keys", async () => {
  const f = await fixture({ defaults });
  await f.service.initialize();
  const original = await f.read("settings.json");
  await f.write(".foom-settings.lock", "");
  await expect(f.service.write(preferences)).rejects.toThrow("foom-error:settings-lock-corrupt");
  expect(await f.read("settings.json")).toBe(original);
  await rm(join(f.folder, ".foom-settings.lock"));
  await f.service.write(preferences);
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings", ...preferences });
});

test("an unsafe lock path refuses saves and a failed rename releases its lock", async () => {
  let fail = false;
  const f = await fixture({
    defaults,
    rename: async (from, to) => {
      if (fail) throw new Error("fixture replacement failure");
      await rename(from, to);
    },
  });
  await f.service.initialize();
  fail = true;
  await expect(f.service.write(preferences)).rejects.toThrow("not applied");
  expect(await readdir(f.folder)).not.toContain(".foom-settings.lock");
  fail = false;
  await f.service.write(preferences);
  // A non-directory parent fails with ENOTDIR rather than looking like contention.
  const files = new ConfigFiles({
    root: join(f.folder, "settings.json"),
    platform: process.platform,
  });
  await expect(files.withSettingsLock(async () => {})).rejects.toThrow();
});
