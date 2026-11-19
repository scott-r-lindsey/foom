import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { configPart } from "../../../../src/main/config/approval";
import { ConfigFiles } from "../../../../src/main/config/files";
import { digest } from "../../../../src/main/config/layout";
import { DEFAULT_SETTINGS, SettingsStore } from "../../../../src/main/setup/settings";
import { fixture } from "./service-fixture";

const preferences = {
  concurrentChildren: 16,
  interfaceScale: 150,
  agents: { claude: true, codex: true, agy: true },
} as const;

// #1234: use production defaults; older config fixtures enable agents by default.
const defaults = configPart(DEFAULT_SETTINGS);

test.each([
  ["zoom", { interfaceScale: 110 }],
  ["agent arguments", { agentArguments: { opencode: ["--model", "example"] } }],
] as const)("a scan and later Settings save preserve saved %s", async (_setting, patch) => {
  const { promise: entered, resolve: atRename } = Promise.withResolvers<undefined>();
  const { promise: resume, resolve: finishRename } = Promise.withResolvers<undefined>();
  let pauseSettingsWrite = false;
  const f = await fixture({
    defaults,
    rename: async (from, to) => {
      if (pauseSettingsWrite && to === join(f.folder, "settings.json")) {
        pauseSettingsWrite = false;
        atRename(undefined);
        await resume;
      }
      await rename(from, to);
    },
  });
  await f.service.initialize();
  await f.settings({ hooks: false });
  expect((await f.service.refresh()).pending?.detail).toBe("hooks: on → off");

  pauseSettingsWrite = true;
  const first = f.service.write(patch);
  await entered;
  const scan = f.service.refresh();
  const agents = { claude: true };
  const later = f.service.write({ agents });
  try {
    expect(f.applied.at(-1)).toEqual({});
  } finally {
    finishRename(undefined);
  }
  await first;
  expect((await scan).pending?.detail).toBe("hooks: on → off");
  await later;

  expect(f.applied.at(-1)).toEqual({ ...patch, agents });
  expect(JSON.parse(f.copy() ?? "")).toEqual({ kind: "settings", ...patch, agents });
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    hooks: false,
    ...patch,
    agents,
  });
  expect(f.service.status().pending?.detail).toBe("hooks: on → off");
});

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

test.each(["write", "refresh"])(
  "Keep preserves safe shared settings after the stale profile runs %s",
  async (action) => {
    const first = await fixture({ defaults });
    await first.service.initialize();
    const agentArguments = { claude: ["--verbose"] };
    await first.service.write({ interfaceScale: 100, agents: { claude: true }, agentArguments });
    const second = await fixture({
      defaults,
      root: first.folder,
      baseline: digest(await first.read("settings.json")),
    });
    await second.service.initialize();
    await first.settings({
      hooks: false,
      interfaceScale: 100,
      agents: { claude: false, codex: true },
      agentArguments: { claude: ["--debug"] },
    });
    await first.service.write({ interfaceScale: 110 });
    expect(second.applied.at(-1)?.interfaceScale).toBe(100);
    const agents =
      action === "write" ? { claude: true, codex: true, agy: true } : { claude: true, codex: true };
    if (action === "write") {
      await second.service.write({ agents });
      expect(second.applied.at(-1)).toEqual({ interfaceScale: 110, agents, agentArguments });
      expect(JSON.parse(second.copy() ?? "")).toEqual({
        kind: "settings",
        ...second.applied.at(-1),
      });
    } else {
      await second.service.refresh();
    }
    expect(second.service.status().pending?.detail).toBe(
      action === "write"
        ? "hooks: on → off, agentArguments.claude"
        : "hooks: on → off, agents.claude: on → off, agentArguments.claude",
    );
    expect(JSON.parse(await first.read("settings.json"))).toMatchObject({
      hooks: false,
      interfaceScale: 110,
      agents: action === "write" ? agents : { claude: false, codex: true },
      agentArguments: { claude: ["--debug"] },
    });

    await second.decide("keep");
    const bytes = await first.read("settings.json");
    expect(JSON.parse(bytes)).toEqual({
      kind: "settings",
      interfaceScale: 110,
      agents,
      agentArguments,
    });
    expect(second.copy()).toBe(bytes);
    expect(second.service.status().pending).toBeNull();
    expect((await first.service.refresh()).pending).toBeNull();
    expect(first.applied.at(-1)).toEqual(second.applied.at(-1));
  },
);

test("a disjoint full provider map keeps its approved entries through Settings save and Keep", async () => {
  const f = await fixture({ defaults });
  const approvedAgents = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`approved-${String(index)}`, true]),
  );
  const proposedAgents = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`proposed-${String(index)}`, true]),
  );
  await f.service.initialize({ agents: approvedAgents });
  await f.settings({ agents: proposedAgents, hooks: false, interfaceScale: 110 });
  expect((await f.service.refresh()).pending?.detail).toContain("agents.approved-0: on → off");

  await f.service.write({ interfaceScale: 120 });
  const approved = { kind: "settings", agents: approvedAgents, interfaceScale: 120 };
  expect(JSON.parse(f.copy() ?? "")).toEqual(approved);
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    ...approved,
    agents: proposedAgents,
    hooks: false,
  });
  expect(f.applied.at(-1)).toEqual({ agents: approvedAgents, interfaceScale: 120 });
  expect((await f.decide("keep")).pending).toBeNull();
  expect(JSON.parse(await f.read("settings.json"))).toEqual(approved);
  expect(f.copy()).toBe(await f.read("settings.json"));
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
