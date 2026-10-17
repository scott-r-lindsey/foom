import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configPart } from "../../../../src/main/config/approval";
import { OWNED_FILES, digest } from "../../../../src/main/config/layout";
import { ConfigService } from "../../../../src/main/config/service";
import type { ConfigServiceDependencies } from "../../../../src/main/config/service";
import { ThemeLibrary } from "../../../../src/main/themes/library";
import { parseThemeFile } from "../../../../src/shared/theme-files";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import { interfaceThemes } from "../../../../src/shared/interface-themes";
import type { ConfigSettings } from "../../../../src/shared/config";

const roots: string[] = [];
const services: ConfigService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const palette = interfaceThemes["eclipse-dark"];
const theme = (name: string, colors = palette.colors) =>
  JSON.stringify({ kind: "theme", name, base: palette.base, colors });

async function fixture({
  baseline: initial,
  appliedText: initialText,
  themeDigests = [],
  realWatch = false,
  ...options
}: Partial<Omit<ConfigServiceDependencies, "baseline" | "appliedText">> & {
  baseline?: string;
  appliedText?: string;
  themeDigests?: [string, string][];
  realWatch?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-service-"));
  roots.push(root);
  const folder = path.join(root, "config");
  let baseline: string | null = initial ?? null;
  let copy: string | null = initialText ?? null;
  const themeBaselines = new Map<string, string>(themeDigests);
  const applied: ConfigSettings[] = [];
  const listeners: ((file: string | null) => void)[] = [];
  const statuses: unknown[] = [];
  const service = new ConfigService({
    root: folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: (values) => {
      applied.push(values);
    },
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
    themeBaseline: {
      get: (file) => themeBaselines.get(file) ?? null,
      set: (file, value) => {
        if (value === null) themeBaselines.delete(file);
        else themeBaselines.set(file, value);
        return Promise.resolve();
      },
    },
    onStatus: (status) => {
      statuses.push(status);
    },
    ...(realWatch
      ? {}
      : {
          watch: (_directory: string, listener: (file: string | null) => void) => {
            listeners.push(listener);
            return { close: vi.fn() };
          },
        }),
    delay: 1,
    ...options,
  });
  services.push(service);
  const write = (file: string, content: string) => writeFile(path.join(folder, file), content);
  const read = (file: string) => readFile(path.join(folder, file), "utf8");
  return {
    root,
    folder,
    service,
    applied,
    listeners,
    statuses,
    write,
    read,
    baseline: () => baseline,
    copy: () => copy,
    themeBaselines,
    /** Decides the proposal currently shown, as the Settings banner does. */
    decide: (decision: string) => service.decide(decision, service.status().pending?.id),
    settings: (values: object) =>
      write("settings.json", JSON.stringify({ kind: "settings", ...values })),
  };
}

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
  await f.write("README.md", "my notes");
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
  expect(await f.read("README.md")).toBe("my notes");
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

test("themes are checked on add, update and removal; invalid themes are rejected", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/deep.json", theme("Deep"));
  let status = await f.service.refresh();
  expect(status.rejected).toEqual([]);
  await f.write("themes/deep.json", theme("Deep", { ...palette.colors, accent: "red" }));
  status = await f.service.refresh();
  expect(status.rejected).toEqual([
    { file: "themes/deep.json", reason: "$.colors.accent: not-a-color" },
  ]);
  await f.write(
    "terminal-themes/t.json",
    JSON.stringify({
      kind: "terminal-theme",
      name: "Term",
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffffff",
      ansi: Array.from({ length: 16 }, () => "#808080"),
    }),
  );
  expect((await f.service.refresh()).rejected).toHaveLength(1);
  await rm(path.join(f.folder, "themes/deep.json"));
  status = await f.service.refresh();
  expect(status.rejected).toEqual([]);
  await mkdir(path.join(f.folder, "themes/dir.json"));
  expect((await f.service.refresh()).rejected).toEqual([
    { file: "themes/dir.json", reason: "$: unsafe-file" },
  ]);
});

test.skipIf(process.platform === "win32")("linked theme files are refused", async () => {
  const f = await fixture();
  await f.service.initialize();
  await writeFile(path.join(f.root, "outside.json"), theme("Outside"));
  await symlink(path.join(f.root, "outside.json"), path.join(f.folder, "themes/link.json"));
  expect((await f.service.refresh()).rejected).toEqual([
    { file: "themes/link.json", reason: "$: unsafe-file" },
  ]);
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

test("active theme edits are held before display, Keep restores and Allow accepts the exact proposal", async () => {
  const f = await fixture();
  await f.service.initialize();
  const original = theme("Personal");
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  const proposed = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  expect(f.service.status().pending).toMatchObject({
    file: "themes/personal.json",
    detail: "attention-distinctness",
  });
  const { parseThemeFile } = await import("../../../../src/shared/theme-files");
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(original, "theme"));
  await expect(f.service.decide("allow", "old")).rejects.toThrow("replaced");
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  await f.decide("allow");
  expect(f.service.status().pending).toBeNull();
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(proposed, "theme"));
});

