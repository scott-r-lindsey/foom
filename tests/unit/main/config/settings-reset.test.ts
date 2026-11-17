import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { configPart } from "../../../../src/main/config/approval";
import { ConfigFiles } from "../../../../src/main/config/files";
import { DEFAULT_SETTINGS, SettingsStore } from "../../../../src/main/setup/settings";
import { fixture } from "./service-fixture";

const preferences = {
  concurrentChildren: 16,
  interfaceScale: 150,
  agents: { claude: true, codex: true, agy: true },
} as const;

// #1234: use production defaults; older config fixtures enable agents by default.
const defaults = configPart(DEFAULT_SETTINGS);

test("a second profile's stale Settings save preserves the child limit and zoom before its watcher runs", async () => {
  const first = await fixture({ defaults });
  await first.service.initialize();
  const second = await fixture({ defaults, root: first.folder });
  await second.service.initialize();
  await first.service.write(preferences);
  // Independent baselines and queues share the config file, as Dev and packaged
  // profiles do. Deliberately do not notify the second profile's fixture watcher.
  expect(second.applied.at(-1)).toEqual({});
  await second.service.write({ agents: { ...preferences.agents, opencode: true } });
  expect(JSON.parse(await first.read("settings.json"))).toEqual({
    kind: "settings",
    ...preferences,
    agents: { ...preferences.agents, opencode: true },
  });
  await first.service.refresh();
  expect(first.applied.at(-1)).toEqual(second.applied.at(-1));
  expect(first.applied.at(-1)).toMatchObject(preferences);
});

test.each(["partial JSON", "read failure"])(
  "a cold profile cannot overwrite all preferences after startup %s",
  async (failure) => {
    const f = await fixture({ defaults });
    await mkdir(f.folder);
    const saved = JSON.stringify({ kind: "settings", ...preferences });
    const interrupted = failure === "partial JSON" ? saved.slice(0, -1) : saved;
    await f.write("settings.json", interrupted);
    const files = new ConfigFiles({ root: f.folder });
    const read = files.read.bind(files);
    const reader = vi.spyOn(ConfigFiles.prototype, "read").mockImplementation((file) => {
      if (failure === "read failure" && file === "settings.json")
        return Promise.reject(new Error("fixture sharing lock"));
      return read(file);
    });
    try {
      expect(await f.service.initialize()).toEqual({});
      expect(f.baseline()).toBeNull();
      await expect(f.service.write({ agents: preferences.agents })).rejects.toThrow(
        "Unable to read valid Foom settings",
      );
      expect(await f.read("settings.json")).toBe(interrupted);
      expect(f.applied.at(-1)).toEqual({});
      expect(f.copy()).toBeNull();
    } finally {
      reader.mockRestore();
    }
    // After the external writer completes or the read lock clears, the same UI
    // action must recover the saved child limit and zoom rather than save 4/100.
    await f.write("settings.json", saved);
    await f.service.write({ agents: preferences.agents });
    expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings", ...preferences });
    expect(f.applied.at(-1)).toEqual(preferences);
    expect(f.copy()).toBe(await f.read("settings.json"));
    expect(f.service.status().rejected).toEqual([]);
  },
);

test.each([false, true])(
  "optional-agent migration preserves saved child limit and zoom (explicit agents: %s)",
  async (explicit) => {
    const f = await fixture({ defaults });
    const profile = join(f.root, "profile");
    await mkdir(profile);
    const settings = {
      setupComplete: true,
      concurrentChildren: preferences.concurrentChildren,
      interfaceScale: preferences.interfaceScale,
      ...(explicit ? { agents: preferences.agents } : {}),
    };
    await writeFile(join(profile, "settings.json"), JSON.stringify({ version: 1, settings }));
    const store = await SettingsStore.open(profile);
    const values = await f.service.initialize(store.legacyConfig());
    await store.attachConfig((patch) => f.service.write(patch), values, f.baseline());
    expect(store.get()).toMatchObject({
      ...settings,
      agents: explicit ? preferences.agents : {},
    });
    expect(JSON.parse(await f.read("settings.json"))).toMatchObject({
      concurrentChildren: 16,
      interfaceScale: 150,
    });
    const backup: unknown = JSON.parse(
      await readFile(join(profile, "settings-before-optional-agents.json"), "utf8"),
    );
    expect(backup).toEqual({ version: 1, settings });
  },
);
