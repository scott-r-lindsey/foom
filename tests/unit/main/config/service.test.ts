import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { configPart } from "../../../../src/main/config/approval";
import { ConfigGit, prepareIsolation } from "../../../../src/main/config/git";
import { OWNED_FILES, digest } from "../../../../src/main/config/layout";
import { ConfigService, revertable } from "../../../../src/main/config/service";
import type { ConfigServiceDependencies } from "../../../../src/main/config/service";
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
  realWatch = false,
  ...options
}: Partial<Omit<ConfigServiceDependencies, "baseline">> & {
  baseline?: string;
  realWatch?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-service-"));
  roots.push(root);
  const folder = path.join(root, "config");
  const git = new ConfigGit(folder, await prepareIsolation(path.join(root, "isolation")));
  let baseline: string | null = initial ?? null;
  const applied: ConfigSettings[] = [];
  const listeners: ((file: string | null) => void)[] = [];
  const statuses: unknown[] = [];
  const service = new ConfigService({
    root: folder,
    git,
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
    git,
    service,
    applied,
    listeners,
    statuses,
    write,
    read,
    baseline: () => baseline,
    settings: (values: object) =>
      write("settings.json", JSON.stringify({ kind: "settings", ...values })),
  };
}

test("first launch writes the layout, migrates profile values once and commits", async () => {
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
  const status = f.service.status();
  expect(status).toMatchObject({ available: true, uncommitted: 0, pending: null, rejected: 0 });
  expect(status.changes[0]).toMatchObject({ summary: "Initialize Foom config", state: "applied" });
  expect(f.service.ready).toBe(true);
  // No keys or profile-only settings ever land in the folder.
  const settings = JSON.parse(await f.read("settings.json")) as Record<string, unknown>;
  for (const key of ["agentArguments", "codeFolder", "setupComplete", "inference"])
    expect(settings).not.toHaveProperty(key);
});

test("an existing settings file wins over profile values and existing repositories are kept", async () => {
  const f = await fixture();
  await mkdir(f.folder, { recursive: true });
  await f.settings({ terminalFontSize: 20 });
  await f.git.init();
  await f.git.commit(new Map([["notes.txt", Buffer.from("mine")]]), "User commit");
  await f.service.initialize({ terminalFontSize: 12 });
  expect(JSON.parse(await f.read("settings.json"))).toMatchObject({ terminalFontSize: 20 });
  const log = await f.git.log(10);
  expect(log.at(-1)?.subject).toBe("User commit");
  expect(log.map((entry) => entry.subject)).toContain("Update Foom config docs");
  expect(log[0]?.subject).toBe("Terminal font size 20");
});

test("unedited docs refresh and edited docs are left alone", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.service.dispose();
  await f.write("README.md", "my notes");
  const again = new ConfigService({
    root: f.folder,
    git: f.git,
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => {},
    baseline: { get: () => f.baseline(), set: () => Promise.resolve() },
    watch: () => ({ close: () => {} }),
  });
  services.push(again);
  await again.initialize();
  expect(await f.read("README.md")).toBe("my notes");
  expect(again.status().uncommitted).toBe(1);
});

test("ordinary changes apply live and commit; invalid files are rejected whole", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ terminalFontSize: 15, sound: { ...DEFAULT_SETTINGS.sound, working: true } });
  f.listeners[0]?.("settings.json");
  await vi.waitFor(() => {
    expect(f.applied.at(-1)).toMatchObject({ terminalFontSize: 15 });
  });
  await f.service.refresh();
  expect(f.service.status().changes[0]).toMatchObject({
    summary: "Settings: terminal font size, sound",
    file: "settings.json",
    state: "applied",
  });
  await f.write("settings.json", '{"kind":"settings","agentArguments":{}}');
  const rejected = await f.service.refresh();
  expect(rejected.changes[0]).toMatchObject({
    state: "rejected",
    file: "settings.json",
    reason: "$.agentArguments: unknown-key",
  });
  expect(rejected.rejected).toBe(1);
  expect(f.applied.at(-1)).toMatchObject({ terminalFontSize: 15 });
  // The same bad content is reported once.
  expect((await f.service.refresh()).changes.filter((c) => c.state === "rejected")).toHaveLength(1);
  await f.write("settings.json", "{");
  expect((await f.service.refresh()).changes[0]?.reason).toBe("$: malformed-json");
  await rm(path.join(f.folder, "settings.json"));
  expect((await f.service.refresh()).changes[0]?.reason).toBe("$: missing");
  await mkdir(path.join(f.folder, "settings.json"));
  expect((await f.service.refresh()).changes[0]?.reason).toBe("$: unsafe-file");
  await rm(path.join(f.folder, "settings.json"), { recursive: true });
  await f.write("settings.json", "x".repeat(70_000));
  expect((await f.service.refresh()).changes[0]?.reason).toBe("$: too-large");
  await f.settings({ terminalFontSize: 15, sound: { ...DEFAULT_SETTINGS.sound, working: true } });
  expect((await f.service.refresh()).rejected).toBe(0);
});