test("a delayed library review cannot clear a newer held theme edit", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const original = theme("Personal");
  await f.write(file, original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  const proposed = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write(file, proposed);
  await f.service.refresh();
  const pending = f.service.status().pending;
  expect(pending?.file).toBe(file);
  // The library read the safe version before the edit, but its review was queued
  // behind the config scan that held the newer proposal.
  expect(await f.service.reviewTheme(file, original, parseThemeFile(original, "theme"))).toEqual(
    parseThemeFile(original, "theme"),
  );
  expect(f.service.status().pending).toEqual(pending);
  await f.decide("keep");
  expect(await f.read(file)).toBe(original);
});

test("a delayed library review cannot resurrect a removed theme or its approval baseline", async () => {
  const f = await fixture();
  await f.service.initialize();
  const file = "themes/personal.json";
  const original = theme("Personal");
  await f.write(file, original);
  await f.service.refresh();
  await rm(path.join(f.folder, file));
  await f.service.refresh();
  expect(
    await f.service.reviewTheme(file, original, parseThemeFile(original, "theme")),
  ).toBeUndefined();
  expect(f.themeBaselines.has(file)).toBe(false);
  expect(f.service.status().pending).toBeNull();
});

test("inactive themes and hue-only warnings apply; file selection is held and UI selection is direct", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write(
    "themes/personal.json",
    theme("Personal", { ...palette.colors, attention: palette.colors.ink }),
  );
  await f.service.refresh();
  expect(f.service.status().pending).toBeNull();
  await f.settings({ interfaceTheme: "user:personal.json" });
  await f.service.refresh();
  expect(f.service.status().pending?.detail).toBe("interfaceTheme: attention-distinctness");
  await f.decide("keep");
  await f.service.write({ interfaceTheme: "user:personal.json" });
  expect(f.service.status().pending).toBeNull();
  await f.write(
    "themes/personal.json",
    theme("Personal", { ...palette.colors, attention: "#3ee0ff" }),
  );
  await f.service.refresh();
  expect(f.service.status().pending).toBeNull();
});

test("a replaced theme proposal cannot be approved, and invalid replacements clear the obsolete hold", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/personal.json", theme("Personal"));
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  await f.write(
    "themes/personal.json",
    theme("Personal", { ...palette.colors, attention: palette.colors.ink }),
  );
  await f.service.refresh();
  const id = f.service.status().pending?.id;
  await f.write("themes/personal.json", "{");
  await expect(f.service.decide("allow", id)).rejects.toThrow("file changed");
  expect(f.service.status().pending).toBeNull();
  expect(f.service.status().rejected).toEqual([
    { file: "themes/personal.json", reason: "$: malformed-json" },
  ]);
});

test("file selection checks the warned palette retained after an invalid edit", async () => {
  const f = await fixture();
  await f.service.initialize();
  const library = new ThemeLibrary(f.folder, undefined, (file, text, parsed) =>
    f.service.reviewTheme(file, text, parsed),
  );
  try {
    await library.initialize();
    await f.write(
      "themes/personal.json",
      theme("Personal", {
        ...palette.colors,
        attention: palette.colors.ink,
      }),
    );
    await library.reload();
    await f.service.refresh();
    const retained = library.snapshot().interface;
    expect(retained).toHaveLength(1);
    await f.write("themes/personal.json", "{");
    await library.reload();
    await f.service.refresh();
    expect(library.snapshot().interface).toEqual(retained);
    await f.settings({ interfaceTheme: "user:personal.json" });
    expect((await f.service.refresh()).pending?.detail).toBe(
      "interfaceTheme: attention-distinctness",
    );
    expect(f.applied.at(-1)?.interfaceTheme).not.toBe("user:personal.json");
    await f.decide("keep");
    expect(f.service.status().pending).toBeNull();
    await f.settings({ interfaceTheme: "user:personal.json" });
    await f.service.refresh();
    await f.decide("allow");
    expect(f.applied.at(-1)?.interfaceTheme).toBe("user:personal.json");
  } finally {
    library.dispose();
  }
});

