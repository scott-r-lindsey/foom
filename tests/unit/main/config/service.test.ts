import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { configPart } from "../../../../src/main/config/approval";
import { OWNED_FILES, digest } from "../../../../src/main/config/layout";
import { ConfigService } from "../../../../src/main/config/service";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { services, roots, fixture, palette, theme } from "./service-fixture";

test("first launch writes the layout as plain files and migrates profile values once", async () => {
  const f = await fixture();
  const values = await f.service.initialize({
    terminalFontSize: 18,
    // A portable palette cannot be expressed in the file and falls back to the default.
    interfaceTheme: palette,
  });
  expect(values).toEqual({ terminalFontSize: 18 });
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    terminalFontSize: 18,
  });
  for (const file of Object.keys(OWNED_FILES)) expect(await f.read(file)).toBe(OWNED_FILES[file]);
  expect(await f.read(".gitignore")).toContain("/sounds/*/*");
  expect(f.baseline()).toBe(digest(await f.read("settings.json")));
  expect(f.copy()).toBe(await f.read("settings.json"));
  expect(f.service.status()).toMatchObject({ available: true, pending: null, rejected: [] });
  await expect(readdir(path.join(f.folder, ".git"))).rejects.toThrow();
  expect(f.service.ready).toBe(true);
  // No keys or profile-only settings ever land in the folder.
  const settings = JSON.parse(await f.read("settings.json")) as Record<string, unknown>;
  for (const key of ["agentArguments", "codeFolder", "setupComplete", "inference"])
    expect(settings).not.toHaveProperty(key);
});

test("an existing settings file wins over profile values and an existing .git is left alone", async () => {
  const f = await fixture();
  await mkdir(path.join(f.folder, ".git"), { recursive: true });
  await f.write(".git/HEAD", "ref: refs/heads/main\n");
  await f.settings({ terminalFontSize: 20 });
  await f.service.initialize({ terminalFontSize: 12 });
  expect(JSON.parse(await f.read("settings.json"))).toMatchObject({ terminalFontSize: 20 });
  await f.settings({ terminalFontSize: 21 });
  await f.service.refresh();
  expect(await readdir(path.join(f.folder, ".git"))).toEqual(["HEAD"]);
  expect(await f.read(".git/HEAD")).toBe("ref: refs/heads/main\n");
});

test("unedited docs refresh and edited docs are left alone", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.service.dispose();
  const oldGuide = await readFile("tests/fixtures/config/guide-2026-10-14.md", "utf8");
  await f.write("README.md", oldGuide);
  await f.write("AGENTS.md", oldGuide);
  await f.write("CLAUDE.md", `${oldGuide}\nmy notes`);
  const again = new ConfigService({
    root: f.folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => {},
    baseline: { get: () => f.baseline(), set: () => Promise.resolve() },
    themeBaseline: { get: () => null, set: () => Promise.resolve() },
    watch: () => ({ close: () => {} }),
  });
  services.push(again);
  await again.initialize();
  expect(await f.read("README.md")).toBe(OWNED_FILES["README.md"]);
  expect(await f.read("AGENTS.md")).toBe(OWNED_FILES["AGENTS.md"]);
  expect(await f.read("CLAUDE.md")).toBe(`${oldGuide}\nmy notes`);
});