test("weakening changes are held; Allow applies and Keep it on restores", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ sound: { ...DEFAULT_SETTINGS.sound, alerts: false } });
  const held = await f.service.refresh();
  expect(held.pending).toEqual({
    action: "turn off the needs-you sound",
    file: "settings.json",
    detail: "sound.alerts: on → off",
  });
  expect(held.changes[0]).toMatchObject({ state: "pending" });
  expect(f.applied.at(-1)).toEqual({});
  // Re-scanning the same held file keeps one pending entry.
  expect((await f.service.refresh()).changes.filter((c) => c.state === "pending")).toHaveLength(1);
  const kept = await f.service.decide("keep");
  expect(kept.pending).toBeNull();
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
  expect(kept.changes[0]).toMatchObject({ state: "rejected", reason: "Declined in Settings" });
  await expect(f.service.decide("keep")).rejects.toThrow("No change");
  await expect(f.service.decide("maybe")).rejects.toThrow("Invalid decision");

  await f.settings({ hooks: false, agents: { claude: false, codex: true, agy: true } });
  const both = await f.service.refresh();
  expect(both.pending?.action).toBe("turn hooks off and turn off Claude Code");
  await f.settings({ hooks: false });
  await f.service.refresh();
  expect(f.service.status().pending?.detail).toBe("hooks: on → off");
  const allowed = await f.service.decide("allow");
  expect(allowed.pending).toBeNull();
  expect(f.applied.at(-1)).toEqual({ hooks: false });
  expect(allowed.changes[0]).toMatchObject({ summary: "Hooks off", state: "applied" });
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
  await expect(f.service.decide("allow")).rejects.toThrow("The file changed");
  expect(f.service.status().pending).not.toBeNull();
  // Restoring the applied file clears the held change.
  await f.settings({});
  await f.write("settings.json", `${JSON.stringify({ kind: "settings" }, null, 2)}\n`);
  expect((await f.service.refresh()).pending).toBeNull();
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

test("the last commit is trusted when it matches the baseline digest", async () => {
  const committed = JSON.stringify({ kind: "settings", hooks: false });
  const f = await fixture({ baseline: digest(committed) });
  await mkdir(f.folder, { recursive: true });
  await f.git.init();
  await f.git.commit(new Map([["settings.json", Buffer.from(committed)]]), "Earlier");
  await f.settings({ hooks: false, agents: { claude: true, codex: false, agy: true } });
  await f.service.initialize();
  expect(f.applied[0]).toEqual({ hooks: false });
  expect(f.service.status().pending?.detail).toBe("agents.codex: on → off");
});

test("themes commit on add, update and removal; invalid themes are rejected", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/deep.json", theme("Deep"));
  let status = await f.service.refresh();
  expect(status.changes[0]).toMatchObject({
    summary: "Add Deep theme",
    file: "themes/deep.json",
    state: "applied",
  });
  expect(status.changes[0]?.hash).toHaveLength(7);
  await f.write("themes/deep.json", theme("Deep", interfaceThemes.graphite.colors));
  expect((await f.service.refresh()).changes[0]?.summary).toBe("Update Deep theme");
  await f.write("themes/deep.json", theme("Deep", { ...palette.colors, accent: "red" }));
  status = await f.service.refresh();
  expect(status.changes[0]).toMatchObject({
    state: "rejected",
    reason: "$.colors.accent: not-a-color",
  });
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
  expect((await f.service.refresh()).changes[0]?.summary).toBe("Add Term terminal colors");
  await rm(path.join(f.folder, "themes/deep.json"));
  status = await f.service.refresh();
  expect(status.changes[0]?.summary).toBe("Remove themes/deep.json");
  expect(status.rejected).toBe(0);
  await mkdir(path.join(f.folder, "themes/dir.json"));
  expect((await f.service.refresh()).changes[0]?.reason).toBe("$: unsafe-file");
  expect(status.uncommitted).toBe(0);
});