test("an accepted area warning does not approve a newly weakened area", async () => {
  const f = await fixture();
  await f.service.initialize();
  const menu = { attention: palette.colors.ink };
  const original = JSON.stringify({
    version: 2,
    name: "Personal",
    base: palette.base,
    colors: palette.colors,
    areas: { menus: menu },
  });
  const proposed = JSON.stringify({
    version: 2,
    name: "Personal",
    base: palette.base,
    colors: palette.colors,
    areas: { menus: menu, sidebar: menu },
  });
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  await f.service.refresh();
  await f.write("themes/personal.json", proposed);
  expect((await f.service.refresh()).pending?.file).toBe("themes/personal.json");
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(original, "theme"));
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  await f.decide("allow");
  expect((await f.service.refresh()).pending).toBeNull();
  expect(
    await f.service.reviewTheme(
      "themes/personal.json",
      proposed,
      parseThemeFile(proposed, "theme"),
    ),
  ).toEqual(parseThemeFile(proposed, "theme"));
});

/** Restarts the service on the same folder and profile, as relaunching Foom does. */
async function restart(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.dispose();
  const again = new ConfigService({
    root: f.folder,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => {},
    baseline: { get: () => f.baseline(), set: () => Promise.resolve() },
    appliedText: { get: () => f.copy(), set: () => Promise.resolve() },
    themeBaseline: {
      get: (file) => f.themeBaselines.get(file) ?? null,
      set: (file, value) => {
        if (value === null) f.themeBaselines.delete(file);
        else f.themeBaselines.set(file, value);
        return Promise.resolve();
      },
    },
    watch: () => ({ close: () => {} }),
  });
  services.push(again);
  await again.initialize();
  return again;
}

test("a theme an agent weakened while Foom was closed is held after a restart", async () => {
  const f = await fixture();
  await f.service.initialize();
  const original = theme("Personal");
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  expect(f.themeBaselines.get("themes/personal.json")).toBe(digest(original));
  // While Foom is closed, an agent weakens the active theme.
  await f.service.dispose();
  const weak = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", weak);
  const again = await restart(f);
  expect(again.status().pending).toMatchObject({ file: "themes/personal.json" });
  // The file's palette is the weak one, so nothing from it is shown.
  expect(
    await again.reviewTheme("themes/personal.json", weak, parseThemeFile(weak, "theme")),
  ).toBeUndefined();
  // With no safe version to restore, Keep it on leaves the theme and keeps the file.
  await again.decide("keep", again.status().pending?.id);
  expect(again.status().pending).toBeNull();
  expect(JSON.parse(await f.read("settings.json"))).toMatchObject({
    interfaceTheme: DEFAULT_SETTINGS.interfaceTheme,
  });
  expect(await f.read("themes/personal.json")).toBe(weak);
});

test("a theme this profile approved stays approved after a restart", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/personal.json", theme("Personal"));
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  const weak = theme("Personal", { ...palette.colors, attention: palette.colors.ink });
  await f.write("themes/personal.json", weak);
  await f.service.refresh();
  await f.decide("allow");
  expect(f.themeBaselines.get("themes/personal.json")).toBe(digest(weak));
  const again = await restart(f);
  expect(again.status().pending).toBeNull();
  expect(
    await again.reviewTheme("themes/personal.json", weak, parseThemeFile(weak, "theme")),
  ).toEqual(parseThemeFile(weak, "theme"));
  // Removing the file forgets its baseline.
  await rm(path.join(f.folder, "themes/personal.json"));
  await again.refresh();
  expect(f.themeBaselines.has("themes/personal.json")).toBe(false);
});

test("an approved attention conflict does not approve a new one on the same color", async () => {
  const f = await fixture();
  await f.service.initialize();
  // Approved: needs-you matches done. Proposed: it now also matches muted text.
  const original = theme("Personal", { ...palette.colors, attention: palette.colors.done });
  const proposed = theme("Personal", {
    ...palette.colors,
    attention: palette.colors.done,
    muted: palette.colors.done,
  });
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  await f.write("themes/personal.json", proposed);
  expect((await f.service.refresh()).pending?.file).toBe("themes/personal.json");
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
});

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