test("ordinary changes apply live; invalid files are rejected whole", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ terminalFontSize: 15, sound: { ...DEFAULT_SETTINGS.sound, working: true } });
  f.listeners[0]?.("settings.json");
  await vi.waitFor(() => {
    expect(f.applied.at(-1)).toMatchObject({ terminalFontSize: 15 });
  });
  expect(f.copy()).toBe(await f.read("settings.json"));
  await f.write("settings.json", '{"kind":"settings","agentArguments":{}}');
  const rejected = await f.service.refresh();
  expect(rejected.rejected).toEqual([
    {
      file: "settings.json",
      reason:
        "$.agentArguments: invalid-value: Default arguments must name Claude Code, Codex and Antigravity.",
    },
  ]);
  expect(f.applied.at(-1)).toMatchObject({ terminalFontSize: 15 });
  // The same bad content is reported once.
  expect((await f.service.refresh()).rejected).toHaveLength(1);
  await f.write("settings.json", "{");
  expect((await f.service.refresh()).rejected[0]?.reason).toBe("$: malformed-json");
  await rm(path.join(f.folder, "settings.json"));
  expect((await f.service.refresh()).rejected[0]?.reason).toBe("$: missing");
  await mkdir(path.join(f.folder, "settings.json"));
  expect((await f.service.refresh()).rejected[0]?.reason).toBe("$: unsafe-file");
  await rm(path.join(f.folder, "settings.json"), { recursive: true });
  await f.write("settings.json", "x".repeat(70_000));
  expect((await f.service.refresh()).rejected[0]?.reason).toBe("$: too-large");
  await f.settings({ terminalFontSize: 15, sound: { ...DEFAULT_SETTINGS.sound, working: true } });
  expect((await f.service.refresh()).rejected).toEqual([]);
});

test("weakening changes are held; Allow applies and Keep it on restores", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ sound: { ...DEFAULT_SETTINGS.sound, alerts: false } });
  const held = await f.service.refresh();
  expect(held.pending).toEqual({
    id: digest(await f.read("settings.json")),
    action: "turn off the needs-you sound",
    file: "settings.json",
    detail: "sound.alerts: on → off",
  });
  expect(f.applied.at(-1)).toEqual({});
  // Re-scanning the same held file keeps the same proposal.
  expect((await f.service.refresh()).pending?.id).toBe(held.pending?.id);
  const kept = await f.decide("keep");
  expect(kept.pending).toBeNull();
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
  await expect(f.decide("keep")).rejects.toThrow("No change");
  await expect(f.decide("maybe")).rejects.toThrow("Invalid decision");

  await f.settings({ hooks: false, agents: { claude: false, codex: true, agy: true } });
  const both = await f.service.refresh();
  expect(both.pending?.action).toBe("turn hooks off and turn off Claude Code");
  await f.settings({ hooks: false });
  await f.service.refresh();
  expect(f.service.status().pending?.detail).toBe("hooks: on → off");
  const allowed = await f.decide("allow");
  expect(allowed.pending).toBeNull();
  expect(f.applied.at(-1)).toEqual({ hooks: false });
  expect(f.copy()).toBe(await f.read("settings.json"));
  // Turning hooks back on tightens and applies without approval.
  await f.settings({});
  expect((await f.service.refresh()).pending).toBeNull();
  expect(f.applied.at(-1)).toEqual({});
});

test("a held change that changes again must be reviewed again", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ sound: { ...DEFAULT_SETTINGS.sound, alertVolume: 0 } });
  expect((await f.service.refresh()).pending?.detail).toBe("sound.alertVolume: 0.5 → 0");
  await f.settings({ sound: { ...DEFAULT_SETTINGS.sound, alertVolume: 0, working: true } });
  await expect(f.decide("allow")).rejects.toThrow("The file changed");
  expect(f.service.status().pending).not.toBeNull();
  // Restoring the applied file clears the held change.
  await f.settings({});
  await f.write("settings.json", `${JSON.stringify({ kind: "settings" }, null, 2)}\n`);
  expect((await f.service.refresh()).pending).toBeNull();
});

test("a decision applies only to the proposal that was shown", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ sound: { ...DEFAULT_SETTINGS.sound, alerts: false } });
  const shown = (await f.service.refresh()).pending;
  expect(shown?.id).toMatch(/^[0-9a-f]{64}$/);
  // An agent swaps in a different weakening and the watcher scans before the click lands.
  await f.settings({ hooks: false });
  expect((await f.service.refresh()).pending?.detail).toBe("hooks: on → off");
  await expect(f.service.decide("allow", shown?.id)).rejects.toThrow("replaced");
  await expect(f.service.decide("keep", undefined)).rejects.toThrow("replaced");
  expect(f.applied.at(-1)).toEqual({});
  // The replacement is still waiting, not applied.
  expect(f.service.status().pending?.detail).toBe("hooks: on → off");
  // The new proposal can still be decided once it is the one on screen.
  expect((await f.decide("allow")).pending).toBeNull();
  expect(f.applied.at(-1)).toEqual({ hooks: false });
});

