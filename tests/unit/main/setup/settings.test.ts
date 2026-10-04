import { interfaceThemes } from "../../../../src/shared/interface-themes";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      inference: { kind: "anthropic", model: "claude-haiku-4-5" },
      inferenceTimeoutMs: 15_000,
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
    inferenceTimeoutMs: 15_000,
    setupComplete: true,
    hooks: false,
    worktreeLocation: "adjacent",
    agents: { claude: true, codex: false, agy: true },
    inference: { kind: "anthropic", model: "claude-haiku-4-5" },
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
  expect(() => parseSettingsPatch({ inference: { kind: "claude" } })).toThrow(
    "CLI inference unavailable",
  );
});

test("a missing, corrupt or unsupported file starts from defaults", async () => {
  const dir = await directory();
  expect((await SettingsStore.open(dir)).get()).toBe(DEFAULT_SETTINGS);
  const file = path.join(dir, "settings.json");
  for (const contents of [
    "not json",
    JSON.stringify({ version: 2, settings: { setupComplete: true } }),
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
  await writeFile(dir, "a file where the folder should be");
  const store = await SettingsStore.open(dir);
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
