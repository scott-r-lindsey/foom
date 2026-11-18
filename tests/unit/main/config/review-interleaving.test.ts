import { rename, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, vi } from "vitest";
import { ConfigFiles } from "../../../../src/main/config/files";
import { configPart } from "../../../../src/main/config/approval";
import { DEFAULT_SETTINGS, SettingsStore } from "../../../../src/main/setup/settings";
import { ApplicationError } from "../../../../src/shared/application-errors";
import type { ConfigSettings } from "../../../../src/shared/config";
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

test("startup returns on lock contention and attaches the writer after its deferred scan", async () => {
  const owner = await fixture({ defaults });
  await owner.service.initialize();
  const store = await SettingsStore.open(join(owner.root, "profile"));
  const onDeferredReady = vi.fn<(values: ConfigSettings) => Promise<void>>();
  const startup = await fixture({
    root: owner.folder,
    defaults,
    apply: (values) => {
      store.setConfig(values);
    },
    onDeferredReady,
  });
  onDeferredReady.mockImplementation((values) =>
    store.attachConfig((patch) => startup.service.write(patch), values, startup.baseline()),
  );
  const unlock = Promise.withResolvers<undefined>();
  const files = new ConfigFiles({ root: owner.folder });
  const lock = vi.spyOn(ConfigFiles.prototype, "withSettingsLock");
  lock.mockRejectedValueOnce(new ApplicationError("settings-busy"));
  lock.mockImplementationOnce(async (work) => {
    await unlock.promise;
    return files.withSettingsLock(work);
  });
  try {
    store.deferConfig(await startup.service.initialize());
    expect(startup.service.ready).toBe(false);
    expect(startup.service.status().error).toBe("Settings are busy; try again.");
    expect(onDeferredReady).not.toHaveBeenCalled();
    await expect(store.update({ interfaceScale: 120 })).rejects.toThrow("foom-error:settings-busy");
    await owner.settings({ terminalFontSize: 18 });
  } finally {
    unlock.resolve(undefined);
  }
  try {
    await vi.waitFor(() => {
      expect(startup.service.ready).toBe(true);
    });
    expect(startup.service.status().error).toBeUndefined();
    expect(onDeferredReady).toHaveBeenCalledExactlyOnceWith({ terminalFontSize: 18 });
    expect(await store.update({ interfaceScale: 150 })).toMatchObject({
      interfaceScale: 150,
      terminalFontSize: 18,
    });
    expect(JSON.parse(await owner.read("settings.json"))).toMatchObject({
      interfaceScale: 150,
      terminalFontSize: 18,
    });
  } finally {
    lock.mockRestore();
  }
});

test("a watcher retries a busy scan after lock removal without another settings edit", async () => {
  const f = await fixture({ defaults });
  await f.service.initialize();
  const attempted = Promise.withResolvers<undefined>();
  const lock = vi.spyOn(ConfigFiles.prototype, "withSettingsLock");
  lock.mockImplementationOnce(() => {
    attempted.resolve(undefined);
    return Promise.reject(new ApplicationError("settings-busy"));
  });
  await f.settings({ interfaceScale: 140 });
  f.listeners[0]?.("settings.json");
  await attempted.promise;
  expect(f.applied.at(-1)).toEqual({});
  f.listeners[0]?.(".foom-settings.lock");
  try {
    await vi.waitFor(() => {
      expect(f.applied.at(-1)).toEqual({ interfaceScale: 140 });
    });
  } finally {
    lock.mockRestore();
  }
});

test("deferred startup shows a profile write failure alongside the busy status until attachment", async () => {
  const owner = await fixture({ defaults });
  await owner.service.initialize();
  const store = await SettingsStore.open(join(owner.root, "profile"));
  const release = Promise.withResolvers<undefined>();
  const onDeferredReady = vi.fn<(values: ConfigSettings) => Promise<void>>();
  const startup = await fixture({ root: owner.folder, defaults, onDeferredReady });
  onDeferredReady
    .mockRejectedValueOnce(new Error("fixture profile write failure"))
    .mockImplementation(async (values) => {
      await release.promise;
      await store.attachConfig((patch) => startup.service.write(patch), values, startup.baseline());
    });
  const lock = vi.spyOn(ConfigFiles.prototype, "withSettingsLock");
  lock.mockRejectedValueOnce(new ApplicationError("settings-busy"));
  try {
    store.deferConfig(await startup.service.initialize());
    await vi.waitFor(() => {
      expect(startup.service.status().error).toBe(
        "Settings are busy; try again. Unable to save profile settings.",
      );
    });
    expect(startup.service.ready).toBe(false);
    await expect(store.update({ interfaceScale: 120 })).rejects.toThrow("foom-error:settings-busy");
  } finally {
    lock.mockRestore();
    release.resolve(undefined);
  }
  await vi.waitFor(() => {
    expect(startup.service.ready).toBe(true);
  });
  expect(startup.service.status().error).toBeUndefined();
});
