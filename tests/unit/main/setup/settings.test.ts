import { interfaceThemes } from "../../../../src/shared/interface-themes";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  DEFAULT_SETTINGS,
  parseSettingsPatch,
  SettingsStore,
} from "../../../../src/main/setup/settings";

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "foom-settings-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("patches copy only known, well-formed fields", () => {
  expect(
    parseSettingsPatch({
      setupComplete: true,
      hooks: false,
      worktreeLocation: "adjacent",
      agents: { claude: true, codex: false, agy: true },
      colorMode: "dark",
      interfaceScale: 120,
      terminalFontSize: 18,
      codeFolder: "/home/me/code",
    }),
  ).toEqual({
    codeFolder: "/home/me/code",
    terminalFontSize: 18,
    colorMode: "dark",
    interfaceScale: 120,
    setupComplete: true,
    hooks: false,
    worktreeLocation: "adjacent",
    agents: { claude: true, codex: false, agy: true },
  });
  expect(parseSettingsPatch({})).toEqual({});
  for (const bad of [
    null,
    [],
    "hooks",
    { hooks: "yes" },
    { setupComplete: 1 },
    { worktreeLocation: "elsewhere" },
    { agents: { claude: true, codex: true } },
    { agents: { claude: true, codex: true, agy: "yes" } },
    { agents: { claude: true, codex: true, agy: true, other: true } },
    { agents: [] },
    { extra: true },
    { inferenceTimeoutMs: 999 },
    { inferenceTimeoutMs: 30_001 },
    { inferenceTimeoutMs: 5000.5 },
    { inferenceTimeoutMs: "5000" },
    { colorMode: "sepia" },
    { interfaceScale: 105 },
    { interfaceScale: 200 },
    { interfaceScale: "100" },
    ...[9, 33, 14.5, "14", null, NaN, Infinity].map((terminalFontSize) => ({ terminalFontSize })),
    { codeFolder: "relative/code" },
    { codeFolder: "/bad\0path" },
    { codeFolder: `/${"x".repeat(4096)}` },
    { codeFolder: 7 },
  ])
    expect(() => parseSettingsPatch(bad), JSON.stringify(bad)).toThrow("Invalid settings");
  expect(() => parseSettingsPatch({ inference: { kind: "claude" } })).toThrow("Invalid settings");
});

test("a missing, corrupt or unsupported file starts from defaults", async () => {
  const dir = await directory();
  expect((await SettingsStore.open(dir)).get()).toBe(DEFAULT_SETTINGS);
  const file = path.join(dir, "settings.json");
  for (const contents of [
    "not json",
    JSON.stringify({ version: 3, settings: { setupComplete: true } }),
    JSON.stringify({ version: 1, settings: { setupComplete: "yes" } }),
    JSON.stringify({ version: 1 }),
    JSON.stringify([]),
  ]) {
    await writeFile(file, contents);
    expect((await SettingsStore.open(dir)).get(), contents).toEqual(DEFAULT_SETTINGS);
  }
  // A partial but valid file keeps defaults for everything it omits.
  await writeFile(file, JSON.stringify({ version: 1, settings: { setupComplete: true } }));
  expect((await SettingsStore.open(dir)).get()).toEqual({
    ...DEFAULT_SETTINGS,
    setupComplete: true,
  });
});

test("updates are private, atomic, serialized and survive a restart", async () => {
  const root = await directory();
  const dir = path.join(root, "user-data");
  const store = await SettingsStore.open(dir);
  const [first, second] = await Promise.all([
    store.update({ hooks: false }),
    store.update({ worktreeLocation: "adjacent", terminalFontSize: 32 }),
  ]);
  expect(first.hooks).toBe(false);
  expect(second).toMatchObject({
    hooks: false,
    worktreeLocation: "adjacent",
    terminalFontSize: 32,
  });
  expect(await readdir(dir)).toEqual(["settings.json"]);
  const file = path.join(dir, "settings.json");
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, settings: second });
  expect((await SettingsStore.open(dir)).get()).toEqual(second);
});

test("a failed write leaves settings unchanged and later writes still work", async () => {
  const root = await directory();
  const dir = path.join(root, "blocked");
  const store = await SettingsStore.open(dir);
  await writeFile(dir, "a file where the folder should be");
  await expect(store.update({ setupComplete: true })).rejects.toThrow();
  expect(store.get().setupComplete).toBe(false);
  await rm(dir);
  await expect(store.update({ setupComplete: true })).resolves.toMatchObject({
    setupComplete: true,
  });
});

test("interface themes persist, preserve legacy modes and reject invalid portable colors", async () => {
  const dir = await directory();
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ version: 1, settings: { colorMode: "dark" } }),
  );
  const store = await SettingsStore.open(dir);
  expect(store.get()).toMatchObject({ colorMode: "dark", interfaceTheme: "follow" });
  await store.update(parseSettingsPatch({ interfaceTheme: "deep-field" }));
  expect((await SettingsStore.open(dir)).get().interfaceTheme).toBe("deep-field");
  const custom = { ...interfaceThemes.moonlight, name: "My Moonlight" };
  await store.update(parseSettingsPatch({ interfaceTheme: custom }));
  expect((await SettingsStore.open(dir)).get().interfaceTheme).toEqual(custom);
  expect(() => parseSettingsPatch({ interfaceTheme: { colors: { bg: "url(x)" } } })).toThrow();
});