test.skipIf(process.platform === "win32")("linked theme files are refused", async () => {
  const f = await fixture();
  await f.service.initialize();
  await writeFile(path.join(f.root, "outside.json"), theme("Outside"));
  await symlink(path.join(f.root, "outside.json"), path.join(f.folder, "themes/link.json"));
  expect((await f.service.refresh()).changes[0]).toMatchObject({
    file: "themes/link.json",
    reason: "$: unsafe-file",
  });
});

test("Revert restores the parent version and a weakening revert asks for approval", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/deep.json", theme("Deep"));
  const added = (await f.service.refresh()).changes[0]?.commit;
  if (!added) throw new Error("Expected a theme commit");
  const reverted = await f.service.revert(added);
  await expect(readdir(path.join(f.folder, "themes"))).resolves.toEqual([]);
  expect(reverted.changes[0]).toMatchObject({ summary: 'Revert "Add Deep theme"' });

  // Turning alerts back on was a tightening; reverting it would weaken attention.
  await f.settings({ sound: { ...DEFAULT_SETTINGS.sound, alerts: false } });
  await f.service.refresh();
  await f.service.decide("allow");
  await f.settings({});
  const enabled = (await f.service.refresh()).changes[0];
  expect(enabled).toMatchObject({ summary: "Sound", state: "applied" });
  if (!enabled?.commit) throw new Error("Expected a settings commit");
  const held = await f.service.revert(enabled.commit);
  expect(held.pending?.detail).toBe("sound.alerts: on → off");
  const allowed = await f.service.decide("allow");
  expect(allowed.changes[0]?.summary).toBe('Revert "Sound"');
});

test("Revert refuses unknown commits, changed files and non-config paths", async () => {
  const f = await fixture();
  await f.service.initialize();
  await expect(f.service.revert("f".repeat(40))).rejects.toThrow("Choose a change");
  await expect(f.service.revert(42)).rejects.toThrow("Choose a change");
  const initial = f.service.status().changes[0]?.commit;
  if (!initial) throw new Error("Expected the initial commit");
  await expect(f.service.revert(initial)).rejects.toThrow("Only settings and theme changes");
  await f.write("themes/deep.json", theme("Deep"));
  const added = (await f.service.refresh()).changes[0]?.commit;
  if (!added) throw new Error("Expected a theme commit");
  await f.write("themes/deep.json", theme("Deeper"));
  await expect(f.service.revert(added)).rejects.toThrow("changed after this change");
  await mkdir(path.join(f.root, "x"));
  expect(revertable("settings.json")).toBe(true);
  expect(revertable("themes/a.json")).toBe(true);
  expect(revertable("themes/../a.json")).toBe(false);
  expect(revertable("README.md")).toBe(false);
  expect(revertable("sounds/done/a.ogg")).toBe(false);
});

test("Settings writes go through the file, commit, and replace a held change", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.settings({ hooks: false });
  await f.service.refresh();
  await f.service.write({ terminalFontSize: 21 });
  expect(JSON.parse(await f.read("settings.json"))).toEqual({
    kind: "settings",
    terminalFontSize: 21,
  });
  const status = await f.service.refresh();
  expect(status.pending).toBeNull();
  expect(status.changes[0]).toMatchObject({ summary: "Terminal font size 21", state: "applied" });
  expect(
    status.changes.some((change) => change.reason === "Replaced by a change in Settings"),
  ).toBe(true);
  await expect(f.service.write({ interfaceTheme: palette })).rejects.toThrow("cannot be stored");
  expect(f.statuses.length).toBeGreaterThan(0);
});