test("an off switch written while Foom was closed is held against the defaults", async () => {
  const f = await fixture({ baseline: "0".repeat(64) });
  await mkdir(f.folder, { recursive: true });
  await f.settings({ hooks: false, terminalFontSize: 16 });
  await f.service.initialize();
  expect(f.service.status().pending?.detail).toBe("hooks: on → off");
  expect(f.applied.at(-1)).toEqual({});
});

test("a matching baseline digest applies the file at startup", async () => {
  const text = JSON.stringify({ kind: "settings", hooks: false });
  const f = await fixture({ baseline: digest(text) });
  await mkdir(f.folder, { recursive: true });
  await f.write("settings.json", text);
  await f.service.initialize();
  expect(f.service.status().pending).toBeNull();
  expect(f.applied.at(-1)).toEqual({ hooks: false });
});

test("the profile's copy is trusted when it matches the baseline digest", async () => {
  const committed = JSON.stringify({ kind: "settings", hooks: false });
  const f = await fixture({ baseline: digest(committed), appliedText: committed });
  await mkdir(f.folder, { recursive: true });
  await f.settings({ hooks: false, agents: { claude: true, codex: false, agy: true } });
  await f.service.initialize();
  expect(f.applied[0]).toEqual({ hooks: false });
  expect(f.service.status().pending?.detail).toBe("agents.codex: on → off");
  // Keep it on restores the profile's copy, not the defaults.
  await f.decide("keep");
  expect(await f.read("settings.json")).toBe(committed);
});

test("a copy that does not match the baseline digest is not trusted", async () => {
  const f = await fixture({
    baseline: "0".repeat(64),
    appliedText: JSON.stringify({ kind: "settings", hooks: false }),
  });
  await mkdir(f.folder, { recursive: true });
  await f.settings({ hooks: false });
  await f.service.initialize();
  expect(f.service.status().pending?.detail).toBe("hooks: on → off");
});

test("Settings writes go through the file and replace a held change", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ hooks: false });
  await f.service.refresh();
  await f.service.write({ terminalFontSize: 21 });
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    terminalFontSize: 21,
  });
  expect(f.copy()).toBe(await f.read("settings.json"));
  const status = await f.service.refresh();
  expect(status.pending).toBeNull();
  expect(f.applied.at(-1)).toEqual({ terminalFontSize: 21 });
  await expect(f.service.write({ interfaceTheme: palette })).rejects.toThrow("cannot be stored");
  expect(f.statuses.length).toBeGreaterThan(0);
});

test("a config path that is a file fails initialization and reports it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-file-"));
  roots.push(root);
  const folder = path.join(root, "config");
  await writeFile(folder, "not a folder");
  const statuses: unknown[] = [];
  const service = new ConfigService({
    root: folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => {},
    baseline: { get: () => null, set: () => Promise.resolve() },
    themeBaseline: { get: () => null, set: () => Promise.resolve() },
    onStatus: (status) => statuses.push(status),
  });
  services.push(service);
  await expect(service.initialize()).rejects.toThrow("not a folder");
  expect(service.ready).toBe(false);
  expect(service.status()).toMatchObject({ available: false });
  expect(statuses).toHaveLength(1);
  expect(service.folder).toBe(folder);
});