test("sound choices, mutes and volumes persist after reopening", async () => {
  const dir = await directory();
  const store = await SettingsStore.open(dir);
  const sound = {
    ...DEFAULT_SETTINGS.sound,
    working: true,
    alerts: false,
    workingVolume: 0.3,
    alertVolume: 0.7,
  };
  await store.update(parseSettingsPatch({ sound }));
  expect((await SettingsStore.open(dir)).get().sound).toEqual(sound);
  expect(() => parseSettingsPatch({ sound: { ...sound, alertVolume: 2 } })).toThrow();
});

test("stores default argv and per-agent acknowledgement and migrates old profiles", async () => {
  const dir = await directory();
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ version: 1, settings: { setupComplete: true } }),
  );
  const store = await SettingsStore.open(dir);
  expect(store.get().agentArguments).toEqual({ claude: [], codex: [], agy: [] });
  const patch = parseSettingsPatch({
    agentArguments: { claude: ["--model", "a model"], codex: [], agy: [] },
    agentBypassAcknowledged: { claude: true, codex: false, agy: false },
  });
  await store.update(patch);
  expect((await SettingsStore.open(dir)).get()).toEqual(store.get());
  expect(() => parseSettingsPatch({ agentBypassAcknowledged: { claude: true } })).toThrow();
  expect(() =>
    parseSettingsPatch({ agentArguments: { claude: ["--settings"], codex: [], agy: [] } }),
  ).toThrow("reserved");
});

test.each([
  { claude: ["--bare"], codex: ["--model", "saved model"], agy: ["--mode", "plan"] },
  { claude: ["--settings={}"], codex: ["--model", "saved model"], agy: ["--mode", "plan"] },
])(
  "a newly reserved argument discards only that agent's stored defaults",
  async (agentArguments) => {
    const dir = await directory();
    const settings = {
      ...DEFAULT_SETTINGS,
      setupComplete: true,
      interfaceTheme: "moonlight",
      agentBypassAcknowledged: { claude: true, codex: true, agy: false },
      agentArguments,
    };
    await writeFile(path.join(dir, "settings.json"), JSON.stringify({ version: 1, settings }));
    const store = await SettingsStore.open(dir);
    expect(store.get()).toEqual({ ...settings, agentArguments: { ...agentArguments, claude: [] } });
    await store.update({ terminalFontSize: 16 });
    expect((await SettingsStore.open(dir)).get()).toEqual(store.get());
    expect(() => parseSettingsPatch({ agentArguments })).toThrow("reserved");
  },
);

test.each([null, [], "invalid", { codex: ["--model", "x"], agy: [42] }])(
  "malformed stored defaults preserve unrelated settings: %j",
  async (agentArguments) => {
    const dir = await directory();
    await writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        version: 1,
        settings: { colorMode: "dark", setupComplete: true, agentArguments },
      }),
    );
    const settings = (await SettingsStore.open(dir)).get();
    expect(settings.colorMode).toBe("dark");
    expect(settings.setupComplete).toBe(true);
    expect(settings.agentArguments.claude).toEqual([]);
    expect(settings.agentArguments.agy).toEqual([]);
  },
);

test("legacy soundscape migrates on disk without changing switches or volumes", async () => {
  const dir = await directory();
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      version: 1,
      settings: {
        sound: {
          soundscape: "soft",
          working: true,
          workingVolume: 0.23,
          alerts: false,
          alertVolume: 0.42,
        },
      },
    }),
  );
  const store = await SettingsStore.open(dir);
  expect(store.get().sound).toEqual({
    ...DEFAULT_SETTINGS.sound,
    working: true,
    workingVolume: 0.23,
    alerts: false,
    alertVolume: 0.42,
  });
  expect(() =>
    parseSettingsPatch({
      sound: {
        soundscape: "soft",
        working: true,
        workingVolume: 0.23,
        alerts: false,
        alertVolume: 0.42,
      },
    }),
  ).toThrow();
});

test("panel color validates and defaults to vivid", () => {
  expect(DEFAULT_SETTINGS.panelColor).toBe("vivid");
  for (const panelColor of ["vivid", "subtle", "plain"])
    expect(parseSettingsPatch({ panelColor })).toEqual({ panelColor });
  for (const panelColor of [null, "bright", 0])
    expect(() => parseSettingsPatch({ panelColor })).toThrow();
});