test("without git, changes still apply and the status says so", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-nogit-"));
  roots.push(root);
  const folder = path.join(root, "config");
  const applied: ConfigSettings[] = [];
  const failing = () => Promise.reject(new Error("no git"));
  const service = new ConfigService({
    root: folder,
    git: {
      exists: () => Promise.resolve(false),
      init: failing,
      head: () => Promise.resolve(null),
      objectId: (bytes) => Promise.resolve(digest(bytes)),
      tree: failing,
      blob: failing,
      commit: failing,
      log: failing,
      changes: failing,
    },
    defaults: configPart(DEFAULT_SETTINGS),
    apply: (values) => applied.push(values),
    baseline: { get: () => null, set: () => Promise.resolve() },
    watch: () => ({ close: () => {} }),
  });
  services.push(service);
  await service.initialize();
  await writeFile(path.join(folder, "settings.json"), '{"kind":"settings","terminalFontSize":13}');
  const status = await service.refresh();
  expect(status).toMatchObject({ available: false, uncommitted: null });
  expect(status.error).toContain("Git is unavailable");
  expect(applied.at(-1)).toEqual({ terminalFontSize: 13 });
});

test("a config path that is a file fails initialization and reports it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "foom-config-file-"));
  roots.push(root);
  const folder = path.join(root, "config");
  await writeFile(folder, "not a folder");
  const statuses: unknown[] = [];
  const service = new ConfigService({
    root: folder,
    git: new ConfigGit(folder, await prepareIsolation(path.join(root, "isolation"))),
    defaults: configPart(DEFAULT_SETTINGS),
    apply: () => {},
    baseline: { get: () => null, set: () => Promise.resolve() },
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

test("files already invalid at first launch stay uncommitted and are reported", async () => {
  const f = await fixture();
  await mkdir(path.join(f.folder, "themes"), { recursive: true });
  await writeFile(path.join(f.folder, "settings.json"), Buffer.from([0x7b, 0xff, 0x7d]));
  await f.write("themes/good.json", theme("Good"));
  await f.write("themes/bad.json", theme("Bad", { ...palette.colors, bg: "nope" }));
  await f.service.initialize();
  const status = f.service.status();
  expect(status.rejected).toBe(2);
  expect(status.changes.map((change) => change.reason).filter(Boolean)).toEqual(
    expect.arrayContaining(["$: malformed-json", "$.colors.bg: not-a-color"]),
  );
  const tree = await f.git.tree((await f.git.head()) ?? "");
  expect(tree.has("themes/good.json")).toBe(true);
  expect(tree.has("themes/bad.json")).toBe(false);
  expect(tree.has("settings.json")).toBe(false);
  expect(status.uncommitted).toBe(2);
});

test("theme folder events schedule a scan", async () => {
  const f = await fixture();
  await f.service.initialize();
  await f.write("themes/live.json", theme("Live"));
  f.listeners[1]?.("live.json");
  await vi.waitFor(async () => {
    expect((await f.git.log(1))[0]?.subject).toBe("Add Live theme");
  });
  // Root events for other files are ignored.
  f.listeners[0]?.("README.md");
});

test("Keep it on restores and commits when an agent committed the weakening itself", async () => {
  const f = await fixture();
  await f.service.initialize();
  const weakened = JSON.stringify({ kind: "settings", hooks: false });
  await f.write("settings.json", weakened);
  await f.git.commit(new Map([["settings.json", Buffer.from(weakened)]]), "Agent commit");
  expect((await f.service.refresh()).pending?.detail).toBe("hooks: on → off");
  await f.service.decide("keep");
  expect(JSON.parse(await f.read("settings.json"))).toEqual({ kind: "settings" });
  expect((await f.git.log(1))[0]?.subject).toBe("Restore settings");
});

test("git failures after setup are reported without losing applied changes", async () => {
  const f = await fixture();
  await f.service.initialize();
  const commit = vi.spyOn(f.git, "commit").mockRejectedValue(new Error("locked"));
  await f.settings({ terminalFontSize: 25 });
  let status = await f.service.refresh();
  expect(status.error).toBe("Unable to record the last change in git.");
  expect(f.applied.at(-1)).toEqual({ terminalFontSize: 25 });
  commit.mockRestore();
  const log = vi.spyOn(f.git, "log").mockRejectedValue(new Error("gone"));
  status = await f.service.refresh();
  expect(status.uncommitted).toBeNull();
  log.mockRestore();
  vi.spyOn(f.git, "head").mockRejectedValue(new Error("gone"));
  await f.service.write({ terminalFontSize: 26 });
  expect(f.applied.at(-1)).toEqual({ terminalFontSize: 26 });
});