test("the real watcher schedules a scan and closes on dispose", async () => {
  const f = await fixture({ realWatch: true, delay: 10 });
  await f.service.initialize();
  await f.settings({ terminalFontSize: 17 });
  await vi.waitFor(
    () => {
      expect(f.applied.at(-1)).toEqual({ terminalFontSize: 17 });
    },
    { timeout: 5000 },
  );
  await f.service.dispose();
  await f.settings({ terminalFontSize: 19 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.applied.at(-1)).toEqual({ terminalFontSize: 17 });
});

test("files already invalid at first launch are reported", async () => {
  const f = await fixture();
  await mkdir(path.join(f.folder, "themes"), { recursive: true });
  await writeFile(path.join(f.folder, "settings.json"), Buffer.from([0x7b, 0xff, 0x7d]));
  await f.write("themes/good.json", theme("Good"));
  await f.write("themes/bad.json", theme("Bad", { ...palette.colors, bg: "nope" }));
  await f.service.initialize();
  expect(f.service.status().rejected).toEqual([
    { file: "settings.json", reason: "$: malformed-json" },
    { file: "themes/bad.json", reason: "$.colors.bg: not-a-color" },
  ]);
});

test("theme folder events schedule a scan", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/live.json", theme("Live", { ...palette.colors, bg: "nope" }));
  f.listeners[1]?.("live.json");
  await vi.waitFor(() => {
    expect(f.service.status().rejected[0]?.file).toBe("themes/live.json");
  });
  // Root events for other files are ignored.
  f.listeners[0]?.("README.md");
});

test("Keep it on restores the applied file over an agent's weakening", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("settings.json", JSON.stringify({ kind: "settings", hooks: false }));
  expect((await f.service.refresh()).pending?.detail).toBe("hooks: on → off");
  await f.decide("keep");
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
  expect((await f.service.refresh()).pending).toBeNull();
});

test.skipIf(process.platform === "win32")(
  "a redirected theme folder is refused for reads",
  async () => {
    const f = await fixture();
    await f.service.initialize();
    await f.write("themes/deep.json", theme("Deep"));
    await f.service.refresh();
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "deep.json"), theme("Deep"));
    await writeFile(path.join(outside, "other.json"), theme("Other"));
    await rm(path.join(f.folder, "themes"), { recursive: true });
    await symlink(outside, path.join(f.folder, "themes"));
    const status = await f.service.refresh();
    expect(status.rejected).toEqual([{ file: "themes/deep.json", reason: "$: unsafe-file" }]);
    expect(await readFile(path.join(outside, "deep.json"), "utf8")).toBe(theme("Deep"));
  },
);

test("Keep it on without a baseline restores a valid default file", async () => {
  const f = await fixture();
  await mkdir(f.folder, { recursive: true });
  await f.settings({ hooks: false });
  await f.service.initialize();
  await f.decide("keep");
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
});

test("concurrent Settings writes apply in order", async () => {
  const f = await fixture();
  await f.service.initialize();
  await Promise.all([
    f.service.write({ terminalFontSize: 15 }),
    f.service.write({ terminalFontSize: 16 }),
  ]);
  await f.service.refresh();
  expect(f.applied.slice(-2)).toEqual([{ terminalFontSize: 15 }, { terminalFontSize: 16 }]);
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    terminalFontSize: 16,
  });
});

test("a replaced theme folder gets a new watcher", async () => {
  const f = await fixture();
  await f.service.initialize();
  const before = f.listeners.length;
  f.listeners[0]?.("themes");
  expect(f.listeners.length).toBe(before + 1);
  await f.write("themes/again.json", theme("Again", { ...palette.colors, bg: "nope" }));
  f.listeners.at(-1)?.("again.json");
  await vi.waitFor(() => {
    expect(f.service.status().rejected[0]?.file).toBe("themes/again.json");
  });
});

test("child placement file changes apply live without approval and Settings writes the same key", async () => {
  const f = await fixture();
  await f.service.initialize({});
  for (const showNewChildren of [false, true]) {
    await f.write("settings.json", JSON.stringify({ kind: "settings", showNewChildren }));
    await f.service.refresh();
    expect(f.service.status().pending).toBeNull();
    expect(f.applied.at(-1)?.showNewChildren).toBe(showNewChildren);
  }
  await f.service.write({ showNewChildren: false });
  expect(JSON.parse(await f.read("settings.json"))).toMatchObject({ showNewChildren: false });
});