test("legacy sources and limits are dropped and ciphertext is removed idempotently", async () => {
  const dir = await directory();
  const file = path.join(dir, "settings.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        hooks: false,
        interfaceScale: 120,
        inference: { kind: "openai", model: "saved-model" },
        inferenceTimeoutMs: 15000,
      },
    }),
  );
  for (const provider of ["anthropic", "openai", "google"])
    await writeFile(path.join(dir, `inference-${provider}.key`), Buffer.from([0, 128, 255]));
  const temporary = "inference-openai.key.12345678-1234-4234-8234-123456789abc.tmp";
  await writeFile(path.join(dir, temporary), Buffer.from([0, 128, 255]));
  const unrelated = [
    "unrelated.key",
    "inference-openai.key.not-a-uuid.tmp",
    "inference-other.key.12345678-1234-4234-8234-123456789abc.tmp",
  ];
  for (const file of unrelated) await writeFile(path.join(dir, file), "keep");
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = await SettingsStore.open(dir);
    expect(store.get()).toMatchObject({ setupComplete: true, hooks: false, interfaceScale: 120 });
    expect(store.get()).not.toHaveProperty("inference");
    expect(store.get()).not.toHaveProperty("inferenceTimeoutMs");
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["settings.json", "unrelated.key"]));
    expect((await readdir(dir)).sort()).toEqual(["settings.json", ...unrelated].sort());
    for (const file of unrelated) expect(await readFile(path.join(dir, file), "utf8")).toBe("keep");
    expect(await readFile(file, "utf8")).not.toContain("inference");
  }
  for (const patch of [{ inference: { kind: "rules" } }, { inferenceTimeoutMs: 5000 }])
    expect(() => parseSettingsPatch(patch)).toThrow("Invalid settings");
});

test("key cleanup fails closed without recursively deleting unexpected directories", async () => {
  const dir = await directory();
  const unexpected = path.join(dir, "inference-openai.key");
  await mkdir(unexpected);
  await writeFile(path.join(unexpected, "keep"), "keep");
  await expect(SettingsStore.open(dir)).rejects.toThrow();
  expect(await readFile(path.join(unexpected, "keep"), "utf8")).toBe("keep");
});

test("key migration reports unreadable profile directories", async () => {
  const dir = await directory();
  const file = path.join(dir, "not-a-directory");
  await writeFile(file, "keep");
  await expect(SettingsStore.open(file)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("keep");
});

test("attaching Foom config moves agent-editable values out of the profile exactly once", async () => {
  const dir = await directory();
  const file = path.join(dir, "settings.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      settings: {
        setupComplete: true,
        terminalFontSize: 18,
        hooks: false,
        worktreeLocation: "adjacent",
      },
    }),
  );
  const store = await SettingsStore.open(dir);
  expect(store.legacyConfig()).toEqual({ terminalFontSize: 18, hooks: false });
  expect(store.configDigest()).toBeNull();
  const writes: unknown[] = [];
  const writer = (patch: object) => {
    writes.push(patch);
    store.setConfig({ ...store.get(), ...patch, agents: store.get().agents });
    return Promise.resolve();
  };
  await store.attachConfig(writer, { terminalFontSize: 18, hooks: false }, "a".repeat(64));
  const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  expect(stored).toEqual({
    version: 2,
    settings: expect.not.objectContaining({ terminalFontSize: 18 }) as unknown,
    configDigest: "a".repeat(64),
  });
  expect(stored["settings"]).toMatchObject({ setupComplete: true, worktreeLocation: "adjacent" });
  expect(stored["settings"]).not.toHaveProperty("hooks");
  expect(store.get()).toMatchObject({ terminalFontSize: 18, hooks: false });

  // Reopening finds nothing left to migrate; config keys come only from the file.
  const reopened = await SettingsStore.open(dir);
  expect(reopened.legacyConfig()).toBeUndefined();
  expect(reopened.configDigest()).toBe("a".repeat(64));
  expect(reopened.get()).toMatchObject({ terminalFontSize: 14, hooks: true, setupComplete: true });

  // Updates split: config keys go to the writer, profile keys to the profile.
  await store.update({ terminalFontSize: 22, setupComplete: false });
  expect(writes).toEqual([{ terminalFontSize: 22 }]);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    version: 2,
    settings: { setupComplete: false },
  });
  await store.update({ panelColor: "plain" });
  expect(writes).toHaveLength(2);
  await store.setConfigDigest("b".repeat(64));
  await store.setConfigDigest("b".repeat(64));
  expect((await SettingsStore.open(dir)).configDigest()).toBe("b".repeat(64));
  store.setConfig({});
  expect(store.get().terminalFontSize).toBe(14);
});

test("a version 2 profile ignores stray config keys and invalid digests", async () => {
  const dir = await directory();
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({
      version: 2,
      settings: { setupComplete: true, hooks: false, sound: { bad: true } },
      configDigest: "not-a-digest",
    }),
  );
  const store = await SettingsStore.open(dir);
  expect(store.get()).toMatchObject({ setupComplete: true, hooks: true });
  expect(store.get().sound).toEqual(DEFAULT_SETTINGS.sound);
  expect(store.configDigest()).toBeNull();
  expect(store.legacyConfig()).toBeUndefined();
});

test("a failed attach keeps the version 1 profile for the next launch", async () => {
  const root = await directory();
  const dir = path.join(root, "blocked");
  const store = await SettingsStore.open(dir);
  await writeFile(dir, "a file where the folder should be");
  await expect(store.attachConfig(async () => {}, { hooks: false }, null)).rejects.toThrow();
  expect(store.legacyConfig()).toEqual({});
  expect(store.get().hooks).toBe(true);
});