for (const code of ["EPERM", "EBUSY"]) {
  test(`Windows config restore retries transient ${code} without applying early`, async () => {
    const replace = vi.fn(rename);
    const f = await fixture({ platform: "win32", rename: replace });
    await f.service.initialize();
    const original = theme("Personal");
    const proposed = theme("Personal", { ...palette.colors, ink: "#ffb23e" });
    await f.write("themes/personal.json", original);
    await f.service.refresh();
    await f.service.write({ interfaceTheme: "user:personal.json" });
    await f.write("themes/personal.json", proposed);
    await f.service.refresh();
    const pending = f.service.status().pending;
    const baseline = f.themeBaselines.get("themes/personal.json");
    replace.mockClear();
    replace.mockImplementationOnce(async () => {
      expect(await f.read("themes/personal.json")).toBe(proposed);
      expect(f.service.status().pending).toEqual(pending);
      expect(f.themeBaselines.get("themes/personal.json")).toBe(baseline);
      throw Object.assign(new Error("sharing violation"), { code });
    });
    await f.decide("keep");
    expect(replace).toHaveBeenCalledTimes(2);
    expect(await f.read("themes/personal.json")).toBe(original);
    expect(f.service.status().pending).toBeNull();
    expect(
      (await readdir(path.join(f.folder, "themes"))).filter((name) => name.startsWith(".foom-")),
    ).toEqual([]);
  });
}

for (const [platform, code, attempts] of [
  ["win32", "EPERM", 5],
  ["win32", "EBUSY", 5],
  ["win32", "EACCES", 1],
  ["linux", "EPERM", 1],
  ["darwin", "EBUSY", 1],
] as const) {
  test(`${platform} failed config restore (${code}) preserves file and approval`, async () => {
    const replace = vi.fn(rename);
    const f = await fixture({ platform, rename: replace });
    await f.service.initialize();
    const original = await f.read("settings.json");
    await f.settings({ hooks: false });
    await f.service.refresh();
    const proposed = await f.read("settings.json");
    const status = f.service.status();
    const baseline = f.baseline();
    const applied = [...f.applied];
    replace.mockClear();
    replace.mockRejectedValue(Object.assign(new Error("sharing violation"), { code }));
    await expect(f.decide("keep")).rejects.toThrow(
      "Unable to replace settings.json. The change was not applied.",
    );
    expect(replace).toHaveBeenCalledTimes(attempts);
    expect(await f.read("settings.json")).toBe(proposed);
    expect(f.service.status()).toEqual(status);
    expect(f.baseline()).toBe(baseline);
    expect(f.applied).toEqual(applied);
    expect((await readdir(f.folder)).filter((name) => name.startsWith(".foom-"))).toEqual([]);
    replace.mockImplementation(rename);
    await f.decide("keep");
    expect(await f.read("settings.json")).toBe(original);
  });
}

test("persistent Windows theme lock preserves the held palette and can be decided later", async () => {
  const replace = vi.fn(rename);
  const f = await fixture({ platform: "win32", rename: replace });
  await f.service.initialize();
  const original = theme("Personal");
  const proposed = theme("Personal", { ...palette.colors, ink: "#ffb23e" });
  await f.write("themes/personal.json", original);
  await f.service.refresh();
  await f.service.write({ interfaceTheme: "user:personal.json" });
  await f.write("themes/personal.json", proposed);
  await f.service.refresh();
  const status = f.service.status();
  const baseline = f.themeBaselines.get("themes/personal.json");
  replace.mockClear();
  replace.mockRejectedValue(Object.assign(new Error("locked"), { code: "EPERM" }));
  await expect(f.decide("keep")).rejects.toThrow(
    "Unable to replace themes/personal.json. The change was not applied.",
  );
  expect(replace).toHaveBeenCalledTimes(5);
  expect(await f.read("themes/personal.json")).toBe(proposed);
  expect(f.service.status()).toEqual(status);
  expect(f.themeBaselines.get("themes/personal.json")).toBe(baseline);
  expect(
    (await readdir(path.join(f.folder, "themes"))).filter((name) => name.startsWith(".foom-")),
  ).toEqual([]);
  replace.mockImplementation(rename);
  await f.decide("keep");
  expect(await f.read("themes/personal.json")).toBe(original);
});

test("failed Settings save leaves the held proposal and its event unchanged", async () => {
  const replace = vi.fn(rename);
  const f = await fixture({ platform: "win32", rename: replace });
  await f.service.initialize();
  await f.settings({ hooks: false });
  await f.service.refresh();
  const status = f.service.status();
  const proposed = await f.read("settings.json");
  const applied = [...f.applied];
  replace.mockRejectedValue(new Error("disk unavailable"));
  await expect(f.service.write({ terminalFontSize: 20 })).rejects.toThrow(
    "The change was not applied.",
  );
  expect(await f.read("settings.json")).toBe(proposed);
  expect(f.service.status()).toEqual(status);
  expect(f.applied).toEqual(applied);
});
